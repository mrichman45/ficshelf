//! An AO3 work's rating and fandoms, read from the preface page that AO3
//! puts at the front of every EPUB it makes:
//!
//! <dl class="tags"><dt>Rating:</dt><dd><a>Explicit</a></dd>
//!                  <dt>Fandom:</dt><dd><a>…</a>, <a>…</a></dd> …</dl>
//!
//! Used to hide Explicit works on request and to group the library by
//! fandom. Books that are not from AO3 simply have neither.

use scraper::{ElementRef, Html, Selector};
use std::io::Read;
use std::path::Path;

#[derive(Debug, Default, PartialEq)]
pub struct Meta {
    pub rating: Option<String>,
    pub fandoms: Vec<String>,
}

fn words(el: ElementRef) -> String {
    el.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Read the tag list from a preface page's HTML.
pub fn from_html(html: &str) -> Meta {
    let doc = Html::parse_document(html);
    let dt = Selector::parse("dt").expect("selector");
    let a = Selector::parse("a").expect("selector");
    let mut meta = Meta::default();
    for term in doc.select(&dt) {
        let label = words(term).trim_end_matches(':').trim().to_lowercase();
        // The <dd> that follows this <dt>.
        let Some(dd) = term.next_siblings().filter_map(ElementRef::wrap).find(|e| e.value().name() == "dd") else {
            continue;
        };
        let values: Vec<String> = {
            let links: Vec<String> = dd.select(&a).map(words).filter(|s| !s.is_empty()).collect();
            if links.is_empty() {
                words(dd).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
            } else {
                links
            }
        };
        match label.as_str() {
            "rating" | "ratings" => meta.rating = values.into_iter().next(),
            "fandom" | "fandoms" => meta.fandoms = values,
            _ => {}
        }
    }
    meta
}

/// Look through the first pages of an EPUB for AO3's preface.
pub fn from_epub(path: &Path) -> Meta {
    let Ok(file) = std::fs::File::open(path) else { return Meta::default() };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return Meta::default() };
    let mut names: Vec<String> = zip
        .file_names()
        .filter(|n| {
            let l = n.to_lowercase();
            l.ends_with(".xhtml") || l.ends_with(".html") || l.ends_with(".htm")
        })
        .map(str::to_string)
        .collect();
    // AO3 calls it "preface.xhtml"; try that first, then the first few pages.
    names.sort_by_key(|n| (!n.to_lowercase().contains("preface"), n.clone()));
    for name in names.into_iter().take(4) {
        let Ok(mut f) = zip.by_name(&name) else { continue };
        if f.size() > 2 * 1024 * 1024 {
            continue;
        }
        let mut html = String::new();
        if f.read_to_string(&mut html).is_err() || !html.contains("Rating") && !html.contains("Fandom") {
            continue;
        }
        let m = from_html(&html);
        if m.rating.is_some() || !m.fandoms.is_empty() {
            return m;
        }
    }
    Meta::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ao3_preface() {
        let html = r#"<html><body><div class="meta"><dl class="tags">
          <dt class="rating">Rating:</dt><dd class="rating"><a href="x">Explicit</a></dd>
          <dt class="warning">Archive Warning:</dt><dd><a>No Archive Warnings Apply</a></dd>
          <dt class="fandom">Fandoms:</dt><dd class="fandom"><a>Good Omens (TV)</a>, <a>Good Omens - Neil Gaiman &amp; Terry Pratchett</a></dd>
        </dl></div></body></html>"#;
        let m = from_html(html);
        assert_eq!(m.rating.as_deref(), Some("Explicit"));
        assert_eq!(m.fandoms, vec!["Good Omens (TV)".to_string(), "Good Omens - Neil Gaiman & Terry Pratchett".to_string()]);
    }

    #[test]
    fn other_books_have_nothing() {
        assert_eq!(from_html("<p>Chapter one</p>"), Meta::default());
    }
}
