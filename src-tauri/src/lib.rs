//! FicShelf: a local reading library for EPUB, PDF and CBZ files, with an
//! optional Archive of Our Own fetcher.
//!
//! The database and the AO3 client are kept apart on purpose. Database work
//! is synchronous and brief; network work is asynchronous and paced. No
//! command ever holds the database lock across an await.

mod ao3;
mod ao3_parse;
mod archive;
mod audiometa;
mod backup;
mod cooldown;
mod creds;
mod db;
mod epubgen;
mod gdrive;
mod opf;
mod sync;
mod syncdata;
mod util;

use anyhow::Result;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct AppState {
    conn: Mutex<rusqlite::Connection>,
    ao3: ao3::Ao3Client,
    sync: sync::SyncState,
    /// Where downloaded works are written. Books imported from elsewhere stay
    /// where they are; only AO3 downloads land here.
    library_dir: Mutex<PathBuf>,
}

/// Commands return a plain string error because that is what the front end can
/// actually display. The detail chain from anyhow is preserved in the text.
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn chain(e: anyhow::Error) -> String {
    let mut s = e.to_string();
    for cause in e.chain().skip(1) {
        s.push_str(&format!(": {cause}"));
    }
    s
}

// ------------------------------------------------------------------ models

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportReport {
    pub added: Vec<db::Book>,
    pub skipped: Vec<String>,
    pub failed: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
pub struct OpenedBook {
    pub book: db::Book,
    /// For CBZ files: the page entries, in reading order.
    pub pages: Vec<String>,
    /// For CBZ files: whether ComicInfo marks it as manga read right to left.
    pub right_to_left: bool,
}

#[derive(Debug, Serialize)]
pub struct UpdateReport {
    pub checked: usize,
    pub with_updates: Vec<db::Book>,
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------- helpers

fn format_of(path: &Path) -> Option<&'static str> {
    util::kind_of_ext(&path.extension()?.to_string_lossy())
}

fn stem_title(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().replace('_', " ").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Untitled".to_string())
}

/// The name of the folder a file sits in, used to group books without a
/// series of their own.
fn parent_name(path: &Path) -> Option<String> {
    path.parent()?
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
}

/// Import one file into the library, reading whatever metadata its format
/// offers. Never copies or moves the file. `folder` names the folder it was
/// added from, for grouping. A DRM-locked book is added and marked as such:
/// FicShelf cannot open it, but lists it and hands it to an app that can.
fn import_one(conn: &rusqlite::Connection, path: &Path, folder: Option<&str>) -> Result<db::Book> {
    let format = format_of(path)
        .ok_or_else(|| anyhow::anyhow!("{} is not an EPUB, PDF, CBZ or audio file", path.display()))?;

    if !path.exists() {
        anyhow::bail!("{} does not exist", path.display());
    }

    let path_str = path.to_string_lossy().to_string();
    let mut title = stem_title(path);
    let mut author: Option<String> = None;
    let mut cover: Option<(Vec<u8>, String)> = None;
    let mut series: Option<String> = None;
    let mut series_index: Option<f64> = None;
    let mut drm: Option<&'static str> = None;

    match format {
        "epub" => {
            drm = archive::epub_drm(path).unwrap_or(None);
            // A locked book's package file is usually readable, so its
            // title and author still come through; its cover may be
            // encrypted, so it is left out rather than shown as garbage.
            if let Ok(info) = archive::read_epub(path) {
                if let Some(t) = info.title.filter(|t| !t.trim().is_empty()) {
                    title = t;
                }
                author = info.author;
                if drm.is_none() {
                    cover = info.cover;
                }
                series = info.series;
                series_index = info.series_index;
            }
        }
        "cbz" => {
            // The first page is the cover. ComicInfo.xml, when present,
            // supplies the title, series and issue number.
            cover = archive::cbz_cover(path).unwrap_or(None);
            if let Ok(Some(info)) = archive::cbz_info(path) {
                if let Some(t) = info.title {
                    title = t;
                }
                author = info.writer;
                series = info.series;
                series_index = info.number;
            }
        }
        "audio" => {
            // A podfic: the tags give the title, the reader (as author) and
            // cover art when they are there.
            let tags = audiometa::read_tags(path);
            if let Some(t) = tags.title.filter(|t| !t.trim().is_empty()) {
                title = t;
            }
            author = tags.artist;
            cover = tags.cover;
        }
        _ => {
            drm = archive::pdf_drm(path).unwrap_or(None);
            // PDFs keep their file name here. The front end renders page one
            // and sends it back as a cover once the book is first opened,
            // which avoids shipping a PDF parser in the backend.
        }
    }

    let new = db::NewBook {
        path: &path_str,
        format,
        title: &title,
        author: author.as_deref(),
        cover: cover.as_ref().map(|(b, m)| (b.as_slice(), m.as_str())),
        ao3_work_id: None,
        chapters_seen: None,
        chapters_total: None,
        complete: false,
        series: series.as_deref(),
        series_index,
        folder,
        drm,
    };
    let id = db::upsert_book(conn, &new)?;
    db::get_book(conn, id)?.ok_or_else(|| anyhow::anyhow!("the book vanished after import"))
}

fn data_url(bytes: &[u8], mime: &str) -> String {
    format!("data:{};base64,{}", mime, B64.encode(bytes))
}

// --------------------------------------------------------------- commands

#[tauri::command]
fn list_books(state: State<'_, AppState>, sort: String) -> Result<Vec<db::Book>, String> {
    let conn = state.conn.lock().map_err(err)?;
    db::list_books(&conn, &sort).map_err(chain)
}

#[tauri::command]
fn import_paths(state: State<'_, AppState>, paths: Vec<String>) -> Result<ImportReport, String> {
    let conn = state.conn.lock().map_err(err)?;
    let mut report = ImportReport { added: vec![], skipped: vec![], failed: vec![] };

    for raw in paths {
        let path = PathBuf::from(&raw);
        if format_of(&path).is_none() {
            report.skipped.push(raw);
            continue;
        }
        let folder = parent_name(&path);
        match import_one(&conn, &path, folder.as_deref()) {
            Ok(book) => report.added.push(book),
            Err(e) => report.failed.push((raw, chain(e))),
        }
    }
    Ok(report)
}

/// Walk a folder and import everything readable in it.
#[tauri::command]
fn scan_folder(state: State<'_, AppState>, path: String, recursive: bool) -> Result<ImportReport, String> {
    let root = PathBuf::from(&path);
    let mut files: Vec<PathBuf> = Vec::new();
    collect_files(&root, recursive, &mut files, 0);

    let conn = state.conn.lock().map_err(err)?;
    let mut report = ImportReport { added: vec![], skipped: vec![], failed: vec![] };
    for file in files {
        let folder = parent_name(&file);
        match import_one(&conn, &file, folder.as_deref()) {
            Ok(book) => report.added.push(book),
            Err(e) => report.failed.push((file.to_string_lossy().to_string(), chain(e))),
        }
    }
    Ok(report)
}

/// Largest file `import_bytes` accepts. The whole file travels through
/// memory once on its way to disk, so this stays modest.
const MAX_IMPORT_BYTES: usize = 512 * 1024 * 1024;

/// Largest file `import_uri` accepts. It streams to disk and never holds
/// the file in memory, so this only guards against filling the phone with
/// something unexpected; omnibus comics run to several gigabytes.
const MAX_STREAMED_IMPORT_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Import a file the front end has already read, for platforms where the
/// file picker returns something other than a path: on Android it is a
/// `content://` link that only the system can open. The bytes arrive as the
/// raw request body; the picker's link comes in the `x-source` header so a
/// file name can be recovered from it when there is one.
///
/// The file is copied into `<library folder>/Imported`, because on Android
/// the original is not ours to keep reopening.
#[tauri::command]
async fn import_bytes(
    request: tauri::ipc::Request<'_>,
    state: State<'_, AppState>,
) -> Result<db::Book, String> {
    // Desktop delivers the bytes raw. Some webviews, Android's among them,
    // can deliver the same Uint8Array as JSON instead: either an array of
    // numbers or an object keyed "0", "1", ... Accept all three.
    let owned: Vec<u8>;
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b,
        tauri::ipc::InvokeBody::Json(json) => {
            owned = bytes_from_json(json).ok_or_else(|| {
                format!("the file arrived in an unexpected form ({})", json_kind(json))
            })?;
            &owned
        }
        #[allow(unreachable_patterns)]
        _ => return Err("the file arrived in an unexpected form".into()),
    };
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err("that file is too large to import".into());
    }
    let source = request
        .headers()
        .get("x-source")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_encoding::percent_decode_str(v).decode_utf8_lossy().into_owned())
        .unwrap_or_default();

    let name = util::name_from_uri(&source);
    let format = util::sniff_format(bytes, name.as_deref().unwrap_or(""))
        .ok_or_else(|| "that is not an EPUB, PDF, CBZ or audio file".to_string())?;

    let stem = name
        .as_deref()
        .and_then(|n| n.rsplit_once('.').map(|(s, _)| s.to_string()))
        .unwrap_or_else(|| format!("Imported {}", db::now()));
    let stem = util::safe_filename(&stem, "Imported");

    let dir = { state.library_dir.lock().map_err(err)?.join("Imported") };
    std::fs::create_dir_all(&dir).map_err(err)?;

    let path = import_destination(&dir, &stem, format, bytes.len() as u64);
    std::fs::write(&path, bytes).map_err(err)?;

    let conn = state.conn.lock().map_err(err)?;
    import_one(&conn, &path, None).map_err(|e| {
        // Our copy is no use if it could not be added.
        std::fs::remove_file(&path).ok();
        chain(e)
    })
}

