//! Reading DRM-free MOBI / AZW3 books (Kindle formats), enough to turn them
//! into an EPUB for the reader: the text (PalmDOC-compressed, as Calibre and
//! KindleGen write it), the title and author, and the images.
//!
//! Books compressed with Amazon's HUFF/CDIC scheme, which in practice means
//! books bought from Amazon (and those carry DRM anyway), are refused with a
//! clear message. Free of external crates so it can be tested on its own.

#[derive(Debug, Default, PartialEq)]
pub struct MobiBook {
    pub title: String,
    pub author: Option<String>,
    /// The book's markup (HTML of the Kindle flavour), decoded to text.
    pub html: String,
    /// Image records in order; `recindex="N"` and `kindle:embed:N` count
    /// from 1 into this list.
    pub images: Vec<Vec<u8>>,
    /// True for a KF8 (AZW3) text, false for older MOBI.
    pub kf8: bool,
}

#[derive(Debug, PartialEq)]
pub enum MobiError {
    NotMobi,
    Encrypted,
    Huffman,
    Damaged(&'static str),
}

impl std::fmt::Display for MobiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            MobiError::NotMobi => "this is not a MOBI or AZW3 book",
            MobiError::Encrypted => "this Kindle book is locked with DRM, so FicShelf cannot open it",
            MobiError::Huffman => {
                "this Kindle book uses Amazon's own compression, which FicShelf cannot read; \
                 convert it to EPUB with Calibre first"
            }
            MobiError::Damaged(what) => what,
        })
    }
}

impl std::error::Error for MobiError {}

fn u16be(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?)))
}

fn u32be(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// The Palm database's records, as byte ranges of the file.
fn records(file: &[u8]) -> Option<Vec<&[u8]>> {
    let count = u16be(file, 76)? as usize;
    if count == 0 || 78 + count * 8 > file.len() {
        return None;
    }
    let mut starts = Vec::with_capacity(count);
    for i in 0..count {
        starts.push(u32be(file, 78 + i * 8)? as usize);
    }
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let a = starts[i];
        let b = if i + 1 < count { starts[i + 1] } else { file.len() };
        if a > b || b > file.len() {
            return None;
        }
        out.push(&file[a..b]);
    }
    Some(out)
}

/// PalmDOC (LZ77-style) decompression.
pub fn palmdoc_decompress(data: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 2);
    let mut i = 0;
    while i < data.len() {
        let c = data[i];
        i += 1;
        match c {
            0x00 | 0x09..=0x7F => out.push(c),
            0x01..=0x08 => {
                let n = c as usize;
                let end = (i + n).min(data.len());
                out.extend_from_slice(&data[i..end]);
                i = end;
            }
            0x80..=0xBF => {
                let Some(&next) = data.get(i) else { break };
                i += 1;
                let v = ((u16::from(c) << 8) | u16::from(next)) & 0x3FFF;
                let dist = (v >> 3) as usize;
                let len = (v & 7) as usize + 3;
                if dist == 0 || dist > out.len() {
                    continue; // a damaged back-reference: skip it
                }
                let start = out.len() - dist;
                for k in 0..len {
                    let b = out[start + k];
                    out.push(b);
                }
            }
            0xC0..=0xFF => {
                out.push(b' ');
                out.push(c ^ 0x80);
            }
        }
    }
    out
}

/// The size of one trailing entry, read backwards from the end of `data`.
fn trailing_entry_size(data: &[u8]) -> usize {
    let mut num: usize = 0;
    let start = data.len().saturating_sub(4);
    for &v in &data[start..] {
        if v & 0x80 != 0 {
            num = 0;
        }
        num = (num << 7) | usize::from(v & 0x7F);
    }
    num
}

/// How many bytes at the end of a text record are not text, per the
/// "extra data flags" of the MOBI header.
pub fn trailing_size(data: &[u8], flags: u32) -> usize {
    let mut num = 0usize;
    let mut f = flags >> 1;
    while f != 0 {
        if f & 1 != 0 {
            if num >= data.len() {
                return data.len();
            }
            num += trailing_entry_size(&data[..data.len() - num]);
        }
        f >>= 1;
    }
    if flags & 1 != 0 && num < data.len() {
        num += usize::from(data[data.len() - num - 1] & 0x3) + 1;
    }
    num.min(data.len())
}

