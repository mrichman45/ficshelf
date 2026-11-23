//! Syncing reading positions, bookmarks, highlights, notes and edited
//! details through Google Drive. See `syncdata` for what is synced and how
//! two copies merge, and `gdrive` for the Google side.
//!
//! One sync: download the shared file, merge it with this device's state,
//! apply what changed elsewhere, upload the merged file. Books that exist
//! only on other devices are carried along untouched, so nothing is lost by
//! a device that does not have them.

use crate::{db, gdrive, syncdata as sd};
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use tokio::sync::Mutex;
use tokio::time::Instant;

/// Where the long-lived Google sign-in is kept: the system keyring on
/// computers; on phones (no keyring) the app's private database.
const KEYRING_USER: &str = "__ficshelf_google_drive_sync__";
const SETTING_KEY: &str = "gdrive_refresh";

#[derive(Default)]
pub struct SyncState {
    /// A sign-in waiting for the user to enter the code.
    pub pending: std::sync::Mutex<Option<gdrive::DeviceCode>>,
    access: Mutex<Option<(String, Instant)>>,
    /// One sync at a time.
    running: Mutex<()>,
    /// Set when the app comes back to the front, to check a pending sign-in.
    pub nudge: std::sync::atomic::AtomicBool,
}

#[derive(Serialize, Default)]
pub struct Summary {
    pub positions: usize,
    pub details: usize,
    pub annotations: usize,
    pub removed: usize,
    pub books_shared: usize,
}

pub fn save_refresh(conn: &rusqlite::Connection, token: &str) -> Result<()> {
    if crate::creds::SUPPORTED {
        crate::creds::store(KEYRING_USER, token)
    } else {
        db::set_setting(conn, SETTING_KEY, token)
    }
}

pub fn load_refresh(conn: &rusqlite::Connection) -> Result<Option<String>> {
    if crate::creds::SUPPORTED {
        crate::creds::load(KEYRING_USER)
    } else {
        Ok(db::get_setting(conn, SETTING_KEY)?.filter(|t| !t.is_empty()))
    }
}

pub fn forget_refresh(conn: &rusqlite::Connection) -> Result<()> {
    if crate::creds::SUPPORTED {
        crate::creds::forget(KEYRING_USER).ok();
    }
    db::set_setting(conn, SETTING_KEY, "")
}

impl SyncState {
    pub async fn clear_access(&self) {
        *self.access.lock().await = None;
    }

    pub async fn set_access(&self, token: String, expires_in: u64) {
        let until = Instant::now() + std::time::Duration::from_secs(expires_in.saturating_sub(60));
        *self.access.lock().await = Some((token, until));
    }

    async fn access_token(&self, http: &reqwest::Client, refresh: &str) -> Result<String> {
        if let Some((t, until)) = self.access.lock().await.clone() {
            if Instant::now() < until {
                return Ok(t);
            }
        }
        let (token, expires) = gdrive::refresh(http, refresh).await?;
        self.set_access(token.clone(), expires).await;
        Ok(token)
    }
}

/// A book's key on every device: its AO3 work, or a fingerprint of its file.
fn key_for(row: &db::SyncRow) -> Option<String> {
    if let Some(w) = row.ao3_work_id {
        return Some(format!("ao3:{w}"));
    }
    row.content_key.clone()
}

/// Fingerprint a file from its first 4 MiB and its size.
fn fingerprint_file(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let mut head = Vec::with_capacity(4 * 1024 * 1024);
    f.by_ref().take(4 * 1024 * 1024).read_to_end(&mut head).ok()?;
    Some(sd::fingerprint(&head, size))
}

