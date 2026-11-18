//! Title, reader and cover from podfic audio files: ID3v2 tags (MP3) and
//! iTunes-style MP4 tags (M4A, M4B). Free of external crates so it can be
//! tested on its own. Anything it cannot read is simply left out; the file
//! name stands in for the title.

use std::io::{Read, Seek, SeekFrom};

#[derive(Debug, Default, PartialEq)]
pub struct AudioTags {
    pub title: Option<String>,
    /// The artist, which for a podfic is the reader.
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Cover image bytes and MIME type.
    pub cover: Option<(Vec<u8>, String)>,
}

/// Largest cover kept from a tag.
const MAX_COVER: usize = 8 * 1024 * 1024;
/// Largest ID3 tag read into memory (covers make them big).
const MAX_ID3: usize = 16 * 1024 * 1024;

/// Read whatever tags the file has, by its extension.
pub fn read_tags(path: &std::path::Path) -> AudioTags {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let Ok(mut f) = std::fs::File::open(path) else {
        return AudioTags::default();
    };
    match ext.as_str() {
        "mp3" | "aac" => read_id3(&mut f).unwrap_or_default(),
        "m4a" | "m4b" => read_mp4(&mut f).unwrap_or_default(),
        _ => AudioTags::default(),
    }
}

// ------------------------------------------------------------------ ID3v2

fn read_id3<R: Read>(r: &mut R) -> Option<AudioTags> {
    let mut header = [0u8; 10];
    r.read_exact(&mut header).ok()?;
    if &header[..3] != b"ID3" {
        return None;
    }
    let size = syncsafe(&header[6..10]) as usize;
    if size > MAX_ID3 {
        return None;
    }
    let mut body = vec![0u8; size];
    r.read_exact(&mut body).ok()?;
    let mut tag = header.to_vec();
    tag.extend_from_slice(&body);
    parse_id3(&tag)
}

fn syncsafe(b: &[u8]) -> u32 {
    b.iter().fold(0u32, |acc, &x| (acc << 7) | u32::from(x & 0x7F))
}

/// Parse a whole ID3v2.2/2.3/2.4 tag, header included.
pub fn parse_id3(tag: &[u8]) -> Option<AudioTags> {
    if tag.len() < 10 || &tag[..3] != b"ID3" {
        return None;
    }
    let version = tag[3];
    let flags = tag[5];
    let size = (syncsafe(&tag[6..10]) as usize).min(tag.len() - 10);
    let mut body = &tag[10..10 + size];
    // Whole-tag unsynchronisation (old v2.3 writers): undo it.
    let undone;
    if flags & 0x80 != 0 && version < 4 {
        undone = unsync(body);
        body = &undone;
    }
    // Skip an extended header.
    if flags & 0x40 != 0 && version >= 3 && body.len() >= 4 {
        let ext = if version == 4 {
            syncsafe(&body[..4]) as usize
        } else {
            u32::from_be_bytes(body[..4].try_into().ok()?) as usize + 4
        };
        body = body.get(ext..)?;
    }

    let mut tags = AudioTags::default();
    let (id_len, head_len) = if version == 2 { (3, 6) } else { (4, 10) };
    let mut i = 0;
    while i + head_len <= body.len() {
        let id = &body[i..i + id_len];
        if id[0] == 0 {
            break; // padding
        }
        let fsize = match version {
            2 => (usize::from(body[i + 3]) << 16) | (usize::from(body[i + 4]) << 8) | usize::from(body[i + 5]),
            3 => u32::from_be_bytes(body[i + 4..i + 8].try_into().ok()?) as usize,
            _ => syncsafe(&body[i + 4..i + 8]) as usize,
        };
        let start = i + head_len;
        let Some(data) = body.get(start..start + fsize) else { break };
        match id {
            b"TIT2" | b"TT2" => tags.title = tags.title.take().or_else(|| id3_text(data)),
            b"TPE1" | b"TP1" => tags.artist = tags.artist.take().or_else(|| id3_text(data)),
            b"TALB" | b"TAL" => tags.album = tags.album.take().or_else(|| id3_text(data)),
            b"APIC" if tags.cover.is_none() => tags.cover = apic(data),
            b"PIC" if tags.cover.is_none() => tags.cover = pic22(data),
            _ => {}
        }
        i = start + fsize;
    }
    Some(tags)
}

fn unsync(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        out.push(b[i]);
        if b[i] == 0xFF && b.get(i + 1) == Some(&0x00) {
            i += 1;
        }
        i += 1;
    }
    out
}

/// A text frame: an encoding byte, then the text.
fn id3_text(data: &[u8]) -> Option<String> {
    let (&enc, rest) = data.split_first()?;
    let s = decode(enc, rest);
    // v2.4 allows several values separated by NULs; the first is enough.
    let first = s.split('\0').next().unwrap_or("").trim().to_string();
    (!first.is_empty()).then_some(first)
}

