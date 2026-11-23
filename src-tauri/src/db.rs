//! The library database: one SQLite file holding what we know about each
//! book, saved searches and settings.
//!
//! Book files themselves are never copied into the database. We store their
//! path and a small cover thumbnail, nothing more, so the library stays tiny
//! and the user's files stay where they put them.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Book {
    pub id: i64,
    pub path: String,
    pub format: String,
    pub title: String,
    pub author: Option<String>,
    pub has_cover: bool,
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
    pub position: Option<String>,
    pub ao3_work_id: Option<i64>,
    pub chapters_seen: Option<i64>,
    pub chapters_total: Option<i64>,
    pub complete: bool,
    pub last_checked_at: Option<i64>,
    pub has_update: bool,
    pub missing: bool,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    /// The name of the folder the book was added from, used to group books
    /// that carry no series of their own.
    pub folder: Option<String>,
    /// True once the user has edited the details by hand; re-importing the
    /// file then leaves title, author and series alone.
    pub edited: bool,
    /// The DRM a locked book carries ("Adobe DRM"), or None. Locked books
    /// stay in the library but are opened in another app.
    pub drm: Option<String>,
    /// Her tags, in the order she gave them.
    pub tags: Vec<String>,
    /// 1 to 5 stars, or none.
    pub rating: Option<u8>,
    /// "unread", "reading" or "finished"; none means not set by hand.
    pub status: Option<String>,
}

/// A highlight in a book, with an optional note. `cfi` is the EPUB location
/// of the highlighted range; `excerpt` is the highlighted text, kept so the
/// Notes list can show it without opening the book.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub id: i64,
    pub book_id: i64,
    pub cfi: String,
    pub excerpt: String,
    pub note: Option<String>,
    pub color: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSearch {
    pub id: i64,
    pub name: String,
    pub query: String,
    pub created_at: i64,
    pub last_run_at: Option<i64>,
}

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating library folder {}", dir.display()))?;
    }
    let conn = Connection::open(path)
        .with_context(|| format!("opening library database {}", path.display()))?;

    // WAL keeps the UI responsive while a download writes, and the busy
    // timeout stops a concurrent update check from erroring out.
    // journal_mode answers with a row, which plain pragma_update treats as
    // an error; the checked form reads it, so WAL is actually switched on.
    conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))
        .ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON").ok();

    migrate(&conn)?;
    add_columns(&conn)?;
    Ok(conn)
}

/// Columns added after the first release. SQLite has no ADD COLUMN IF NOT
/// EXISTS, so each is added only when the table lacks it.
fn add_columns(conn: &Connection) -> Result<()> {
    add_columns_to(conn, "books", &[
        ("series", "TEXT"),
        ("series_index", "REAL"),
        ("folder", "TEXT"),
        ("edited", "INTEGER NOT NULL DEFAULT 0"),
        ("drm", "TEXT"),
        // For sync: which book this is on every device, and when its
        // position and hand-edited details last changed.
        ("content_key", "TEXT"),
        ("position_at", "INTEGER"),
        ("edited_at", "INTEGER"),
        // Her own marks: tags (one per line), 1-5 stars, read status
        // ("unread", "reading", "finished"), and when they last changed.
        ("tags", "TEXT"),
        ("rating", "INTEGER"),
        ("status", "TEXT"),
        ("marks_at", "INTEGER"),
    ])?;
    add_columns_to(conn, "annotations", &[("uid", "TEXT"), ("updated_at", "INTEGER")])?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_tombstones (
            uid TEXT PRIMARY KEY,
            at  INTEGER NOT NULL
        );
        -- Folders added in place, checked for new books.
        CREATE TABLE IF NOT EXISTS watched_folders (
            path     TEXT PRIMARY KEY,
            added_at INTEGER NOT NULL
        );
        -- Time spent reading, for History and Statistics. The title is kept
        -- so a removed book still reads sensibly in the history.
        CREATE TABLE IF NOT EXISTS reading_sessions (
            id         INTEGER PRIMARY KEY,
            book_id    INTEGER NOT NULL,
            title      TEXT NOT NULL,
            format     TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            ended_at   INTEGER NOT NULL,
            seconds    INTEGER NOT NULL,
            pages      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS reading_sessions_when ON reading_sessions(ended_at);
        -- Files a folder check could not add, skipped until they change.
        CREATE TABLE IF NOT EXISTS scan_skips (
            path TEXT PRIMARY KEY,
            size INTEGER NOT NULL
        );",
    )?;
    Ok(())
}

