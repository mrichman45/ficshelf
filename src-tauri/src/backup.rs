//! Backup and restore: one zip holding the library database (positions,
//! highlights, notes, bookmarks, edited details, settings), the app's own
//! preferences from the front end, and, if asked for, the book files that
//! live in FicShelf's own storage. Books she added from elsewhere stay where
//! they are and are only referred to.
//!
//! Paths in the database are absolute. A backup records the app-data and
//! downloads folders it was made with, and a restore rewrites paths from
//! those to the new device's folders.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const FORMAT: &str = "ficshelf-backup";
const MANIFEST: &str = "ficshelf-backup.json";
const DATABASE: &str = "library.sqlite3";

#[derive(Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub created: i64,
    pub app_version: String,
    pub data_dir: String,
    pub library_dir: String,
    pub with_books: bool,
    pub books_included: u64,
    /// The front end's preferences (theme, reading layout, …) as stored.
    pub prefs: serde_json::Value,
}

#[derive(Serialize)]
pub struct Made {
    pub path: String,
    pub bytes: u64,
    pub books: u64,
}

#[derive(Serialize)]
pub struct Restored {
    pub books: u64,
    pub files: u64,
    pub prefs: serde_json::Value,
    pub created: i64,
}

/// What a file's path in the zip is, by which of FicShelf's folders it was
/// in: "books/data/…" or "books/library/…".
fn zip_name(path: &Path, data_dir: &Path, library_dir: &Path) -> Option<String> {
    let (root, rest) = if let Ok(r) = path.strip_prefix(library_dir) {
        ("library", r)
    } else if let Ok(r) = path.strip_prefix(data_dir) {
        ("data", r)
    } else {
        return None;
    };
    let parts: Vec<String> = rest
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    if parts.is_empty() || parts.iter().any(|p| p == ".." || p.is_empty()) {
        return None;
    }
    Some(format!("books/{root}/{}", parts.join("/")))
}

