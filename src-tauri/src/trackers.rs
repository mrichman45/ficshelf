//! Tracking manga and light novels on AniList and MyAnimeList: a series in
//! the library is linked to an entry there, and when she finishes volumes
//! FicShelf updates her list (volumes read, reading/completed, score).
//!
//! FicShelf is registered with each service as an app; the client IDs come
//! from the build (FICSHELF_ANILIST_CLIENT_ID, FICSHELF_MAL_CLIENT_ID).
//! Sign-in needs no website of FicShelf's own:
//! - AniList's "PIN" flow shows a token to copy back into FicShelf;
//! - MyAnimeList sends the browser to the redirect address with a code in
//!   it; she copies that address back, and FicShelf trades the code (PKCE).

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};

pub const ANILIST_ID: Option<&str> = option_env!("FICSHELF_ANILIST_CLIENT_ID");
pub const MAL_ID: Option<&str> = option_env!("FICSHELF_MAL_CLIENT_ID");
/// The redirect address registered for the MyAnimeList client.
pub const MAL_REDIRECT: &str = "https://github.com/mrichman45/ficshelf";

pub fn available(service: &str) -> bool {
    match service {
        "anilist" => ANILIST_ID.is_some_and(|s| !s.trim().is_empty()),
        "mal" => MAL_ID.is_some_and(|s| !s.trim().is_empty()),
        _ => false,
    }
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("FicShelf/", env!("CARGO_PKG_VERSION"), " (tracking)"))
        .timeout(std::time::Duration::from_secs(25))
        .build()?)
}

async fn json_of(resp: reqwest::Response) -> Result<Value> {
    let status = resp.status();
    let body = resp.text().await?;
    let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let msg = v["errors"][0]["message"]
            .as_str()
            .or_else(|| v["message"].as_str())
            .or_else(|| v["error"].as_str())
            .unwrap_or("");
        return Err(anyhow!("the service answered {status} {msg}"));
    }
    if let Some(m) = v["errors"][0]["message"].as_str() {
        return Err(anyhow!("{m}"));
    }
    Ok(v)
}

// ------------------------------------------------------------- sign-in

pub fn anilist_auth_url() -> Option<String> {
    let id = ANILIST_ID?.trim();
    Some(format!("https://anilist.co/api/v2/oauth/authorize?client_id={id}&response_type=token"))
}

/// A PKCE verifier: 64 characters from the unreserved set.
pub fn new_verifier() -> String {
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
        ^ 0x9E37_79B9_7F4A_7C15;
    const SET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    (0..64)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            SET[(seed % SET.len() as u64) as usize] as char
        })
        .collect()
}

/// MyAnimeList's sign-in page, for the "plain" PKCE method (the verifier is
/// the challenge), which is all MAL supports.
pub fn mal_auth_url(verifier: &str) -> Option<String> {
    let id = MAL_ID?.trim();
    Some(format!(
        "https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id={id}&code_challenge={verifier}&code_challenge_method=plain&redirect_uri={}",
        percent_encoding::utf8_percent_encode(MAL_REDIRECT, percent_encoding::NON_ALPHANUMERIC)
    ))
}

/// The code out of what she pasted: the whole address or the code alone.
pub fn code_from(pasted: &str) -> Option<String> {
    let p = pasted.trim();
    if let Some(i) = p.find("code=") {
        let rest = &p[i + 5..];
        let end = rest.find(['&', '#']).unwrap_or(rest.len());
        let code = &rest[..end];
        return (!code.is_empty()).then(|| code.to_string());
    }
    (!p.is_empty() && !p.contains(' ') && !p.contains('/')).then(|| p.to_string())
}

#[derive(Serialize, Clone)]
pub struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
    /// Unix seconds when the access token stops working.
    pub expires: i64,
}

pub async fn mal_exchange(code: &str, verifier: &str) -> Result<Tokens> {
    let id = MAL_ID.ok_or_else(|| anyhow!("MyAnimeList is not set up in this build"))?.trim();
    let resp = client()?
        .post("https://myanimelist.net/v1/oauth2/token")
        .form(&[
            ("client_id", id),
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", MAL_REDIRECT),
        ])
        .send()
        .await?;
    tokens_from(json_of(resp).await?)
}

pub async fn mal_refresh(refresh: &str) -> Result<Tokens> {
    let id = MAL_ID.ok_or_else(|| anyhow!("MyAnimeList is not set up in this build"))?.trim();
    let resp = client()?
        .post("https://myanimelist.net/v1/oauth2/token")
        .form(&[("client_id", id), ("grant_type", "refresh_token"), ("refresh_token", refresh)])
        .send()
        .await?;
    tokens_from(json_of(resp).await?)
}