fn decode(enc: u8, b: &[u8]) -> String {
    match enc {
        0 => b.iter().map(|&c| c as char).collect(),
        1 | 2 => {
            let (big, body) = match b {
                [0xFE, 0xFF, rest @ ..] => (true, rest),
                [0xFF, 0xFE, rest @ ..] => (false, rest),
                _ => (enc == 2, b),
            };
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| if big { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
                .collect();
            String::from_utf16_lossy(&units)
        }
        _ => String::from_utf8_lossy(b).into_owned(),
    }
}

/// The end of a NUL-terminated string in the given encoding, and the index
/// just past its terminator.
fn after_terminated(enc: u8, b: &[u8]) -> Option<usize> {
    if enc == 1 || enc == 2 {
        let mut i = 0;
        while i + 1 < b.len() {
            if b[i] == 0 && b[i + 1] == 0 {
                return Some(i + 2);
            }
            i += 2;
        }
        None
    } else {
        b.iter().position(|&c| c == 0).map(|p| p + 1)
    }
}

fn apic(data: &[u8]) -> Option<(Vec<u8>, String)> {
    let (&enc, rest) = data.split_first()?;
    let mime_end = rest.iter().position(|&c| c == 0)?;
    let mut mime = String::from_utf8_lossy(&rest[..mime_end]).to_ascii_lowercase();
    let rest = rest.get(mime_end + 1..)?;
    let rest = rest.get(1..)?; // picture type
    let pic = rest.get(after_terminated(enc, rest)?..)?;
    if mime.is_empty() || mime == "image/jpg" || !mime.contains('/') {
        mime = image_mime(pic)?.to_string();
    }
    cover(pic, mime)
}

fn pic22(data: &[u8]) -> Option<(Vec<u8>, String)> {
    let (&enc, rest) = data.split_first()?;
    let rest = rest.get(4..)?; // three-letter format, picture type
    let pic = rest.get(after_terminated(enc, rest)?..)?;
    cover(pic, image_mime(pic)?.to_string())
}

fn cover(pic: &[u8], mime: String) -> Option<(Vec<u8>, String)> {
    (!pic.is_empty() && pic.len() <= MAX_COVER && mime.starts_with("image/")).then(|| (pic.to_vec(), mime))
}

fn image_mime(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0xFF, 0xD8]) {
        Some("image/jpeg")
    } else if b.starts_with(b"\x89PNG") {
        Some("image/png")
    } else if b.starts_with(b"GIF8") {
        Some("image/gif")
    } else if b.len() > 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

// -------------------------------------------------------------------- MP4

/// Walk to moov/udta/meta/ilst and read it. moov is often at the very end
/// of a long audiobook, so the file is walked by seeking, never read whole.
fn read_mp4<R: Read + Seek>(r: &mut R) -> Option<AudioTags> {
    let end = r.seek(SeekFrom::End(0)).ok()?;
    let (start, len) = find_box(r, 0, end, b"moov")?;
    let (start, len) = find_box(r, start, start + len, b"udta")?;
    let (start, len) = find_box(r, start, start + len, b"meta")?;
    // meta is a "full box": four bytes of version and flags first.
    let (start, len) = find_box(r, start + 4, start + len, b"ilst")?;
    if len > MAX_ID3 as u64 {
        return None;
    }
    r.seek(SeekFrom::Start(start)).ok()?;
    let mut ilst = vec![0u8; len as usize];
    r.read_exact(&mut ilst).ok()?;
    Some(parse_ilst(&ilst))
}

/// Find a child box by type between `from` and `to`; returns where its
/// contents start and how long they are.
fn find_box<R: Read + Seek>(r: &mut R, from: u64, to: u64, kind: &[u8; 4]) -> Option<(u64, u64)> {
    let mut pos = from;
    while pos + 8 <= to {
        r.seek(SeekFrom::Start(pos)).ok()?;
        let mut h = [0u8; 8];
        r.read_exact(&mut h).ok()?;
        let mut size = u64::from(u32::from_be_bytes(h[..4].try_into().ok()?));
        let mut head = 8;
        if size == 1 {
            let mut big = [0u8; 8];
            r.read_exact(&mut big).ok()?;
            size = u64::from_be_bytes(big);
            head = 16;
        } else if size == 0 {
            size = to - pos;
        }
        if size < head {
            return None;
        }
        if &h[4..8] == kind {
            return Some((pos + head, size - head));
        }
        pos += size;
    }
    None
}

