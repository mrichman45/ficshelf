//! A small, deliberately slow Archive of Our Own client.
//!
//! Design rules, which matter more here than cleverness does:
//!
//! * One request at a time, with a minimum gap between them. AO3 is a charity
//!   running on donated hardware and it rate-limits scrapers; this client is
//!   meant to look like a person reading, because that is what it is doing.
//! * Works are fetched through AO3's own Download link, the same one a reader
//!   would click. We never assemble a book out of scraped chapter HTML.
//! * Nothing is cached or re-served. Downloaded files go to the user's own
//!   folder and no further.
//! * The user agent says what this is and who it is for, so AO3 can identify
//!   and block it specifically if they ever want to.

use crate::ao3_parse as p;
use anyhow::{anyhow, Context, Result};
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, MutexGuard};
use tokio::time::Instant;

const USER_AGENT: &str = concat!(
    "FicShelf/",
    env!("CARGO_PKG_VERSION"),
    " (personal offline reading library; one user, rate limited)"
);

/// Minimum gap between requests, measured from the end of one to the start
/// of the next. Deliberately generous.
const MIN_GAP: Duration = Duration::from_millis(1500);
const TIMEOUT: Duration = Duration::from_secs(45);

/// Refuse anything implausibly large for a fanwork, so a redirect to something
/// unexpected cannot fill the disk.
const MAX_DOWNLOAD_BYTES: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub work_id: i64,
    pub title: String,
    pub authors: Vec<String>,
    pub fandoms: Vec<String>,
    pub summary: Option<String>,
    pub words: Option<u64>,
    pub chapters_posted: Option<u32>,
    pub chapters_total: Option<u32>,
    pub complete: bool,
    pub updated: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkMeta {
    pub work_id: i64,
    pub title: String,
    pub authors: Vec<String>,
    pub chapters_posted: u32,
    pub chapters_total: Option<u32>,
    pub complete: bool,
    pub words: Option<u64>,
    pub summary: Option<String>,
    /// The EPUB link taken from the work's own Download menu, when present.
    pub download_url: Option<String>,
    /// The HTML link from the same menu, the fallback when EPUB downloads
    /// are unavailable.
    pub html_download_url: Option<String>,
    /// Podfic audio on the work's page: embedded players' files and direct
    /// links to audio files. AO3's downloads leave embedded players out.
    pub audio: Vec<String>,
    /// Tagged or titled as a podfic.
    pub podfic: bool,
}

/// One page of the user's Bookmarks or Marked for Later list.
#[derive(Debug, Clone, Serialize)]
pub struct ShelfPage {
    pub hits: Vec<SearchHit>,
    /// Bookmarks of series, external works and deleted works have no work to
    /// download, so they are counted rather than listed.
    pub skipped: usize,
    pub has_more: bool,
}

/// Exclusive use of the connection to AO3. While one of these exists no
/// other request can start; when it is dropped the time is recorded, so the
/// next request waits `MIN_GAP` from the moment this one *finished*. A slow
/// download therefore can never overlap the request after it.
struct Slot<'a> {
    last: MutexGuard<'a, Option<Instant>>,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.last = Some(Instant::now());
    }
}

fn build_http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(TIMEOUT)
        .cookie_store(true)
        .gzip(true)
        // One connection is plenty and keeps our footprint obvious.
        .pool_max_idle_per_host(1)
        // Phones cut idle connections while the app is in the background;
        // reusing one gives "connection abort". Let idle ones go quickly.
        .pool_idle_timeout(Duration::from_secs(20))
        .build()
        .context("building the HTTP client")
}

#[derive(Clone)]
pub struct Ao3Client {
    /// Replaced wholesale on sign-out: the cookie jar inside it holds the
    /// session, and a fresh client is the only way to empty it.
    http: Arc<std::sync::RwLock<reqwest::Client>>,
    last_request: Arc<Mutex<Option<Instant>>>,
    /// Whether this process has a logged-in session. The session itself lives
    /// in the cookie jar inside `http` and is never written to disk.
    logged_in: Arc<Mutex<bool>>,
    /// The account name AO3 greeted us with, for `/users/<name>/...` pages.
    account: Arc<Mutex<Option<String>>>,
    /// Backing off after AO3 says "slow down" or "overloaded"; kept in a
    /// file so closing the app does not skip the wait.
    cooldown: Arc<std::sync::Mutex<crate::cooldown::Cooldown>>,
    cooldown_file: Arc<Option<std::path::PathBuf>>,
    /// Works saved in the last hour, for the hourly limit; kept on disk too.
    budget: Arc<std::sync::Mutex<crate::cooldown::Budget>>,
}

