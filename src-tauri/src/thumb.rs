//! Covers are kept as thumbnails. A comic's cover is its first page, often
//! several megabytes; a library of a thousand comics would otherwise carry
//! gigabytes of covers in its database (and in every backup of it).

/// Covers smaller than this are kept as they are.
const KEEP_UNDER: usize = 150 * 1024;
const MAX_W: u32 = 360;
const MAX_H: u32 = 540;

/// A cover, shrunk to a JPEG thumbnail if it is large. Anything that cannot
/// be decoded is kept as it was; the library shrinks it later when it is
/// first shown.
pub fn shrink(bytes: Vec<u8>, mime: String) -> (Vec<u8>, String) {
    if bytes.len() <= KEEP_UNDER {
        return (bytes, mime);
    }
    match small_jpeg(&bytes) {
        Some(out) if out.len() < bytes.len() => (out, "image/jpeg".to_string()),
        _ => (bytes, mime),
    }
}

fn small_jpeg(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let rgb = img.thumbnail(MAX_W, MAX_H).to_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82)
        .encode_image(&rgb)
        .ok()?;
    Some(out)
}
