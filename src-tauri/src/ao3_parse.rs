//! URL building and small bits of parsing for Archive of Our Own.
//!
//! Dependency-free on purpose: this is the part most likely to be wrong, and
//! keeping it free of external crates means it can be unit-tested anywhere.
//!
//! Everything here is about *addressing* works and reading the numbers AO3
//! puts on a work's page. Fetching lives in `ao3.rs`.

pub const BASE: &str = "https://archiveofourown.org";

/// The canonical page for a work.
pub fn work_url(work_id: u64) -> String {
    format!("{BASE}/works/{work_id}")
}

/// The page we read a work's metadata from. Stats, byline and the Download
/// menu are all on the first chapter's page, so there is no need to ask for
/// the whole work: `view_full_work` would make AO3 render every chapter's
/// text just so we could read a chapter count. `view_adult` skips the
/// content-warning interstitial on Explicit and Mature works.
pub fn work_meta_url(work_id: u64) -> String {
    format!("{BASE}/works/{work_id}?view_adult=true")
}

/// The whole work on one page. Read only for multi-chapter podfics, whose
/// later chapters carry their own audio.
pub fn work_full_url(work_id: u64) -> String {
    format!("{BASE}/works/{work_id}?view_adult=true&view_full_work=true")
}

/// Which of the signed-in user's own lists to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shelf {
    Bookmarks,
    MarkedForLater,
}

impl Shelf {
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "bookmarks" => Some(Self::Bookmarks),
            "later" => Some(Self::MarkedForLater),
            _ => None,
        }
    }
}

/// One page of a user's Bookmarks or Marked for Later list. AO3 shows twenty
/// to a page; `page` is 1-based.
pub fn shelf_url(user: &str, shelf: Shelf, page: u32) -> String {
    let user = percent_encode(user);
    let page = page.max(1);
    match shelf {
        Shelf::Bookmarks => format!("{BASE}/users/{user}/bookmarks?page={page}"),
        Shelf::MarkedForLater => {
            format!("{BASE}/users/{user}/readings?show=to-read&page={page}")
        }
    }
}

/// The account name AO3 greets a signed-in user with, read from the header
/// of any page. People may sign in with their email address, which cannot be
/// used in a `/users/<name>/...` URL, so this is what those URLs are built
/// from.
pub fn parse_greeting_user(html: &str) -> Option<String> {
    let at = html.find("id=\"greeting\"")?;
    let rest = &html[at..];
    let marker = "href=\"/users/";
    let start = rest.find(marker)? + marker.len();
    let rest = &rest[start..];
    let end = rest.find(|c: char| c == '"' || c == '/' || c == '?')?;
    let name = &rest[..end];
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some(name.to_string())
}

/// AO3's own download link. The slug is cosmetic; AO3 serves the work whatever
/// it says, but we keep it tidy because it becomes the downloaded file's name.
pub fn download_url(work_id: u64, slug: &str) -> String {
    format!("{BASE}/downloads/{work_id}/{}.epub", url_slug(slug))
}

/// AO3's own HTML download of a work: the whole work as one page, from the
/// same Download menu. Used when the EPUB download is unavailable.
pub fn html_download_url(work_id: u64, slug: &str) -> String {
    format!("{BASE}/downloads/{work_id}/{}.html", url_slug(slug))
}

/// A work search. `page` is 1-based; AO3 omits the parameter for page 1.
pub fn search_url(query: &str, page: u32) -> String {
    let mut url = format!(
        "{BASE}/works/search?work_search%5Bquery%5D={}",
        percent_encode(query)
    );
    if page > 1 {
        url.push_str(&format!("&page={page}"));
    }
    url
}

/// Browsing a tag, which is how fandom and relationship links work.
pub fn tag_works_url(tag: &str, page: u32) -> String {
    let mut url = format!("{BASE}/tags/{}/works", percent_encode(tag));
    if page > 1 {
        url.push_str(&format!("?page={page}"));
    }
    url
}