/// Windows-1252, for old MOBI files that are not UTF-8.
fn cp1252(bytes: &[u8]) -> String {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}',
        '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    bytes
        .iter()
        .map(|&b| if (0x80..0xA0).contains(&b) { HIGH[(b - 0x80) as usize] } else { b as char })
        .collect()
}

fn is_image(b: &[u8]) -> bool {
    b.starts_with(&[0xFF, 0xD8]) || b.starts_with(b"\x89PNG") || b.starts_with(b"GIF8") || b.starts_with(b"BM")
}

pub fn parse(file: &[u8]) -> Result<MobiBook, MobiError> {
    if file.get(60..68) != Some(b"BOOKMOBI".as_slice()) {
        return Err(MobiError::NotMobi);
    }
    let recs = records(file).ok_or(MobiError::Damaged("the book's record table is damaged"))?;
    let r0 = recs[0];
    let compression = u16be(r0, 0).ok_or(MobiError::Damaged("the book's header is damaged"))?;
    let text_records = u16be(r0, 8).unwrap_or(0) as usize;
    let encryption = u16be(r0, 12).unwrap_or(0);
    if encryption != 0 {
        return Err(MobiError::Encrypted);
    }
    if compression == 17480 {
        return Err(MobiError::Huffman);
    }
    if r0.get(16..20) != Some(b"MOBI".as_slice()) {
        return Err(MobiError::Damaged("the book has no MOBI header"));
    }
    let header_len = u32be(r0, 20).unwrap_or(0) as usize;
    let encoding = u32be(r0, 28).unwrap_or(1252);
    let version = u32be(r0, 36).unwrap_or(0);
    let first_image = u32be(r0, 108).unwrap_or(u32::MAX) as usize;
    // Offsets here are from the start of record 0, as in the MobileRead
    // format notes.
    let extra_flags = if header_len >= 0xE4 { u16be(r0, 0xF2).unwrap_or(0) } else { 0 };

    // Title: the full name the header points at; EXTH 503 when present.
    let mut title = {
        let off = u32be(r0, 84).unwrap_or(0) as usize;
        let len = u32be(r0, 88).unwrap_or(0) as usize;
        r0.get(off..off + len).map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default()
    };
    let mut author = None;
    let mut kf8_boundary = None;
    let exth_flag = u32be(r0, 128).unwrap_or(0);
    if exth_flag & 0x40 != 0 {
        let at = 16 + header_len;
        if r0.get(at..at + 4) == Some(b"EXTH".as_slice()) {
            let count = u32be(r0, at + 8).unwrap_or(0) as usize;
            let mut p = at + 12;
            for _ in 0..count.min(1000) {
                let (Some(kind), Some(len)) = (u32be(r0, p), u32be(r0, p + 4)) else { break };
                let len = len as usize;
                if len < 8 {
                    break;
                }
                let data = r0.get(p + 8..p + len).unwrap_or(&[]);
                let text = || {
                    let s = String::from_utf8_lossy(data).trim().to_string();
                    (!s.is_empty()).then_some(s)
                };
                match kind {
                    100 if author.is_none() => author = text(),
                    503 => {
                        if let Some(t) = text() {
                            title = t;
                        }
                    }
                    121 => kf8_boundary = u32be(data, 0).map(|n| n as usize),
                    _ => {}
                }
                p += len;
            }
        }
    }

    // A combined MOBI+KF8 file: the old MOBI part comes first and is
    // complete on its own, which is the part read here. A KF8-only file
    // (version 8) is read as it is.
    let kf8 = version >= 8 && kf8_boundary.is_none();
    let mut text: Vec<u8> = Vec::new();
    for rec in recs.iter().skip(1).take(text_records) {
        let body = &rec[..rec.len() - trailing_size(rec, extra_flags)];
        match compression {
            1 => text.extend_from_slice(body),
            2 => text.extend_from_slice(&palmdoc_decompress(body)),
            _ => return Err(MobiError::Damaged("the book uses a compression FicShelf does not know")),
        }
    }
    let html = if encoding == 65001 { String::from_utf8_lossy(&text).into_owned() } else { cp1252(&text) };

    let mut images = Vec::new();
    if first_image != u32::MAX as usize && first_image < recs.len() {
        let end = kf8_boundary.unwrap_or(recs.len()).min(recs.len());
        for rec in &recs[first_image..end.max(first_image)] {
            // Non-image records (fonts, resources, end markers) keep their
            // place so the numbering still lines up.
            images.push(if is_image(rec) { rec.to_vec() } else { Vec::new() });
        }
    }

    if title.trim().is_empty() {
        title = String::from_utf8_lossy(&file[..32]).trim_end_matches('\0').replace('_', " ").trim().to_string();
    }
    Ok(MobiBook { title, author, html, images, kf8 })
}