impl Ao3Client {
    pub fn new(cooldown_file: Option<std::path::PathBuf>) -> Result<Self> {
        let cooldown = cooldown_file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .map(|line| crate::cooldown::Cooldown::from_line(&line))
            .unwrap_or_default();
        let budget = cooldown_file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f.with_extension("saves")).ok())
            .map(|line| crate::cooldown::Budget::from_line(&line))
            .unwrap_or_default();
        Ok(Self {
            budget: Arc::new(std::sync::Mutex::new(budget)),
            http: Arc::new(std::sync::RwLock::new(build_http()?)),
            last_request: Arc::new(Mutex::new(None)),
            logged_in: Arc::new(Mutex::new(false)),
            account: Arc::new(Mutex::new(None)),
            cooldown: Arc::new(std::sync::Mutex::new(cooldown)),
            cooldown_file: Arc::new(cooldown_file),
        })
    }

    /// Seconds left in a cooldown and what caused it (429 or 503), if any.
    pub fn cooldown_left(&self) -> Option<(i64, u16)> {
        let c = self.cooldown.lock().unwrap_or_else(|p| p.into_inner());
        c.remaining(crate::db::now()).map(|s| (s, c.reason))
    }

    /// Seconds until another work may be saved, if the hourly limit is
    /// reached.
    pub fn save_wait(&self) -> Option<i64> {
        self.budget.lock().unwrap_or_else(|p| p.into_inner()).wait(crate::db::now())
    }

    /// Count a saved work against the hourly limit.
    pub fn record_save(&self) {
        let mut b = self.budget.lock().unwrap_or_else(|p| p.into_inner());
        b.record(crate::db::now());
        if let Some(f) = self.cooldown_file.as_ref() {
            std::fs::write(f.with_extension("saves"), b.to_line()).ok();
        }
    }

    /// The message for a request refused because of a cooldown, or None.
    fn cooling(&self) -> Option<String> {
        let (left, reason) = self.cooldown_left()?;
        let wait = crate::cooldown::describe(left);
        Some(if reason == 503 {
            format!("AO3 is overloaded, so FicShelf is giving it {wait} before asking again.")
        } else {
            format!("AO3 asked FicShelf to slow down, so AO3 requests are paused for {wait}.")
        })
    }

    /// Note AO3's answer; a 429 or 503 starts a cooldown. Returns the
    /// message to show if it did.
    fn note(&self, resp: &reqwest::Response) -> Option<String> {
        let status = resp.status().as_u16();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(crate::cooldown::parse_retry_after);
        let started = {
            let mut c = self.cooldown.lock().unwrap_or_else(|p| p.into_inner());
            let started = c.answered(crate::db::now(), status, retry_after);
            if started {
                if let Some(f) = self.cooldown_file.as_ref() {
                    std::fs::write(f, c.to_line()).ok();
                }
            }
            started
        };
        if started { self.cooling() } else { None }
    }

    /// A handle to the current client. `reqwest::Client` is a cheap,
    /// reference-counted handle, so this never copies the cookie jar.
    fn http(&self) -> reqwest::Client {
        match self.http.read() {
            Ok(c) => c.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    pub async fn is_logged_in(&self) -> bool {
        *self.logged_in.lock().await
    }

    /// The signed-in account's name, if there is a session.
    pub async fn account(&self) -> Option<String> {
        if !self.is_logged_in().await {
            return None;
        }
        self.account.lock().await.clone()
    }

    /// Sign in to AO3 with the user's own account.
    ///
    /// The password is used for exactly one request and is not stored here;
    /// what persists is the session cookie, in memory only, for as long as the
    /// app is running. On the next start the app logs in again from the
    /// credential stored in the operating system's keyring.
    pub async fn login(&self, username: &str, password: &str) -> Result<()> {
        // Rails requires the anti-forgery token from the login page itself,
        // and the session cookie issued alongside it.
        let page = self.get_text(&p::login_url()).await?;
        let token = p::parse_csrf_token(&page).ok_or_else(|| {
            anyhow!("could not find AO3's login token; their login page may have changed")
        })?;

        let (status, body) = {
            let _slot = self.slot().await;
            if let Some(m) = self.cooling() {
                return Err(anyhow!(m));
            }
            let resp = self
                .http()
                .post(p::login_url())
                .form(&[
                    ("authenticity_token", token.as_str()),
                    ("user[login]", username),
                    ("user[password]", password),
                    ("user[remember_me]", "1"),
                    ("commit", "Log In"),
                ])
                .send()
                .await
                .context("sending the login request")?;
            if let Some(m) = self.note(&resp) {
                return Err(anyhow!(m));
            }
            let status = resp.status();
            (status, resp.text().await.unwrap_or_default())
        };

        // AO3 answers a bad login with the form again plus an error message,
        // at the same status code as success, so the body is what tells us.
        let lower = body.to_ascii_lowercase();
        let failed = lower.contains("the password or user name you entered doesn't match")
            || lower.contains("please try again")
            || (lower.contains("user[password]") && lower.contains("<form"));

        if failed {
            *self.logged_in.lock().await = false;
            *self.account.lock().await = None;
            return Err(anyhow!(
                "AO3 did not accept that username or password. Note that AO3 wants the \
                 username you log in with, which is not always the name shown on your works."
            ));
        }

        // The page after a successful login greets the account by name. If
        // that ever stops being findable, a plain username still works for
        // the Bookmarks pages; an email address does not.
        let account = p::parse_greeting_user(&body)
            .or_else(|| (!username.contains('@')).then(|| username.to_string()));
        *self.account.lock().await = account;

        *self.logged_in.lock().await = true;
        Ok(())
    }

    /// Forget the session entirely, cookie included, so nothing after this
    /// reaches AO3 as the signed-in user.
    pub async fn logout(&self) {
        // Wait for any request in flight to finish before swapping clients.
        let _slot = self.slot().await;
        *self.logged_in.lock().await = false;
        *self.account.lock().await = None;
        if let Ok(fresh) = build_http() {
            match self.http.write() {
                Ok(mut c) => *c = fresh,
                Err(poisoned) => *poisoned.into_inner() = fresh,
            }
        }
    }

    /// Wait for our turn, then for the minimum gap since the previous request
    /// finished. The returned slot must be held until the response body has
    /// been read in full. Holding the lock across both the sleep and the
    /// request is intentional: it serialises every request this process
    /// makes, which is the whole point.
    async fn slot(&self) -> Slot<'_> {
        let last = self.last_request.lock().await;
        if let Some(prev) = *last {
            let elapsed = prev.elapsed();
            if elapsed < MIN_GAP {
                tokio::time::sleep(MIN_GAP - elapsed).await;
            }
        }
        Slot { last }
    }

    /// A GET that survives the phone having cut the connection: if it fails
    /// before AO3 has answered anything (a dropped or aborted connection, so
    /// nothing reached AO3), it is tried once more after the usual gap. Any
    /// answer from AO3, 429 included, is never retried. Called with the
    /// pacing slot held, so the retry is paced too.
    async fn get_once_more(&self, url: &str) -> reqwest::Result<reqwest::Response> {
        match self.http().get(url).send().await {
            Ok(r) => Ok(r),
            Err(e) if e.is_connect() || (e.is_request() && !e.is_timeout()) => {
                tokio::time::sleep(MIN_GAP).await;
                self.http().get(url).send().await
            }
            Err(e) => Err(e),
        }
    }

    async fn get_text(&self, url: &str) -> Result<String> {
        if let Some(m) = self.cooling() {
            return Err(anyhow!(m));
        }
        let _slot = self.slot().await;
        // Another request may have started a cooldown while this one waited.
        if let Some(m) = self.cooling() {
            return Err(anyhow!(m));
        }
        let resp = self
            .get_once_more(url)
            .await
            .with_context(|| format!("requesting {url}"))?;

        if let Some(m) = self.note(&resp) {
            return Err(anyhow!(m));
        }
        let status = resp.status();
        if status.as_u16() == 404 {
            return Err(anyhow!("That work does not exist, or has been deleted."));
        }
        if !status.is_success() {
            return Err(anyhow!("AO3 returned {status} for {url}"));
        }
        Ok(resp.text().await.context("reading the response body")?)
    }

    pub async fn search(&self, query: &str, page: u32) -> Result<Vec<SearchHit>> {
        let url = p::search_url(query, page.max(1));
        let html = self.get_text(&url).await?;
        Ok(parse_search_results(&html))
    }

    pub async fn browse_tag(&self, tag: &str, page: u32) -> Result<Vec<SearchHit>> {
        let url = p::tag_works_url(tag, page.max(1));
        let html = self.get_text(&url).await?;
        Ok(parse_search_results(&html))
    }

    /// A work's details from its first page. With `all_audio`, a
    /// multi-chapter podfic also has its whole-work page read for every
    /// chapter's audio; that is only wanted when saving, never for update
    /// checks.
    pub async fn work_meta(&self, work_id: i64, all_audio: bool) -> Result<WorkMeta> {
        let url = p::work_meta_url(work_id as u64);
        let html = self.get_text(&url).await?;

        if let Some(mut meta) = parse_work_page(&html, work_id) {
            // A multi-chapter podfic usually has audio in every chapter, and
            // this page is only the first. One more paced request for the
            // whole work collects the rest. If it fails, chapter one's audio
            // is still kept.
            if all_audio && meta.chapters_posted > 1 && (meta.podfic || !meta.audio.is_empty()) {
                match self.get_text(&p::work_full_url(work_id as u64)).await {
                    Ok(full) => {
                        let all = page_audio(&Html::parse_document(&full));
                        let mut merged = all;
                        for u in std::mem::take(&mut meta.audio) {
                            if !merged.contains(&u) {
                                merged.push(u);
                            }
                        }
                        meta.audio = merged;
                    }
                    Err(e) => eprintln!("could not read all chapters of work {work_id} for podfic audio: {e:#}"),
                }
            }
            return Ok(meta);
        }

        // Distinguish "we are not allowed to see this" from "we could not
        // understand the page", because the fixes are completely different.
        if p::looks_like_login_wall(&html) {
            let signed_in = *self.logged_in.lock().await;
            Err(anyhow!(
                "Work {work_id} is restricted to registered users. {}",
                if signed_in {
                    "You are signed in, so the author may have limited it further."
                } else {
                    "Sign in under Settings and try again."
                }
            ))
        } else {
            Err(anyhow!(
                "Could not read work {work_id}; AO3's page layout may have changed."
            ))
        }
    }

    /// Fetch the EPUB AO3 generates for a work.
    ///
    /// Prefers the link from the work's own Download menu and falls back to
    /// the conventional URL, so a layout change costs us a nicety rather than
    /// the feature.
    pub async fn download_epub(&self, meta: &WorkMeta) -> Result<Vec<u8>> {
        // The link from the work's own Download menu is preferred. The
        // fallback carries view_adult so an Explicit work does not come back
        // as the interstitial page instead of the file.
        let url = meta.download_url.clone().unwrap_or_else(|| {
            format!(
                "{}?view_adult=true",
                p::download_url(meta.work_id as u64, &meta.title)
            )
        });

        match self.fetch_download(&url, meta.work_id).await {
            Ok(bytes) => Ok(bytes),
            // 429 means slow down; answering it with another request would be
            // exactly wrong.
            Err(DownloadError::SlowDown(m)) => Err(anyhow!(m)),
            // Anything else: AO3 may have EPUB downloads switched off (it did
            // after its November 2026 outage). Its own HTML download of the
            // same work is the fallback, packaged into an EPUB here. Still
            // AO3's Download link, still one paced request.
            Err(DownloadError::Failed(epub_err)) => {
                let html_url = meta.html_download_url.clone().unwrap_or_else(|| {
                    format!(
                        "{}?view_adult=true",
                        p::html_download_url(meta.work_id as u64, &meta.title)
                    )
                });
                match self.fetch_download(&html_url, meta.work_id).await {
                    Ok(html) => epub_from_ao3_html(&String::from_utf8_lossy(&html), meta)
                        .context("packaging AO3's HTML download as an EPUB"),
                    Err(DownloadError::SlowDown(m)) => Err(anyhow!(m)),
                    Err(DownloadError::Failed(html_err)) => Err(anyhow!(
                        "AO3 would not provide this work for download ({epub_err}; HTML: {html_err})"
                    )),
                }
            }
        }
    }

    /// One paced download request, size-limited.
    async fn fetch_download(&self, url: &str, work_id: i64) -> std::result::Result<Vec<u8>, DownloadError> {
        if let Some(m) = self.cooling() {
            return Err(DownloadError::SlowDown(m));
        }
        let _slot = self.slot().await;
        if let Some(m) = self.cooling() {
            return Err(DownloadError::SlowDown(m));
        }
        let resp = self
            .get_once_more(url)
            .await
            .map_err(|e| DownloadError::Failed(format!("could not reach AO3: {e}")))?;

        // 429 and 503 start a cooldown, and are not answered with the HTML
        // fallback: another request to a server that just said "slow down"
        // or "overloaded" would be exactly wrong.
        if let Some(m) = self.note(&resp) {
            return Err(DownloadError::SlowDown(m));
        }
        let status = resp.status();
        if !status.is_success() {
            return Err(DownloadError::Failed(format!(
                "AO3 returned {status} when downloading work {work_id}"
            )));
        }
        if let Some(len) = resp.content_length() {
            if len as usize > MAX_DOWNLOAD_BYTES {
                return Err(DownloadError::Failed(format!(
                    "that download is implausibly large ({len} bytes)"
                )));
            }
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| DownloadError::Failed(format!("reading the download: {e}")))?;
        if bytes.len() > MAX_DOWNLOAD_BYTES {
            return Err(DownloadError::Failed("that download is implausibly large".into()));
        }
        Ok(bytes.to_vec())
    }

    /// One page of the signed-in user's Bookmarks or Marked for Later.
    ///
    /// This lists; it never downloads. Each page is one ordinary, paced
    /// request, and the caller asks for pages one at a time as the user
    /// scrolls, rather than walking the whole list up front.
    pub async fn shelf(&self, shelf: p::Shelf, page: u32) -> Result<ShelfPage> {
        let Some(user) = self.account().await else {
            return Err(anyhow!(
                "Sign in under Settings to see your bookmarks and Marked for Later."
            ));
        };
        let url = p::shelf_url(&user, shelf, page);
        let html = self.get_text(&url).await?;

        if p::looks_like_login_wall(&html) {
            // The session has lapsed on AO3's side; let the next attempt sign
            // in again from the keyring.
            *self.logged_in.lock().await = false;
            return Err(anyhow!("AO3 has signed us out. Try again to sign back in."));
        }
        Ok(parse_shelf_page(&html))
    }
}

