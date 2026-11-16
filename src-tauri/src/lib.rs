//! FicShelf: a local reading library for EPUB, PDF and CBZ files, with an
//! optional Archive of Our Own fetcher.
//!
//! The database and the AO3 client are kept apart on purpose. Database work
//! is synchronous and brief; network work is asynchronous and paced. No
//! command ever holds the database lock across an await.

mod ao3;
mod ao3_parse;
mod archive;
mod creds;
mod db;
mod opf;
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
}

#[derive(Debug, Serialize)]
pub struct UpdateReport {
    pub checked: usize,
    pub with_updates: Vec<db::Book>,
    pub errors: Vec<String>,
}

// ---------------------------------------------------------------- helpers

fn format_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    match ext.as_str() {
        "epub" => Some("epub"),
        "pdf" => Some("pdf"),
        "cbz" | "zip" => Some("cbz"),
        _ => None,
    }
}

fn stem_title(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().replace('_', " ").trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Untitled".to_string())
}

/// Import one file into the library, reading whatever metadata its format
/// offers. Never copies or moves the file.
fn import_one(conn: &rusqlite::Connection, path: &Path) -> Result<db::Book> {
    let format = format_of(path)
        .ok_or_else(|| anyhow::anyhow!("{} is not an EPUB, PDF or CBZ", path.display()))?;

    if !path.exists() {
        anyhow::bail!("{} does not exist", path.display());
    }

    let path_str = path.to_string_lossy().to_string();
    let mut title = stem_title(path);
    let mut author: Option<String> = None;
    let mut cover: Option<(Vec<u8>, String)> = None;

    match format {
        "epub" => {
            if let Ok(info) = archive::read_epub(path) {
                if let Some(t) = info.title.filter(|t| !t.trim().is_empty()) {
                    title = t;
                }
                author = info.author;
                cover = info.cover;
            }
        }
        "cbz" => {
            // A comic has no metadata worth the name; the first page is the
            // cover and the file name is the title.
            cover = archive::cbz_cover(path).unwrap_or(None);
        }
        _ => {
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
        match import_one(&conn, &path) {
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
        match import_one(&conn, &file) {
            Ok(book) => report.added.push(book),
            Err(e) => report.failed.push((file.to_string_lossy().to_string(), chain(e))),
        }
    }
    Ok(report)
}

/// Largest file `import_bytes` accepts. The whole file travels through
/// memory once on its way to disk, which is fine for books and comics.
const MAX_IMPORT_BYTES: usize = 512 * 1024 * 1024;

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
        .ok_or_else(|| "that is not an EPUB, PDF or CBZ file".to_string())?;

    let stem = name
        .as_deref()
        .and_then(|n| n.rsplit_once('.').map(|(s, _)| s.to_string()))
        .unwrap_or_else(|| format!("Imported {}", db::now()));
    let stem = util::safe_filename(&stem, "Imported");

    let dir = { state.library_dir.lock().map_err(err)?.join("Imported") };
    std::fs::create_dir_all(&dir).map_err(err)?;

    // Same name and same size is taken to be the same file, so importing it
    // twice updates the entry rather than making a copy.
    let mut path = dir.join(format!("{stem}.{format}"));
    let mut n = 2;
    while path.exists()
        && std::fs::metadata(&path).map(|m| m.len()).ok() != Some(bytes.len() as u64)
    {
        path = dir.join(format!("{stem} ({n}).{format}"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(err)?;

    let conn = state.conn.lock().map_err(err)?;
    import_one(&conn, &path).map_err(chain)
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

    let pages = if book.format == "cbz" {
        archive::cbz_pages(Path::new(&book.path)).map_err(chain)?
    } else {
        Vec::new()
    };
    Ok(OpenedBook { book, pages })
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
fn book_cover(state: State<'_, AppState>, id: i64) -> Result<Option<String>, String> {
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

#[tauri::command]
fn update_metadata(
    state: State<'_, AppState>,
    id: i64,
    title: String,
    author: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(err)?;
    db::update_metadata(&conn, id, &title, author.as_deref()).map_err(chain)
}

#[tauri::command]
fn forget_book(state: State<'_, AppState>, id: i64) -> Result<(), String> {
    let conn = state.conn.lock().map_err(err)?;
    db::forget_book(&conn, id).map_err(chain)
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
    match state.ao3.login(&username, &password).await {
        Ok(()) => None,
        Err(e) => Some(format!("Could not sign in to AO3: {}", chain(e))),
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

    // Try the credentials before storing them, so a typo is never saved.
    state.ao3.login(&username, &password).await.map_err(chain)?;

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

    // Network first, lock afterwards.
    let meta = state.ao3.work_meta(work_id).await.map_err(chain)?;
    let bytes = state.ao3.download_epub(&meta).await.map_err(chain)?;

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
    std::fs::write(&path, &bytes).map_err(err)?;

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
        match state.ao3.work_meta(work_id).await {
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
                ao3: ao3::Ao3Client::new()?,
                library_dir: Mutex::new(library_dir),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_books,
            import_paths,
            import_bytes,
            scan_folder,
            open_book,
            cbz_page,
            book_cover,
            set_cover_from_data_url,
            save_position,
            update_metadata,
            forget_book,
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
