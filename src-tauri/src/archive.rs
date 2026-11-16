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

pub struct EpubInfo {
    pub title: Option<String>,
    pub author: Option<String>,
    pub cover: Option<(Vec<u8>, String)>,
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
        return Ok(EpubInfo { title: None, author: None, cover: None });
    };

    let opf_xml = match read_entry(&mut archive, &opf_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(_) => return Ok(EpubInfo { title: None, author: None, cover: None }),
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

    Ok(EpubInfo { title: meta.title, author, cover })
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
