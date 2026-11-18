//! Reading inside EPUB and CBZ files, both of which are ZIP archives.
//!
//! Nothing is ever extracted to disk. Pages and covers are read out of the
//! archive on demand and handed straight to the front end.

use crate::opf;
use crate::util::{image_mime, is_image_name, natural_cmp};
use anyhow::{anyhow, Context, Result};
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Cap on a single extracted entry, so a malformed or hostile archive cannot
/// exhaust memory. No cover or comic page legitimately approaches this.
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;

fn open_zip(path: &Path) -> Result<zip::ZipArchive<File>> {
    let file = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    zip::ZipArchive::new(file).with_context(|| format!("reading {} as a zip archive", path.display()))
}

fn read_entry(archive: &mut zip::ZipArchive<File>, name: &str) -> Result<Vec<u8>> {
    let mut entry = archive
        .by_name(name)
        .with_context(|| format!("{name} is not in the archive"))?;
    if entry.size() > MAX_ENTRY_BYTES {
        return Err(anyhow!("{name} is implausibly large ({} bytes)", entry.size()));
    }
    let mut buf = Vec::with_capacity(entry.size().min(8 * 1024 * 1024) as usize);
    entry.read_to_end(&mut buf)?;
    Ok(buf)
}

// ------------------------------------------------------------------- EPUB

#[derive(Default)]
pub struct EpubInfo {
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover: Option<(Vec<u8>, String)>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
}

/// Whether an EPUB is DRM-locked, and by what. None for an open book.
pub fn epub_drm(path: &Path) -> Result<Option<&'static str>> {
    let mut archive = open_zip(path)?;
    let mut text = |name: &str| {
        read_entry(&mut archive, name).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
    };
    let encryption = text("META-INF/encryption.xml");
    let rights = text("META-INF/rights.xml");
    Ok(opf::drm_kind(encryption.as_deref(), rights.as_deref()))
}

/// Whether a PDF is locked with Adobe's DRM, which pdf.js cannot open. A
/// PDF with only an owner password (no printing, say) still opens fine and
/// is not reported. Adobe's handler is named in the trailer at the end of
/// the file, so only the last part is read.
pub fn pdf_drm(path: &Path) -> Result<Option<&'static str>> {
    use std::io::{Seek, SeekFrom};
    let mut f = File::open(path).with_context(|| format!("opening {}", path.display()))?;
    let len = f.metadata()?.len();
    let tail = len.min(256 * 1024);
    f.seek(SeekFrom::Start(len - tail))?;
    let mut buf = Vec::with_capacity(tail as usize);
    f.take(tail).read_to_end(&mut buf)?;
    let hay = String::from_utf8_lossy(&buf);
    Ok(hay.contains("EBX_HANDLER").then_some("Adobe DRM"))
}

/// Read title, author and cover image out of an EPUB.
///
/// Every step degrades quietly: a file whose metadata cannot be read still
/// imports, it just arrives with its file name as the title.
pub fn read_epub(path: &Path) -> Result<EpubInfo> {
    let mut archive = open_zip(path)?;

    let container = read_entry(&mut archive, "META-INF/container.xml")
        .ok()
        .and_then(|b| String::from_utf8(b).ok());

    let opf_path = container
        .as_deref()
        .and_then(opf::rootfile_path)
        // Some files omit or misspell container.xml; the conventional
        // locations are worth a try before giving up.
        .or_else(|| {
            ["OEBPS/content.opf", "content.opf", "OPS/content.opf"]
                .iter()
                .find(|p| archive.by_name(p).is_ok())
                .map(|p| p.to_string())
        });

    let Some(opf_path) = opf_path else {
        return Ok(EpubInfo::default());
    };

    let opf_xml = match read_entry(&mut archive, &opf_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return Ok(EpubInfo::default()),
    };

    let meta = opf::parse_opf(&opf_xml, &opf_path);

    let cover = meta.cover_href.as_deref().and_then(|href| {
        read_entry(&mut archive, href)
            .ok()
            .map(|bytes| (bytes, image_mime(href).to_string()))
    });

    let author = if meta.authors.is_empty() {
        None
    } else {
        Some(meta.authors.join(", "))
    };

    Ok(EpubInfo {
        title: meta.title,
        author,
        cover,
        series: meta.series,
        series_index: meta.series_index,
    })
}

// -------------------------------------------------------------------- CBZ

/// The image entries of a comic archive, in reading order.
pub fn cbz_pages(path: &Path) -> Result<Vec<String>> {
    let archive = open_zip(path)?;
    let mut names: Vec<String> = archive
        .file_names()
        .filter(|n| is_image_name(n))
        .map(|n| n.to_string())
        .collect();
    names.sort_by(|a, b| natural_cmp(a, b));
    Ok(names)
}

