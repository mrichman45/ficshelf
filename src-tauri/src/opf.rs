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
    /// The series this book belongs to, and its place in it.
    pub series: Option<String>,
    pub series_index: Option<f64>,
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
        series: None,
        series_index: None,
    };
    let (series, index) = series_of(opf_xml);
    meta.series = series;
    meta.series_index = index;

    if let Some(href) = cover_href(opf_xml) {
        meta.cover_href = Some(resolve_relative(opf_path, &href));
    }
    meta
}

/// The book's series, from EPUB 3's `belongs-to-collection` or, failing
/// that, the `calibre:series` tags Calibre and many stores write.
fn series_of(opf: &str) -> (Option<String>, Option<f64>) {
    // EPUB 3: <meta property="belongs-to-collection" id="c1">Name</meta>,
    // refined by <meta refines="#c1" property="group-position">2</meta> and
    // optionally collection-type "series" or "set".
    let metas = elements(opf, "meta");
    let refinement = |id: &str, prop: &str| -> Option<String> {
        let target = format!("#{id}");
        metas.iter().find_map(|(tag, text)| {
            (attr(tag, "refines").as_deref() == Some(target.as_str())
                && attr(tag, "property").as_deref() == Some(prop))
            .then(|| text.trim().to_string())
        })
    };
    let mut collections: Vec<(String, Option<String>, bool)> = Vec::new();
    for (tag, text) in &metas {
        if attr(tag, "property").as_deref() == Some("belongs-to-collection") && !text.trim().is_empty() {
            let id = attr(tag, "id");
            let is_series = id
                .as_deref()
                .and_then(|i| refinement(i, "collection-type"))
                .map(|t| t.eq_ignore_ascii_case("series"))
                .unwrap_or(false);
            collections.push((text.trim().to_string(), id, is_series));
        }
    }
    collections.sort_by_key(|(_, _, is_series)| !is_series);
    if let Some((name, id, _)) = collections.into_iter().next() {
        let index = id
            .as_deref()
            .and_then(|i| refinement(i, "group-position"))
            .and_then(|v| parse_index(&v));
        return (Some(name), index);
    }

    // Calibre: <meta name="calibre:series" content="Name"/> and
    // <meta name="calibre:series_index" content="2.0"/>.
    let named = |n: &str| {
        metas.iter().find_map(|(tag, _)| {
            (attr(tag, "name").as_deref() == Some(n))
                .then(|| attr(tag, "content").map(|c| decode_entities(&c)))
                .flatten()
        })
    };
    let series = named("calibre:series").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let index = series
        .as_ref()
        .and(named("calibre:series_index"))
        .and_then(|v| parse_index(&v));
    (series, index)
}

/// A position in a series: "2", "2.0", "1.5", " 3 ". Anything else is None.
pub fn parse_index(v: &str) -> Option<f64> {
    v.trim().parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0)
}

// -------------------------------------------------------------- ComicInfo

/// What a comic archive's `ComicInfo.xml` says about it, the de facto
/// standard written by ComicRack, Komga, Mylar and most comic tools.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ComicMeta {
    pub title: Option<String>,
    pub series: Option<String>,
    pub number: Option<f64>,
    pub writer: Option<String>,
}

pub fn parse_comicinfo(xml: &str) -> ComicMeta {
    let field = |n: &str| text_of(xml, n).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let series = field("Series");
    // Number is the issue; Volume is the fallback for collected editions.
    let number = field("Number")
        .and_then(|v| parse_index(&v))
        .or_else(|| field("Volume").and_then(|v| parse_index(&v)));
    let title = field("Title").or_else(|| match (&series, number) {
        (Some(s), Some(n)) => Some(format!("{s} {}", format_index(n))),
        _ => None,
    });
    ComicMeta { title, series, number, writer: field("Writer") }
}

