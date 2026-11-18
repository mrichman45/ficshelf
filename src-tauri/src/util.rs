//! Small pure helpers. Deliberately free of external crates so they can be
//! compiled and tested on their own, without fetching any dependencies.

/// Make a string safe to use as a file name on both Windows and Linux.
///
/// Windows is the stricter of the two: it forbids `\ / : * ? " < > |`, forbids
/// trailing dots and spaces, and reserves a set of device names (CON, PRN,
/// AUX, NUL, COM1-9, LPT1-9) even when they carry an extension.
pub fn safe_filename(input: &str, fallback: &str) -> String {
    const FORBIDDEN: &[char] = &['\\', '/', ':', '*', '?', '"', '<', '>', '|'];

    let mut out = String::with_capacity(input.len());
    let mut last_was_space = false;
    for ch in input.chars() {
        let ch = if FORBIDDEN.contains(&ch) || (ch as u32) < 0x20 {
            ' '
        } else {
            ch
        };
        // collapse runs of whitespace so names stay tidy
        if ch.is_whitespace() {
            if last_was_space {
                continue;
            }
            last_was_space = true;
            out.push(' ');
        } else {
            last_was_space = false;
            out.push(ch);
        }
    }

    let mut out = out.trim().trim_end_matches('.').trim().to_string();

    if is_reserved_device_name(&out) {
        out.push('_');
    }

    if out.is_empty() {
        out = fallback.to_string();
    }

    // Leave room for an extension and a disambiguating suffix. 120 chars keeps
    // us well inside the 255-byte limit even for multi-byte characters.
    truncate_chars(&out, 120)
}

fn is_reserved_device_name(name: &str) -> bool {
    let stem = match name.find('.') {
        Some(i) => &name[..i],
        None => name,
    };
    let stem = stem.trim().to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    if let Some(rest) = stem.strip_prefix("COM").or_else(|| stem.strip_prefix("LPT")) {
        return rest.len() == 1 && matches!(rest.as_bytes()[0], b'1'..=b'9');
    }
    false
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>().trim_end().to_string()
}

/// Compare two names the way a person would order pages: any run of digits is
/// compared as a number, so `page2` sorts before `page10`.
///
/// Comparison is case-insensitive for ASCII, which matters because archives
/// are often a mix of `Page01.jpg` and `page02.jpg`.
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let mut ai = a.char_indices().peekable();
    let mut bi = b.char_indices().peekable();

    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some((apos, ac)), Some((bpos, bc))) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let (anum, anext) = take_digits(a, apos);
                    let (bnum, bnext) = take_digits(b, bpos);

                    // Compare numerically by trimming leading zeros, then by
                    // length, then lexically. Falls back gracefully on runs too
                    // long to fit in any integer type.
                    let at = anum.trim_start_matches('0');
                    let bt = bnum.trim_start_matches('0');
                    let ord = at.len().cmp(&bt.len()).then_with(|| at.cmp(bt));
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    // Equal in value: shorter (fewer leading zeros) first, so
                    // the ordering stays total and stable.
                    let ord = anum.len().cmp(&bnum.len());
                    if ord != Ordering::Equal {
                        return ord;
                    }

                    advance_to(&mut ai, anext);
                    advance_to(&mut bi, bnext);
                } else {
                    let al = ac.to_ascii_lowercase();
                    let bl = bc.to_ascii_lowercase();
                    if al != bl {
                        return al.cmp(&bl);
                    }
                    ai.next();
                    bi.next();
                }
            }
        }
    }
}

/// Returns the run of digits starting at `from`, and the byte index just past it.
fn take_digits(s: &str, from: usize) -> (&str, usize) {
    let bytes = s.as_bytes();
    let mut end = from;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    (&s[from..end], end)
}

fn advance_to(it: &mut std::iter::Peekable<std::str::CharIndices<'_>>, target: usize) {
    while let Some((pos, _)) = it.peek().copied() {
        if pos >= target {
            break;
        }
        it.next();
    }
}

/// True when a path looks like an image we can show as a comic page.
pub fn is_image_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    // Reject anything inside a resource fork or hidden entry, which Mac-made
    // archives are full of and which are not real pages.
    let file = lower.rsplit('/').next().unwrap_or(&lower);
    if file.starts_with('.') || lower.contains("__macosx/") {
        return false;
    }
    [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"]
        .iter()
        .any(|ext| file.ends_with(ext))
}

/// The MIME type to hand the front end for an image page.
pub fn image_mime(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else {
        "image/jpeg"
    }
}


