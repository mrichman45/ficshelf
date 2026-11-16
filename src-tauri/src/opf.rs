//! Just enough EPUB container/OPF reading to get a title, authors and a cover.
//!
//! EPUB metadata is XML, but we only ever pull a handful of well-known fields
//! out of it, so this is a small tolerant reader rather than a parser. It is
//! dependency-free so it can be tested without fetching anything, and it is
//! written to degrade quietly: a file it cannot understand yields `None` and
//! the caller falls back to the file name.

#[derive(Debug, Default, Clone, PartialEq)]
pub struct EpubMeta {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub language: Option<String>,
    /// Path to the cover image, relative to the archive root.
    pub cover_href: Option<String>,
}

/// `META-INF/container.xml` points at the OPF file. Returns its path within
/// the archive.
pub fn rootfile_path(container_xml: &str) -> Option<String> {
    let tag = find_tag(container_xml, "rootfile")?;
    attr(&tag, "full-path").map(|s| decode_entities(&s))
}

/// Pull the fields we care about out of an OPF document.
pub fn parse_opf(opf_xml: &str, opf_path: &str) -> EpubMeta {
    let mut meta = EpubMeta {
        title: text_of(opf_xml, "dc:title").or_else(|| text_of(opf_xml, "title")),
        authors: creators(opf_xml),
        language: text_of(opf_xml, "dc:language").or_else(|| text_of(opf_xml, "language")),
        cover_href: None,
    };

    if let Some(href) = cover_href(opf_xml) {
        meta.cover_href = Some(resolve_relative(opf_path, &href));
    }
    meta
}

/// EPUB offers several ways to name a cover. Try them in order of reliability.
fn cover_href(opf: &str) -> Option<String> {
    // 1. EPUB 3: a manifest item with properties="cover-image".
    for tag in tags_named(opf, "item") {
        if attr(&tag, "properties")
            .map(|p| p.split_whitespace().any(|w| w == "cover-image"))
            .unwrap_or(false)
        {
            if let Some(h) = attr(&tag, "href") {
                return Some(decode_entities(&h));
            }
        }
    }

    // 2. EPUB 2: <meta name="cover" content="<manifest id>">.
    let cover_id = tags_named(opf, "meta").into_iter().find_map(|tag| {
        if attr(&tag, "name").as_deref() == Some("cover") {
            attr(&tag, "content")
        } else {
            None
        }
    });
    if let Some(id) = cover_id {
        if let Some(h) = manifest_href(opf, &id) {
            return Some(h);
        }
    }

    // 3. Last resort: a manifest image whose id or href mentions a cover.
    for tag in tags_named(opf, "item") {
        let media = attr(&tag, "media-type").unwrap_or_default();
        if !media.starts_with("image/") {
            continue;
        }
        let id = attr(&tag, "id").unwrap_or_default().to_ascii_lowercase();
        let href = attr(&tag, "href").unwrap_or_default();
        if id.contains("cover") || href.to_ascii_lowercase().contains("cover") {
            return Some(decode_entities(&href));
        }
    }
    None
}

/// The href of the manifest item with this id.
pub fn manifest_href(opf: &str, id: &str) -> Option<String> {
    tags_named(opf, "item").into_iter().find_map(|tag| {
        if attr(&tag, "id").as_deref() == Some(id) {
            attr(&tag, "href").map(|h| decode_entities(&h))
        } else {
            None
        }
    })
}

