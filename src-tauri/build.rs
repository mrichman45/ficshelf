fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        android_link_fixes();
    }
    tauri_build::build()
}

/// The RAR library (unrar) is C++ and asks for "pthread". On Android:
///
/// - there is no separate libpthread (those functions live in libc), so an
///   empty stand-in is put where the linker will find it;
/// - the C++ standard library must be linked in, or the app's library
///   refers to C++ functions nothing provides and Android will not load it
///   (the app closes on its splash screen). It is linked statically, so the
///   APK needs no extra libc++_shared.so.
fn android_link_fixes() {
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let stub = out.join("pthread-stub");
    std::fs::create_dir_all(&stub).expect("creating the pthread stub folder");
    // An archive with no members: just the magic line.
    std::fs::write(stub.join("libpthread.a"), b"!<arch>\n").expect("writing the pthread stub");
    println!("cargo:rustc-link-search=native={}", stub.display());

    let ndk = ["NDK_HOME", "ANDROID_NDK_HOME", "ANDROID_NDK_ROOT"]
        .iter()
        .find_map(|k| std::env::var(k).ok())
        .expect("NDK_HOME is needed to build for Android");
    let host = if cfg!(target_os = "windows") {
        "windows-x86_64"
    } else if cfg!(target_os = "macos") {
        "darwin-x86_64"
    } else {
        "linux-x86_64"
    };
    let triple = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "aarch64-linux-android",
        Ok("arm") => "arm-linux-androideabi",
        Ok("x86_64") => "x86_64-linux-android",
        Ok("x86") => "i686-linux-android",
        other => panic!("unexpected Android architecture {other:?}"),
    };
    let lib = std::path::Path::new(&ndk)
        .join("toolchains/llvm/prebuilt")
        .join(host)
        .join("sysroot/usr/lib")
        .join(triple);
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-lib=static=c++_static");
    println!("cargo:rustc-link-lib=static=c++abi");
    println!("cargo:rerun-if-env-changed=NDK_HOME");
}
