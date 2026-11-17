//! What FicShelf syncs between devices, and how two copies are merged.
//!
//! One small document, kept in the hidden app-data folder of the user's
//! Google Drive, holds every book's reading position, edited details,
//! bookmarks, highlights and notes. Each device downloads it, merges it with
//! its own state, applies the result and uploads it again.
//!
//! Merging is per item and the most recent change wins. Deleting an
//! annotation leaves a tombstone, so the deletion reaches every device
//! rather than the note coming back from one that still has it.
//!
//! Books are matched across devices by key: `ao3:<work id>` for AO3 works,
//! otherwise a fingerprint of the file's contents (`fp:<hash>:<size>`), so
//! the same file added on two devices is the same book.
//!
//! No I/O and no dependencies beyond serde, so the merge rules are tested on
//! their own. (`nodeps` is set only when testing outside the app.)

use std::collections::BTreeMap;

#[cfg_attr(not(nodeps), derive(serde::Serialize, serde::Deserialize))]
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SyncFile {
    pub version: u32,
    pub books: BTreeMap<String, BookSync>,
    /// Deleted annotations, by uid, with when they were deleted.
    #[cfg_attr(not(nodeps), serde(default))]
    pub tombstones: BTreeMap<String, i64>,
}

#[cfg_attr(not(nodeps), derive(serde::Serialize, serde::Deserialize))]
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BookSync {
    /// For recognising the book; not merged.
    #[cfg_attr(not(nodeps), serde(default))]
    pub title: String,
    #[cfg_attr(not(nodeps), serde(default))]
    pub position: Option<Stamped<String>>,
    #[cfg_attr(not(nodeps), serde(default))]
    pub details: Option<Stamped<Details>>,
    #[cfg_attr(not(nodeps), serde(default))]
    pub annotations: BTreeMap<String, AnnotationSync>,
}

/// A value with when it was set (seconds since 1970).
#[cfg_attr(not(nodeps), derive(serde::Serialize, serde::Deserialize))]
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stamped<T> {
    pub value: T,
    pub at: i64,
}

/// Details the user edited by hand.
#[cfg_attr(not(nodeps), derive(serde::Serialize, serde::Deserialize))]
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Details {
    pub title: String,
    pub author: Option<String>,
    pub series: Option<String>,
    pub series_index: Option<f64>,
}