fn creators(opf: &str) -> Vec<String> {
    let mut out = Vec::new();
    for name in ["dc:creator", "creator"] {
        for value in texts_of(opf, name) {
            let v = value.trim().to_string();
            if !v.is_empty() && !out.contains(&v) {
                out.push(v);
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// Resolve an href that is relative to the OPF file into a path relative to
/// the archive root, collapsing any `..` and `.` segments.
pub fn resolve_relative(opf_path: &str, href: &str) -> String {
    // An absolute-looking href is already archive-relative.
    let href = href.trim_start_matches('/');

    let mut parts: Vec<&str> = Vec::new();
    if let Some(dir) = opf_path.rsplit_once('/').map(|(d, _)| d) {
        parts.extend(dir.split('/').filter(|s| !s.is_empty() && *s != "."));
    }
    for seg in href.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

// ----------------------------------------------------------------- tiny XML

/// The text content of the first `<name>...</name>` element.
fn text_of(xml: &str, name: &str) -> Option<String> {
    texts_of(xml, name).into_iter().next()
}

/// The text content of every `<name>...</name>` element, in document order.
fn texts_of(xml: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut cursor = 0usize;

    while let Some(rel) = xml[cursor..].find(&open) {
        let tag_start = cursor + rel;
        // Make sure we matched a whole element name, not a prefix of a longer
        // one: <dc:title> must not match a search for <dc:t>.
        let after = xml[tag_start + open.len()..].chars().next();
        if !matches!(after, Some(c) if c.is_whitespace() || c == '>' || c == '/') {
            cursor = tag_start + open.len();
            continue;
        }
        let Some(gt) = xml[tag_start..].find('>') else {
            break;
        };
        let content_start = tag_start + gt + 1;
        // Self-closing elements have no text.
        if xml[tag_start..content_start].trim_end_matches('>').ends_with('/') {
            cursor = content_start;
            continue;
        }
        match xml[content_start..].find(&close) {
            Some(rel_end) => {
                let raw = &xml[content_start..content_start + rel_end];
                let text = decode_entities(raw).trim().to_string();
                if !text.is_empty() {
                    out.push(text);
                }
                cursor = content_start + rel_end + close.len();
            }
            None => break,
        }
    }
    out
}

/// The raw text of the first `<name ...>` tag, without the angle brackets.
fn find_tag(xml: &str, name: &str) -> Option<String> {
    tags_named(xml, name).into_iter().next()
}

/// The raw text of every `<name ...>` opening tag.
fn tags_named(xml: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let open = format!("<{name}");
    let mut cursor = 0usize;

    while let Some(rel) = xml[cursor..].find(&open) {
        let start = cursor + rel;
        let after = xml[start + open.len()..].chars().next();
        if !matches!(after, Some(c) if c.is_whitespace() || c == '>' || c == '/') {
            cursor = start + open.len();
            continue;
        }
        match xml[start..].find('>') {
            Some(rel_end) => {
                out.push(xml[start..start + rel_end + 1].to_string());
                cursor = start + rel_end + 1;
            }
            None => break,
        }
    }
    out
}

/// The value of an attribute within a raw tag. Handles single and double
/// quotes, and tolerates whitespace around the equals sign.
fn attr(tag: &str, name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut search_from = 0usize;

    while let Some(rel) = tag[search_from..].find(name) {
        let at = search_from + rel;
        search_from = at + name.len();

        // Must be preceded by whitespace (or the tag opener) so that `href`
        // does not match inside `xlink:href`.
        let before_ok = at == 0 || bytes[at - 1].is_ascii_whitespace();
        if !before_ok {
            continue;
        }

        // Skip whitespace, expect '=', skip whitespace, expect a quote.
        let mut i = at + name.len();
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'=' {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= bytes.len() {
            return None;
        }
        let quote = bytes[i];
        if quote != b'"' && quote != b'\'' {
            continue;
        }
        i += 1;
        let start = i;
        while i < bytes.len() && bytes[i] != quote {
            i += 1;
        }
        return Some(tag[start..i].to_string());
    }
    None
}

/// The five XML entities, plus numeric escapes.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(semi) = rest.find(';').filter(|s| *s <= 12) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            other => other
                .strip_prefix('#')
                .and_then(|num| {
                    if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        num.parse::<u32>().ok()
                    }
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTAINER: &str = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

    #[test]
    fn container_points_at_the_opf() {
        assert_eq!(rootfile_path(CONTAINER), Some("OEBPS/content.opf".into()));
        assert_eq!(rootfile_path("<container/>"), None);
    }

    #[test]
    fn ao3_style_epub_metadata_reads_cleanly() {
        // Shaped like what AO3 actually produces.
        let opf = r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uuid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>A Study in Pink &amp; Grey</dc:title>
    <dc:creator opf:role="aut">someauthor</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
</package>"#;
        let meta = parse_opf(opf, "OEBPS/content.opf");
        assert_eq!(meta.title.as_deref(), Some("A Study in Pink & Grey"));
        assert_eq!(meta.authors, vec!["someauthor".to_string()]);
        assert_eq!(meta.language.as_deref(), Some("en"));
        assert_eq!(meta.cover_href.as_deref(), Some("OEBPS/images/cover.jpg"));
    }

    #[test]
    fn epub3_cover_properties_win() {
        let opf = r#"<package><manifest>
            <item id="x" href="img/front.png" media-type="image/png" properties="cover-image"/>
            <item id="y" href="img/other.png" media-type="image/png"/>
        </manifest></package>"#;
        let meta = parse_opf(opf, "content.opf");
        assert_eq!(meta.cover_href.as_deref(), Some("img/front.png"));
    }

    #[test]
    fn cover_falls_back_to_a_likely_image() {
        let opf = r#"<package><manifest>
            <item id="pic-cover" href="a/cover_full.jpeg" media-type="image/jpeg"/>
            <item id="text" href="a/body.xhtml" media-type="application/xhtml+xml"/>
        </manifest></package>"#;
        let meta = parse_opf(opf, "a/content.opf");
        assert_eq!(meta.cover_href.as_deref(), Some("a/a/cover_full.jpeg"));
    }

    #[test]
    fn several_authors_are_kept_in_order_without_duplicates() {
        let opf = r#"<metadata>
            <dc:creator>alice</dc:creator>
            <dc:creator>bob</dc:creator>
            <dc:creator>alice</dc:creator>
        </metadata>"#;
        let meta = parse_opf(opf, "content.opf");
        assert_eq!(meta.authors, vec!["alice".to_string(), "bob".to_string()]);
    }

    #[test]
    fn relative_paths_resolve_against_the_opf_location() {
        assert_eq!(resolve_relative("OEBPS/content.opf", "images/c.jpg"), "OEBPS/images/c.jpg");
        assert_eq!(resolve_relative("OEBPS/x/content.opf", "../images/c.jpg"), "OEBPS/images/c.jpg");
        assert_eq!(resolve_relative("content.opf", "c.jpg"), "c.jpg");
        assert_eq!(resolve_relative("OEBPS/content.opf", "./c.jpg"), "OEBPS/c.jpg");
        assert_eq!(resolve_relative("OEBPS/content.opf", "/abs/c.jpg"), "OEBPS/abs/c.jpg");
        // cannot climb out of the archive
        assert_eq!(resolve_relative("a/b.opf", "../../../c.jpg"), "c.jpg");
    }

    #[test]
    fn element_names_are_matched_whole() {
        // <dc:titlepage> must not be read as <dc:title>
        let opf = "<metadata><dc:titlepage>nope</dc:titlepage><dc:title>yes</dc:title></metadata>";
        let meta = parse_opf(opf, "c.opf");
        assert_eq!(meta.title.as_deref(), Some("yes"));
    }

    #[test]
    fn attributes_are_matched_whole_too() {
        // xlink:href must not satisfy a search for href
        let tag = r#"<item xlink:href="wrong.jpg" href="right.jpg"/>"#;
        assert_eq!(attr(tag, "href").as_deref(), Some("right.jpg"));
        // single quotes and loose spacing
        let tag2 = "<item href = 'spaced.jpg' />";
        assert_eq!(attr(tag2, "href").as_deref(), Some("spaced.jpg"));
    }

    #[test]
    fn self_closing_elements_have_no_text() {
        let opf = "<metadata><dc:title/></metadata>";
        assert_eq!(parse_opf(opf, "c.opf").title, None);
    }

    #[test]
    fn entities_decode_including_numeric() {
        assert_eq!(decode_entities("a &amp; b"), "a & b");
        assert_eq!(decode_entities("&lt;tag&gt;"), "<tag>");
        assert_eq!(decode_entities("&#65;&#x42;"), "AB");
        assert_eq!(decode_entities("caf&#233;"), "café");
        // a stray ampersand survives untouched
        assert_eq!(decode_entities("Q&A"), "Q&A");
        assert_eq!(decode_entities("100% &unknown; ok"), "100% &unknown; ok");
    }

    #[test]
    fn a_file_we_cannot_understand_yields_nothing_rather_than_panicking() {
        let meta = parse_opf("", "c.opf");
        assert_eq!(meta, EpubMeta::default());
        let meta = parse_opf("<package><manifest><item href=", "c.opf");
        assert!(meta.title.is_none());
        // unterminated element
        let meta = parse_opf("<dc:title>no end", "c.opf");
        assert!(meta.title.is_none());
    }
}
