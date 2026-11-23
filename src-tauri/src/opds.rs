//! Book servers that speak OPDS: Komga, Kavita, Calibre-Web, Calibre's own
//! content server and many more. A server's catalogue is a tree of Atom
//! feeds: some entries lead to more feeds, others are books with download
//! links. FicShelf browses them and saves books into the library.

use anyhow::{anyhow, Context, Result};
use scraper::{ElementRef, Html, Selector};
use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default)]
pub struct Feed {
    pub title: String,
    pub url: String,
    pub entries: Vec<Entry>,
    pub next: Option<String>,
    pub search: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Entry {
    pub title: String,
    pub author: Option<String>,
    pub summary: Option<String>,
    /// A further feed (a folder, series, library…).
    pub feed: Option<String>,
    /// Downloads, best first: (url, file type).
    pub downloads: Vec<(String, String)>,
    pub cover: Option<String>,
}

pub struct Server<'a> {
    pub url: &'a str,
    pub username: Option<&'a str>,
    pub password: Option<&'a str>,
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(concat!("FicShelf/", env!("CARGO_PKG_VERSION"), " (OPDS)"))
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(60))
        .build()?)
}

fn request(s: &Server<'_>, url: &str) -> Result<reqwest::RequestBuilder> {
    let mut r = client()?.get(url).header(
        reqwest::header::ACCEPT,
        "application/atom+xml, application/opds+xml, application/xml;q=0.9, */*;q=0.5",
    );
    if let Some(u) = s.username.filter(|u| !u.is_empty()) {
        r = r.basic_auth(u, s.password);
    }
    Ok(r)
}

/// Fetch a URL from the server, refusing to send its login anywhere else.
pub async fn get(s: &Server<'_>, url: &str) -> Result<reqwest::Response> {
    let base = reqwest::Url::parse(s.url).context("the server address is not a web address")?;
    let target = reqwest::Url::parse(url).context("that link is not a web address")?;
    if target.host_str() != base.host_str() || target.port_or_known_default() != base.port_or_known_default() {
        return Err(anyhow!("that link leads away from the server, so it was not followed"));
    }
    let resp = request(s, url)?.send().await.map_err(|e| anyhow!("could not reach the server: {e}"))?;
    match resp.status().as_u16() {
        200..=299 => Ok(resp),
        401 | 403 => Err(anyhow!("the server did not accept the username or password")),
        404 => Err(anyhow!("the server has no catalogue at that address (404)")),
        n => Err(anyhow!("the server answered {n}")),
    }
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("selector")
}

fn text(el: ElementRef) -> String {
    el.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

fn resolve(base: &str, href: &str) -> Option<String> {
    reqwest::Url::parse(base).ok()?.join(href).ok().map(|u| u.to_string())
}

/// How good a download is for FicShelf, lower is better.
fn rank(kind: &str, href: &str) -> u8 {
    let k = kind.to_ascii_lowercase();
    let h = href.to_ascii_lowercase();
    if k.contains("epub") || h.ends_with(".epub") {
        0
    } else if k.contains("cbz") || k.contains("comicbook+zip") || h.ends_with(".cbz") {
        1
    } else if k.contains("pdf") || h.ends_with(".pdf") {
        2
    } else if k.contains("cbr") || k.contains("rar") || k.contains("cb7") {
        3
    } else if k.contains("mobi") || k.contains("kindle") || k.contains("azw") {
        4
    } else if k.contains("zip") {
        5
    } else {
        9
    }
}

/// Read an OPDS (Atom) feed. The HTML parser is lenient, which suits feeds
/// from many different servers.
pub fn parse(xml: &str, url: &str) -> Feed {
    let doc = Html::parse_document(xml);
    let mut feed = Feed { url: url.to_string(), ..Default::default() };
    let link_sel = sel("link");
    let entry_sel = sel("entry");

    // Feed-level title and links: those not inside an entry.
    let in_entry = |el: &ElementRef| el.ancestors().any(|a| a.value().as_element().is_some_and(|e| e.name() == "entry"));
    feed.title = doc.select(&sel("title")).find(|t| !in_entry(t)).map(text).unwrap_or_default();
    for l in doc.select(&link_sel).filter(|l| !in_entry(l)) {
        let rel = l.value().attr("rel").unwrap_or("");
        let kind = l.value().attr("type").unwrap_or("");
        let Some(href) = l.value().attr("href").and_then(|h| resolve(url, h)) else { continue };
        match rel {
            "next" => feed.next = Some(href),
            "search" if kind.contains("atom") || href.contains("{searchTerms}") => feed.search = Some(href),
            "search" if feed.search.is_none() => feed.search = Some(format!("opensearch:{href}")),
            _ => {}
        }
    }

    for e in doc.select(&entry_sel) {
        let mut entry = Entry {
            title: e.select(&sel("title")).next().map(text).unwrap_or_else(|| "Untitled".into()),
            author: {
                let names: Vec<String> = e.select(&sel("author name")).map(text).filter(|n| !n.is_empty()).collect();
                (!names.is_empty()).then(|| names.join(", "))
            },
            summary: e
                .select(&sel("summary, content"))
                .next()
                .map(text)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(400).collect()),
            ..Default::default()
        };
        let mut downloads: Vec<(u8, String, String)> = Vec::new();
        for l in e.select(&link_sel) {
            let rel = l.value().attr("rel").unwrap_or("");
            let kind = l.value().attr("type").unwrap_or("").to_string();
            let Some(href) = l.value().attr("href").and_then(|h| resolve(url, h)) else { continue };
            if rel.contains("opds-spec.org/acquisition") || (rel.is_empty() && rank(&kind, &href) < 9) {
                downloads.push((rank(&kind, &href), href, kind));
            } else if rel.contains("thumbnail") || (rel.contains("opds-spec.org/image") && entry.cover.is_none()) {
                entry.cover = Some(href);
            } else if kind.contains("atom") || kind.contains("opds") || rel == "subsection" || rel.contains("/sort/") {
                if entry.feed.is_none() && !rel.contains("acquisition") {
                    entry.feed = Some(href);
                }
            }
        }
        downloads.sort_by(|a, b| a.0.cmp(&b.0));
        entry.downloads = downloads.into_iter().map(|(_, h, k)| (h, k)).collect();
        if !entry.downloads.is_empty() {
            entry.feed = None; // a book, not a folder
        }
        feed.entries.push(entry);
    }
    feed
}