/// Zip files into an EPUB. The `mimetype` entry is written first and
/// uncompressed, as the EPUB standard requires; everything else is deflated.
/// Add FicShelf's podfic page (players and links for `urls`) to the end of
/// an EPUB, unless every one of those links is already in the book.
pub fn add_podfic_page(epub: &[u8], urls: &[String]) -> Result<Vec<u8>> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(epub))?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::with_capacity(zip.len() + 1);
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        if f.is_dir() || f.name() == "mimetype" {
            continue;
        }
        let mut bytes = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut bytes)?;
        files.push((f.name().to_string(), bytes));
    }

    let text = |name: &str| files.iter().find(|(n, _)| n == name).map(|(_, b)| String::from_utf8_lossy(b).into_owned());
    // Links the book already carries need no second copy.
    let in_book = |url: &str| {
        let escaped = crate::epubgen::xml_escape(url);
        files.iter().any(|(n, b)| {
            (n.ends_with(".xhtml") || n.ends_with(".html") || n.ends_with(".htm"))
                && (contains(b, url.as_bytes()) || contains(b, escaped.as_bytes()))
        })
    };
    let missing: Vec<String> = urls.iter().filter(|u| !in_book(u)).cloned().collect();
    if missing.is_empty() {
        return Ok(epub.to_vec());
    }

    let container = text("META-INF/container.xml").ok_or_else(|| anyhow::anyhow!("no container.xml"))?;
    let opf_path = crate::epubgen::rootfile_path(&container).ok_or_else(|| anyhow::anyhow!("no rootfile"))?;
    let opf = text(&opf_path).ok_or_else(|| anyhow::anyhow!("no OPF at {opf_path}"))?;
    let new_opf = crate::epubgen::opf_with_page(&opf, "ficshelf-podfic", "ficshelf-podfic.xhtml")
        .ok_or_else(|| anyhow::anyhow!("OPF has no manifest or spine"))?;
    let dir = opf_path.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
    let page_path = format!("{dir}ficshelf-podfic.xhtml");

    for f in files.iter_mut() {
        if f.0 == opf_path {
            f.1 = new_opf.clone().into_bytes();
        }
    }
    files.retain(|(n, _)| *n != page_path);
    files.push((page_path, crate::epubgen::podfic_xhtml(&missing).into_bytes()));
    let refs: Vec<(&str, &[u8])> = files.iter().map(|(n, b)| (n.as_str(), b.as_slice())).collect();
    write_epub(&refs)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

pub fn write_epub(files: &[(&str, &[u8])]) -> Result<Vec<u8>> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file(
        "mimetype",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )?;
    zip.write_all(b"application/epub+zip")?;
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, bytes) in files {
        zip.start_file(*name, deflated)?;
        zip.write_all(bytes)?;
    }
    Ok(zip.finish()?.into_inner())
}

/// What the comic's `ComicInfo.xml` says, if it has one. The name is matched
/// without regard to case or folder, since tools disagree on both.
pub fn cbz_info(path: &Path) -> Result<Option<opf::ComicMeta>> {
    let mut archive = open_zip(path)?;
    let name = archive
        .file_names()
        .find(|n| {
            n.rsplit('/')
                .next()
                .map(|b| b.eq_ignore_ascii_case("ComicInfo.xml"))
                .unwrap_or(false)
        })
        .map(|n| n.to_string());
    let Some(name) = name else { return Ok(None) };
    let bytes = read_entry(&mut archive, &name)?;
    Ok(Some(opf::parse_comicinfo(&String::from_utf8_lossy(&bytes))))
}

/// One page's bytes, with the MIME type the front end should display it as.
pub fn cbz_page(path: &Path, name: &str) -> Result<(Vec<u8>, String)> {
    if !is_image_name(name) {
        return Err(anyhow!("{name} is not an image"));
    }
    let mut archive = open_zip(path)?;
    let bytes = read_entry(&mut archive, name)?;
    Ok((bytes, image_mime(name).to_string()))
}

/// The first page, used as the library cover.
pub fn cbz_cover(path: &Path) -> Result<Option<(Vec<u8>, String)>> {
    let pages = cbz_pages(path)?;
    match pages.first() {
        Some(first) => cbz_page(path, first).map(Some),
        None => Ok(None),
    }
}

/// How many pages a comic has, without reading any of them.
pub fn cbz_page_count(path: &Path) -> Result<usize> {
    Ok(cbz_pages(path)?.len())
}