/// What kind of book a file is, judged from its first bytes rather than its
/// name. On Android the file picker hands over a `content://` link that often
/// carries no usable name at all, so the bytes are the only reliable witness.
///
/// An EPUB is a zip whose first entry is an uncompressed file called
/// `mimetype` holding `application/epub+zip`; the spec requires this so that
/// exactly this check works. Any other zip is treated as a comic.
pub fn sniff_format(bytes: &[u8], name_hint: &str) -> Option<&'static str> {
    if let Some(ext) = sniff_audio(bytes) {
        // The contents say "audio"; the name, when it is an audio name too,
        // says which flavour better (.m4b vs .m4a, .aac vs .mp3).
        let named = name_hint.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        if let Some(n) = named.as_deref().and_then(audio_ext) {
            return Some(n);
        }
        return Some(ext);
    }
    let hint_ext = name_hint.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if bytes.starts_with(b"Rar!\x1a\x07") {
        return Some("cbr");
    }
    if bytes.starts_with(b"7z\xbc\xaf\x27\x1c") {
        return Some("cb7");
    }
    if bytes.get(60..68) == Some(b"BOOKMOBI".as_slice()) {
        return Some(if hint_ext == "azw3" { "azw3" } else { "mobi" });
    }
    if bytes.starts_with(b"%PDF") {
        return Some("pdf");
    }
    if bytes.starts_with(b"PK\x03\x04") {
        let head = &bytes[..bytes.len().min(128)];
        if contains(head, b"mimetypeapplication/epub+zip") {
            return Some("epub");
        }
        // Some tools write the mimetype entry out of place; trust the name then.
        if name_hint.to_ascii_lowercase().ends_with(".epub") {
            return Some("epub");
        }
        return Some("cbz");
    }
    None
}

/// Whether version `a` ("1.0.1", "v1.2.0") is newer than `b`. Missing
/// parts count as 0; anything after a "-" (pre-releases) is ignored.
pub fn version_newer(a: &str, b: &str) -> bool {
    fn parts(v: &str) -> Vec<u64> {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    }
    let (x, y) = (parts(a), parts(b));
    for i in 0..x.len().max(y.len()) {
        let (p, q) = (x.get(i).copied().unwrap_or(0), y.get(i).copied().unwrap_or(0));
        if p != q {
            return p > q;
        }
    }
    false
}

/// Audio file extensions FicShelf plays (podfics), as the canonical
/// `&'static str` for an extension in any case.
pub fn audio_ext(ext: &str) -> Option<&'static str> {
    const ALL: &[&str] = &["mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "flac", "wav"];
    let lower = ext.to_ascii_lowercase();
    ALL.iter().copied().find(|e| *e == lower)
}

/// What kind of item a file extension is in the library: "epub", "pdf",
/// "cbz" or "audio".
pub fn kind_of_ext(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "epub" => Some("epub"),
        "pdf" => Some("pdf"),
        // Comics in any container read the same way.
        "cbz" | "zip" | "cbr" | "rar" | "cb7" | "7z" => Some("cbz"),
        // Kindle books, turned into EPUB for the reader.
        "mobi" | "azw3" | "azw" | "prc" => Some("mobi"),
        other => audio_ext(other).map(|_| "audio"),
    }
}