/// The items of an ilst box: each a box whose `data` child holds the value.
pub fn parse_ilst(ilst: &[u8]) -> AudioTags {
    let mut tags = AudioTags::default();
    let mut i = 0;
    while i + 8 <= ilst.len() {
        let size = u32::from_be_bytes(ilst[i..i + 4].try_into().unwrap()) as usize;
        if size < 8 || i + size > ilst.len() {
            break;
        }
        let kind = &ilst[i + 4..i + 8];
        let item = &ilst[i + 8..i + size];
        // data box: size, "data", type (4), locale (4), value.
        if item.len() >= 16 && &item[4..8] == b"data" {
            let dsize = (u32::from_be_bytes(item[..4].try_into().unwrap()) as usize).min(item.len());
            let dtype = u32::from_be_bytes(item[8..12].try_into().unwrap()) & 0x00FF_FFFF;
            let value = &item[16..dsize.max(16)];
            let text = || {
                let s = String::from_utf8_lossy(value).trim().to_string();
                (!s.is_empty()).then_some(s)
            };
            match kind {
                b"\xA9nam" => tags.title = text(),
                b"\xA9ART" => tags.artist = text(),
                b"aART" if tags.artist.is_none() => tags.artist = text(),
                b"\xA9alb" => tags.album = text(),
                b"covr" if tags.cover.is_none() => {
                    let mime = match dtype {
                        13 => Some("image/jpeg"),
                        14 => Some("image/png"),
                        _ => image_mime(value),
                    };
                    if let Some(m) = mime {
                        tags.cover = cover(value, m.to_string());
                    }
                }
                _ => {}
            }
        }
        i += size;
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame23(id: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut f = id.to_vec();
        f.extend_from_slice(&(data.len() as u32).to_be_bytes());
        f.extend_from_slice(&[0, 0]);
        f.extend_from_slice(data);
        f
    }

    fn tag(version: u8, frames: &[u8]) -> Vec<u8> {
        let n = frames.len() as u32;
        let mut t = b"ID3".to_vec();
        t.extend_from_slice(&[version, 0, 0]);
        t.extend_from_slice(&[((n >> 21) & 0x7F) as u8, ((n >> 14) & 0x7F) as u8, ((n >> 7) & 0x7F) as u8, (n & 0x7F) as u8]);
        t.extend_from_slice(frames);
        t
    }

    #[test]
    fn id3v23_text_and_cover() {
        let mut frames = frame23(b"TIT2", b"\x00Podfic of Stars");
        // UTF-16 with BOM: "Reader"
        let mut utf16 = vec![1u8, 0xFF, 0xFE];
        for u in "Réader".encode_utf16() {
            utf16.extend_from_slice(&u.to_le_bytes());
        }
        frames.extend(frame23(b"TPE1", &utf16));
        let mut apic = vec![0u8];
        apic.extend_from_slice(b"image/jpeg\0");
        apic.push(3);
        apic.extend_from_slice(b"desc\0");
        apic.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);
        frames.extend(frame23(b"APIC", &apic));
        frames.extend_from_slice(&[0; 20]); // padding

        let t = parse_id3(&tag(3, &frames)).unwrap();
        assert_eq!(t.title.as_deref(), Some("Podfic of Stars"));
        assert_eq!(t.artist.as_deref(), Some("Réader"));
        let (bytes, mime) = t.cover.unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(bytes, vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]);
        assert_eq!(read_id3(&mut std::io::Cursor::new(tag(3, &frames))).unwrap().title.as_deref(), Some("Podfic of Stars"));
    }

    #[test]
    fn id3v24_syncsafe_frames_and_utf8() {
        let data = b"\x03Chapter One\x00";
        let mut f = b"TIT2".to_vec();
        f.extend_from_slice(&[0, 0, 0, data.len() as u8, 0, 0]);
        f.extend_from_slice(data);
        let t = parse_id3(&tag(4, &f)).unwrap();
        assert_eq!(t.title.as_deref(), Some("Chapter One"));
    }

    #[test]
    fn mp4_tags() {
        fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
            let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
            b.extend_from_slice(kind);
            b.extend_from_slice(body);
            b
        }
        fn data(t: u32, v: &[u8]) -> Vec<u8> {
            let mut d = t.to_be_bytes().to_vec();
            d.extend_from_slice(&[0; 4]);
            d.extend_from_slice(v);
            bx(b"data", &d)
        }
        let mut ilst = bx(b"\xA9nam", &data(1, b"A Long Podfic"));
        ilst.extend(bx(b"\xA9ART", &data(1, b"Some Reader")));
        ilst.extend(bx(b"covr", &data(14, b"\x89PNGxyz")));
        let mut meta = vec![0u8; 4];
        meta.extend(bx(b"hdlr", &[0; 25]));
        meta.extend(bx(b"ilst", &ilst));
        let moov = bx(b"moov", &[bx(b"mvhd", &[0; 100]), bx(b"udta", &bx(b"meta", &meta))].concat());
        let mut file = bx(b"ftyp", b"M4B \0\0\0\0");
        file.extend(bx(b"mdat", &[7; 1000]));
        file.extend(moov);

        let t = read_mp4(&mut std::io::Cursor::new(file)).unwrap();
        assert_eq!(t.title.as_deref(), Some("A Long Podfic"));
        assert_eq!(t.artist.as_deref(), Some("Some Reader"));
        assert_eq!(t.cover.unwrap().1, "image/png");
    }
}
