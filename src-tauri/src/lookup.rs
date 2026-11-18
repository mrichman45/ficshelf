//! Looking a book up online, like Calibre's "Download metadata": Open
//! Library and Google Books, searched by title and author. Only when she
//! asks, one search on each, nothing about her library sent but the words
//! she searched for.

use anyhow::{anyhow, Result};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct Candidate {
    pub source: &'static str,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<String>,
    pub publisher: Option<String>,
    pub cover_url: Option<String>,
    pub description: Option<String>,
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!(
            "FicShelf/",
            env!("CARGO_PKG_VERSION"),
            " (book details lookup; https://github.com/mrichman45/ficshelf)"
        ))
        .timeout(std::time::Duration::from_secs(20))
        .build()?)
}

async fn get_json(c: &reqwest::Client, url: &str) -> Result<serde_json::Value> {
    let resp = c.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("{} answered {}", url.split('/').nth(2).unwrap_or("the site"), resp.status()));
    }
    Ok(serde_json::from_str(&resp.text().await?)?)
}

fn enc(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s.trim(), percent_encoding::NON_ALPHANUMERIC).to_string()
}

fn https(url: &str) -> String {
    url.strip_prefix("http://").map(|r| format!("https://{r}")).unwrap_or_else(|| url.to_string())
}

async fn open_library(c: &reqwest::Client, title: &str, author: &str) -> Result<Vec<Candidate>> {
    let mut url = format!(
        "https://openlibrary.org/search.json?limit=8&fields=title,author_name,first_publish_year,cover_i,publisher&title={}",
        enc(title)
    );
    if !author.trim().is_empty() {
        url.push_str(&format!("&author={}", enc(author)));
    }
    let v = get_json(c, &url).await?;
    Ok(v["docs"]
        .as_array()
        .map(|docs| {
            docs.iter()
                .filter_map(|d| {
                    Some(Candidate {
                        source: "Open Library",
                        title: d["title"].as_str()?.to_string(),
                        authors: d["author_name"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).take(3).collect())
                            .unwrap_or_default(),
                        year: d["first_publish_year"].as_i64().map(|y| y.to_string()),
                        publisher: d["publisher"].as_array().and_then(|p| p.first()).and_then(|p| p.as_str()).map(str::to_string),
                        cover_url: d["cover_i"].as_i64().map(|id| format!("https://covers.openlibrary.org/b/id/{id}-L.jpg")),
                        description: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

async fn google_books(c: &reqwest::Client, title: &str, author: &str) -> Result<Vec<Candidate>> {
    let mut q = format!("intitle:{}", title.trim());
    if !author.trim().is_empty() {
        q.push_str(&format!(" inauthor:{}", author.trim()));
    }
    let url = format!("https://www.googleapis.com/books/v1/volumes?maxResults=8&printType=books&q={}", enc(&q));
    let v = get_json(c, &url).await?;
    Ok(v["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|it| {
                    let i = &it["volumeInfo"];
                    let cover = i["imageLinks"]["thumbnail"]
                        .as_str()
                        .or_else(|| i["imageLinks"]["smallThumbnail"].as_str())
                        // A larger rendition of the same image.
                        .map(|u| https(u).replace("&edge=curl", "").replace("zoom=1", "zoom=2"));
                    Some(Candidate {
                        source: "Google Books",
                        title: i["title"].as_str()?.to_string(),
                        authors: i["authors"]
                            .as_array()
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).take(3).collect())
                            .unwrap_or_default(),
                        year: i["publishedDate"].as_str().map(|d| d.chars().take(4).collect()),
                        publisher: i["publisher"].as_str().map(str::to_string),
                        cover_url: cover,
                        description: i["description"].as_str().map(|d| d.chars().take(600).collect()),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Both sources, Google Books first (it usually has light novels and
/// manga volumes), then Open Library. If one fails the other still counts.
pub async fn search(title: &str, author: &str) -> Result<Vec<Candidate>> {
    if title.trim().is_empty() {
        return Err(anyhow!("type a title to look up"));
    }
    let c = client()?;
    let (g, o) = tokio::join!(google_books(&c, title, author), open_library(&c, title, author));
    let mut out = Vec::new();
    let mut errors = Vec::new();
    match g {
        Ok(v) => out.extend(v),
        Err(e) => errors.push(e.to_string()),
    }
    match o {
        Ok(v) => out.extend(v),
        Err(e) => errors.push(e.to_string()),
    }
    if out.is_empty() && !errors.is_empty() {
        return Err(anyhow!("the lookup failed: {}", errors.join("; ")));
    }
    Ok(out)
}

/// Fetch a cover image chosen from the results.
pub async fn cover(url: &str) -> Result<(Vec<u8>, String)> {
    let url = https(url.trim());
    let ok_host = ["https://covers.openlibrary.org/", "https://books.google.com/", "https://books.googleusercontent.com/"]
        .iter()
        .any(|h| url.starts_with(h));
    if !ok_host {
        return Err(anyhow!("covers are only fetched from Open Library or Google Books"));
    }
    let resp = client()?.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("the cover could not be fetched ({})", resp.status()));
    }
    let bytes = resp.bytes().await?;
    if bytes.len() > 10 * 1024 * 1024 || bytes.len() < 200 {
        return Err(anyhow!("that cover could not be used"));
    }
    let mime = if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else {
        return Err(anyhow!("that cover is not an image"));
    };
    Ok((bytes.to_vec(), mime.to_string()))
}