// ------------------------------------------------------------------ parsing
//
// Selectors are kept together here because they are the part most likely to
// need adjusting when AO3 changes its markup. Each one degrades to None or an
// empty list rather than failing the whole parse.

fn sel(s: &str) -> Selector {
    // These are all literals written here; a bad one is a bug we want loudly.
    Selector::parse(s).expect("invalid CSS selector")
}

fn text_of(el: scraper::ElementRef<'_>) -> String {
    el.text().collect::<String>().trim().to_string()
}

fn parse_search_results(html: &str) -> Vec<SearchHit> {
    let doc = Html::parse_document(html);
    // Search results and Marked for Later use `li.work.blurb` (the latter
    // also has `reading`); Bookmarks use `li.bookmark.blurb`.
    let blurb = sel("li.work.blurb, li.bookmark.blurb");
    let heading_links = sel("h4.heading a");
    let fandom_links = sel("h5.fandoms a.tag");
    let summary_sel = sel("blockquote.summary");
    let tag_sel = sel("ul.tags li a.tag");
    let chapters_sel = sel("dl.stats dd.chapters");
    let words_sel = sel("dl.stats dd.words");
    let date_sel = sel("p.datetime");

    let mut out = Vec::new();

    for work in doc.select(&blurb) {
        let mut links = work.select(&heading_links);
        let Some(title_link) = links.next() else { continue };
        let href = title_link.value().attr("href").unwrap_or_default();
        let Some(work_id) = p::parse_work_id(href) else { continue };

        let title = text_of(title_link);
        let authors: Vec<String> = links
            .filter(|a| {
                a.value()
                    .attr("rel")
                    .map(|r| r.contains("author"))
                    .unwrap_or(true)
            })
            .map(text_of)
            .filter(|s| !s.is_empty())
            .collect();

        let (chapters_posted, chapters_total) = work
            .select(&chapters_sel)
            .next()
            .map(|e| text_of(e))
            .and_then(|t| p::parse_chapters(&t))
            .map(|(a, b)| (Some(a), b))
            .unwrap_or((None, None));

        out.push(SearchHit {
            work_id: work_id as i64,
            title,
            authors,
            fandoms: work.select(&fandom_links).map(text_of).collect(),
            summary: work
                .select(&summary_sel)
                .next()
                .map(text_of)
                .filter(|s| !s.is_empty()),
            words: work
                .select(&words_sel)
                .next()
                .map(|e| text_of(e))
                .and_then(|t| p::parse_count(&t)),
            chapters_posted,
            chapters_total,
            complete: match (chapters_posted, chapters_total) {
                (Some(a), b) => p::is_complete(a, b),
                _ => false,
            },
            updated: work.select(&date_sel).next().map(text_of),
            tags: work.select(&tag_sel).map(text_of).take(12).collect(),
        });
    }
    out
}

