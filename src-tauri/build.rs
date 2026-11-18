fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=native/macos_chrome.m");
        cc::Build::new()
            .file("native/macos_chrome.m")
            .flag("-fobjc-arc")
            .flag("-Werror=unguarded-availability")
            .compile("homeworkbook_macos_chrome");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=WebKit");
        link_apple_availability_runtime();
    }
    tauri_build::build();
}

#[cfg(target_os = "macos")]
fn link_apple_availability_runtime() {
    // Objective-C @available uses compiler-rt. Rust's linker invocation skips
    // the default libraries Clang would otherwise supply for an AppKit target.
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    let output = std::process::Command::new("xcrun")
        .args([
            "--sdk",
            "macosx",
            "clang",
            "--print-file-name=libclang_rt.osx.a",
        ])
        .output()
        .expect("locate the Apple Clang runtime with xcrun");
    let path = String::from_utf8(output.stdout).expect("Apple Clang runtime path is UTF-8");
    let library = std::path::Path::new(path.trim());
    assert!(
        output.status.success() && library.is_absolute() && library.is_file(),
        "the Apple Clang runtime (libclang_rt.osx.a) is required for macOS availability checks"
    );
    let directory = library.parent().expect("Apple Clang runtime directory");
    println!("cargo:rustc-link-search=native={}", directory.display());
    println!("cargo:rustc-link-lib=static=clang_rt.osx");
}