/// The audio format of a file from its first bytes, as an extension.
fn sniff_audio(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(b"ID3") {
        return Some("mp3");
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        let brand = &b[8..12];
        // An MP4 container. Only the audio brands count; a video is not a
        // podfic FicShelf can show.
        return match brand {
            b"M4B " | b"M4BP" => Some("m4b"),
            b"M4A " | b"M4P " | b"mp42" | b"isom" | b"dash" => Some("m4a"),
            _ => None,
        };
    }
    if b.starts_with(b"OggS") {
        return Some(if contains(&b[..b.len().min(256)], b"OpusHead") { "opus" } else { "ogg" });
    }
    if b.starts_with(b"fLaC") {
        return Some("flac");
    }
    if b.len() >= 12 && b.starts_with(b"RIFF") && &b[8..12] == b"WAVE" {
        return Some("wav");
    }
    // A bare MPEG audio frame: eleven sync bits, then a valid layer.
    if b.len() >= 2 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0 {
        let layer = (b[1] >> 1) & 0x03;
        let version = (b[1] >> 3) & 0x03;
        if layer == 0 && version != 1 {
            return Some("aac"); // ADTS
        }
        if layer != 0 {
            return Some("mp3");
        }
    }
    None
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// A best-effort file name out of whatever the platform's file picker gave
/// us: a plain path, or an Android `content://` link such as
/// `content://com.android.externalstorage.documents/document/primary%3ADownload%2FMy%20Fic.epub`.
/// Returns `None` when the link holds nothing that looks like a name, which
/// is common for the Downloads provider (`.../document/msf%3A1234`).
pub fn name_from_uri(uri: &str) -> Option<String> {
    let no_query = uri.split(['?', '#']).next().unwrap_or(uri);
    let last = no_query.rsplit('/').next().unwrap_or(no_query);
    let decoded = percent_decode(last);
    let name = decoded
        .rsplit(['/', '\\', ':'])
        .next()
        .unwrap_or(&decoded)
        .trim()
        .to_string();
    // Only a name with an extension is worth keeping; "1234" is an id.
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() || ext.len() > 5 {
        return None;
    }
    Some(name)
}

pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // Read the two hex digits as bytes: slicing the str could land
            // inside a multi-byte character and panic.
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn filenames_lose_forbidden_characters() {
        assert_eq!(safe_filename("a/b:c*d?", "x"), "a b c d");
        assert_eq!(safe_filename("  padded  ", "x"), "padded");
        assert_eq!(safe_filename("trailing...", "x"), "trailing");
        assert_eq!(safe_filename("", "fallback"), "fallback");
        assert_eq!(safe_filename("   ", "fallback"), "fallback");
    }

    #[test]
    fn windows_device_names_are_escaped() {
        assert_eq!(safe_filename("CON", "x"), "CON_");
        assert_eq!(safe_filename("con.epub", "x"), "con.epub_");
        assert_eq!(safe_filename("COM1", "x"), "COM1_");
        assert_eq!(safe_filename("LPT9", "x"), "LPT9_");
        // not reserved
        assert_eq!(safe_filename("COM10", "x"), "COM10");
        assert_eq!(safe_filename("CONSOLE", "x"), "CONSOLE");
    }

    #[test]
    fn long_names_are_truncated_without_splitting_characters() {
        let long = "é".repeat(200);
        let out = safe_filename(&long, "x");
        assert_eq!(out.chars().count(), 120);
    }

    #[test]
    fn pages_sort_the_way_people_expect() {
        let mut pages = vec![
            "page10.jpg",
            "page2.jpg",
            "page1.jpg",
            "page20.jpg",
            "page3.jpg",
        ];
        pages.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            pages,
            vec![
                "page1.jpg",
                "page2.jpg",
                "page3.jpg",
                "page10.jpg",
                "page20.jpg"
            ]
        );
    }

    #[test]
    fn zero_padded_and_bare_numbers_interleave_correctly() {
        let mut pages = vec!["p007.jpg", "p8.jpg", "p06.jpg", "p10.jpg"];
        pages.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(pages, vec!["p06.jpg", "p007.jpg", "p8.jpg", "p10.jpg"]);
    }

    #[test]
    fn natural_sort_is_case_insensitive_and_total() {
        assert_eq!(natural_cmp("Page1.jpg", "page1.jpg"), Ordering::Equal);
        assert_eq!(natural_cmp("a", "b"), Ordering::Less);
        assert_eq!(natural_cmp("b", "a"), Ordering::Greater);
        assert_eq!(natural_cmp("a", "ab"), Ordering::Less);
        assert_eq!(natural_cmp("", ""), Ordering::Equal);
        // chapter folders then pages
        let mut v = vec!["ch2/p1.jpg", "ch10/p1.jpg", "ch1/p2.jpg", "ch1/p10.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            vec!["ch1/p2.jpg", "ch1/p10.jpg", "ch2/p1.jpg", "ch10/p1.jpg"]
        );
    }

    #[test]
    fn huge_digit_runs_do_not_panic_or_overflow() {
        let a = format!("p{}.jpg", "9".repeat(60));
        let b = format!("p{}.jpg", "8".repeat(60));
        assert_eq!(natural_cmp(&a, &b), Ordering::Greater);
        let c = format!("p{}.jpg", "1".repeat(61));
        assert_eq!(natural_cmp(&c, &a), Ordering::Greater); // longer = larger
    }

    #[test]
    fn image_detection_skips_mac_rubbish() {
        assert!(is_image_name("pages/001.jpg"));
        assert!(is_image_name("A.PNG"));
        assert!(!is_image_name("__MACOSX/pages/._001.jpg"));
        assert!(!is_image_name("pages/.hidden.jpg"));
        assert!(!is_image_name("ComicInfo.xml"));
        assert!(!is_image_name("notes.txt"));
    }

    #[test]
    fn mime_types_match_extensions() {
        assert_eq!(image_mime("a.png"), "image/png");
        assert_eq!(image_mime("a.JPG"), "image/jpeg");
        assert_eq!(image_mime("a.webp"), "image/webp");
        assert_eq!(image_mime("a.unknown"), "image/jpeg");
    }

    #[test]
    fn formats_are_known_by_their_bytes() {
        let epub = b"PK\x03\x04\x0a\x00\x00\x00\x00\x00junkjunkjunkjunkjunkmimetypeapplication/epub+zipPK";
        assert_eq!(sniff_format(epub, ""), Some("epub"));
        assert_eq!(sniff_format(b"%PDF-1.7\n...", "whatever.epub"), Some("pdf"));
        assert_eq!(sniff_format(b"PK\x03\x04page001.jpg", ""), Some("cbz"));
        assert_eq!(sniff_format(b"PK\x03\x04odd", "Book.EPUB"), Some("epub"));
        assert_eq!(sniff_format(b"<html>", "x.epub"), None);
        assert_eq!(sniff_format(b"", ""), None);
    }

    #[test]
    fn names_come_out_of_android_links() {
        assert_eq!(
            name_from_uri("content://com.android.externalstorage.documents/document/primary%3ADownload%2FMy%20Fic.epub")
                .as_deref(),
            Some("My Fic.epub")
        );
        assert_eq!(name_from_uri("content://com.android.providers.downloads.documents/document/msf%3A1234"), None);
        assert_eq!(name_from_uri("/home/me/Books/A Book.pdf").as_deref(), Some("A Book.pdf"));
        assert_eq!(name_from_uri("C:\\Books\\Comic.cbz").as_deref(), Some("Comic.cbz"));
        assert_eq!(name_from_uri("content://x/document/raw%3A%2Fstorage%2Fa.cbz?x=1").as_deref(), Some("a.cbz"));
        assert_eq!(name_from_uri("content://x/document/100%"), None);
        // a stray % before a multi-byte character must not panic
        assert_eq!(name_from_uri("/x/%éa.pdf").as_deref(), Some("%éa.pdf"));
    }
}

