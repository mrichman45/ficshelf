//! The text parts of a minimal EPUB 3 package, for works FicShelf has to
//! package itself.
//!
//! AO3 normally supplies a finished EPUB. When it cannot (after its November
//! 2026 outage it came back with only HTML downloads switched on), FicShelf
//! fetches AO3's own HTML download of the work and wraps it in an EPUB built
//! from these pieces. Dependency-free so it can be unit-tested on its own;
//! the zipping and HTML parsing live elsewhere.

/// Escape text for XML content and attribute values.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Characters XML 1.0 forbids outright; dropping them is the only
            // way to keep the document well-formed.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            '\u{FFFE}' | '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

/// HTML elements that have no closing tag, written `<br/>` in XHTML.
pub fn is_void(name: &str) -> bool {
    matches!(
        name,
        "area" | "base" | "br" | "col" | "embed" | "hr" | "img" | "input" | "link" | "meta"
            | "source" | "track" | "wbr"
    )
}

/// Whether `name` can be written as an XML element or attribute name.
/// Anything else is dropped rather than risk a page that will not parse.
pub fn valid_xml_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else { return false };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

pub fn content_opf(title: &str, authors: &[String], identifier: &str, modified: &str) -> String {
    let creators: String = authors
        .iter()
        .filter(|a| !a.trim().is_empty())
        .map(|a| format!("    <dc:creator>{}</dc:creator>\n", xml_escape(a.trim())))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="en">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">{id}</dc:identifier>
    <dc:title>{title}</dc:title>
{creators}    <dc:language>en</dc:language>
    <dc:publisher>Archive of Our Own</dc:publisher>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="text"/>
  </spine>
</package>
"#,
        id = xml_escape(identifier),
        title = xml_escape(title),
    )
}

/// The table of contents. `chapters` are (anchor id, heading) pairs in
/// text.xhtml; with none, the book gets a single entry.
pub fn nav_xhtml(title: &str, chapters: &[(String, String)]) -> String {
    let items: String = if chapters.is_empty() {
        format!("<li><a href=\"text.xhtml\">{}</a></li>", xml_escape(title))
    } else {
        chapters
            .iter()
            .map(|(id, label)| {
                format!(
                    "\n      <li><a href=\"text.xhtml#{}\">{}</a></li>",
                    xml_escape(id),
                    xml_escape(label)
                )
            })
            .collect()
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>{t}</title></head>
<body>
  <nav epub:type="toc"><ol>{items}
  </ol></nav>
</body>
</html>
"#,
        t = xml_escape(title)
    )
}

/// Collapse a heading's text to one tidy line for the chapter list.
pub fn heading_label(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.chars().count() > 120 {
        let cut: String = joined.chars().take(117).collect();
        format!("{cut}…")
    } else {
        joined
    }
}

/// The one content page. `style` is CSS taken from the original's <style>
/// elements; `body` is already-serialised, well-formed XHTML.
pub fn text_xhtml(title: &str, style: &str, body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en">
<head>
<title>{t}</title>
<style>{style}</style>
</head>
<body>
{body}
</body>
</html>
"#,
        t = xml_escape(title),
        style = xml_escape(style),
    )
}

/// Seconds since 1970 as the UTC timestamp EPUB 3 wants for
/// dcterms:modified, e.g. "2026-11-16T21:37:05Z".
pub fn iso_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaping_keeps_xml_well_formed() {
        assert_eq!(xml_escape(r#"Tom & "Jerry" <3"#), "Tom &amp; &quot;Jerry&quot; &lt;3");
        assert_eq!(xml_escape("a\u{0}b\u{8}c\td\ne"), "abc\td\ne");
    }

    #[test]
    fn names_and_void_elements() {
        assert!(is_void("br") && is_void("img") && !is_void("p"));
        assert!(valid_xml_name("class") && valid_xml_name("data-x") && valid_xml_name("xml.lang"));
        assert!(!valid_xml_name("") && !valid_xml_name("1x") && !valid_xml_name("on\"x") && !valid_xml_name("a b"));
    }

    #[test]
    fn package_names_title_and_every_author() {
        let opf = content_opf(
            "Fish & Chips",
            &["Alice".into(), " ".into(), "Bob <b>".into()],
            "urn:ao3:work:42",
            "2026-11-16T00:00:00Z",
        );
        assert!(opf.contains("<dc:title>Fish &amp; Chips</dc:title>"));
        assert!(opf.contains("<dc:creator>Alice</dc:creator>"));
        assert!(opf.contains("<dc:creator>Bob &lt;b&gt;</dc:creator>"));
        assert_eq!(opf.matches("<dc:creator>").count(), 2);
        assert!(opf.contains(r#"<dc:identifier id="uid">urn:ao3:work:42</dc:identifier>"#));
        // and it reads back through FicShelf's own OPF parser
        let meta = crate::opf::parse_opf(&opf, "OEBPS/content.opf");
        assert_eq!(meta.title.as_deref(), Some("Fish & Chips"));
    }

    #[test]
    fn chapter_list() {
        let nav = nav_xhtml("Work", &[]);
        assert!(nav.contains(r#"<a href="text.xhtml">Work</a>"#));
        let nav = nav_xhtml(
            "Work",
            &[("ch1".into(), "Chapter 1: Begin".into()), ("ch2".into(), "Chapter 2 & More".into())],
        );
        assert!(nav.contains(r#"<a href="text.xhtml#ch1">Chapter 1: Begin</a>"#));
        assert!(nav.contains(r#"<a href="text.xhtml#ch2">Chapter 2 &amp; More</a>"#));
        assert_eq!(heading_label("  Chapter 3:\n   The   End "), "Chapter 3: The End");
        assert!(heading_label(&"x".repeat(200)).ends_with('…'));
    }

    #[test]
    fn utc_timestamps() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_794_861_425), "2026-11-16T20:37:05Z");
        assert_eq!(iso_utc(951_782_400), "2000-02-29T00:00:00Z");
    }
}