/// Import a file the Android file picker chose, by its `content://` link.
///
/// The backend opens the link itself through the system and copies it to
/// `<library folder>/Imported` a piece at a time, so a 300 MB comic never
/// has to fit in memory. (Sending the bytes over IPC instead, as
/// `import_bytes` does, works for small books but on Android the bytes
/// travel as JSON, several times their size, and a large CBZ runs the app
/// out of memory.)
#[tauri::command]
async fn import_uri(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    uri: String,
    folder: Option<String>,
) -> Result<db::Book, String> {
    use std::io::{Read, Write};
    use tauri_plugin_fs::FsExt;

    let file_path: tauri_plugin_fs::FilePath = uri.parse().map_err(err)?;
    let mut opts = tauri_plugin_fs::OpenOptions::new();
    opts.read(true);
    let mut src = app
        .fs()
        .open(file_path, opts)
        .map_err(|e| format!("could not open the chosen file: {e}"))?;

    // The first bytes say what kind of book this is.
    let mut head = [0u8; 256];
    let mut got = 0;
    while got < head.len() {
        match src.read(&mut head[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(format!("could not read the chosen file: {e}")),
        }
    }
    let name = util::name_from_uri(&uri);
    let format = util::sniff_format(&head[..got], name.as_deref().unwrap_or(""))
        .ok_or_else(|| "that is not an EPUB, PDF, CBZ or audio file".to_string())?;

    let dir = { state.library_dir.lock().map_err(err)?.join("Imported") };
    std::fs::create_dir_all(&dir).map_err(err)?;

    // Copy to a temporary name first, so a failed or oversized copy never
    // leaves a half-written book where the library would find it.
    let tmp = dir.join(format!(".importing-{}-{}.part", std::process::id(), db::now()));
    let copied = (|| -> std::io::Result<u64> {
        let mut out = std::fs::File::create(&tmp)?;
        out.write_all(&head[..got])?;
        // One byte past the limit is enough to know it was exceeded.
        let rest = std::io::copy(&mut src.take(MAX_STREAMED_IMPORT_BYTES + 1), &mut out)?;
        out.flush()?;
        Ok(got as u64 + rest)
    })();
    let size = match copied {
        Ok(n) => n,
        Err(e) => {
            std::fs::remove_file(&tmp).ok();
            return Err(format!("could not copy the chosen file: {e}"));
        }
    };
    if size > MAX_STREAMED_IMPORT_BYTES {
        std::fs::remove_file(&tmp).ok();
        return Err("that file is over 4 GB, too large to import".into());
    }

    let stem = name
        .as_deref()
        .and_then(|n| n.rsplit_once('.').map(|(s, _)| s.to_string()))
        .unwrap_or_else(|| format!("Imported {}", db::now()));
    let path = import_destination(&dir, &util::safe_filename(&stem, "Imported"), format, size);
    std::fs::rename(&tmp, &path).map_err(|e| {
        std::fs::remove_file(&tmp).ok();
        err(e)
    })?;

    let conn = state.conn.lock().map_err(err)?;
    let folder = folder.filter(|f| !f.trim().is_empty());
    import_one(&conn, &path, folder.as_deref()).map_err(|e| {
        // Our copy is no use if it could not be added.
        std::fs::remove_file(&path).ok();
        chain(e)
    })
}

/// Where an imported file goes. The same name and the same size is taken to
/// be the same file, so importing it twice updates the entry rather than
/// making a copy; anything else gets " (2)", " (3)" and so on.
fn import_destination(dir: &Path, stem: &str, format: &str, size: u64) -> PathBuf {
    let mut path = dir.join(format!("{stem}.{format}"));
    let mut n = 2;
    while path.exists() && std::fs::metadata(&path).map(|m| m.len()).ok() != Some(size) {
        path = dir.join(format!("{stem} ({n}).{format}"));
        n += 1;
    }
    path
}

/// A byte array that came through IPC as JSON rather than raw.
fn bytes_from_json(json: &serde_json::Value) -> Option<Vec<u8>> {
    let byte = |v: &serde_json::Value| v.as_u64().filter(|n| *n < 256).map(|n| n as u8);
    match json {
        serde_json::Value::Array(items) => items.iter().map(byte).collect(),
        serde_json::Value::Object(map) => {
            let mut out = vec![0u8; map.len()];
            for (k, v) in map {
                let i: usize = k.parse().ok()?;
                *out.get_mut(i)? = byte(v)?;
            }
            Some(out)
        }
        _ => None,
    }
}

fn json_kind(json: &serde_json::Value) -> &'static str {
    match json {
        serde_json::Value::Null => "nothing",
        serde_json::Value::Bool(_) => "a true/false value",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "text",
        serde_json::Value::Array(_) => "a list that is not bytes",
        serde_json::Value::Object(_) => "an object that is not bytes",
    }
}