/// The 1-based image number in `recindex="00012"` or `kindle:embed:000C`.
pub fn image_ref(value: &str) -> Option<usize> {
    if let Some(rest) = value.strip_prefix("kindle:embed:") {
        let code: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        // Base 32 with the digits 0-9A-V.
        return usize::from_str_radix(&code, 32).ok().filter(|n| *n > 0);
    }
    value.trim().parse::<usize>().ok().filter(|n| *n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palmdoc() {
        // literal "abc", then a back-reference of 3 bytes, distance 3.
        let v: u16 = 0x8000 | (3 << 3) | (3 - 3);
        let data = [b'a', b'b', b'c', (v >> 8) as u8, (v & 0xFF) as u8, 0xC0 | b'x' ^ 0x80 | 0x80];
        let out = palmdoc_decompress(&data);
        assert_eq!(&out[..6], b"abcabc");
        assert_eq!(palmdoc_decompress(&[0x02, b'h', b'i']), b"hi");
        assert_eq!(palmdoc_decompress(&[0xE8]), b" h");
    }

    #[test]
    fn trailing_entries() {
        // Multibyte flag only: last byte's low two bits + 1.
        assert_eq!(trailing_size(&[b'a', b'b', 0x01], 1), 2);
        // One trailing entry of 3 bytes (size encoded in its last byte).
        assert_eq!(trailing_size(&[b'a', b'b', 9, 9, 0x83], 2), 3);
        assert_eq!(trailing_size(&[], 3), 0);
    }

    #[test]
    fn image_refs() {
        assert_eq!(image_ref("00012"), Some(12));
        assert_eq!(image_ref("kindle:embed:000C?mime=image/jpg"), Some(12));
        assert_eq!(image_ref("0"), None);
    }

    #[test]
    fn small_book_round_trip() {
        // A minimal PalmDB with record 0 (headers) and one uncompressed text
        // record.
        let text = b"<html><body><h2>One</h2><p>Hello</p></body></html>".to_vec();
        let mut r0 = vec![0u8; 16 + 0xE8];
        r0[0..2].copy_from_slice(&1u16.to_be_bytes()); // no compression
        r0[4..8].copy_from_slice(&(text.len() as u32).to_be_bytes());
        r0[8..10].copy_from_slice(&1u16.to_be_bytes()); // one text record
        r0[16..20].copy_from_slice(b"MOBI");
        r0[20..24].copy_from_slice(&0xE8u32.to_be_bytes());
        r0[28..32].copy_from_slice(&65001u32.to_be_bytes());
        r0[36..40].copy_from_slice(&6u32.to_be_bytes());
        r0[108..112].copy_from_slice(&u32::MAX.to_be_bytes());
        let name = b"A Small Book";
        let name_at = r0.len() as u32;
        r0[84..88].copy_from_slice(&name_at.to_be_bytes());
        r0[88..92].copy_from_slice(&(name.len() as u32).to_be_bytes());
        r0.extend_from_slice(name);

        let mut file = vec![0u8; 78 + 2 * 8 + 2];
        file[..12].copy_from_slice(b"A_Small_Book");
        file[60..68].copy_from_slice(b"BOOKMOBI");
        file[76..78].copy_from_slice(&2u16.to_be_bytes());
        let r0_at = file.len() as u32;
        let r1_at = r0_at + r0.len() as u32;
        file[78..82].copy_from_slice(&r0_at.to_be_bytes());
        file[86..90].copy_from_slice(&r1_at.to_be_bytes());
        file.extend_from_slice(&r0);
        file.extend_from_slice(&text);

        let b = parse(&file).unwrap();
        assert_eq!(b.title, "A Small Book");
        assert!(b.html.contains("<p>Hello</p>"));
        assert!(!b.kf8);
        assert_eq!(parse(b"not a book at all, nope.............................................................."), Err(MobiError::NotMobi));
    }
}
