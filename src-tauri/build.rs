fn main() {
    // The RAR library (unrar) asks to link "pthread". Android has no
    // separate libpthread (those functions live in its libc), so an empty
    // stand-in is put where the linker will find it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
        let stub = out.join("pthread-stub");
        std::fs::create_dir_all(&stub).expect("creating the pthread stub folder");
        // An archive with no members: just the magic line.
        std::fs::write(stub.join("libpthread.a"), b"!<arch>\n").expect("writing the pthread stub");
        println!("cargo:rustc-link-search=native={}", stub.display());
    }
    tauri_build::build()
}