fn collect_files(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>, depth: usize) {
    // A depth cap stops a symlink loop from running forever.
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if recursive {
                collect_files(&path, recursive, out, depth + 1);
            }
        } else if format_of(&path).is_some() {
            out.push(path);
        }
    }
}

#[tauri::command]
fn open_book(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<OpenedBook, String> {
    let conn = state.conn.lock().map_err(err)?;
    let book = db::get_book(&conn, id)
        .map_err(chain)?
        .ok_or_else(|| "that book is not in the library".to_string())?;

    // The EPUB and PDF readers load the file through the asset protocol,
    // whose static scope only covers the home and app-data folders. A book
    // on another drive is let through by name, and only that one file.
    if book.format != "cbz" {
        app.asset_protocol_scope()
            .allow_file(&book.path)
            .map_err(err)?;
    }

    let (pages, right_to_left) = if book.format == "cbz" {
        let p = Path::new(&book.path);
        let rtl = archive::cbz_info(p)
            .ok()
            .flatten()
            .map(|i| i.right_to_left)
            .unwrap_or(false);
        (archive::cbz_pages(p).map_err(chain)?, rtl)
    } else {
        (Vec::new(), false)
    };
    Ok(OpenedBook { book, pages, right_to_left })
}

/// A whole EPUB's bytes, for the reader. Sent as a raw binary response
/// rather than fetched through the asset protocol, which on Android is a
/// slow path for files of any size.
#[tauri::command]
async fn book_bytes(state: State<'_, AppState>, id: i64) -> Result<tauri::ipc::Response, String> {
    let path = {
        let conn = state.conn.lock().map_err(err)?;
        db::get_book(&conn, id)
            .map_err(chain)?
            .ok_or_else(|| "that book is not in the library".to_string())?
            .path
    };
    let bytes = std::fs::read(&path).map_err(|e| format!("could not read the book: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn cbz_page(state: State<'_, AppState>, id: i64, name: String) -> Result<String, String> {
    let path = {
        let conn = state.conn.lock().map_err(err)?;
        db::get_book(&conn, id)
            .map_err(chain)?
            .ok_or_else(|| "that book is not in the library".to_string())?
            .path
    };
    let (bytes, mime) = archive::cbz_page(Path::new(&path), &name).map_err(chain)?;
    Ok(data_url(&bytes, &mime))
}

#[tauri::command]
async fn book_cover(state: State<'_, AppState>, id: i64) -> Result<Option<String>, String> {
    let conn = state.conn.lock().map_err(err)?;
    Ok(db::cover_bytes(&conn, id)
        .map_err(chain)?
        .map(|(bytes, mime)| data_url(&bytes, &mime)))
}

/// Used by the front end to store a cover it rendered itself, which is how
/// PDFs get one.
#[tauri::command]
fn set_cover_from_data_url(
    state: State<'_, AppState>,
    id: i64,
    data_url: String,
) -> Result<(), String> {
    let (mime, b64) = data_url
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .ok_or_else(|| "expected a base64 data URL".to_string())?;
    if !mime.starts_with("image/") {
        return Err("covers must be images".into());
    }
    let bytes = B64.decode(b64).map_err(err)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("that cover is too large".into());
    }
    let conn = state.conn.lock().map_err(err)?;
    db::set_cover(&conn, id, &bytes, mime).map_err(chain)
}

#[tauri::command]
fn save_position(state: State<'_, AppState>, id: i64, position: String) -> Result<(), String> {
    let conn = state.conn.lock().map_err(err)?;
    db::save_position(&conn, id, &position).map_err(chain)
}

/// Save the user's own edit of a book's details. Blank fields become empty;
/// a blank title is refused, since every book needs one.
#[tauri::command]
fn update_metadata(
    state: State<'_, AppState>,
    id: i64,
    title: String,
    author: Option<String>,
    series: Option<String>,
    series_index: Option<f64>,
) -> Result<db::Book, String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("A book needs a title.".into());
    }
    let tidy = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let author = tidy(author);
    let series = tidy(series);
    let series_index = series_index.filter(|n| n.is_finite() && *n >= 0.0);
    let conn = state.conn.lock().map_err(err)?;
    db::update_metadata(&conn, id, title, author.as_deref(), series.as_deref(), series_index)
        .map_err(chain)?;
    db::get_book(&conn, id)
        .map_err(chain)?
        .ok_or_else(|| "that book is not in the library".to_string())
}

/// Open a book in the computer's own default app for its file type. Used for
/// DRM-locked books, which only software licensed for that DRM can open,
/// such as Adobe Digital Editions. (On Android the front end asks the native
/// side instead, which offers a choice of installed apps.)
#[tauri::command]
fn open_externally(app: tauri::AppHandle, state: State<'_, AppState>, id: i64) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = {
        let conn = state.conn.lock().map_err(err)?;
        db::get_book(&conn, id)
            .map_err(chain)?
            .ok_or_else(|| "that book is not in the library".to_string())?
            .path
    };
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("no app on this computer would open it: {e}"))
}

/// Open a web link from inside a book in the browser. Only http(s) links.
#[tauri::command]
fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("only web links can be opened".into());
    }
    app.opener()
        .open_url(url.trim(), None::<&str>)
        .map_err(|e| format!("could not open the link: {e}"))
}