/// Run one sync. `conn` is locked only for the moments it is needed, never
/// across a network request.
pub async fn run(
    sync: &SyncState,
    conn: &std::sync::Mutex<rusqlite::Connection>,
) -> Result<Summary> {
    let _one = sync.running.lock().await;
    let lock = || conn.lock().map_err(|_| anyhow!("the library database is busy"));

    let refresh = { load_refresh(&*lock()?)? }
        .ok_or_else(|| anyhow!("Not signed in to Google Drive. Sign in under Settings → Sync."))?;
    let http = gdrive::http()?;
    let token = sync.access_token(&http, &refresh).await?;

    // Books added before sync existed get their fingerprint now (reading
    // files, so outside the lock).
    let needing: Vec<(i64, String)> = {
        let c = lock()?;
        db::backfill_uids(&c)?;
        db::sync_rows(&c)?
            .into_iter()
            .filter(|r| r.ao3_work_id.is_none() && r.content_key.is_none())
            .map(|r| (r.id, r.path))
            .collect()
    };
    let keys: Vec<(i64, String)> = needing
        .into_iter()
        .filter_map(|(id, path)| fingerprint_file(Path::new(&path)).map(|k| (id, k)))
        .collect();

    // This device's state.
    let (local, rows) = {
        let c = lock()?;
        for (id, k) in &keys {
            db::set_content_key(&c, *id, k)?;
        }
        let rows = db::sync_rows(&c)?;
        let anns = db::sync_annotations(&c)?;
        let mut file = sd::SyncFile { version: sd::VERSION, ..Default::default() };
        let mut key_of: BTreeMap<i64, String> = BTreeMap::new();
        for r in &rows {
            let Some(key) = key_for(r) else { continue };
            key_of.insert(r.id, key.clone());
            file.books.insert(
                key,
                sd::BookSync {
                    title: r.title.clone(),
                    position: r.position.clone().map(|value| sd::Stamped { value, at: r.position_at.unwrap_or(0) }),
                    details: r.edited.then(|| sd::Stamped {
                        value: sd::Details {
                            title: r.title.clone(),
                            author: r.author.clone(),
                            series: r.series.clone(),
                            series_index: r.series_index,
                        },
                        at: r.edited_at.unwrap_or(0),
                    }),
                    marks: r.marks_at.map(|at| sd::Stamped {
                        value: sd::Marks { tags: r.tags.clone(), rating: r.rating, status: r.status.clone() },
                        at,
                    }),
                    annotations: BTreeMap::new(),
                },
            );
        }
        for (uid, book_id, cfi, excerpt, note, color, created_at, updated_at) in anns {
            let Some(key) = key_of.get(&book_id) else { continue };
            if let Some(b) = file.books.get_mut(key) {
                b.annotations.insert(uid, sd::AnnotationSync { cfi, excerpt, note, color, created_at, updated_at });
            }
        }
        for (uid, at) in db::tombstones(&c)? {
            file.tombstones.insert(uid, at);
        }
        (file, rows)
    };

    // The shared copy.
    let existing = gdrive::find_sync_file(&http, &token).await?;
    let remote = match &existing {
        Some(id) => {
            let bytes = gdrive::download(&http, &token, id).await?;
            // A file that will not parse is not overwritten: better to stop
            // than to replace someone's data with this device's alone.
            serde_json::from_slice::<sd::SyncFile>(&bytes)
                .context("the sync file in Google Drive could not be read; it was left as it is")?
        }
        None => sd::SyncFile::default(),
    };

    let merged = sd::merge(&local, &remote);

    // Apply what changed elsewhere.
    let mut summary = Summary { books_shared: merged.books.len(), ..Default::default() };
    {
        let c = lock()?;
        let before = db::sync_annotations(&c)?.len();
        for r in &rows {
            let Some(key) = key_for(r) else { continue };
            let Some(m) = merged.books.get(&key) else { continue };
            if let Some(p) = &m.position {
                if p.at > r.position_at.unwrap_or(0) && r.position.as_deref() != Some(p.value.as_str()) {
                    db::apply_position(&c, r.id, &p.value, p.at)?;
                    summary.positions += 1;
                }
            }
            if let Some(d) = &m.details {
                if d.at > r.edited_at.unwrap_or(0) {
                    db::apply_details(&c, r.id, &d.value, d.at)?;
                    summary.details += 1;
                }
            }
            if let Some(mk) = &m.marks {
                if mk.at > r.marks_at.unwrap_or(0) {
                    db::set_marks(&c, r.id, &mk.value.tags, mk.value.rating, mk.value.status.as_deref(), mk.at)?;
                    summary.details += 1;
                }
            }
            for (uid, a) in &m.annotations {
                db::apply_annotation(&c, r.id, uid, a)?;
            }
        }
        db::apply_tombstones(&c, &merged.tombstones)?;
        let after = db::sync_annotations(&c)?.len();
        summary.annotations = after.saturating_sub(before);
        summary.removed = before.saturating_sub(after);
        db::set_setting(&c, "last_sync_at", &db::now().to_string())?;
    }

    let json = serde_json::to_vec(&merged).context("writing the sync file")?;
    gdrive::upload(&http, &token, existing.as_deref(), &json).await?;
    Ok(summary)
}
