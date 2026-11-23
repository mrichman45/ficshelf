//! Google Drive, for sync: signing in with a code, and reading and writing
//! one file, "ficshelf-sync.json", in the account's Drive.
//!
//! Sign-in uses Google's flow for devices without a convenient browser: the
//! app shows a short code, the user enters it at google.com/device on any
//! phone or computer and approves. It works the same on Android, Windows and
//! Linux, with nothing to redirect back into the app.
//!
//! The only permission asked for is `drive.file`: access to the files
//! FicShelf itself created, and nothing else in the user's Drive. (The
//! hidden app-data folder would be tidier, but Google does not allow its
//! scope with the device sign-in flow: "invalid_scope".)
//!
//! The OAuth client id and secret are compiled in from the environment
//! (FICSHELF_GOOGLE_CLIENT_ID / _SECRET, set as repository secrets for the
//! release builds). Google treats an installed app's secret as public; it
//! identifies the app, it does not protect anything.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::time::Duration;

pub const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const DEVICE_CODE_URL: &str = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
pub const SYNC_FILE: &str = "ficshelf-sync.json";

pub fn client() -> Option<(&'static str, &'static str)> {
    let id = option_env!("FICSHELF_GOOGLE_CLIENT_ID")?;
    let secret = option_env!("FICSHELF_GOOGLE_CLIENT_SECRET")?;
    (!id.is_empty() && !secret.is_empty()).then_some((id, secret))
}

pub fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(concat!("FicShelf/", env!("CARGO_PKG_VERSION"), " (sync)"))
        .build()
        .context("building the HTTP client")
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Step one of signing in: get the code to show the user.
pub async fn start_sign_in(http: &reqwest::Client) -> Result<DeviceCode> {
    let (id, _) = client().ok_or_else(not_configured)?;
    let resp = http
        .post(DEVICE_CODE_URL)
        .form(&[("client_id", id), ("scope", SCOPE)])
        .send()
        .await
        .context("reaching Google")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("Google refused to start sign-in ({status}): {}", short(&body)));
    }
    serde_json::from_str(&body).context("reading Google's sign-in reply")
}

#[derive(Debug, Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
}

pub enum Poll {
    /// Signed in: the refresh token to keep, and a first access token.
    Done { refresh: String, access: String, expires_in: u64 },
    /// The user has not finished yet; ask again after this long.
    Wait(u64),
}

/// Step two: ask whether the user has approved yet.
pub async fn poll_sign_in(http: &reqwest::Client, device_code: &str, interval: u64) -> Result<Poll> {
    let (id, secret) = client().ok_or_else(not_configured)?;
    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", id),
            ("client_secret", secret),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await;
    // While she approves in the browser, a phone often pauses FicShelf or
    // drops its connections. A failed check is not a failed sign-in: ask
    // again at the next interval.
    let Ok(resp) = resp else { return Ok(Poll::Wait(interval)) };
    let Ok(reply) = read_json::<TokenReply>(resp).await else { return Ok(Poll::Wait(interval)) };
    match reply.error.as_deref() {
        None => {
            let access = reply.access_token.ok_or_else(|| anyhow!("Google sent no access token"))?;
            let refresh = reply.refresh_token.ok_or_else(|| anyhow!("Google sent no refresh token"))?;
            Ok(Poll::Done { refresh, access, expires_in: reply.expires_in.unwrap_or(3600) })
        }
        Some("authorization_pending") => Ok(Poll::Wait(interval)),
        Some("slow_down") => Ok(Poll::Wait(interval + 5)),
        Some("access_denied") => Err(anyhow!("Sign-in was declined.")),
        Some("expired_token") => Err(anyhow!("The code expired before it was entered. Try again.")),
        Some(other) => Err(anyhow!("Google sign-in failed: {other}")),
    }
}