#[cfg(test)]
mod audio_sniff_tests {
    use super::*;

    #[test]
    fn sniffs_audio() {
        assert_eq!(sniff_format(b"ID3\x03\x00\x00\x00\x00\x00\x00", "x.mp3"), Some("mp3"));
        assert_eq!(sniff_format(b"ID3\x03\x00\x00\x00\x00\x00\x00", ""), Some("mp3"));
        assert_eq!(sniff_format(&[0xFF, 0xFB, 0x90, 0x00], ""), Some("mp3"));
        assert_eq!(sniff_format(&[0xFF, 0xF1, 0x50, 0x80], ""), Some("aac"));
        assert_eq!(sniff_format(b"\0\0\0\x20ftypM4A \0\0\0\0", "Fic.m4b"), Some("m4b"));
        assert_eq!(sniff_format(b"\0\0\0\x20ftypM4B \0\0\0\0", ""), Some("m4b"));
        assert_eq!(sniff_format(b"\0\0\0\x20ftypqt  \0\0\0\0", ""), None);
        assert_eq!(sniff_format(b"OggS\0\x02xxxxxxxxxxxxxxxxxxxxxxOpusHead", ""), Some("opus"));
        assert_eq!(sniff_format(b"fLaC\0\0", ""), Some("flac"));
        assert_eq!(sniff_format(b"RIFF\0\0\0\0WAVEfmt ", ""), Some("wav"));
        assert_eq!(sniff_format(b"%PDF-1.7", "a.mp3"), Some("pdf"));
        assert_eq!(kind_of_ext("M4B"), Some("audio"));
        assert_eq!(kind_of_ext("zip"), Some("cbz"));
        assert_eq!(kind_of_ext("mp4"), None);
    }

    #[test]
    fn versions() {
        assert!(version_newer("v1.0.1", "1.0.0"));
        assert!(version_newer("1.1", "1.0.9"));
        assert!(version_newer("1.0.0", "0.7.5"));
        assert!(!version_newer("1.0.0", "1.0.0"));
        assert!(!version_newer("0.9.9", "1.0.0"));
        assert!(!version_newer("1.0.0-beta", "1.0.0"));
    }

    #[test]
    fn sniffs_more_formats() {
        assert_eq!(sniff_format(b"Rar!\x1a\x07\x01\x00", "x.cbr"), Some("cbr"));
        assert_eq!(sniff_format(b"7z\xbc\xaf\x27\x1c\x00\x04", ""), Some("cb7"));
        let mut mobi = vec![0u8; 80];
        mobi[60..68].copy_from_slice(b"BOOKMOBI");
        assert_eq!(sniff_format(&mobi, "book.azw3"), Some("azw3"));
        assert_eq!(sniff_format(&mobi, "book.mobi"), Some("mobi"));
        assert_eq!(kind_of_ext("CBR"), Some("cbz"));
        assert_eq!(kind_of_ext("azw3"), Some("mobi"));
    }
}
