//! The app's own source files, compiled alone for their tests.
#![allow(dead_code)]

#[path = "../../src/util.rs"]
pub mod util;
#[path = "../../src/opf.rs"]
pub mod opf;
#[path = "../../src/ao3_parse.rs"]
pub mod ao3_parse;
#[path = "../../src/epubgen.rs"]
pub mod epubgen;
#[path = "../../src/syncdata.rs"]
pub mod syncdata;
#[path = "../../src/audiometa.rs"]
pub mod audiometa;
#[path = "../../src/cooldown.rs"]
pub mod cooldown;
#[path = "../../src/mobi.rs"]
pub mod mobi;