/// Where a "books/…" entry goes on this device, refusing anything that
/// would land outside FicShelf's folders.
fn restore_target(name: &str, data_dir: &Path, library_dir: &Path) -> Option<PathBuf> {
    let rest = name.strip_prefix("books/")?;
    let (root, rel) = rest.split_once('/')?;
    let base = match root {
        "data" => data_dir,
        "library" => library_dir,
        _ => return None,
    };
    let mut out = base.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains('\\') || part.contains(':') {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// A path moved from one folder to another, if it was in the first.
pub fn remap(path: &str, from: &str, to: &str) -> Option<String> {
    if from.is_empty() || from == to {
        return None;
    }
    let from_t = from.trim_end_matches(['/', '\\']);
    let rest = path.strip_prefix(from_t)?;
    if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')) {
        return None; // "/data/Works2" is not inside "/data/Works"
    }
    Some(format!("{}{}", to.trim_end_matches(['/', '\\']), rest))
}

/// Write a backup to `dest`. `progress(done, total)` is called as book
/// bytes are written.
pub fn make(
    conn: &std::sync::Mutex<rusqlite::Connection>,
    data_dir: &Path,
    library_dir: &Path,
    dest: &Path,
    with_books: bool,
    prefs: serde_json::Value,
    app_version: &str,
    mut progress: impl FnMut(u64, u64),
) -> Result<Made> {
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    }
    // A consistent copy of the database, taken without stopping the app.
    let snap = data_dir.join(format!(".backup-{}.sqlite3", std::process::id()));
    std::fs::remove_file(&snap).ok();
    let paths: Vec<String> = {
        let c = conn.lock().map_err(|_| anyhow!("library is busy"))?;
        let quoted = snap.to_string_lossy().replace('\'', "''");
        c.execute_batch(&format!("VACUUM INTO '{quoted}'"))
            .context("copying the library database")?;
        let mut st = c.prepare("SELECT path FROM books")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let books: Vec<(PathBuf, String, u64)> = if with_books {
        let mut seen = std::collections::HashSet::new();
        paths
            .iter()
            .map(PathBuf::from)
            .filter_map(|p| {
                let name = zip_name(&p, data_dir, library_dir)?;
                let size = std::fs::metadata(&p).ok().filter(|m| m.is_file())?.len();
                seen.insert(name.clone()).then_some((p, name, size))
            })
            .collect()
    } else {
        Vec::new()
    };
    let total: u64 = books.iter().map(|b| b.2).sum();

    let tmp = dest.with_extension("zip.part");
    let result = (|| -> Result<u64> {
        let file = std::fs::File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
        let deflate = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        // Books are already compressed (zip, mp3, jpeg); storing is faster.
        let stored = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .large_file(true);

        let manifest = Manifest {
            format: FORMAT.into(),
            version: 1,
            created: crate::db::now(),
            app_version: app_version.into(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            library_dir: library_dir.to_string_lossy().into_owned(),
            with_books,
            books_included: books.len() as u64,
            prefs,
        };
        zip.start_file(MANIFEST, deflate)?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;

        zip.start_file(DATABASE, deflate.large_file(true))?;
        std::io::copy(&mut std::fs::File::open(&snap)?, &mut zip)?;

        let mut done = 0u64;
        progress(0, total);
        for (path, name, _) in &books {
            let Ok(mut f) = std::fs::File::open(path) else { continue };
            zip.start_file(name.as_str(), stored)?;
            let mut buf = vec![0u8; 1 << 20];
            loop {
                let n = f.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buf[..n])?;
                done += n as u64;
                progress(done, total);
            }
        }
        let mut w = zip.finish()?;
        w.flush()?;
        Ok(books.len() as u64)
    })();
    std::fs::remove_file(&snap).ok();
    let count = match result {
        Ok(n) => n,
        Err(e) => {
            std::fs::remove_file(&tmp).ok();
            return Err(e);
        }
    };
    std::fs::rename(&tmp, dest).with_context(|| format!("saving {}", dest.display()))?;
    let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    Ok(Made { path: dest.to_string_lossy().into_owned(), bytes, books: count })
}

/// Read a backup's manifest, checking it is one.
pub fn manifest_of<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>) -> Result<Manifest> {
    let mut s = String::new();
    zip.by_name(MANIFEST)
        .map_err(|_| anyhow!("that file is not a FicShelf backup"))?
        .read_to_string(&mut s)?;
    let m: Manifest = serde_json::from_str(&s).context("the backup's description is damaged")?;
    if m.format != FORMAT {
        return Err(anyhow!("that file is not a FicShelf backup"));
    }
    if m.version > 1 {
        return Err(anyhow!("that backup was made by a newer FicShelf; update this one first"));
    }
    Ok(m)
}