fn tokens_from(v: Value) -> Result<Tokens> {
    Ok(Tokens {
        access: v["access_token"].as_str().ok_or_else(|| anyhow!("no access token in the answer"))?.to_string(),
        refresh: v["refresh_token"].as_str().map(str::to_string),
        expires: crate::db::now() + v["expires_in"].as_i64().unwrap_or(3600) - 60,
    })
}

/// The name of the signed-in account, to show and to check the token.
pub async fn whoami(service: &str, token: &str) -> Result<String> {
    match service {
        "anilist" => {
            let v = anilist(token, "query { Viewer { name } }", json!({})).await?;
            Ok(v["data"]["Viewer"]["name"].as_str().unwrap_or("AniList").to_string())
        }
        _ => {
            let resp = client()?.get("https://api.myanimelist.net/v2/users/@me").bearer_auth(token).send().await?;
            Ok(json_of(resp).await?["name"].as_str().unwrap_or("MyAnimeList").to_string())
        }
    }
}

// -------------------------------------------------------------- search

#[derive(Serialize, Clone)]
pub struct Media {
    pub id: i64,
    pub title: String,
    pub kind: String,
    pub volumes: Option<i64>,
    pub chapters: Option<i64>,
    pub cover: Option<String>,
    pub year: Option<i64>,
}

async fn anilist(token: &str, query: &str, vars: Value) -> Result<Value> {
    let mut r = client()?.post("https://graphql.anilist.co")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(json!({ "query": query, "variables": vars }).to_string());
    if !token.is_empty() {
        r = r.bearer_auth(token);
    }
    json_of(r.header(reqwest::header::ACCEPT, "application/json").send().await?).await
}