/// Largest podfic fetched from a link.
const MAX_PODFIC_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Download a podfic's audio from a link in a work (the podficcer's own
/// "download here" link) into the library. One file, fetched once, when she
/// asks for it; nothing else on that site is touched.
#[tauri::command]
async fn save_podfic_url(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    title: Option<String>,
    author: Option<String>,
) -> Result<db::Book, String> {
    use std::io::Write;

    let url = url.trim().to_string();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("that is not a web link".into());
    }
    // The standard "compatible" form: it still names FicShelf, but small
    // hosts that refuse anything not starting "Mozilla/5.0" let it through.
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Mozilla/5.0 (compatible; FicShelf/",
            env!("CARGO_PKG_VERSION"),
            "; podfic download; +https://github.com/mrichman45/ficshelf)"
        ))
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(err)?;
    let fetch = || {
        client
            .get(&url)
            .header(reqwest::header::ACCEPT, "audio/*, */*;q=0.8")
            .send()
    };
    // One retry after a pause if the host is busy or slow to answer;
    // personal podfic hosts often are.
    let busy = |r: &Result<reqwest::Response, reqwest::Error>| match r {
        Ok(resp) => matches!(resp.status().as_u16(), 502 | 503 | 504),
        Err(e) => e.is_timeout() || e.is_connect(),
    };
    let mut first = fetch().await;
    if busy(&first) {
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        first = fetch().await;
    }
    let mut resp = first.map_err(|e| {
        if e.is_timeout() || e.is_connect() {
            format!("that site did not answer (it may be down): {e}")
        } else {
            format!("could not reach that site: {e}")
        }
    })?;
    if !resp.status().is_success() {
        return Err(format!(
            "the site answered {} for that link{}",
            resp.status(),
            if resp.status().as_u16() == 503 { " (it is busy or down; try again later)" } else { "" }
        ));
    }
    if resp.content_length().is_some_and(|n| n > MAX_PODFIC_BYTES) {
        return Err("that file is over 2 GB, too large to save".into());
    }
    let name = resp
        .url()
        .path_segments()
        .and_then(|mut s| s.next_back().map(util::percent_decode))
        .filter(|n| !n.is_empty());

    let dir = { state.library_dir.lock().map_err(err)?.join("Podfics") };
    std::fs::create_dir_all(&dir).map_err(err)?;
    let tmp = dir.join(format!(".downloading-{}-{}.part", std::process::id(), db::now()));
    let mut out = std::fs::File::create(&tmp).map_err(err)?;
    let mut head: Vec<u8> = Vec::with_capacity(256);
    let mut size: u64 = 0;
    let total = resp.content_length();
    // Progress for the front end, a few times a second at most.
    let mut last_report = std::time::Instant::now() - std::time::Duration::from_secs(1);
    let report = |got: u64| {
        use tauri::Emitter;
        app.emit("podfic-progress", serde_json::json!({ "got": got, "total": total })).ok();
    };
    report(0);
    let result: Result<(), String> = async {
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("the download stopped: {e}"))? {
            if head.len() < 256 {
                let take = (256 - head.len()).min(chunk.len());
                head.extend_from_slice(&chunk[..take]);
                // A web page instead of audio: stop early.
                if head.len() >= 16 && util::sniff_format(&head, name.as_deref().unwrap_or("")).is_none() {
                    return Err("that link leads to a web page, not an audio file; open it in the browser instead"
                        .into());
                }
            }
            size += chunk.len() as u64;
            if size > MAX_PODFIC_BYTES {
                return Err("that file is over 2 GB, too large to save".into());
            }
            out.write_all(&chunk).map_err(err)?;
            if last_report.elapsed() >= std::time::Duration::from_millis(250) {
                last_report = std::time::Instant::now();
                report(size);
            }
        }
        report(size);
        out.flush().map_err(err)?;
        Ok(())
    }
    .await;
    drop(out);
    if let Err(e) = result {
        std::fs::remove_file(&tmp).ok();
        return Err(e);
    }
    let format = match util::sniff_format(&head, name.as_deref().unwrap_or("")) {
        Some(f) if util::kind_of_ext(f) == Some("audio") => f,
        _ => {
            std::fs::remove_file(&tmp).ok();
            return Err("that link is not an audio file".into());
        }
    };

    let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let stem = title
        .clone()
        .or_else(|| name.as_deref().and_then(|n| n.rsplit_once('.').map(|(s, _)| s.to_string())))
        .unwrap_or_else(|| format!("Podfic {}", db::now()));
    let path = import_destination(&dir, &util::safe_filename(&stem, "Podfic"), format, size);
    std::fs::rename(&tmp, &path).map_err(|e| {
        std::fs::remove_file(&tmp).ok();
        err(e)
    })?;

    let conn = state.conn.lock().map_err(err)?;
    let book = import_one(&conn, &path, Some("Podfics")).map_err(|e| {
        std::fs::remove_file(&path).ok();
        chain(e)
    })?;
    // Files from podfic hosts are often tagged badly or not at all: the
    // work's own title and creator are better than a file name.
    let untagged = book.author.is_none() || Some(&book.title) == path.file_stem().map(|s| s.to_string_lossy().into_owned()).as_ref();
    if untagged {
        if let Some(t) = &title {
            let by = book.author.clone().or(author.filter(|a| !a.trim().is_empty()));
            db::update_metadata(&conn, book.id, t, by.as_deref(), book.series.as_deref(), book.series_index)
                .map_err(chain)?;
            return db::get_book(&conn, book.id)
                .map_err(chain)?
                .ok_or_else(|| "the podfic vanished from the library".to_string());
        }
    }
    Ok(book)
}

/// Open a word's dictionary entry (Wiktionary) in the browser. The URL is
/// built here, so the front end cannot ask for anything but a dictionary
/// page.
#[tauri::command]
fn look_up(app: tauri::AppHandle, word: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let word: String = word.trim().chars().take(80).collect();
    if word.is_empty() {
        return Err("select a word first".into());
    }
    let url = format!(
        "https://en.wiktionary.org/wiki/{}",
        percent_encoding::utf8_percent_encode(&word.replace(' ', "_"), percent_encoding::NON_ALPHANUMERIC)
    );
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("could not open the dictionary: {e}"))
}

// ------------------------------------------------------------------ sync

#[derive(Serialize)]
pub struct SyncStatus {
    /// False in a build made without a Google client id.
    pub configured: bool,
    pub signed_in: bool,
    pub last_sync_at: Option<i64>,
}

#[tauri::command]
fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let conn = state.conn.lock().map_err(err)?;
    Ok(SyncStatus {
        configured: gdrive::client().is_some(),
        signed_in: sync::load_refresh(&conn).ok().flatten().is_some(),
        last_sync_at: db::get_setting(&conn, "last_sync_at")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok()),
    })
}

/// Step one of connecting Google Drive: a code for the user to enter at
/// Google's device page.
#[tauri::command]
async fn sync_begin_sign_in(state: State<'_, AppState>) -> Result<gdrive::DeviceCode, String> {
    let http = gdrive::http().map_err(chain)?;
    let code = gdrive::start_sign_in(&http).await.map_err(chain)?;
    *state.sync.pending.lock().map_err(err)? = Some(code.clone());
    Ok(code)
}

/// Step two: wait (politely, at Google's interval) for the user to approve,
/// then keep the sign-in.
#[tauri::command]
async fn sync_finish_sign_in(state: State<'_, AppState>) -> Result<SyncStatus, String> {
    let code = state
        .sync
        .pending
        .lock()
        .map_err(err)?
        .clone()
        .ok_or_else(|| "start signing in first".to_string())?;
    let http = gdrive::http().map_err(chain)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(code.expires_in);
    let mut wait = code.interval.max(5);
    loop {
        if std::time::Instant::now() > deadline {
            return Err("The code expired before it was entered. Try again.".into());
        }
        // Cancelled from the front end.
        if state.sync.pending.lock().map_err(err)?.is_none() {
            return Err("Sign-in cancelled.".into());
        }
        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
        match gdrive::poll_sign_in(&http, &code.device_code, wait).await.map_err(chain)? {
            gdrive::Poll::Wait(next) => wait = next.max(5),
            gdrive::Poll::Done { refresh, access, expires_in } => {
                {
                    let conn = state.conn.lock().map_err(err)?;
                    sync::save_refresh(&conn, &refresh).map_err(chain)?;
                }
                state.sync.set_access(access, expires_in).await;
                *state.sync.pending.lock().map_err(err)? = None;
                return sync_status(state);
            }
        }
    }
}

#[tauri::command]
fn sync_cancel_sign_in(state: State<'_, AppState>) -> Result<(), String> {
    *state.sync.pending.lock().map_err(err)? = None;
    Ok(())
}