fn parse_shelf_page(html: &str) -> ShelfPage {
    let hits = parse_search_results(html);
    let doc = Html::parse_document(html);
    let entries = doc
        .select(&sel("li.bookmark.blurb, li.reading.blurb, li.work.blurb"))
        .count();
    // A "Next" that is a link means there is another page; on the last page
    // AO3 renders it as a plain span.
    let has_more = doc.select(&sel("ol.pagination li.next a[href]")).next().is_some();
    ShelfPage {
        skipped: entries.saturating_sub(hits.len()),
        hits,
        has_more,
    }
}

fn parse_work_page(html: &str, work_id: i64) -> Option<WorkMeta> {
    let doc = Html::parse_document(html);

    let title = doc
        .select(&sel("h2.title.heading"))
        .next()
        .map(text_of)
        .filter(|s| !s.is_empty())?;

    let authors: Vec<String> = doc
        .select(&sel("h3.byline a[rel=\"author\"]"))
        .map(text_of)
        .filter(|s| !s.is_empty())
        .collect();

    let chapters_text = doc
        .select(&sel("dl.stats dd.chapters"))
        .next()
        .map(text_of)
        .unwrap_or_default();
    let (chapters_posted, chapters_total) =
        p::parse_chapters(&chapters_text).unwrap_or((1, None));

    let words = doc
        .select(&sel("dl.stats dd.words"))
        .next()
        .map(|e| text_of(e))
        .and_then(|t| p::parse_count(&t));

    let summary = doc
        .select(&sel("div.summary blockquote"))
        .next()
        .map(text_of)
        .filter(|s| !s.is_empty());

    // The Download menu lists several formats; we want the EPUB, and the
    // HTML as a fallback.
    let download_link = |ext: &str| {
        doc.select(&sel("li.download a, ul.download a")).find_map(|a| {
            let href = a.value().attr("href")?;
            let path = href.split(['?', '#']).next().unwrap_or(href).to_ascii_lowercase();
            path.ends_with(ext).then(|| absolute(href))
        })
    };
    let download_url = download_link(".epub");
    let html_download_url = download_link(".html");

    let audio = page_audio(&doc);
    // Tagged as a podfic, or calling itself one.
    let podfic = title.to_ascii_lowercase().contains("podfic")
        || doc
            .select(&sel("dd.freeform.tags a.tag"))
            .any(|a| text_of(a).to_ascii_lowercase().contains("podfic"));

    Some(WorkMeta {
        work_id,
        title,
        authors,
        chapters_posted,
        chapters_total,
        complete: p::is_complete(chapters_posted, chapters_total),
        words,
        summary,
        download_url,
        html_download_url,
        audio,
        podfic,
    })
}

