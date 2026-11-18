//! Turning Kindle books (MOBI, AZW3) into EPUB for the reader, and comics
//! in any container into CBZ. The originals are never changed.

use crate::{epubgen as g, mobi};
use anyhow::{anyhow, Result};
use std::path::Path;

fn image_ext(b: &[u8]) -> (&'static str, &'static str) {
    if b.starts_with(b"\x89PNG") {
        ("png", "image/png")
    } else if b.starts_with(b"GIF8") {
        ("gif", "image/gif")
    } else if b.starts_with(b"BM") {
        ("bmp", "image/bmp")
    } else {
        ("jpg", "image/jpeg")
    }
}

/// Point the book's image references at files in the EPUB:
/// `recindex="00012"` (MOBI) and `src="kindle:embed:000C…"` (AZW3).
fn rewrite_images(html: &str, images: &[Vec<u8>]) -> String {
    let file_for = |n: usize| -> Option<String> {
        let img = images.get(n.checked_sub(1)?)?;
        (!img.is_empty()).then(|| format!("images/{n}.{}", image_ext(img).0))
    };
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let r = rest.find("recindex=");
        let k = rest.find("kindle:embed:");
        let at = match (r, k) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => break,
        };
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        if rest.starts_with("recindex=") {
            // recindex="00012" or recindex='00012' or recindex=00012
            let after = &rest["recindex=".len()..];
            let quote = after.chars().next().filter(|c| *c == '"' || *c == '\'');
            let body = if quote.is_some() { &after[1..] } else { after };
            let end = body.find(|c: char| !c.is_ascii_digit()).unwrap_or(body.len());
            let num = &body[..end];
            let consumed = "recindex=".len() + quote.map_or(0, |_| 1) + end + quote.map_or(0, |_| 1).min(body.len() - end);
            match mobi::image_ref(num).and_then(file_for) {
                Some(f) => out.push_str(&format!("src=\"{f}\"")),
                None => out.push_str("data-missing-image=\"\""),
            }
            rest = &rest[consumed.min(rest.len())..];
        } else {
            let end = rest.find(|c: char| c == '"' || c == '\'' || c.is_whitespace() || c == ')').unwrap_or(rest.len());
            match mobi::image_ref(&rest[..end]).and_then(file_for) {
                Some(f) => out.push_str(&f),
                None => out.push_str("about:blank"),
            }
            rest = &rest[end..];
        }
    }
    out.push_str(rest);
    out
}

/// A MOBI or AZW3 book as an EPUB, with its title and author.
pub fn mobi_to_epub(path: &Path) -> Result<(Vec<u8>, String, Option<String>)> {
    let bytes = std::fs::read(path)?;
    let book = mobi::parse(&bytes).map_err(|e| anyhow!("{e}"))?;
    let html = rewrite_images(&book.html, &book.images)
        .replace("<mbp:pagebreak", "<div class=\"pagebreak\"")
        .replace("</mbp:pagebreak>", "</div>");

    let doc = scraper::Html::parse_document(&html);
    let body_sel = scraper::Selector::parse("body").expect("selector");
    let mut text = String::with_capacity(html.len());
    let mut chapters = Vec::new();
    match doc.select(&body_sel).next() {
        Some(body) => crate::ao3::write_xhtml_children(body, &mut text, &mut chapters),
        None => crate::ao3::write_xhtml_children(doc.root_element(), &mut text, &mut chapters),
    }
    if text.trim().is_empty() {
        return Err(anyhow!("no text could be read from that book"));
    }
    if chapters.len() < 2 {
        chapters.clear();
    }

    let title = if book.title.trim().is_empty() { "Untitled".to_string() } else { book.title.clone() };
    let authors: Vec<String> = book.author.iter().cloned().collect();
    let mut opf = g::content_opf(&title, &authors, &format!("urn:ficshelf:mobi:{}", title), &g::iso_utc(crate::db::now()))
        .replace("    <dc:publisher>Archive of Our Own</dc:publisher>\n", "");
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut items = String::new();
    for (i, img) in book.images.iter().enumerate() {
        if img.is_empty() {
            continue;
        }
        let (ext, mime) = image_ext(img);
        let name = format!("images/{}.{ext}", i + 1);
        items.push_str(&format!("    <item id=\"img{}\" href=\"{name}\" media-type=\"{mime}\"/>\n", i + 1));
        files.push((format!("OEBPS/{name}"), img.clone()));
    }
    if let Some(at) = opf.find("  </manifest>") {
        opf.insert_str(at, &items);
    }
    let style = ".pagebreak { break-before: page; } img { max-width: 100%; height: auto; }";
    let nav = g::nav_xhtml(&title, &chapters);
    let xhtml = g::text_xhtml(&title, style, &text);

    let mut all: Vec<(&str, &[u8])> = vec![
        ("META-INF/container.xml", g::CONTAINER_XML.as_bytes()),
        ("OEBPS/content.opf", opf.as_bytes()),
        ("OEBPS/nav.xhtml", nav.as_bytes()),
        ("OEBPS/text.xhtml", xhtml.as_bytes()),
    ];
    for (n, b) in &files {
        all.push((n.as_str(), b.as_slice()));
    }
    let epub = crate::archive::write_epub(&all)?;
    Ok((epub, title, book.author))
}

/// The first usable image of a Kindle book, for its cover.
pub fn mobi_cover(path: &Path) -> Option<(Vec<u8>, String)> {
    let bytes = std::fs::read(path).ok()?;
    let book = mobi::parse(&bytes).ok()?;
    let img = book.images.into_iter().find(|i| !i.is_empty())?;
    let mime = image_ext(&img).1.to_string();
    Some((img, mime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_references() {
        let imgs = vec![vec![0xFF, 0xD8, 1], vec![], b"\x89PNGx".to_vec()];
        assert_eq!(rewrite_images(r#"<img recindex="00001" />"#, &imgs), r#"<img src="images/1.jpg" />"#);
        assert_eq!(rewrite_images(r#"<img recindex="00003">"#, &imgs), r#"<img src="images/3.png">"#);
        assert_eq!(rewrite_images(r#"<img src="kindle:embed:0003?mime=image/png"/>"#, &imgs), r#"<img src="images/3.png"/>"#);
        assert!(rewrite_images(r#"<img recindex="00002">"#, &imgs).contains("data-missing-image"));
    }
}