/// Open Google's page for entering the sign-in code. Only Google's own
/// device-sign-in addresses are opened.
#[tauri::command]
fn sync_open_page(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let ok = ["https://www.google.com/device", "https://google.com/device"]
        .iter()
        .any(|p| url == *p || url.starts_with(&format!("{p}?")));
    let url = if ok { url } else { "https://www.google.com/device".to_string() };
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
async fn sync_now(state: State<'_, AppState>) -> Result<sync::Summary, String> {
    sync::run(&state.sync, &state.conn).await.map_err(chain)
}

/// Disconnect Google Drive on this device. The shared file in Drive is left
/// for the other devices.
#[tauri::command]
async fn sync_sign_out(state: State<'_, AppState>) -> Result<(), String> {
    {
        let conn = state.conn.lock().map_err(err)?;
        sync::forget_refresh(&conn).map_err(chain)?;
    }
    state.sync.clear_access().await;
    Ok(())
}

#[tauri::command]
fn forget_book(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(err)?;
    db::forget_book(&conn, id).map_err(chain)
}

// ------------------------------------------------- highlights and notes

/// The longest highlight kept. A selection longer than this is almost
/// always an accident (a slip that selected a chapter), and the excerpt is
/// only there to recognise the highlight in the Notes list.
const MAX_EXCERPT_CHARS: usize = 2000;

fn tidy_note(note: Option<String>) -> Option<String> {
    note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty())
}

#[tauri::command]
fn list_annotations(state: State<'_, AppState>, book_id: i64) -> Result<Vec<db::Annotation>, String> {
    let conn = state.conn.lock().map_err(err)?;
    db::list_annotations(&conn, book_id).map_err(chain)
}

#[tauri::command]
fn add_annotation(
    state: State<'_, AppState>,
    book_id: i64,
    cfi: String,
    excerpt: String,
    note: Option<String>,
    color: String,
) -> Result<db::Annotation, String> {
    if cfi.trim().is_empty() {
        return Err("nothing was selected".into());
    }
    let excerpt: String = excerpt.split_whitespace().collect::<Vec<_>>().join(" ");
    if excerpt.chars().count() > MAX_EXCERPT_CHARS {
        return Err("That selection is too long to highlight; select a shorter passage.".into());
    }
    let conn = state.conn.lock().map_err(err)?;
    db::add_annotation(&conn, book_id, &cfi, &excerpt, tidy_note(note).as_deref(), &color)
        .map_err(chain)
}

#[tauri::command]
fn update_annotation(
    state: State<'_, AppState>,
    id: i64,
    note: Option<String>,
    color: String,
) -> Result<db::Annotation, String> {
    let conn = state.conn.lock().map_err(err)?;
    db::update_annotation(&conn, id, tidy_note(note).as_deref(), &color).map_err(chain)
}

#[tauri::command]
fn delete_annotation(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(err)?;
    db::delete_annotation(&conn, id).map_err(chain)
}

// --------------------------------------------------------- AO3 sign-in

#[derive(Serialize)]
pub struct Ao3Status {
    /// The username, if one has been saved. Never the password.
    pub username: Option<String>,
    /// Whether a password is held in the system keyring for that username.
    pub has_saved_password: bool,
    /// Whether this run of the app currently has a live session.
    pub logged_in: bool,
    /// False on phones, where there is no system keyring to keep it in and
    /// sign-in lasts until the app is closed.
    pub can_save_password: bool,
}

fn saved_username(conn: &rusqlite::Connection) -> Option<String> {
    db::get_setting(conn, "ao3_username").ok().flatten()
}

/// Sign in, if a credential is saved and we have not already done so.
///
/// Called before anything that might need an account. Failing to sign in is
/// never fatal here: public works still download, so the caller carries on and
/// the restricted ones report their own clear error.
async fn ensure_session(state: &AppState) -> Option<String> {
    if state.ao3.is_logged_in().await {
        return None;
    }
    let username = {
        let conn = state.conn.lock().ok()?;
        saved_username(&conn)?
    };
    let password = match creds::load(&username) {
        Ok(Some(p)) => p,
        Ok(None) => return None,
        Err(e) => return Some(format!("Could not read the saved password: {e}")),
    };
    // After two refusals in a row, stop signing in by itself: AO3 locks an
    // account after repeated failures, and a saved password that stopped
    // working (changed on the website, say) would keep failing every time.
    if login_failures(state) >= AUTO_SIGN_IN_LIMIT {
        return Some(
            "Automatic sign-in is paused after two failed attempts. Check your password under \
             Settings → Your AO3 account."
                .into(),
        );
    }
    match state.ao3.login(&username, &password).await {
        Ok(()) => {
            set_login_failures(state, 0);
            None
        }
        Err(e) => {
            let msg = chain(e);
            if msg.starts_with(LOGIN_REJECTED) {
                set_login_failures(state, login_failures(state) + 1);
            }
            Some(format!("Could not sign in to AO3: {msg}"))
        }
    }
}

/// How AO3's refusal of a username or password begins (see ao3::login).
const LOGIN_REJECTED: &str = "AO3 did not accept";
/// Refusals in a row after which automatic sign-in stops.
const AUTO_SIGN_IN_LIMIT: i64 = 2;
/// Refusals in a row after which even signing in by hand waits a while.
const MANUAL_SIGN_IN_LIMIT: i64 = 4;
const MANUAL_SIGN_IN_WAIT: i64 = 15 * 60;

fn login_failures(state: &AppState) -> i64 {
    state
        .conn
        .lock()
        .ok()
        .and_then(|c| db::get_setting(&c, "ao3_login_failures").ok().flatten())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

fn set_login_failures(state: &AppState, n: i64) {
    if let Ok(c) = state.conn.lock() {
        db::set_setting(&c, "ao3_login_failures", &n.to_string()).ok();
        if n > 0 {
            db::set_setting(&c, "ao3_login_failed_at", &db::now().to_string()).ok();
        }
    }
}

#[tauri::command]
async fn ao3_sign_in(
    state: State<'_, AppState>,
    username: String,
    password: String,
) -> Result<Ao3Status, String> {
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("Both the username and the password are needed.".into());
    }

    // Several refusals in a row: wait before trying again, so a run of
    // typos cannot get the account locked by AO3.
    let failures = login_failures(&state);
    if failures >= MANUAL_SIGN_IN_LIMIT {
        let last: i64 = {
            let conn = state.conn.lock().map_err(err)?;
            db::get_setting(&conn, "ao3_login_failed_at")
                .map_err(chain)?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
        };
        let left = last + MANUAL_SIGN_IN_WAIT - db::now();
        if left > 0 {
            return Err(format!(
                "AO3 has refused the last {failures} sign-ins. To keep the account from being \
                 locked, FicShelf waits {} before trying again. If you have forgotten the \
                 password, reset it on the AO3 website.",
                cooldown::describe(left)
            ));
        }
    }

    // Try the credentials before storing them, so a typo is never saved.
    if let Err(e) = state.ao3.login(&username, &password).await {
        let msg = chain(e);
        if msg.starts_with(LOGIN_REJECTED) {
            set_login_failures(&state, failures + 1);
            let left = AUTO_SIGN_IN_LIMIT.max(MANUAL_SIGN_IN_LIMIT) - (failures + 1);
            if left > 0 && failures + 1 >= AUTO_SIGN_IN_LIMIT {
                return Err(format!("{msg} ({left} more tries before FicShelf waits 15 minutes.)"));
            }
        }
        return Err(msg);
    }
    set_login_failures(&state, 0);

    if creds::SUPPORTED {
        creds::store(&username, &password).map_err(chain)?;
    }
    {
        let conn = state.conn.lock().map_err(err)?;
        db::set_setting(&conn, "ao3_username", &username).map_err(chain)?;
    }
    Ok(Ao3Status {
        username: Some(username),
        has_saved_password: creds::SUPPORTED,
        logged_in: true,
        can_save_password: creds::SUPPORTED,
    })
}

