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
    let existing: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('books')")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, decl) in [
        ("series", "TEXT"),
        ("series_index", "REAL"),
        ("folder", "TEXT"),
        ("edited", "INTEGER NOT NULL DEFAULT 0"),
        ("drm", "TEXT"),
    ] {
        if !existing.iter().any(|c| c == name) {
            conn.execute_batch(&format!("ALTER TABLE books ADD COLUMN {name} {decl};"))?;
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
     series, series_index, folder, edited, drm";

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
    })
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
        "UPDATE books SET position = ?2, last_opened_at = ?3 WHERE id = ?1",
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
        "UPDATE books SET title = ?2, author = ?3, series = ?4, series_index = ?5, edited = 1
         WHERE id = ?1",
        params![id, title, author, series, series_index],
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
pub const COLORS: [&str; 4] = ["yellow", "green", "blue", "pink"];

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
    conn.execute(
        "INSERT INTO annotations(book_id, cfi, excerpt, note, color, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![book_id, cfi, excerpt, note, color, now()],
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
        "UPDATE annotations SET note = ?2, color = ?3 WHERE id = ?1",
        params![id, note, color],
    )?;
    get_annotation(conn, id)
}

pub fn delete_annotation(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])?;
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
         ORDER BY COALESCE(last_checked_at, 0) ASC
         LIMIT ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit], row_to_book)?;
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