/// Restore from the zip at `src`. Replaces the library database (the old
/// one is kept beside it as library.sqlite3.before-restore), puts book
/// files back, and rewrites paths for this device.
pub fn restore(
    conn: &std::sync::Mutex<rusqlite::Connection>,
    library_dir: &std::sync::Mutex<PathBuf>,
    data_dir: &Path,
    src: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<Restored> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(src)?).context("that file is not a zip")?;
    let m = manifest_of(&mut zip)?;

    // Where the old downloads folder lives on this device: moved along with
    // the app's data if it was inside it, otherwise the same place.
    let new_library = remap(&m.library_dir, &m.data_dir, &data_dir.to_string_lossy())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&m.library_dir));
    let new_library = if std::fs::create_dir_all(&new_library).is_ok() {
        new_library
    } else {
        data_dir.join("Works") // e.g. a phone folder this device lacks
    };

    // The database first, to a side file.
    let incoming = data_dir.join("library.sqlite3.restoring");
    {
        let mut f = zip.by_name(DATABASE).map_err(|_| anyhow!("the backup has no library in it"))?;
        let mut out = std::fs::File::create(&incoming)?;
        std::io::copy(&mut f, &mut out)?;
    }
    // Check it opens before anything is replaced.
    rusqlite::Connection::open(&incoming)
        .and_then(|c| c.query_row("SELECT count(*) FROM books", [], |r| r.get::<_, i64>(0)))
        .map_err(|e| {
            std::fs::remove_file(&incoming).ok();
            anyhow!("the library in that backup could not be read: {e}")
        })?;

    // Book files.
    let total: u64 = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().filter(|f| f.name().starts_with("books/")).map(|f| f.size()))
        .sum();
    let mut done = 0u64;
    let mut files = 0u64;
    progress(0, total);
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        if !f.is_file() {
            continue;
        }
        let Some(target) = restore_target(f.name(), data_dir, &new_library) else { continue };
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let part = target.with_extension("restoring");
        let mut out = std::fs::File::create(&part)?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
            done += n as u64;
            progress(done, total);
        }
        drop(out);
        std::fs::rename(&part, &target)?;
        files += 1;
    }

    // Swap the database in.
    let live = data_dir.join("library.sqlite3");
    let books = {
        let mut c = conn.lock().map_err(|_| anyhow!("library is busy"))?;
        *c = rusqlite::Connection::open_in_memory()?; // closes the live file
        let keep = data_dir.join("library.sqlite3.before-restore");
        std::fs::remove_file(&keep).ok();
        std::fs::rename(&live, &keep).ok();
        for ext in ["-wal", "-shm"] {
            std::fs::remove_file(data_dir.join(format!("library.sqlite3{ext}"))).ok();
        }
        std::fs::rename(&incoming, &live)?;
        let fresh = crate::db::open(&live)?;

        let new_data = data_dir.to_string_lossy().into_owned();
        let new_lib = new_library.to_string_lossy().into_owned();
        let moves = [(m.library_dir.clone(), new_lib.clone()), (m.data_dir.clone(), new_data)];
        let rows: Vec<(i64, String)> = {
            let mut st = fresh.prepare("SELECT id, path FROM books")?;
            let it = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            it.filter_map(|r| r.ok()).collect()
        };
        for (id, path) in &rows {
            if let Some(np) = moves.iter().find_map(|(from, to)| remap(path, from, to)) {
                fresh.execute("UPDATE books SET path = ?2 WHERE id = ?1", rusqlite::params![id, np])?;
            }
        }
        crate::db::set_setting(&fresh, "library_dir", &new_lib)?;
        *library_dir.lock().map_err(|_| anyhow!("library is busy"))? = new_library.clone();
        let n = rows.len() as u64;
        *c = fresh;
        n
    };

    Ok(Restored { books, files, prefs: m.prefs, created: m.created })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_move_between_devices() {
        assert_eq!(remap("/a/data/Works/x.epub", "/a/data", "/b/d").as_deref(), Some("/b/d/Works/x.epub"));
        assert_eq!(remap("/a/data2/x", "/a/data", "/b"), None);
        assert_eq!(remap("/a/data", "/a/data/", "/b"), Some("/b".into()));
        assert_eq!(remap("/x/y", "/a", "/b"), None);
        assert_eq!(remap(r"C:\Users\m\AppData\x.epub", r"C:\Users\m\AppData", "/data").as_deref(), Some(r"/data\x.epub"));
    }

    #[test]
    fn zip_names_stay_inside() {
        let d = Path::new("/d");
        let l = Path::new("/d/Works");
        assert_eq!(zip_name(Path::new("/d/Works/Podfics/a.mp3"), d, l).as_deref(), Some("books/library/Podfics/a.mp3"));
        assert_eq!(zip_name(Path::new("/d/Imported/b.cbz"), d, l).as_deref(), Some("books/data/Imported/b.cbz"));
        assert_eq!(zip_name(Path::new("/home/me/c.epub"), d, l), None);

        let nd = Path::new("/n");
        let nl = Path::new("/n/Works");
        assert_eq!(restore_target("books/library/Podfics/a.mp3", nd, nl), Some(PathBuf::from("/n/Works/Podfics/a.mp3")));
        assert_eq!(restore_target("books/data/../../etc/passwd", nd, nl), None);
        assert_eq!(restore_target("books/other/x", nd, nl), None);
        assert_eq!(restore_target("library.sqlite3", nd, nl), None);
    }
}