pub async fn feed(s: &Server<'_>, url: &str) -> Result<Feed> {
    let resp = get(s, url).await?;
    let body = resp.text().await?;
    if !body.contains("<feed") && !body.contains("<entry") {
        return Err(anyhow!("that address is not an OPDS catalogue"));
    }
    Ok(parse(&body, url))
}

/// Run a search: the feed's search link is either a template with
/// {searchTerms}, or an OpenSearch description that holds one.
pub async fn search(s: &Server<'_>, search: &str, query: &str) -> Result<Feed> {
    let template = if let Some(desc) = search.strip_prefix("opensearch:") {
        let body = get(s, desc).await?.text().await?;
        let doc = Html::parse_document(&body);
        doc.select(&sel("url"))
            .filter_map(|u| u.value().attr("template").map(|t| (u.value().attr("type").unwrap_or(""), t)))
            .max_by_key(|(t, _)| t.contains("atom"))
            .and_then(|(_, t)| resolve(desc, t))
            .ok_or_else(|| anyhow!("this server's search could not be understood"))?
    } else {
        search.to_string()
    };
    let q = percent_encoding::utf8_percent_encode(query.trim(), percent_encoding::NON_ALPHANUMERIC).to_string();
    let url = template
        .replace("{searchTerms}", &q)
        .replace("%7BsearchTerms%7D", &q)
        .replace("{startPage?}", "1")
        .replace("{startIndex?}", "0")
        .replace("{count?}", "50");
    feed(s, &url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_feed() {
        let xml = r#"<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Library</title>
  <link rel="search" type="application/atom+xml" href="/opds/search?q={searchTerms}"/>
  <link rel="next" href="?page=2"/>
  <entry>
    <title>Manga</title>
    <link rel="subsection" type="application/atom+xml;profile=opds-catalog;kind=navigation" href="/opds/manga"/>
  </entry>
  <entry>
    <title>One Piece v01</title>
    <author><name>Oda</name></author>
    <content type="text">Pirates.</content>
    <link rel="http://opds-spec.org/image/thumbnail" href="/t/1.jpg"/>
    <link rel="http://opds-spec.org/acquisition" type="application/pdf" href="/d/1.pdf"/>
    <link rel="http://opds-spec.org/acquisition" type="application/vnd.comicbook+zip" href="/d/1.cbz"/>
  </entry>
</feed>"#;
        let f = parse(xml, "https://srv.example/opds/");
        assert_eq!(f.title, "Library");
        assert_eq!(f.search.as_deref(), Some("https://srv.example/opds/search?q={searchTerms}"));
        assert_eq!(f.next.as_deref(), Some("https://srv.example/opds/?page=2"));
        assert_eq!(f.entries.len(), 2);
        assert_eq!(f.entries[0].feed.as_deref(), Some("https://srv.example/opds/manga"));
        let b = &f.entries[1];
        assert_eq!(b.author.as_deref(), Some("Oda"));
        assert_eq!(b.summary.as_deref(), Some("Pirates."));
        assert_eq!(b.cover.as_deref(), Some("https://srv.example/t/1.jpg"));
        assert_eq!(b.downloads[0].0, "https://srv.example/d/1.cbz");
        assert!(b.feed.is_none());
    }
}