/// Podfic audio in a work page's own content (notes and text, not AO3's
/// menus): embedded players' files and direct links to audio files.
fn page_audio(doc: &Html) -> Vec<String> {
    let scope = doc.select(&sel("#workskin")).next();
    let players = sel("audio[src], audio source[src], video[src], video source[src]");
    let links = sel("a[href]");
    let (player_els, link_els): (Vec<scraper::ElementRef>, Vec<scraper::ElementRef>) = match scope {
        Some(ws) => (ws.select(&players).collect(), ws.select(&links).collect()),
        None => (doc.select(&players).collect(), doc.select(&links).collect()),
    };
    // Players and links in page order, so chapter 1's audio comes first.
    let mut found: Vec<(String, bool)> = Vec::new();
    for el in player_els {
        if let Some(src) = el.value().attr("src") {
            found.push((absolute(src), true));
        }
    }
    for el in link_els {
        if let Some(href) = el.value().attr("href") {
            found.push((href.to_string(), false));
        }
    }
    crate::epubgen::audio_urls(found.iter().map(|(u, p)| (u.as_str(), *p)))
}

enum DownloadError {
    /// AO3 said slow down or overloaded, or a cooldown is running.
    SlowDown(String),
    Failed(String),
}

/// Package AO3's single-page HTML download as an EPUB: the page's <style>
/// and <body>, re-written as well-formed XHTML, with the work's title and
/// authors in the package. Scripts are dropped.
fn epub_from_ao3_html(html: &str, meta: &WorkMeta) -> Result<Vec<u8>> {
    use crate::epubgen as g;
    let doc = Html::parse_document(html);

    let style: String = doc
        .select(&sel("head style"))
        .map(|s| s.text().collect::<String>())
        .collect::<Vec<_>>()
        .join("\n");

    let body = doc
        .select(&sel("body"))
        .next()
        .ok_or_else(|| anyhow!("AO3's HTML download had no body"))?;
    let mut out = String::with_capacity(html.len());
    let mut chapters: Vec<(String, String)> = Vec::new();
    write_xhtml_children(body, &mut out, &mut chapters);
    if out.trim().is_empty() {
        return Err(anyhow!("AO3's HTML download was empty"));
    }

    let title = if meta.title.trim().is_empty() {
        format!("Work {}", meta.work_id)
    } else {
        meta.title.clone()
    };
    let opf = g::content_opf(
        &title,
        &meta.authors,
        &format!("urn:ao3:work:{}", meta.work_id),
        &g::iso_utc(crate::db::now()),
    );
    // AO3's single-page download heads each chapter with an <h2>; those
    // become the book's chapter list. (One heading means nothing to jump
    // between.)
    if chapters.len() < 2 {
        chapters.clear();
    }
    let nav = g::nav_xhtml(&title, &chapters);
    let text = g::text_xhtml(&title, &style, &out);
    crate::archive::write_epub(&[
        ("META-INF/container.xml", g::CONTAINER_XML.as_bytes()),
        ("OEBPS/content.opf", opf.as_bytes()),
        ("OEBPS/nav.xhtml", nav.as_bytes()),
        ("OEBPS/text.xhtml", text.as_bytes()),
    ])
}

