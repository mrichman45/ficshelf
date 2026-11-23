//! Mending EPUBs whose zip says one size for a file and holds another.
//!
//! The reader unpacks EPUBs with JSZip, which stops with "uncompressed data
//! size mismatch" when an entry's recorded size is not what it unpacks to.
//! Other apps shrug this off, and some tools that make EPUBs get it wrong.
//! Here each entry is unpacked by hand, ignoring the recorded sizes, and if
//! any disagree the book is written out again with the true ones.

use anyhow::Result;
use std::io::{Cursor, Read, Write};

/// One entry, unpacked: its name and its real contents.
fn entries(bytes: &[u8]) -> Result<(Vec<(String, Vec<u8>)>, bool)> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
    let mut out = Vec::with_capacity(zip.len());
    let mut bad = false;
    for i in 0..zip.len() {
        let mut f = zip.by_index_raw(i)?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        let declared = f.size();
        let method = f.compression();
        let mut raw = Vec::with_capacity(f.compressed_size() as usize);
        // A short read means the recorded compressed size is wrong too:
        // keep what there is.
        if f.read_to_end(&mut raw).is_err() {
            bad = true;
        }
        let data = match method {
            zip::CompressionMethod::Stored => raw,
            zip::CompressionMethod::Deflated => {
                let mut d = flate2::read::DeflateDecoder::new(&raw[..]);
                let mut v = Vec::with_capacity(declared.min(64 << 20) as usize);
                if d.read_to_end(&mut v).is_err() {
                    bad = true;
                }
                v
            }
            // Anything else is left for the reader to deal with.
            _ => return Ok((Vec::new(), false)),
        };
        if data.len() as u64 != declared {
            bad = true;
        }
        out.push((name, data));
    }
    Ok((out, bad))
}

/// The book rewritten with correct sizes, or None when it needs nothing.
pub fn mend(bytes: &[u8]) -> Result<Option<Vec<u8>>> {
    let (mut files, bad) = entries(bytes)?;
    if !bad || files.is_empty() {
        return Ok(None);
    }
    use zip::write::SimpleFileOptions;
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::with_capacity(bytes.len() + 4096)));
    // "mimetype" goes first and uncompressed, as EPUB requires.
    if let Some(i) = files.iter().position(|(n, _)| n == "mimetype") {
        let (n, d) = files.remove(i);
        out.start_file(n, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored))?;
        out.write_all(&d)?;
    }
    for (n, d) in files {
        out.start_file(n, SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated))?;
        out.write_all(&d)?;
    }
    Ok(Some(out.finish()?.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> Vec<u8> {
        use zip::write::SimpleFileOptions;
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        z.start_file("mimetype", SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
        z.write_all(b"application/epub+zip").unwrap();
        z.start_file("OEBPS/ch1.xhtml", SimpleFileOptions::default()).unwrap();
        z.write_all(&b"<p>Hello</p>".repeat(50)).unwrap();
        z.finish().unwrap().into_inner()
    }

    #[test]
    fn good_books_are_left_alone() {
        assert!(mend(&book()).unwrap().is_none());
    }

    #[test]
    fn wrong_sizes_are_mended() {
        let mut b = book();
        // Corrupt the recorded uncompressed size of ch1 in the central
        // directory (offset 24 into its record).
        let name = b"OEBPS/ch1.xhtml";
        let cd = b.windows(4).rposition(|w| w == [0x50, 0x4b, 0x01, 0x02]).unwrap();
        assert_eq!(&b[cd + 46..cd + 46 + name.len()], name);
        b[cd + 24] = b[cd + 24].wrapping_add(7);
        let fixed = mend(&b).unwrap().expect("mended");
        let mut z = zip::ZipArchive::new(Cursor::new(fixed)).unwrap();
        assert_eq!(z.by_index(0).unwrap().name(), "mimetype");
        let mut s = String::new();
        z.by_name("OEBPS/ch1.xhtml").unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s.len(), 600);
    }
}
