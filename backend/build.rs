use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    time::SystemTime,
};

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("Cargo sets manifest dir"));
    let frontend_dir = manifest_dir.join("../frontend");
    let dist_dir = frontend_dir.join("dist");

    for path in [
        frontend_dir.join("src"),
        frontend_dir.join("index.html"),
        frontend_dir.join("package.json"),
        frontend_dir.join("tsconfig.json"),
        frontend_dir.join("vite.config.ts"),
    ] {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!(
        "cargo:rerun-if-changed={}",
        dist_dir.join("index.html").display()
    );

    if assets_need_build(&frontend_dir, &dist_dir) {
        build_frontend(&frontend_dir);
    }
}

fn assets_need_build(frontend_dir: &Path, dist_dir: &Path) -> bool {
    let index = dist_dir.join("index.html");
    if !index.is_file() {
        return true;
    }

    let source_modified = frontend_source_modified(frontend_dir).unwrap_or_else(|error| {
        panic!(
            "Cannot inspect frontend sources at {}: {error}. Run `npm install --prefix frontend` from the repository root before any Cargo command.",
            frontend_dir.display()
        )
    });
    let index_modified = index.metadata().and_then(|metadata| metadata.modified());

    match (source_modified, index_modified) {
        (Some(source_modified), Ok(index_modified)) => source_modified > index_modified,
        _ => true,
    }
}

fn frontend_source_modified(frontend_dir: &Path) -> std::io::Result<Option<SystemTime>> {
    let mut latest = None;
    for path in [
        frontend_dir.join("src"),
        frontend_dir.join("index.html"),
        frontend_dir.join("package.json"),
        frontend_dir.join("tsconfig.json"),
        frontend_dir.join("vite.config.ts"),
    ] {
        let modified = latest_modified(&path)?;
        if modified > latest {
            latest = modified;
        }
    }
    Ok(latest)
}

fn latest_modified(path: &Path) -> std::io::Result<Option<SystemTime>> {
    let metadata = fs::metadata(path)?;
    if metadata.is_file() {
        return Ok(Some(metadata.modified()?));
    }

    let mut latest = None;
    for entry in fs::read_dir(path)? {
        let modified = latest_modified(&entry?.path())?;
        if modified > latest {
            latest = modified;
        }
    }
    Ok(latest)
}

fn build_frontend(frontend_dir: &Path) {
    let output = Command::new("npm")
        .args(["run", "build"])
        .current_dir(frontend_dir)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "Failed to run `npm run build` in {}: {error}. Run `npm install --prefix frontend` from the repository root before any Cargo command.",
                frontend_dir.display()
            )
        });

    if !output.status.success() {
        panic!(
            "Frontend build failed in {}. Run `npm install --prefix frontend` from the repository root before any Cargo command.\nstdout:\n{}\nstderr:\n{}",
            frontend_dir.display(),
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