#[tauri::command]
async fn ao3_sign_out(state: State<'_, AppState>) -> Result<Ao3Status, String> {
    let username = {
        let conn = state.conn.lock().map_err(err)?;
        saved_username(&conn)
    };
    if let Some(u) = &username {
        creds::forget(u).map_err(chain)?;
    }
    {
        let conn = state.conn.lock().map_err(err)?;
        db::set_setting(&conn, "ao3_username", "").map_err(chain)?;
    }
    state.ao3.logout().await;
    Ok(Ao3Status {
        username: None,
        has_saved_password: false,
        logged_in: false,
        can_save_password: creds::SUPPORTED,
    })
}

#[tauri::command]
async fn ao3_status(state: State<'_, AppState>) -> Result<Ao3Status, String> {
    let username = {
        let conn = state.conn.lock().map_err(err)?;
        saved_username(&conn).filter(|u| !u.is_empty())
    };
    let has_saved_password = match &username {
        Some(u) => creds::load(u).unwrap_or(None).is_some(),
        None => false,
    };
    Ok(Ao3Status {
        username,
        has_saved_password,
        logged_in: state.ao3.is_logged_in().await,
        can_save_password: creds::SUPPORTED,
    })
}

// ------------------------------------------------------------------- AO3

#[tauri::command]
async fn ao3_search(
    state: State<'_, AppState>,
    query: String,
    page: u32,
) -> Result<Vec<ao3::SearchHit>, String> {
    state.ao3.search(&query, page).await.map_err(chain)
}

#[tauri::command]
async fn ao3_browse_tag(
    state: State<'_, AppState>,
    tag: String,
    page: u32,
) -> Result<Vec<ao3::SearchHit>, String> {
    state.ao3.browse_tag(&tag, page).await.map_err(chain)
}

#[derive(Serialize)]
pub struct ShelfEntry {
    #[serde(flatten)]
    pub hit: ao3::SearchHit,
    /// The library's copy, if this work has already been saved.
    pub book_id: Option<i64>,
    pub has_update: bool,
}

#[derive(Serialize)]
pub struct ShelfPageOut {
    pub page: u32,
    pub entries: Vec<ShelfEntry>,
    pub skipped: usize,
    pub has_more: bool,
}

/// One page of the user's AO3 Bookmarks (`shelf = "bookmarks"`) or Marked
/// for Later (`shelf = "later"`), each marked with whether it is already in
/// the library.
///
/// Listing only. Saving goes through `ao3_save_work`, one work at a time, and
/// the front end runs those from a visible queue the user starts by hand.
/// There is deliberately no command that saves a whole shelf.
#[tauri::command]
async fn ao3_shelf(
    state: State<'_, AppState>,
    shelf: String,
    page: u32,
) -> Result<ShelfPageOut, String> {
    let which = ao3_parse::Shelf::from_name(&shelf)
        .ok_or_else(|| format!("unknown list {shelf:?}"))?;
    if let Some(problem) = ensure_session(&state).await {
        return Err(problem);
    }
    let page = page.max(1);
    let listed = state.ao3.shelf(which, page).await.map_err(chain)?;

    let conn = state.conn.lock().map_err(err)?;
    let mut entries = Vec::with_capacity(listed.hits.len());
    for hit in listed.hits {
        let book = db::book_by_work_id(&conn, hit.work_id).map_err(chain)?;
        entries.push(ShelfEntry {
            book_id: book.as_ref().map(|b| b.id),
            has_update: book.as_ref().map(|b| b.has_update).unwrap_or(false),
            hit,
        });
    }
    Ok(ShelfPageOut {
        page,
        entries,
        skipped: listed.skipped,
        has_more: listed.has_more,
    })
}

/// Download a work's EPUB into the library folder and add it to the library.
#[tauri::command]
async fn ao3_save_work(state: State<'_, AppState>, work_id: i64) -> Result<db::Book, String> {
    // Sign in first if a credential is saved, so works restricted to
    // registered users are reachable.
    ensure_session(&state).await;

    // The hourly limit is checked before anything is asked of AO3.
    if let Some(wait) = state.ao3.save_wait() {
        return Err(format!(
            "FicShelf has saved {} works in the last hour, its limit to stay friendly with AO3. \
             Saving is paused for {}; searching and reading still work.",
            cooldown::SAVES_PER_HOUR,
            cooldown::describe(wait)
        ));
    }

    // Network first, lock afterwards.
    let meta = state.ao3.work_meta(work_id, true).await.map_err(chain)?;
    let mut bytes = state.ao3.download_epub(&meta).await.map_err(chain)?;
    state.ao3.record_save();
    // A podfic's player is not in AO3's download; add its audio back as a
    // page at the end. Failing that, the work is still saved as AO3 sent it.
    if !meta.audio.is_empty() {
        match archive::add_podfic_page(&bytes, &meta.audio) {
            Ok(with_audio) => bytes = with_audio,
            Err(e) => eprintln!("could not add the podfic page to work {work_id}: {e:#}"),
        }
    }

    let dir = { state.library_dir.lock().map_err(err)?.clone() };
    std::fs::create_dir_all(&dir).map_err(err)?;

    let author = meta.authors.first().cloned().unwrap_or_default();
    let base = if author.is_empty() {
        meta.title.clone()
    } else {
        format!("{} - {}", meta.title, author)
    };
    let stem = util::safe_filename(&base, &format!("work-{work_id}"));

    // Keep the work id in the name so a re-download overwrites rather than
    // accumulating copies, and two works with the same title stay distinct.
    let path = dir.join(format!("{stem} [{work_id}].epub"));
    // Written beside it, then swapped in whole: a re-save that is cut short
    // never leaves a half-written book in place of the old copy.
    let part = dir.join(format!(".{work_id}.epub.part"));
    std::fs::write(&part, &bytes).map_err(err)?;
    std::fs::rename(&part, &path).map_err(|e| {
        std::fs::remove_file(&part).ok();
        err(e)
    })?;

    let path_str = path.to_string_lossy().to_string();
    let info = archive::read_epub(&path).ok();
    let cover = info.as_ref().and_then(|i| i.cover.clone());

    let conn = state.conn.lock().map_err(err)?;
    let new = db::NewBook {
        path: &path_str,
        format: "epub",
        title: &meta.title,
        author: if meta.authors.is_empty() {
            None
        } else {
            Some(author.as_str())
        },
        cover: cover.as_ref().map(|(b, m)| (b.as_slice(), m.as_str())),
        ao3_work_id: Some(work_id),
        chapters_seen: Some(meta.chapters_posted as i64),
        chapters_total: meta.chapters_total.map(|c| c as i64),
        complete: meta.complete,
        series: info.as_ref().and_then(|i| i.series.as_deref()),
        series_index: info.as_ref().and_then(|i| i.series_index),
        folder: None,
        drm: None,
    };
    let id = db::upsert_book(&conn, &new).map_err(chain)?;
    db::clear_update(&conn, id, meta.chapters_posted as i64).map_err(chain)?;
    db::get_book(&conn, id)
        .map_err(chain)?
        .ok_or_else(|| "the work vanished after saving".to_string())
}