/// A fresh access token from the long-lived refresh token.
pub async fn refresh(http: &reqwest::Client, refresh_token: &str) -> Result<(String, u64)> {
    let (id, secret) = client().ok_or_else(not_configured)?;
    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", id),
            ("client_secret", secret),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .context("reaching Google")?;
    let reply: TokenReply = read_json(resp).await?;
    if let Some(err) = reply.error {
        return Err(if err == "invalid_grant" {
            anyhow!("Google has signed FicShelf out of Drive. Sign in again under Settings → Sync.")
        } else {
            anyhow!("Google refused the sync sign-in: {err}")
        });
    }
    let access = reply.access_token.ok_or_else(|| anyhow!("Google sent no access token"))?;
    Ok((access, reply.expires_in.unwrap_or(3600)))
}

#[derive(Debug, Deserialize)]
struct FileList {
    files: Vec<FileEntry>,
}

#[derive(Debug, Deserialize)]
struct FileEntry {
    id: String,
}

/// The sync file's id, if FicShelf has made it yet. With `drive.file`
/// only files FicShelf created are listed, so a file of the same name she
/// made herself is never picked up.
pub async fn find_sync_file(http: &reqwest::Client, token: &str) -> Result<Option<String>> {
    let q = format!("name = '{SYNC_FILE}' and trashed = false");
    let resp = http
        .get(FILES_URL)
        .bearer_auth(token)
        .query(&[("q", q.as_str()), ("fields", "files(id)"), ("orderBy", "modifiedTime desc"), ("pageSize", "10")])
        .send()
        .await
        .context("reaching Google Drive")?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!("Google Drive answered {status} when listing the sync file"));
    }
    let list: FileList = read_json(resp).await?;
    Ok(list.files.into_iter().next().map(|f| f.id))
}

pub async fn download(http: &reqwest::Client, token: &str, id: &str) -> Result<Vec<u8>> {
    let resp = http
        .get(format!("{FILES_URL}/{id}"))
        .bearer_auth(token)
        .query(&[("alt", "media")])
        .send()
        .await
        .context("reaching Google Drive")?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!("Google Drive answered {status} when downloading the sync file"));
    }
    Ok(resp.bytes().await.context("reading the sync file")?.to_vec())
}

/// Write the sync file: replace it if it exists, otherwise create it at the
/// top of her Drive.
pub async fn upload(http: &reqwest::Client, token: &str, existing: Option<&str>, json: &[u8]) -> Result<()> {
    let resp = if let Some(id) = existing {
        http.patch(format!("{UPLOAD_URL}/{id}"))
            .bearer_auth(token)
            .query(&[("uploadType", "media")])
            .header("Content-Type", "application/json")
            .body(json.to_vec())
            .send()
            .await
    } else {
        // Metadata and contents together, as Drive's "multipart/related".
        let boundary = "ficshelf-sync-boundary-7f3a";
        let meta = format!(
            r#"{{"name":"{SYNC_FILE}","description":"FicShelf's reading positions, bookmarks and notes, for syncing between devices. Deleting it is safe: FicShelf makes a new one."}}"#
        );
        let mut body = Vec::with_capacity(json.len() + 300);
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/json\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(json);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        http.post(UPLOAD_URL)
            .bearer_auth(token)
            .query(&[("uploadType", "multipart")])
            .header("Content-Type", format!("multipart/related; boundary={boundary}"))
            .body(body)
            .send()
            .await
    }
    .context("reaching Google Drive")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Google Drive answered {status} when saving the sync file: {}", short(&body)));
    }
    Ok(())
}

/// Read a JSON reply. (FicShelf's HTTP client is built without reqwest's
/// own JSON support; serde_json does the parsing.)
async fn read_json<T: serde::de::DeserializeOwned>(resp: reqwest::Response) -> Result<T> {
    let body = resp.text().await.context("reading Google's reply")?;
    serde_json::from_str(&body).with_context(|| format!("Google's reply was not understood: {}", short(&body)))
}

fn not_configured() -> anyhow::Error {
    anyhow!("Sync is not set up in this build of FicShelf (no Google client id).")
}

fn short(s: &str) -> String {
    s.chars().take(200).collect()
}