/// Accepts a bare id, a work URL, a chapter URL, or a URL with query or
/// fragment attached, and returns the work id.
pub fn parse_work_id(input: &str) -> Option<u64> {
    let s = input.trim();
    if s.is_empty() {
        return None;
    }

    // A bare number is a work id.
    if s.chars().all(|c| c.is_ascii_digit()) {
        return s.parse().ok();
    }

    // Otherwise look for /works/<digits> anywhere in the string.
    let marker = "/works/";
    let start = s.find(marker)? + marker.len();
    let rest = &s[start..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

/// Reads AO3's "Chapters: 5/12" into (posted, total). A total of `?` for a
/// work in progress gives `None`.
pub fn parse_chapters(text: &str) -> Option<(u32, Option<u32>)> {
    let t = text.trim();
    // Tolerate a leading label and any whitespace around the slash.
    let t = t.rsplit(':').next().unwrap_or(t).trim();
    let (left, right) = t.split_once('/')?;
    let posted: u32 = left.trim().replace(',', "").parse().ok()?;
    let right = right.trim();
    let total = if right == "?" {
        None
    } else {
        Some(right.replace(',', "").parse::<u32>().ok()?)
    };
    Some((posted, total))
}

/// Reads a count that AO3 renders with thousands separators, such as word
/// counts, kudos and hits.
pub fn parse_count(text: &str) -> Option<u64> {
    let cleaned: String = text
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        cleaned.parse().ok()
    }
}

/// A work is finished when AO3 knows the total and we have all of it.
pub fn is_complete(posted: u32, total: Option<u32>) -> bool {
    matches!(total, Some(t) if t > 0 && posted >= t)
}

/// How many chapters appeared since we last looked. Saturating, so a work that
/// loses chapters (orphaned, restructured) reports zero rather than panicking.
pub fn new_chapter_count(seen: u32, now: u32) -> u32 {
    now.saturating_sub(seen)
}

/// The login form's page.
pub fn login_url() -> String {
    format!("{BASE}/users/login")
}

/// Rails puts a one-time anti-forgery token on every page, and refuses any
/// form submission that does not carry the one matching the session. It
/// appears as a `csrf-token` meta tag, and again as a hidden field named
/// `authenticity_token` inside the form itself.
///
/// This is deliberately a string search rather than an HTML parse: it needs to
/// keep working on a page we may otherwise fail to understand.
pub fn parse_csrf_token(html: &str) -> Option<String> {
    // Preferred: <meta name="csrf-token" content="...">
    if let Some(tok) = meta_content(html, "csrf-token") {
        if !tok.is_empty() {
            return Some(tok);
        }
    }
    // Fallback: <input name="authenticity_token" value="...">
    let mut cursor = 0usize;
    while let Some(rel) = html[cursor..].find("authenticity_token") {
        let at = cursor + rel;
        cursor = at + "authenticity_token".len();
        // Look only within the enclosing tag.
        let start = html[..at].rfind('<')?;
        let end = match html[at..].find('>') {
            Some(e) => at + e,
            None => break,
        };
        if let Some(v) = tag_attr(&html[start..end], "value") {
            if !v.is_empty() {
                return Some(decode_basic_entities(&v));
            }
        }
    }
    None
}

/// True when AO3 handed us a page meaning "you are not allowed to see this",
/// rather than the thing we asked for.
pub fn looks_like_login_wall(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    lower.contains("this work is only available to registered users")
        || lower.contains("you don't have permission")
        || (lower.contains("<form") && lower.contains("user[password]"))
}

fn meta_content(html: &str, name: &str) -> Option<String> {
    let needle = format!("name=\"{name}\"");
    let alt = format!("name='{name}'");
    let at = html.find(&needle).or_else(|| html.find(&alt))?;
    let start = html[..at].rfind('<')?;
    let end = at + html[at..].find('>')?;
    tag_attr(&html[start..end], "content").map(|v| decode_basic_entities(&v))
}

/// The value of an attribute inside a single raw tag.
fn tag_attr(tag: &str, name: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut from = 0usize;
    while let Some(rel) = tag[from..].find(name) {
        let at = from + rel;
        from = at + name.len();
        if at > 0 && !bytes[at - 1].is_ascii_whitespace() {
            continue; // part of a longer attribute name
        }
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

fn decode_basic_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

/// Percent-encode for a query string: everything but the unreserved set.
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

/// A short ASCII slug for the download URL's cosmetic filename segment.
fn url_slug(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; // avoids a leading dash
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 60 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "work".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_ids_come_out_of_anything_shaped_like_a_link() {
        assert_eq!(parse_work_id("258626"), Some(258626));
        assert_eq!(
            parse_work_id("https://archiveofourown.org/works/258626"),
            Some(258626)
        );
        assert_eq!(
            parse_work_id("https://archiveofourown.org/works/258626/chapters/401313"),
            Some(258626)
        );
        assert_eq!(
            parse_work_id("archiveofourown.org/works/258626?view_full_work=true"),
            Some(258626)
        );
        assert_eq!(
            parse_work_id("  https://archiveofourown.org/works/258626#main  "),
            Some(258626)
        );
        assert_eq!(parse_work_id(""), None);
        assert_eq!(parse_work_id("not a link"), None);
        assert_eq!(parse_work_id("https://example.com/works/"), None);
        assert_eq!(parse_work_id("https://example.com/works/abc"), None);
    }

    #[test]
    fn chapter_counts_read_both_finished_and_ongoing_works() {
        assert_eq!(parse_chapters("5/12"), Some((5, Some(12))));
        assert_eq!(parse_chapters("5/?"), Some((5, None)));
        assert_eq!(parse_chapters("Chapters: 3/3"), Some((3, Some(3))));
        assert_eq!(parse_chapters(" 1 / 1 "), Some((1, Some(1))));
        assert_eq!(parse_chapters("1,024/2,048"), Some((1024, Some(2048))));
        assert_eq!(parse_chapters("nonsense"), None);
        assert_eq!(parse_chapters(""), None);
    }

    #[test]
    fn completion_needs_a_known_total() {
        assert!(is_complete(3, Some(3)));
        assert!(is_complete(4, Some(3))); // tolerate a shrinking total
        assert!(!is_complete(2, Some(3)));
        assert!(!is_complete(9, None)); // work in progress
        assert!(!is_complete(0, Some(0)));
    }

    #[test]
    fn new_chapters_never_go_negative() {
        assert_eq!(new_chapter_count(3, 5), 2);
        assert_eq!(new_chapter_count(5, 5), 0);
        assert_eq!(new_chapter_count(7, 2), 0);
        assert_eq!(new_chapter_count(0, 1), 1);
    }

    #[test]
    fn counts_ignore_separators_and_labels() {
        assert_eq!(parse_count("12,345"), Some(12345));
        assert_eq!(parse_count("Words: 1 234"), Some(1234));
        assert_eq!(parse_count("none"), None);
    }

    #[test]
    fn search_urls_encode_properly() {
        assert_eq!(
            search_url("good omens", 1),
            "https://archiveofourown.org/works/search?work_search%5Bquery%5D=good+omens"
        );
        assert!(search_url("x", 3).ends_with("&page=3"));
        // characters that must not leak into a query string
        let u = search_url("a&b=c#d", 1);
        assert!(u.contains("a%26b%3Dc%23d"), "got {u}");
        // non-ASCII
        assert!(search_url("café", 1).contains("caf%C3%A9"));
    }

    #[test]
    fn html_downloads_sit_beside_epub_ones() {
        assert_eq!(
            html_download_url(258626, "A Study in Pink"),
            "https://archiveofourown.org/downloads/258626/A-Study-in-Pink.html"
        );
    }

    #[test]
    fn download_urls_have_a_tidy_slug() {
        assert_eq!(
            download_url(258626, "A Study in Pink"),
            "https://archiveofourown.org/downloads/258626/A-Study-in-Pink.epub"
        );
        // punctuation collapses, no leading or trailing dashes
        assert_eq!(
            download_url(1, "  !!! Hello, World !!!  "),
            "https://archiveofourown.org/downloads/1/Hello-World.epub"
        );
        // a title with nothing usable still produces a valid URL
        assert_eq!(
            download_url(2, "！！！"),
            "https://archiveofourown.org/downloads/2/work.epub"
        );
    }

    #[test]
    fn the_login_token_is_found_in_either_place() {
        // The meta tag is preferred.
        let page = r#"<html><head>
            <meta name="csrf-param" content="authenticity_token" />
            <meta name="csrf-token" content="abc123==" />
          </head><body></body></html>"#;
        assert_eq!(parse_csrf_token(page).as_deref(), Some("abc123=="));

        // Falling back to the hidden form field, attribute order reversed.
        let page2 = r#"<form action="/users/login" method="post">
            <input type="hidden" value="tok-from-form" name="authenticity_token" />
          </form>"#;
        assert_eq!(parse_csrf_token(page2).as_deref(), Some("tok-from-form"));

        // Single quotes, and an entity in the value.
        let page3 = "<meta name='csrf-token' content='a&amp;b' />";
        assert_eq!(parse_csrf_token(page3).as_deref(), Some("a&b"));

        // An empty meta tag must not win over a usable form field.
        let page4 = r#"<meta name="csrf-token" content="" />
            <input name="authenticity_token" value="real" />"#;
        assert_eq!(parse_csrf_token(page4).as_deref(), Some("real"));

        assert_eq!(parse_csrf_token("<html></html>"), None);
        assert_eq!(parse_csrf_token(""), None);
    }

    #[test]
    fn a_login_wall_is_recognised() {
        assert!(looks_like_login_wall(
            "<p>Sorry, this work is only available to registered users of the Archive.</p>"
        ));
        assert!(looks_like_login_wall(
            "<form><input name=\"user[password]\" type=\"password\"></form>"
        ));
        assert!(!looks_like_login_wall("<h2 class=\"title heading\">A Work</h2>"));
        assert!(!looks_like_login_wall(""));
    }

    #[test]
    fn metadata_comes_from_the_first_chapter_not_the_whole_work() {
        let u = work_meta_url(258626);
        assert_eq!(u, "https://archiveofourown.org/works/258626?view_adult=true");
        assert!(!u.contains("view_full_work"));
    }

    #[test]
    fn shelf_urls_point_at_the_right_lists() {
        assert_eq!(
            shelf_url("reader_01", Shelf::Bookmarks, 1),
            "https://archiveofourown.org/users/reader_01/bookmarks?page=1"
        );
        assert_eq!(
            shelf_url("reader_01", Shelf::MarkedForLater, 3),
            "https://archiveofourown.org/users/reader_01/readings?show=to-read&page=3"
        );
        // page 0 is treated as the first page
        assert!(shelf_url("x", Shelf::Bookmarks, 0).ends_with("page=1"));
        assert_eq!(Shelf::from_name("later"), Some(Shelf::MarkedForLater));
        assert_eq!(Shelf::from_name("history"), None);
    }

    #[test]
    fn the_signed_in_name_is_read_from_the_greeting() {
        let page = r#"<ul class="primary navigation actions"></ul>
            <ul id="greeting" class="primary navigation actions">
              <li class="dropdown"><a href="/users/reader_01">Hi, reader_01!</a>
                <ul class="menu"><li><a href="/users/reader_01/pseuds">My Pseuds</a></li></ul>
              </li></ul>"#;
        assert_eq!(parse_greeting_user(page).as_deref(), Some("reader_01"));

        // A link to some other user before the greeting must not be taken.
        let page2 = r#"<a href="/users/someone_else">x</a>
            <div id="greeting"><a href="/users/me/bookmarks">Bookmarks</a></div>"#;
        assert_eq!(parse_greeting_user(page2).as_deref(), Some("me"));

        assert_eq!(parse_greeting_user("<div id=\"login\"></div>"), None);
        assert_eq!(
            parse_greeting_user(r#"<div id="greeting"><a href="/users/a%20b">x</a></div>"#),
            None
        );
    }

    #[test]
    fn tag_urls_encode_the_tag() {
        assert!(tag_works_url("Good Omens (TV)", 1).contains("Good+Omens+%28TV%29"));
        assert!(tag_works_url("x", 2).ends_with("/works?page=2"));
    }
}