/// Re-check saved AO3 works for new chapters. Paced by the client, so this
/// takes roughly 1.5 seconds per work by design.
#[tauri::command]
async fn ao3_check_updates(state: State<'_, AppState>, limit: i64) -> Result<UpdateReport, String> {
    let sign_in_problem = ensure_session(&state).await;

    let candidates = {
        let conn = state.conn.lock().map_err(err)?;
        db::works_to_check(&conn, limit.clamp(1, 200)).map_err(chain)?
    };

    let mut errors = Vec::new();
    if let Some(problem) = sign_in_problem {
        errors.push(problem);
    }
    let mut checked = 0usize;

    for book in &candidates {
        let Some(work_id) = book.ao3_work_id else { continue };
        // AO3 said slow down or overloaded: stop here, not one refusal per
        // remaining work. The rest are checked next time.
        if state.ao3.cooldown_left().is_some() {
            errors.push("Stopped early: AO3 asked FicShelf to slow down. The rest are checked next time.".into());
            break;
        }
        match state.ao3.work_meta(work_id, false).await {
            Ok(meta) => {
                checked += 1;
                let seen = book.chapters_seen.unwrap_or(meta.chapters_posted as i64) as u32;
                let fresh = ao3_parse::new_chapter_count(seen, meta.chapters_posted) > 0;
                // Explicit scope: the database guard is not Send, so it must
                // be dropped before the loop reaches the next await.
                {
                    let conn = state.conn.lock().map_err(err)?;
                    db::record_check(
                        &conn,
                        book.id,
                        meta.chapters_posted as i64,
                        meta.chapters_total.map(|c| c as i64),
                        meta.complete,
                        fresh,
                    )
                    .map_err(chain)?;
                }
            }
            Err(e) => errors.push(format!("{}: {}", book.title, chain(e))),
        }
    }

    let conn = state.conn.lock().map_err(err)?;
    let with_updates = db::books_with_updates(&conn).map_err(chain)?;
    Ok(UpdateReport { checked, with_updates, errors })
}

#[tauri::command]
fn list_updates(state: State<'_, AppState>) -> Result<Vec<db::Book>, String> {
    let conn = state.conn.lock().map_err(err)?;
    db::books_with_updates(&conn).map_err(chain)
}

// -------------------------------------------------------- saved searches

#[tauri::command]
fn list_searches(state: State<'_, AppState>) -> Result<Vec<db::SavedSearch>, String> {
    let conn = state.conn.lock().map_err(err)?;
    db::list_searches(&conn).map_err(chain)
}

#[tauri::command]
fn add_search(state: State<'_, AppState>, name: String, query: String) -> Result<i64, String> {
    let conn = state.conn.lock().map_err(err)?;
    db::add_search(&conn, &name, &query).map_err(chain)
}

#[tauri::command]
fn touch_search(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(err)?;
    db::touch_search(&conn, id).map_err(chain)
}

#[tauri::command]
fn delete_search(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(err)?;
    db::delete_search(&conn, id).map_err(chain)
}

// ---------------------------------------------------------------- settings

#[derive(Serialize)]
pub struct Settings {
    pub library_dir: String,
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    let dir = state.library_dir.lock().map_err(err)?.clone();
    Ok(Settings { library_dir: dir.to_string_lossy().to_string() })
}

#[tauri::command]
fn set_library_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    std::fs::create_dir_all(&p).map_err(err)?;
    {
        let conn = state.conn.lock().map_err(err)?;
        db::set_setting(&conn, "library_dir", &path).map_err(chain)?;
    }
    *state.library_dir.lock().map_err(err)? = p;
    Ok(())
}

/// On a phone, where downloads go: "app" (FicShelf's private storage),
/// "documents" or "download" (a FicShelf folder in the phone's shared
/// Documents or Download folder, visible in the Files app). Android lets an
/// app create and read back its own files there without any permission; a
/// test file is written first so a refusal shows up now, not mid-download.
#[tauri::command]
fn set_phone_storage(app: tauri::AppHandle, state: State<'_, AppState>, choice: String) -> Result<String, String> {
    const SHARED: &str = "/storage/emulated/0";
    let dir = match choice.as_str() {
        "app" => app.path().app_data_dir().map_err(err)?.join("Works"),
        "documents" => PathBuf::from(SHARED).join("Documents").join("FicShelf"),
        "download" => PathBuf::from(SHARED).join("Download").join("FicShelf"),
        _ => return Err("unknown place".into()),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("Android did not allow a folder there: {e}"))?;
    let probe = dir.join(".ficshelf-write-test");
    std::fs::write(&probe, b"ok").map_err(|e| format!("Android did not allow saving there: {e}"))?;
    std::fs::remove_file(&probe).ok();
    let path = dir.to_string_lossy().to_string();
    {
        let conn = state.conn.lock().map_err(err)?;
        db::set_setting(&conn, "library_dir", &path).map_err(chain)?;
    }
    *state.library_dir.lock().map_err(err)? = dir;
    Ok(path)
}

/// How long AO3 requests are paused for, if they are: seconds left and
/// whether AO3 said "slow down" (429) or "overloaded" (503).
#[derive(Serialize)]
struct Ao3Cooldown {
    seconds: i64,
    reason: u16,
}

/// `reason` 429 or 503 for AO3's own answers, 1 for FicShelf's hourly
/// limit on saving works.
#[tauri::command]
fn ao3_cooldown(state: State<'_, AppState>) -> Option<Ao3Cooldown> {
    state
        .ao3
        .cooldown_left()
        .map(|(seconds, reason)| Ao3Cooldown { seconds, reason })
        .or_else(|| state.ao3.save_wait().map(|seconds| Ao3Cooldown { seconds, reason: 1 }))
}

// ---------------------------------------------------------------- backup