#[cfg_attr(not(nodeps), derive(serde::Serialize, serde::Deserialize))]
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnnotationSync {
    pub cfi: String,
    pub excerpt: String,
    pub note: Option<String>,
    pub color: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub const VERSION: u32 = 1;

/// The later of two stamped values; on a tie, `a`.
fn newer<T: Clone>(a: &Option<Stamped<T>>, b: &Option<Stamped<T>>) -> Option<Stamped<T>> {
    match (a, b) {
        (Some(x), Some(y)) => Some(if y.at > x.at { y.clone() } else { x.clone() }),
        (Some(x), None) => Some(x.clone()),
        (None, Some(y)) => Some(y.clone()),
        (None, None) => None,
    }
}

/// Merge two sync documents. Symmetric apart from ties, which go to `a`.
pub fn merge(a: &SyncFile, b: &SyncFile) -> SyncFile {
    let mut tombstones = a.tombstones.clone();
    for (uid, at) in &b.tombstones {
        let e = tombstones.entry(uid.clone()).or_insert(*at);
        *e = (*e).max(*at);
    }

    let mut books = BTreeMap::new();
    let keys: std::collections::BTreeSet<&String> = a.books.keys().chain(b.books.keys()).collect();
    for key in keys {
        let empty = BookSync::default();
        let x = a.books.get(key).unwrap_or(&empty);
        let y = b.books.get(key).unwrap_or(&empty);

        let mut annotations = BTreeMap::new();
        let uids: std::collections::BTreeSet<&String> =
            x.annotations.keys().chain(y.annotations.keys()).collect();
        for uid in uids {
            let pick = match (x.annotations.get(uid), y.annotations.get(uid)) {
                (Some(p), Some(q)) => {
                    if q.updated_at > p.updated_at {
                        q
                    } else {
                        p
                    }
                }
                (Some(p), None) => p,
                (None, Some(q)) => q,
                (None, None) => continue,
            };
            // Deleted after its last edit: gone. (Edited after a deletion
            // elsewhere, which is rare, brings it back.)
            if tombstones.get(uid).is_some_and(|&dead| dead >= pick.updated_at) {
                continue;
            }
            annotations.insert(uid.clone(), pick.clone());
        }

        books.insert(
            key.clone(),
            BookSync {
                title: if x.title.is_empty() { y.title.clone() } else { x.title.clone() },
                position: newer(&x.position, &y.position),
                details: newer(&x.details, &y.details),
                annotations,
            },
        );
    }

    SyncFile { version: VERSION, books, tombstones }
}

/// A fingerprint of a file's contents for matching books across devices:
/// 64-bit FNV-1a over (at most) the first 4 MiB, plus the full size. Not a
/// security measure, only "is this the same file".
pub fn fingerprint(head: &[u8], size: u64) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &byte in head.iter().take(4 * 1024 * 1024) {
        h ^= byte as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fp:{h:016x}:{size}")
}

/// A random-enough id for an annotation, unique across devices: the time in
/// nanoseconds mixed with a process-wide counter and the device's salt.
pub fn new_uid(nanos: u128, counter: u64, salt: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in nanos
        .to_le_bytes()
        .iter()
        .chain(counter.to_le_bytes().iter())
        .chain(salt.as_bytes())
    {
        h ^= *byte as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:x}{:016x}", nanos & 0xffff_ffff, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ann(note: &str, updated: i64) -> AnnotationSync {
        AnnotationSync {
            cfi: "epubcfi(/6/4!/4/2)".into(),
            excerpt: "x".into(),
            note: Some(note.into()),
            color: "yellow".into(),
            created_at: 1,
            updated_at: updated,
        }
    }

    fn book(pos: Option<(&str, i64)>) -> BookSync {
        BookSync {
            title: "T".into(),
            position: pos.map(|(v, at)| Stamped { value: v.into(), at }),
            ..Default::default()
        }
    }

    #[test]
    fn newest_position_wins_either_way_round() {
        let mut a = SyncFile::default();
        let mut b = SyncFile::default();
        a.books.insert("ao3:1".into(), book(Some(("old", 10))));
        b.books.insert("ao3:1".into(), book(Some(("new", 20))));
        assert_eq!(merge(&a, &b).books["ao3:1"].position.as_ref().unwrap().value, "new");
        assert_eq!(merge(&b, &a).books["ao3:1"].position.as_ref().unwrap().value, "new");
    }

    #[test]
    fn books_on_only_one_side_are_kept() {
        let mut a = SyncFile::default();
        let b = {
            let mut f = SyncFile::default();
            f.books.insert("fp:abc:9".into(), book(Some(("p", 5))));
            f
        };
        a.books.insert("ao3:2".into(), book(None));
        let m = merge(&a, &b);
        assert!(m.books.contains_key("ao3:2") && m.books.contains_key("fp:abc:9"));
        assert_eq!(m.version, VERSION);
    }

    #[test]
    fn annotations_merge_by_uid_and_newest_edit() {
        let mut a = book(None);
        let mut b = book(None);
        a.annotations.insert("u1".into(), ann("first", 10));
        b.annotations.insert("u1".into(), ann("edited", 30));
        b.annotations.insert("u2".into(), ann("only on b", 5));
        let (mut fa, mut fb) = (SyncFile::default(), SyncFile::default());
        fa.books.insert("k".into(), a);
        fb.books.insert("k".into(), b);
        let m = merge(&fa, &fb);
        let anns = &m.books["k"].annotations;
        assert_eq!(anns["u1"].note.as_deref(), Some("edited"));
        assert!(anns.contains_key("u2"));
    }

    #[test]
    fn deletions_reach_every_device() {
        let mut a = book(None);
        a.annotations.insert("u1".into(), ann("note", 10));
        let mut fa = SyncFile::default();
        fa.books.insert("k".into(), a);
        // b deleted u1 at time 20
        let mut fb = SyncFile::default();
        fb.books.insert("k".into(), book(None));
        fb.tombstones.insert("u1".into(), 20);
        let m = merge(&fa, &fb);
        assert!(m.books["k"].annotations.is_empty());
        assert_eq!(m.tombstones["u1"], 20);
        // but an edit made after the deletion survives it
        let mut c = book(None);
        c.annotations.insert("u1".into(), ann("edited later", 30));
        let mut fc = SyncFile::default();
        fc.books.insert("k".into(), c);
        assert!(merge(&fc, &fb).books["k"].annotations.contains_key("u1"));
    }

    #[test]
    fn edited_details_follow_the_newest() {
        let d = |t: &str, at| Stamped { value: Details { title: t.into(), ..Default::default() }, at };
        let mut fa = SyncFile::default();
        let mut fb = SyncFile::default();
        fa.books.insert("k".into(), BookSync { details: Some(d("Mine", 50)), ..Default::default() });
        fb.books.insert("k".into(), BookSync { details: Some(d("Theirs", 40)), ..Default::default() });
        assert_eq!(merge(&fa, &fb).books["k"].details.as_ref().unwrap().value.title, "Mine");
    }

    #[test]
    fn fingerprints_and_uids() {
        let f1 = fingerprint(b"hello", 5);
        assert_eq!(f1, fingerprint(b"hello", 5));
        assert_ne!(f1, fingerprint(b"hellp", 5));
        assert_ne!(f1, fingerprint(b"hello", 6));
        assert!(f1.starts_with("fp:"));
        let u1 = new_uid(123_456_789, 1, "dev");
        let u2 = new_uid(123_456_789, 2, "dev");
        assert_ne!(u1, u2);
        assert_ne!(new_uid(1, 1, "a"), new_uid(1, 1, "b"));
    }
}