/// 2.0 as "2", 1.5 as "1.5".
pub fn format_index(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

// -------------------------------------------------------------------- DRM

/// Whether an EPUB is locked by DRM, judged from the two files DRM schemes
/// put in `META-INF`. Returns a name for the lock, or None when the book is
/// open.
///
/// `encryption.xml` alone is not DRM: the EPUB standard uses it to obfuscate
/// embedded fonts, and those books read fine. Only encryption by another
/// method, or Adobe's `rights.xml`, means the text itself is locked.
pub fn drm_kind(encryption_xml: Option<&str>, rights_xml: Option<&str>) -> Option<&'static str> {
    if let Some(rights) = rights_xml {
        if rights.contains("ns.adobe.com/adept") {
            return Some("Adobe DRM");
        }
    }
    let enc = encryption_xml?;
    const FONT_OBFUSCATION: [&str; 2] = [
        "http://www.idpf.org/2008/embedding",
        "http://ns.adobe.com/pdf/enc#RC",
    ];
    let locked = tags_named(enc, "enc:EncryptionMethod")
        .into_iter()
        .chain(tags_named(enc, "EncryptionMethod"))
        .filter_map(|t| attr(&t, "Algorithm"))
        .any(|alg| !FONT_OBFUSCATION.contains(&alg.as_str()));
    if !locked {
        return None;
    }
    if rights_xml.is_some() {
        Some("Adobe DRM")
    } else {
        Some("DRM")
    }
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

/// Every `<name ...>` element as (opening tag, text). Self-closing elements
/// come back with empty text.
fn elements(xml: &str, name: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut cursor = 0usize;
    while let Some(rel) = xml[cursor..].find(&open) {
        let start = cursor + rel;
        let after = xml[start + open.len()..].chars().next();
        if !matches!(after, Some(c) if c.is_whitespace() || c == '>' || c == '/') {
            cursor = start + open.len();
            continue;
        }
        let Some(gt) = xml[start..].find('>') else { break };
        let tag_end = start + gt + 1;
        let tag = xml[start..tag_end].to_string();
        if tag.trim_end_matches('>').ends_with('/') {
            out.push((tag, String::new()));
            cursor = tag_end;
            continue;
        }
        match xml[tag_end..].find(&close) {
            Some(rel_end) => {
                out.push((tag, decode_entities(&xml[tag_end..tag_end + rel_end])));
                cursor = tag_end + rel_end + close.len();
            }
            None => {
                out.push((tag, String::new()));
                cursor = tag_end;
            }
        }
    }
    out
}

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

    #[test]
    fn calibre_series_is_read() {
        let opf = r#"<metadata>
            <dc:title>The Fellowship</dc:title>
            <meta name="calibre:series" content="The Lord of the Rings"/>
            <meta name="calibre:series_index" content="1.0"/>
          </metadata>"#;
        let m = parse_opf(opf, "content.opf");
        assert_eq!(m.series.as_deref(), Some("The Lord of the Rings"));
        assert_eq!(m.series_index, Some(1.0));
    }

    #[test]
    fn epub3_collections_win_and_prefer_series_over_sets() {
        let opf = r##"<metadata>
            <meta property="belongs-to-collection" id="set1">Box Set</meta>
            <meta refines="#set1" property="collection-type">set</meta>
            <meta property="belongs-to-collection" id="c1">Discworld</meta>
            <meta refines="#c1" property="collection-type">series</meta>
            <meta refines="#c1" property="group-position">7</meta>
            <meta name="calibre:series" content="Something Else"/>
          </metadata>"##;
        let m = parse_opf(opf, "OEBPS/content.opf");
        assert_eq!(m.series.as_deref(), Some("Discworld"));
        assert_eq!(m.series_index, Some(7.0));
    }

    #[test]
    fn no_series_is_none() {
        let m = parse_opf("<metadata><dc:title>Alone</dc:title></metadata>", "c.opf");
        assert_eq!(m.series, None);
        assert_eq!(m.series_index, None);
        // an index without a series means nothing
        let m = parse_opf(r#"<meta name="calibre:series_index" content="3"/>"#, "c.opf");
        assert_eq!(m.series_index, None);
    }

    #[test]
    fn comicinfo_reads_series_and_number() {
        let xml = r#"<?xml version="1.0"?><ComicInfo>
            <Series>Azumanga Daioh</Series><Number>1</Number>
            <Writer>Kiyohiko Azuma</Writer></ComicInfo>"#;
        let c = parse_comicinfo(xml);
        assert_eq!(c.series.as_deref(), Some("Azumanga Daioh"));
        assert_eq!(c.number, Some(1.0));
        assert_eq!(c.title.as_deref(), Some("Azumanga Daioh 1"));
        assert_eq!(c.writer.as_deref(), Some("Kiyohiko Azuma"));

        let c = parse_comicinfo("<ComicInfo><Title>Ch. 2</Title><Volume>3</Volume></ComicInfo>");
        assert_eq!(c.title.as_deref(), Some("Ch. 2"));
        assert_eq!(c.number, Some(3.0));
        assert_eq!(parse_comicinfo("<ComicInfo/>"), ComicMeta::default());
    }

    #[test]
    fn indexes_parse_and_print_tidily() {
        assert_eq!(parse_index(" 2 "), Some(2.0));
        assert_eq!(parse_index("1.5"), Some(1.5));
        assert_eq!(parse_index("two"), None);
        assert_eq!(parse_index("-1"), None);
        assert_eq!(format_index(2.0), "2");
        assert_eq!(format_index(1.5), "1.5");
    }

    #[test]
    fn font_obfuscation_is_not_drm_but_real_encryption_is() {
        let fonts = r#"<encryption><enc:EncryptedData>
            <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
          </enc:EncryptedData></encryption>"#;
        assert_eq!(drm_kind(Some(fonts), None), None);
        assert_eq!(drm_kind(None, None), None);

        let aes = r#"<encryption><EncryptedData>
            <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
          </EncryptedData></encryption>"#;
        assert_eq!(drm_kind(Some(aes), None), Some("DRM"));
        assert_eq!(drm_kind(Some(aes), Some("<rights/>")), Some("Adobe DRM"));
        assert_eq!(
            drm_kind(None, Some(r#"<adept:rights xmlns:adept="http://ns.adobe.com/adept">"#)),
            Some("Adobe DRM")
        );
    }
}