pub async fn search(service: &str, token: &str, q: &str) -> Result<Vec<Media>> {
    match service {
        "anilist" => {
            let v = anilist(
                token,
                "query ($s: String) { Page(perPage: 12) { media(search: $s, type: MANGA) {
                    id format volumes chapters startDate { year }
                    title { english romaji } coverImage { medium } } } }",
                json!({ "s": q }),
            )
            .await?;
            Ok(v["data"]["Page"]["media"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|m| {
                            Some(Media {
                                id: m["id"].as_i64()?,
                                title: m["title"]["english"]
                                    .as_str()
                                    .or_else(|| m["title"]["romaji"].as_str())?
                                    .to_string(),
                                kind: m["format"].as_str().unwrap_or("MANGA").replace('_', " ").to_lowercase(),
                                volumes: m["volumes"].as_i64(),
                                chapters: m["chapters"].as_i64(),
                                cover: m["coverImage"]["medium"].as_str().map(str::to_string),
                                year: m["startDate"]["year"].as_i64(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default())
        }
        _ => {
            let id = MAL_ID.unwrap_or("").trim();
            let url = format!(
                "https://api.myanimelist.net/v2/manga?limit=12&fields=num_volumes,num_chapters,media_type,start_date&q={}",
                percent_encoding::utf8_percent_encode(&q.chars().take(64).collect::<String>(), percent_encoding::NON_ALPHANUMERIC)
            );
            let mut r = client()?.get(url);
            r = if token.is_empty() { r.header("X-MAL-CLIENT-ID", id) } else { r.bearer_auth(token) };
            let v = json_of(r.send().await?).await?;
            Ok(v["data"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|d| {
                            let n = &d["node"];
                            Some(Media {
                                id: n["id"].as_i64()?,
                                title: n["title"].as_str()?.to_string(),
                                kind: n["media_type"].as_str().unwrap_or("manga").replace('_', " "),
                                volumes: n["num_volumes"].as_i64().filter(|n| *n > 0),
                                chapters: n["num_chapters"].as_i64().filter(|n| *n > 0),
                                cover: n["main_picture"]["medium"].as_str().map(str::to_string),
                                year: n["start_date"].as_str().and_then(|d| d.get(..4)).and_then(|y| y.parse().ok()),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default())
        }
    }
}

// -------------------------------------------------------------- update

/// Her progress on a series, as worked out from the library.
pub struct Progress {
    pub volumes: i64,
    pub completed: bool,
    /// 1-5 stars, averaged over the rated books, if any.
    pub stars: Option<f64>,
}

pub async fn push(service: &str, token: &str, media_id: i64, p: &Progress) -> Result<()> {
    match service {
        "anilist" => {
            let mut vars = json!({
                "id": media_id,
                "status": if p.completed { "COMPLETED" } else { "CURRENT" },
                "vols": p.volumes,
            });
            if let Some(s) = p.stars {
                vars["score"] = json!((s * 20.0).round() as i64); // out of 100
            }
            anilist(
                token,
                "mutation ($id: Int, $status: MediaListStatus, $vols: Int, $score: Int) {
                    SaveMediaListEntry(mediaId: $id, status: $status, progressVolumes: $vols, scoreRaw: $score) { id } }",
                vars,
            )
            .await?;
            Ok(())
        }
        _ => {
            let mut form = vec![
                ("status", if p.completed { "completed".to_string() } else { "reading".to_string() }),
                ("num_volumes_read", p.volumes.to_string()),
            ];
            if let Some(s) = p.stars {
                form.push(("score", ((s * 2.0).round() as i64).clamp(1, 10).to_string()));
            }
            let resp = client()?
                .patch(format!("https://api.myanimelist.net/v2/manga/{media_id}/my_list_status"))
                .bearer_auth(token)
                .form(&form)
                .send()
                .await?;
            json_of(resp).await.map(|_| ())
        }
    }
}

// ---------------------------------------------------------------- pull

/// Her entry for a title on the service: volumes read, status, score (1-5).
#[derive(Serialize, Clone, Default)]
pub struct Entry {
    pub volumes: i64,
    pub completed: bool,
    pub stars: Option<f64>,
    pub listed: bool,
}

pub async fn pull(service: &str, token: &str, media_id: i64) -> Result<Entry> {
    match service {
        "anilist" => {
            let v = anilist(
                token,
                "query ($id: Int) { Media(id: $id) { mediaListEntry { progressVolumes status score(format: POINT_100) } } }",
                json!({ "id": media_id }),
            )
            .await?;
            let e = &v["data"]["Media"]["mediaListEntry"];
            if e.is_null() {
                return Ok(Entry::default());
            }
            Ok(Entry {
                volumes: e["progressVolumes"].as_i64().unwrap_or(0),
                completed: e["status"].as_str() == Some("COMPLETED"),
                stars: e["score"].as_f64().filter(|s| *s > 0.0).map(|s| (s / 20.0).clamp(1.0, 5.0)),
                listed: true,
            })
        }
        _ => {
            let resp = client()?
                .get(format!("https://api.myanimelist.net/v2/manga/{media_id}?fields=my_list_status"))
                .bearer_auth(token)
                .send()
                .await?;
            let v = json_of(resp).await?;
            let e = &v["my_list_status"];
            if e.is_null() {
                return Ok(Entry::default());
            }
            Ok(Entry {
                volumes: e["num_volumes_read"].as_i64().unwrap_or(0),
                completed: e["status"].as_str() == Some("completed"),
                stars: e["score"].as_f64().filter(|s| *s > 0.0).map(|s| (s / 2.0).clamp(1.0, 5.0)),
                listed: true,
            })
        }
    }
}

// ------------------------------------------------------- recommendations

#[derive(Serialize, Clone)]
pub struct Suggestion {
    pub title: String,
    pub cover: Option<String>,
    pub url: String,
    pub kind: Option<String>,
    pub year: Option<i64>,
}

pub async fn recommendations(service: &str, token: &str, media_id: i64) -> Result<Vec<Suggestion>> {
    match service {
        "anilist" => {
            let v = anilist(
                token,
                "query ($id: Int) { Media(id: $id) { recommendations(sort: RATING_DESC, perPage: 15) { nodes {
                    mediaRecommendation { id siteUrl format startDate { year } title { english romaji } coverImage { medium } } } } } }",
                json!({ "id": media_id }),
            )
            .await?;
            Ok(v["data"]["Media"]["recommendations"]["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|n| {
                    let m = &n["mediaRecommendation"];
                    Some(Suggestion {
                        title: m["title"]["english"].as_str().or_else(|| m["title"]["romaji"].as_str())?.to_string(),
                        cover: m["coverImage"]["medium"].as_str().map(str::to_string),
                        url: m["siteUrl"].as_str().map(str::to_string).unwrap_or_else(|| format!("https://anilist.co/manga/{}", m["id"])),
                        kind: m["format"].as_str().map(|f| f.replace('_', " ").to_lowercase()),
                        year: m["startDate"]["year"].as_i64(),
                    })
                })
                .collect())
        }
        _ => {
            let mut r = client()?.get(format!("https://api.myanimelist.net/v2/manga/{media_id}?fields=recommendations"));
            r = if token.is_empty() { r.header("X-MAL-CLIENT-ID", MAL_ID.unwrap_or("").trim()) } else { r.bearer_auth(token) };
            let v = json_of(r.send().await?).await?;
            Ok(v["recommendations"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|d| {
                    let n = &d["node"];
                    let id = n["id"].as_i64()?;
                    Some(Suggestion {
                        title: n["title"].as_str()?.to_string(),
                        cover: n["main_picture"]["medium"].as_str().map(str::to_string),
                        url: format!("https://myanimelist.net/manga/{id}"),
                        kind: None,
                        year: None,
                    })
                })
                .take(15)
                .collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_from_pasted_addresses() {
        assert_eq!(code_from("https://github.com/mrichman45/ficshelf?code=abc123&state=x").as_deref(), Some("abc123"));
        assert_eq!(code_from("  def456 ").as_deref(), Some("def456"));
        assert_eq!(code_from("https://github.com/mrichman45/ficshelf"), None);
        assert_eq!(new_verifier().len(), 64);
    }
}