/// Make a backup. `dest` is where to write it (from a save dialog); on a
/// phone it is left out and the backup goes to Download/FicShelf.
#[tauri::command]
async fn backup_make(
    app: tauri::AppHandle,
    with_books: bool,
    prefs: serde_json::Value,
    dest: Option<String>,
) -> Result<backup::Made, String> {
    let data_dir = app.path().app_data_dir().map_err(err)?;
    let dest = match dest.filter(|d| !d.trim().is_empty()) {
        Some(d) => PathBuf::from(d),
        None => {
            let stamp = epubgen::iso_utc(db::now()).replace(['T', ':'], " ").replace('Z', "");
            let stamp = stamp.trim().get(..16).unwrap_or(stamp.trim()).replace(' ', "_");
            PathBuf::from("/storage/emulated/0/Download/FicShelf").join(format!("FicShelf backup {stamp}.zip"))
        }
    };
    let version = app.package_info().version.to_string();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let state = handle.state::<AppState>();
        let library_dir = state.library_dir.lock().map_err(err)?.clone();
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        backup::make(&state.conn, &data_dir, &library_dir, &dest, with_books, prefs, &version, |done, total| {
            if last.elapsed() >= std::time::Duration::from_millis(250) || done == total {
                last = std::time::Instant::now();
                handle.emit("backup-progress", serde_json::json!({ "done": done, "total": total })).ok();
            }
        })
        .map_err(chain)
    })
    .await
    .map_err(err)?
}

#[derive(Serialize)]
struct AutoBackup {
    /// Unix seconds of the newest automatic backup, 0 if none yet.
    last: i64,
    /// Where automatic backups go.
    dir: String,
    /// True if one was made just now.
    made: bool,
}

const AUTO_BACKUP_EVERY: i64 = 7 * 24 * 60 * 60;
const AUTO_BACKUPS_KEPT: usize = 4;

/// The weekly automatic backup of reading data (no book files). Called when
/// the app starts; makes one only if the last is a week old. The newest four
/// are kept. On a phone they go to Download/FicShelf/Automatic backups, which
/// survives the app being reinstalled; failing that, into the app's own
/// storage.
#[tauri::command]
async fn backup_auto(app: tauri::AppHandle, prefs: serde_json::Value) -> Result<AutoBackup, String> {
    let data_dir = app.path().app_data_dir().map_err(err)?;
    let last: i64 = {
        let state = app.state::<AppState>();
        let conn = state.conn.lock().map_err(err)?;
        db::get_setting(&conn, "auto_backup_at").map_err(chain)?.and_then(|v| v.parse().ok()).unwrap_or(0)
    };
    let mut dirs = Vec::new();
    if cfg!(target_os = "android") {
        dirs.push(PathBuf::from("/storage/emulated/0/Download/FicShelf/Automatic backups"));
    }
    dirs.push(data_dir.join("Backups"));
    let usable = dirs
        .iter()
        .find(|d| std::fs::create_dir_all(d).is_ok() && std::fs::write(d.join(".ficshelf-test"), b"ok").is_ok())
        .cloned()
        .unwrap_or_else(|| data_dir.join("Backups"));
    std::fs::remove_file(usable.join(".ficshelf-test")).ok();

    if db::now() - last < AUTO_BACKUP_EVERY {
        return Ok(AutoBackup { last, dir: usable.to_string_lossy().into_owned(), made: false });
    }

    let day = epubgen::iso_utc(db::now()).get(..10).unwrap_or("backup").to_string();
    let dest = usable.join(format!("FicShelf auto {day}.zip"));
    let version = app.package_info().version.to_string();
    let handle = app.clone();
    let dir = usable.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let state = handle.state::<AppState>();
        let library_dir = state.library_dir.lock().map_err(err)?.clone();
        backup::make(&state.conn, &data_dir, &library_dir, &dest, false, prefs, &version, |_, _| {})
            .map_err(chain)?;
        // Keep the newest few.
        let mut autos: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map_err(err)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("FicShelf auto ") && n.to_string_lossy().ends_with(".zip"))
                    .unwrap_or(false)
            })
            .collect();
        autos.sort();
        while autos.len() > AUTO_BACKUPS_KEPT {
            std::fs::remove_file(autos.remove(0)).ok();
        }
        let conn = state.conn.lock().map_err(err)?;
        db::set_setting(&conn, "auto_backup_at", &db::now().to_string()).map_err(chain)?;
        Ok(())
    })
    .await
    .map_err(err)??;
    Ok(AutoBackup { last: db::now(), dir: usable.to_string_lossy().into_owned(), made: true })
}

/// Restore from a backup file (a path, or a content:// URI on a phone).
#[tauri::command]
async fn backup_restore(app: tauri::AppHandle, src: String) -> Result<backup::Restored, String> {
    use tauri_plugin_fs::FsExt;
    let data_dir = app.path().app_data_dir().map_err(err)?;
    // Copy it in first: a zip needs to be read in any order, which a
    // phone's shared file does not promise.
    let local = data_dir.join(".restore-incoming.zip");
    {
        let file_path: tauri_plugin_fs::FilePath = src.parse().map_err(err)?;
        let mut opts = tauri_plugin_fs::OpenOptions::new();
        opts.read(true);
        let mut f = app
            .fs()
            .open(file_path, opts)
            .map_err(|e| format!("could not open that file: {e}"))?;
        let mut out = std::fs::File::create(&local).map_err(err)?;
        std::io::copy(&mut f, &mut out).map_err(|e| format!("could not read that file: {e}"))?;
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        let state = handle.state::<AppState>();
        let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        backup::restore(&state.conn, &state.library_dir, &data_dir, &local, |done, total| {
            if last.elapsed() >= std::time::Duration::from_millis(250) || done == total {
                last = std::time::Instant::now();
                handle.emit("backup-progress", serde_json::json!({ "done": done, "total": total })).ok();
            }
        })
        .map_err(chain)
    })
    .await
    .map_err(err)?;
    std::fs::remove_file(app.path().app_data_dir().map_err(err)?.join(".restore-incoming.zip")).ok();
    result
}

// -------------------------------------------------------------------- run

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("library.sqlite3"))?;

            // Downloads default to a folder beside the database, which always
            // exists and needs no permission the app does not already have.
            let default_dir = data_dir.join("Works");
            let library_dir = db::get_setting(&conn, "library_dir")?
                .map(PathBuf::from)
                .unwrap_or(default_dir);
            std::fs::create_dir_all(&library_dir).ok();

            app.manage(AppState {
                conn: Mutex::new(conn),
                ao3: ao3::Ao3Client::new(Some(data_dir.join("ao3-cooldown")))?,
                sync: sync::SyncState::default(),
                library_dir: Mutex::new(library_dir),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_books,
            open_link,
            ao3_cooldown,
            backup_make,
            backup_restore,
            backup_auto,
            set_phone_storage,
            save_podfic_url,
            import_paths,
            import_bytes,
            import_uri,
            scan_folder,
            open_book,
            cbz_page,
            book_bytes,
            book_cover,
            set_cover_from_data_url,
            save_position,
            update_metadata,
            forget_book,
            open_externally,
            look_up,
            sync_status,
            sync_begin_sign_in,
            sync_finish_sign_in,
            sync_cancel_sign_in,
            sync_now,
            sync_open_page,
            sync_sign_out,
            list_annotations,
            add_annotation,
            update_annotation,
            delete_annotation,
            ao3_search,
            ao3_browse_tag,
            ao3_save_work,
            ao3_sign_in,
            ao3_sign_out,
            ao3_status,
            ao3_check_updates,
            ao3_shelf,
            list_updates,
            list_searches,
            add_search,
            touch_search,
            delete_search,
            get_settings,
            set_library_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FicShelf");
}