/// Point a book at a converted copy of its file.
pub fn set_path_format(conn: &Connection, id: i64, path: &str, format: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET path = ?2, format = ?3, content_key = NULL WHERE id = ?1",
        params![id, path, format],
    )?;
    Ok(())
}

/// Add reading time to a book. A stretch that follows on within five
/// minutes of the last one for the same book extends it, so a sitting with
/// a few interruptions stays one entry in the history.
pub fn record_session(conn: &Connection, book_id: i64, started: i64, ended: i64, seconds: i64, pages: i64) -> Result<()> {
    if seconds <= 0 && pages <= 0 {
        return Ok(());
    }
    let (title, format): (String, String) = conn
        .query_row("SELECT title, format FROM books WHERE id = ?1", params![book_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .unwrap_or_else(|| ("Removed book".into(), String::new()));
    let last: Option<(i64, i64)> = conn
        .query_row(
            "SELECT id, ended_at FROM reading_sessions WHERE book_id = ?1 ORDER BY ended_at DESC LIMIT 1",
            params![book_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match last {
        Some((id, end)) if started - end <= 5 * 60 => {
            conn.execute(
                "UPDATE reading_sessions SET ended_at = MAX(ended_at, ?2), seconds = seconds + ?3, pages = pages + ?4, title = ?5 WHERE id = ?1",
                params![id, ended, seconds.max(0), pages.max(0), title],
            )?;
        }
        _ => {
            conn.execute(
                "INSERT INTO reading_sessions(book_id, title, format, started_at, ended_at, seconds, pages) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![book_id, title, format, started, ended, seconds.max(0), pages.max(0)],
            )?;
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct HistoryEntry {
    pub id: i64,
    pub book_id: i64,
    pub title: String,
    pub format: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub seconds: i64,
    pub pages: i64,
    /// Still in the library.
    pub present: bool,
}

pub fn history(conn: &Connection, limit: i64) -> Result<Vec<HistoryEntry>> {
    let mut st = conn.prepare(
        "SELECT s.id, s.book_id, COALESCE(b.title, s.title), COALESCE(b.format, s.format), s.started_at, s.ended_at,
                s.seconds, s.pages, b.id IS NOT NULL
         FROM reading_sessions s LEFT JOIN books b ON b.id = s.book_id
         ORDER BY s.ended_at DESC LIMIT ?1",
    )?;
    let rows = st.query_map(params![limit], |r| {
        Ok(HistoryEntry {
            id: r.get(0)?,
            book_id: r.get(1)?,
            title: r.get(2)?,
            format: r.get(3)?,
            started_at: r.get(4)?,
            ended_at: r.get(5)?,
            seconds: r.get(6)?,
            pages: r.get(7)?,
            present: r.get::<_, i64>(8)? != 0,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn forget_history(conn: &Connection, entry: Option<i64>) -> Result<()> {
    match entry {
        Some(id) => conn.execute("DELETE FROM reading_sessions WHERE id = ?1", params![id])?,
        None => conn.execute("DELETE FROM reading_sessions", [])?,
    };
    Ok(())
}

/// Every session as (ended_at, seconds, pages, book_id, title), for the
/// statistics, which are worked out in the front end in local time.
pub fn all_sessions(conn: &Connection) -> Result<Vec<(i64, i64, i64, i64, String)>> {
    let mut st = conn.prepare(
        "SELECT s.ended_at, s.seconds, s.pages, s.book_id, COALESCE(b.title, s.title)
         FROM reading_sessions s LEFT JOIN books b ON b.id = s.book_id ORDER BY s.ended_at",
    )?;
    let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// When each finished book was marked finished, for the statistics.
pub fn finished_at(conn: &Connection) -> Result<Vec<i64>> {
    let mut st = conn.prepare("SELECT COALESCE(marks_at, last_opened_at, 0) FROM books WHERE status = 'finished'")?;
    let rows = st.query_map([], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn watch_folder(conn: &Connection, path: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO watched_folders(path, added_at) VALUES(?1, ?2) ON CONFLICT(path) DO NOTHING",
        params![path, now()],
    )?;
    Ok(())
}

pub fn unwatch_folder(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("DELETE FROM watched_folders WHERE path = ?1", params![path])?;
    Ok(())
}

pub fn watched_folders(conn: &Connection) -> Result<Vec<String>> {
    let mut st = conn.prepare("SELECT path FROM watched_folders ORDER BY path")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Every book's path, for telling new files from known ones.
pub fn book_paths(conn: &Connection) -> Result<std::collections::HashSet<String>> {
    let mut st = conn.prepare("SELECT path FROM books")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Files skipped by folder checks, with the size they had when they failed.
pub fn scan_skips(conn: &Connection) -> Result<std::collections::HashMap<String, i64>> {
    let mut st = conn.prepare("SELECT path, size FROM scan_skips")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn set_scan_skip(conn: &Connection, path: &str, size: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO scan_skips(path, size) VALUES(?1, ?2) ON CONFLICT(path) DO UPDATE SET size = excluded.size",
        params![path, size],
    )?;
    Ok(())
}

fn add_columns_to(conn: &Connection, table: &str, cols: &[(&str, &str)]) -> Result<()> {
    let existing: Vec<String> = conn
        .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, decl) in cols {
        if !existing.iter().any(|c| c == name) {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {decl};"))?;
        }
    }
    Ok(())
}


fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS books (
            id              INTEGER PRIMARY KEY,
            path            TEXT NOT NULL UNIQUE,
            format          TEXT NOT NULL,
            title           TEXT NOT NULL,
            author          TEXT,
            cover           BLOB,
            cover_mime      TEXT,
            added_at        INTEGER NOT NULL,
            last_opened_at  INTEGER,
            position        TEXT,
            ao3_work_id     INTEGER,
            chapters_seen   INTEGER,
            chapters_total  INTEGER,
            complete        INTEGER NOT NULL DEFAULT 0,
            last_checked_at INTEGER,
            has_update      INTEGER NOT NULL DEFAULT 0
        );

        CREATE UNIQUE INDEX IF NOT EXISTS books_ao3 ON books(ao3_work_id)
            WHERE ao3_work_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS searches (
            id          INTEGER PRIMARY KEY,
            name        TEXT NOT NULL,
            query       TEXT NOT NULL,
            created_at  INTEGER NOT NULL,
            last_run_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS annotations (
            id          INTEGER PRIMARY KEY,
            book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
            cfi         TEXT NOT NULL,
            excerpt     TEXT NOT NULL,
            note        TEXT,
            color       TEXT NOT NULL DEFAULT 'yellow',
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS annotations_book ON annotations(book_id);

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// --------------------------------------------------------------- settings

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let v = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    Ok(v)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// ------------------------------------------------------------------ books

pub struct NewBook<'a> {
    pub path: &'a str,
    pub format: &'a str,
    pub title: &'a str,
    pub author: Option<&'a str>,
    pub cover: Option<(&'a [u8], &'a str)>,
    pub ao3_work_id: Option<i64>,
    pub chapters_seen: Option<i64>,
    pub chapters_total: Option<i64>,
    pub complete: bool,
    pub series: Option<&'a str>,
    pub series_index: Option<f64>,
    pub folder: Option<&'a str>,
    pub drm: Option<&'a str>,
}

/// Insert a book, or update the existing row if this path is already known.
/// Returns the book id.
pub fn upsert_book(conn: &Connection, b: &NewBook<'_>) -> Result<i64> {
    let (cover_bytes, cover_mime) = match b.cover {
        Some((bytes, mime)) => (Some(bytes), Some(mime)),
        None => (None, None),
    };

    // A book the user has edited keeps their title, author and series when
    // its file is imported again or re-downloaded from AO3.
    conn.execute(
        "INSERT INTO books(path, format, title, author, cover, cover_mime, added_at,
                           ao3_work_id, chapters_seen, chapters_total, complete, last_checked_at,
                           series, series_index, folder, drm)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(path) DO UPDATE SET
            title          = CASE WHEN books.edited THEN books.title ELSE excluded.title END,
            author         = CASE WHEN books.edited THEN books.author ELSE excluded.author END,
            series         = CASE WHEN books.edited THEN books.series
                                  ELSE COALESCE(excluded.series, books.series) END,
            series_index   = CASE WHEN books.edited THEN books.series_index
                                  ELSE COALESCE(excluded.series_index, books.series_index) END,
            folder         = COALESCE(excluded.folder, books.folder),
            drm            = excluded.drm,
            cover          = COALESCE(excluded.cover, books.cover),
            cover_mime     = COALESCE(excluded.cover_mime, books.cover_mime),
            ao3_work_id    = COALESCE(excluded.ao3_work_id, books.ao3_work_id),
            chapters_seen  = COALESCE(excluded.chapters_seen, books.chapters_seen),
            chapters_total = excluded.chapters_total,
            complete       = excluded.complete,
            last_checked_at= COALESCE(excluded.last_checked_at, books.last_checked_at),
            has_update     = 0",
        params![
            b.path,
            b.format,
            b.title,
            b.author,
            cover_bytes,
            cover_mime,
            now(),
            b.ao3_work_id,
            b.chapters_seen,
            b.chapters_total,
            b.complete as i32,
            b.ao3_work_id.map(|_| now()),
            b.series,
            b.series_index,
            b.folder,
            b.drm,
        ],
    )?;

    let id = conn.query_row(
        "SELECT id FROM books WHERE path = ?1",
        params![b.path],
        |r| r.get(0),
    )?;
    Ok(id)
}

const BOOK_COLUMNS: &str = "id, path, format, title, author, cover IS NOT NULL,
     added_at, last_opened_at, position, ao3_work_id, chapters_seen,
     chapters_total, complete, last_checked_at, has_update,
     series, series_index, folder, edited, drm, tags, rating, status";

fn row_to_book(r: &rusqlite::Row<'_>) -> rusqlite::Result<Book> {
    let path: String = r.get(1)?;
    let missing = !Path::new(&path).exists();
    Ok(Book {
        id: r.get(0)?,
        path,
        format: r.get(2)?,
        title: r.get(3)?,
        author: r.get(4)?,
        has_cover: r.get::<_, i64>(5)? != 0,
        added_at: r.get(6)?,
        last_opened_at: r.get(7)?,
        position: r.get(8)?,
        ao3_work_id: r.get(9)?,
        chapters_seen: r.get(10)?,
        chapters_total: r.get(11)?,
        complete: r.get::<_, i64>(12)? != 0,
        last_checked_at: r.get(13)?,
        has_update: r.get::<_, i64>(14)? != 0,
        missing,
        series: r.get(15)?,
        series_index: r.get(16)?,
        folder: r.get(17)?,
        edited: r.get::<_, i64>(18)? != 0,
        drm: r.get(19)?,
        tags: split_tags(r.get::<_, Option<String>>(20)?.as_deref()),
        rating: r.get::<_, Option<i64>>(21)?.and_then(|n| u8::try_from(n).ok()).filter(|n| (1..=5).contains(n)),
        status: r.get(22)?,
    })
}

/// Tags are kept one per line.
pub fn split_tags(s: Option<&str>) -> Vec<String> {
    s.unwrap_or("").lines().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).collect()
}

/// Tidy a list of tags: trimmed, no blanks, no repeats (ignoring case),
/// first spelling kept.
pub fn tidy_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().trim_start_matches('#').trim();
        if t.is_empty() || t.len() > 80 {
            continue;
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    out
}

const STATUSES: &[&str] = &["unread", "reading", "finished"];

/// Set her marks on a book. `at` is when (now, or another device's time).
pub fn set_marks(
    conn: &Connection,
    id: i64,
    tags: &[String],
    rating: Option<u8>,
    status: Option<&str>,
    at: i64,
) -> Result<()> {
    let tags = tidy_tags(tags).join("\n");
    let rating = rating.filter(|n| (1..=5).contains(n));
    let status = status.filter(|s| STATUSES.contains(s));
    conn.execute(
        "UPDATE books SET tags = ?2, rating = ?3, status = ?4, marks_at = ?5 WHERE id = ?1",
        params![id, if tags.is_empty() { None } else { Some(tags) }, rating, status, at],
    )?;
    Ok(())
}

/// Every tag in the library with how many books carry it, most used first.
pub fn all_tags(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut st = conn.prepare("SELECT tags FROM books WHERE tags IS NOT NULL")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    let mut counts: Vec<(String, i64)> = Vec::new();
    for r in rows {
        for t in split_tags(Some(&r?)) {
            match counts.iter_mut().find(|(n, _)| n.eq_ignore_ascii_case(&t)) {
                Some(c) => c.1 += 1,
                None => counts.push((t, 1)),
            }
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    Ok(counts)
}

pub fn list_books(conn: &Connection, sort: &str) -> Result<Vec<Book>> {
    // The sort key comes from a fixed set, never from user text, so it can be
    // interpolated safely.
    let order = match sort {
        "title" => "LOWER(title) ASC",
        "author" => "LOWER(COALESCE(author, '')) ASC, LOWER(title) ASC",
        "recent" => "COALESCE(last_opened_at, 0) DESC, added_at DESC",
        _ => "added_at DESC",
    };
    let sql = format!("SELECT {BOOK_COLUMNS} FROM books ORDER BY {order}");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_book)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn get_book(conn: &Connection, id: i64) -> Result<Option<Book>> {
    let sql = format!("SELECT {BOOK_COLUMNS} FROM books WHERE id = ?1");
    let b = conn.query_row(&sql, params![id], row_to_book).optional()?;
    Ok(b)
}

pub fn book_by_work_id(conn: &Connection, work_id: i64) -> Result<Option<Book>> {
    let sql = format!("SELECT {BOOK_COLUMNS} FROM books WHERE ao3_work_id = ?1");
    let b = conn.query_row(&sql, params![work_id], row_to_book).optional()?;
    Ok(b)
}

pub fn cover_bytes(conn: &Connection, id: i64) -> Result<Option<(Vec<u8>, String)>> {
    let row = conn
        .query_row(
            "SELECT cover, COALESCE(cover_mime, 'image/jpeg') FROM books WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, Option<Vec<u8>>>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(bytes, mime)| bytes.map(|b| (b, mime))))
}

pub fn set_cover(conn: &Connection, id: i64, bytes: &[u8], mime: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET cover = ?2, cover_mime = ?3 WHERE id = ?1",
        params![id, bytes, mime],
    )?;
    Ok(())
}

pub fn save_position(conn: &Connection, id: i64, position: &str) -> Result<()> {
    conn.execute(
        "UPDATE books SET position = ?2, last_opened_at = ?3, position_at = ?3 WHERE id = ?1",
        params![id, position, now()],
    )?;
    Ok(())
}

/// The user's own edit of a book's details. Marks the book as edited, so a
/// later re-import or re-download does not undo it.
pub fn update_metadata(
    conn: &Connection,
    id: i64,
    title: &str,
    author: Option<&str>,
    series: Option<&str>,
    series_index: Option<f64>,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET title = ?2, author = ?3, series = ?4, series_index = ?5, edited = 1,
                          edited_at = ?6
         WHERE id = ?1",
        params![id, title, author, series, series_index, now()],
    )?;
    Ok(())
}

/// Remove a book from the library, with its highlights and notes. The file
/// on disk is never touched.
pub fn forget_book(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM annotations WHERE book_id = ?1", params![id])?;
    conn.execute("DELETE FROM books WHERE id = ?1", params![id])?;
    Ok(())
}

// ------------------------------------------------------------ annotations

/// The colours a highlight may have. Anything else becomes yellow.
/// "bookmark" marks a page bookmark rather than a highlight: its `cfi` is the
/// position (an EPUB CFI, or "page:N" for comics and PDFs).
pub const COLORS: [&str; 5] = ["yellow", "green", "blue", "pink", "bookmark"];

fn row_to_annotation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Annotation> {
    Ok(Annotation {
        id: r.get(0)?,
        book_id: r.get(1)?,
        cfi: r.get(2)?,
        excerpt: r.get(3)?,
        note: r.get(4)?,
        color: r.get(5)?,
        created_at: r.get(6)?,
    })
}

const ANNOTATION_COLUMNS: &str = "id, book_id, cfi, excerpt, note, color, created_at";

pub fn list_annotations(conn: &Connection, book_id: i64) -> Result<Vec<Annotation>> {
    let sql = format!(
        "SELECT {ANNOTATION_COLUMNS} FROM annotations WHERE book_id = ?1 ORDER BY created_at, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![book_id], row_to_annotation)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn add_annotation(
    conn: &Connection,
    book_id: i64,
    cfi: &str,
    excerpt: &str,
    note: Option<&str>,
    color: &str,
) -> Result<Annotation> {
    let color = if COLORS.contains(&color) { color } else { "yellow" };
    let t = now();
    conn.execute(
        "INSERT INTO annotations(book_id, cfi, excerpt, note, color, created_at, uid, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6)",
        params![book_id, cfi, excerpt, note, color, t, fresh_uid(conn)],
    )?;
    get_annotation(conn, conn.last_insert_rowid())
}

pub fn update_annotation(
    conn: &Connection,
    id: i64,
    note: Option<&str>,
    color: &str,
) -> Result<Annotation> {
    let color = if COLORS.contains(&color) { color } else { "yellow" };
    conn.execute(
        "UPDATE annotations SET note = ?2, color = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, note, color, now()],
    )?;
    get_annotation(conn, id)
}

/// Delete an annotation, leaving a tombstone so the deletion syncs.
pub fn delete_annotation(conn: &Connection, id: i64) -> Result<()> {
    let uid: Option<String> = conn
        .query_row("SELECT uid FROM annotations WHERE id = ?1", params![id], |r| r.get(0))
        .optional()?
        .flatten();
    if let Some(uid) = uid {
        conn.execute(
            "INSERT INTO sync_tombstones(uid, at) VALUES(?1, ?2)
             ON CONFLICT(uid) DO UPDATE SET at = excluded.at",
            params![uid, now()],
        )?;
    }
    conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
    Ok(())
}

// ------------------------------------------------------------------- sync

/// This install's id, made once. Mixed into annotation uids so two devices
/// never mint the same one.
pub fn device_id(conn: &Connection) -> Result<String> {
    if let Some(id) = get_setting(conn, "device_id")? {
        return Ok(id);
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let id = crate::syncdata::new_uid(nanos, std::process::id() as u64, "device");
    set_setting(conn, "device_id", &id)?;
    Ok(id)
}

fn fresh_uid(conn: &Connection) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let salt = device_id(conn).unwrap_or_default();
    crate::syncdata::new_uid(nanos, COUNTER.fetch_add(1, Ordering::Relaxed), &salt)
}

/// Give every annotation made before sync existed a uid.
pub fn backfill_uids(conn: &Connection) -> Result<()> {
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM annotations WHERE uid IS NULL OR uid = ''")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in ids {
        conn.execute(
            "UPDATE annotations SET uid = ?2, updated_at = COALESCE(updated_at, created_at) WHERE id = ?1",
            params![id, fresh_uid(conn)],
        )?;
    }
    Ok(())
}

/// One local book as sync sees it.
pub struct SyncRow {
    pub id: i64,
    pub path: String,
    pub title: String,
    pub author: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
    pub ao3_work_id: Option<i64>,
    pub content_key: Option<String>,
    pub position: Option<String>,
    pub position_at: Option<i64>,
    pub edited: bool,
    pub edited_at: Option<i64>,
    pub tags: Vec<String>,
    pub rating: Option<u8>,
    pub status: Option<String>,
    pub marks_at: Option<i64>,
}

pub fn sync_rows(conn: &Connection) -> Result<Vec<SyncRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, path, title, author, series, series_index, ao3_work_id, content_key,
                position, COALESCE(position_at, last_opened_at), edited, edited_at,
                tags, rating, status, marks_at
         FROM books",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SyncRow {
            id: r.get(0)?,
            path: r.get(1)?,
            title: r.get(2)?,
            author: r.get(3)?,
            series: r.get(4)?,
            series_index: r.get(5)?,
            ao3_work_id: r.get(6)?,
            content_key: r.get(7)?,
            position: r.get(8)?,
            position_at: r.get(9)?,
            edited: r.get::<_, i64>(10)? != 0,
            edited_at: r.get(11)?,
            tags: split_tags(r.get::<_, Option<String>>(12)?.as_deref()),
            rating: r.get::<_, Option<i64>>(13)?.and_then(|n| u8::try_from(n).ok()),
            status: r.get(14)?,
            marks_at: r.get(15)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn set_content_key(conn: &Connection, id: i64, key: &str) -> Result<()> {
    conn.execute("UPDATE books SET content_key = ?2 WHERE id = ?1", params![id, key])?;
    Ok(())
}

/// Annotations with their sync fields: (uid, book_id, cfi, excerpt, note,
/// color, created_at, updated_at).
pub type SyncAnnotation = (String, i64, String, String, Option<String>, String, i64, i64);

pub fn sync_annotations(conn: &Connection) -> Result<Vec<SyncAnnotation>> {
    let mut stmt = conn.prepare(
        "SELECT uid, book_id, cfi, excerpt, note, color, created_at, COALESCE(updated_at, created_at)
         FROM annotations WHERE uid IS NOT NULL AND uid != ''",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn tombstones(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare("SELECT uid, at FROM sync_tombstones")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Apply a position that came from another device.
pub fn apply_position(conn: &Connection, id: i64, position: &str, at: i64) -> Result<()> {
    conn.execute(
        "UPDATE books SET position = ?2, position_at = ?3 WHERE id = ?1",
        params![id, position, at],
    )?;
    Ok(())
}

/// Apply hand-edited details that came from another device.
pub fn apply_details(
    conn: &Connection,
    id: i64,
    d: &crate::syncdata::Details,
    at: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE books SET title = ?2, author = ?3, series = ?4, series_index = ?5,
                          edited = 1, edited_at = ?6
         WHERE id = ?1",
        params![id, d.title, d.author, d.series, d.series_index, at],
    )?;
    Ok(())
}

/// Insert or update an annotation that came from another device.
pub fn apply_annotation(
    conn: &Connection,
    book_id: i64,
    uid: &str,
    a: &crate::syncdata::AnnotationSync,
) -> Result<()> {
    let color = if COLORS.contains(&a.color.as_str()) { a.color.as_str() } else { "yellow" };
    let updated = conn.execute(
        "UPDATE annotations SET note = ?2, color = ?3, updated_at = ?4
         WHERE uid = ?1 AND COALESCE(updated_at, 0) < ?4",
        params![uid, a.note, color, a.updated_at],
    )?;
    let exists: bool = conn
        .query_row("SELECT 1 FROM annotations WHERE uid = ?1", params![uid], |_| Ok(()))
        .optional()?
        .is_some();
    if updated == 0 && !exists {
        conn.execute(
            "INSERT INTO annotations(book_id, cfi, excerpt, note, color, created_at, uid, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![book_id, a.cfi, a.excerpt, a.note, color, a.created_at, uid, a.updated_at],
        )?;
    }
    Ok(())
}

/// Remove annotations deleted elsewhere, and remember the tombstones.
pub fn apply_tombstones(conn: &Connection, dead: &std::collections::BTreeMap<String, i64>) -> Result<()> {
    for (uid, at) in dead {
        conn.execute(
            "DELETE FROM annotations WHERE uid = ?1 AND COALESCE(updated_at, created_at) <= ?2",
            params![uid, at],
        )?;
        conn.execute(
            "INSERT INTO sync_tombstones(uid, at) VALUES(?1, ?2)
             ON CONFLICT(uid) DO UPDATE SET at = MAX(at, excluded.at)",
            params![uid, at],
        )?;
    }
    Ok(())
}

fn get_annotation(conn: &Connection, id: i64) -> Result<Annotation> {
    let sql = format!("SELECT {ANNOTATION_COLUMNS} FROM annotations WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], row_to_annotation)?)
}

/// Books that came from AO3 and are not finished, oldest check first, so an
/// update run starts with whatever is most stale.
pub fn works_to_check(conn: &Connection, limit: i64) -> Result<Vec<Book>> {
    let sql = format!(
        "SELECT {BOOK_COLUMNS} FROM books
         WHERE ao3_work_id IS NOT NULL AND complete = 0
           AND COALESCE(last_checked_at, 0) <= ?2
         ORDER BY COALESCE(last_checked_at, 0) ASC
         LIMIT ?1"
    );
    // A work checked in the last few hours is not asked about again yet:
    // pressing Check twice should not mean twice the requests.
    const RECHECK_AFTER: i64 = 4 * 60 * 60;
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit, now() - RECHECK_AFTER], row_to_book)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn record_check(
    conn: &Connection,
    id: i64,
    chapters_now: i64,
    chapters_total: Option<i64>,
    complete: bool,
    has_update: bool,
) -> Result<()> {
    conn.execute(
        "UPDATE books
         SET chapters_total = ?2, complete = ?3, last_checked_at = ?4,
             has_update = CASE WHEN ?5 THEN 1 ELSE has_update END,
             chapters_seen = COALESCE(chapters_seen, ?6)
         WHERE id = ?1",
        params![
            id,
            chapters_total,
            complete as i32,
            now(),
            has_update as i32,
            chapters_now
        ],
    )?;
    Ok(())
}

/// Called after the user re-downloads a work: the new chapter count becomes
/// the baseline and the update flag clears.
pub fn clear_update(conn: &Connection, id: i64, chapters_seen: i64) -> Result<()> {
    conn.execute(
        "UPDATE books SET chapters_seen = ?2, has_update = 0, last_checked_at = ?3 WHERE id = ?1",
        params![id, chapters_seen, now()],
    )?;
    Ok(())
}

pub fn books_with_updates(conn: &Connection) -> Result<Vec<Book>> {
    let sql = format!(
        "SELECT {BOOK_COLUMNS} FROM books WHERE has_update = 1 ORDER BY LOWER(title)"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_book)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

// --------------------------------------------------------- saved searches

pub fn add_search(conn: &Connection, name: &str, query: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO searches(name, query, created_at) VALUES(?1, ?2, ?3)",
        params![name, query, now()],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_searches(conn: &Connection) -> Result<Vec<SavedSearch>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, query, created_at, last_run_at FROM searches ORDER BY LOWER(name)",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SavedSearch {
            id: r.get(0)?,
            name: r.get(1)?,
            query: r.get(2)?,
            created_at: r.get(3)?,
            last_run_at: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn touch_search(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE searches SET last_run_at = ?2 WHERE id = ?1",
        params![id, now()],
    )?;
    Ok(())
}

pub fn delete_search(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM searches WHERE id = ?1", params![id])?;
    Ok(())
}