/// Serialise an element's children as XHTML: void elements self-closed,
/// everything escaped, scripts and anything with an unwritable name left
/// out.
pub(crate) fn write_xhtml_children(el: ElementRef<'_>, out: &mut String, chapters: &mut Vec<(String, String)>) {
    use crate::epubgen as g;
    for child in el.children() {
        if let Some(t) = child.value().as_text() {
            out.push_str(&g::xml_escape(t));
            continue;
        }
        let Some(ce) = ElementRef::wrap(child) else { continue };
        let name = ce.value().name().to_ascii_lowercase();
        if name == "script" || !g::valid_xml_name(&name) {
            continue;
        }
        out.push('<');
        out.push_str(&name);
        // Every <h2> is a chapter heading, given an id to jump to.
        if name == "h2" {
            let id = ce
                .value()
                .attr("id")
                .filter(|v| g::valid_xml_name(v))
                .map(str::to_string)
                .unwrap_or_else(|| format!("ficshelf-ch{}", chapters.len() + 1));
            let label = g::heading_label(&ce.text().collect::<String>());
            out.push_str(" id=\"");
            out.push_str(&g::xml_escape(&id));
            out.push('"');
            if !label.is_empty() {
                chapters.push((id, label));
            }
        }
        for (attr, value) in ce.value().attrs() {
            let attr = attr.to_ascii_lowercase();
            // No event handlers, and nothing XML cannot express. A heading's
            // id was written above.
            if attr.starts_with("on")
                || !g::valid_xml_name(&attr)
                || attr == "xmlns"
                || (name == "h2" && attr == "id")
            {
                continue;
            }
            out.push(' ');
            out.push_str(&attr);
            out.push_str("=\"");
            out.push_str(&g::xml_escape(value));
            out.push('"');
        }
        if g::is_void(&name) {
            out.push_str("/>");
            continue;
        }
        out.push('>');
        write_xhtml_children(ce, out, chapters);
        out.push_str("</");
        out.push_str(&name);
        out.push('>');
    }
}

fn absolute(href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        href.to_string()
    } else if let Some(stripped) = href.strip_prefix('/') {
        format!("{}/{}", p::BASE, stripped)
    } else {
        format!("{}/{}", p::BASE, href)
    }
}
