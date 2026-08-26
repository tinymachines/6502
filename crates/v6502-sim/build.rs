//! Stamp the build with the commit it came from.
//!
//! halfwave is a binary that sits behind a service for weeks, and a release
//! of the site does not rebuild it (`deploy/deploy.sh` publishes the web
//! tree; the unit's comment says to rebuild the engine by hand). So the only
//! way to know which engine is answering was the file's digest and mtime.
//! This gives it a name: `halfwave --version` and the `META` reply both carry
//! the workspace version and the commit, and a build from a dirty tree says
//! `-dirty`, because a commit that is not what was built is worse than none.
//!
//! The commit is read out of `.git` directly rather than by running `git`:
//! a build under systemd's PATH need not have it (the same reason the site's
//! provenance is read that way). `git` IS run, when present, for the one
//! thing the files cannot say, whether the tree is clean; absent git the
//! stamp is the commit alone and says so with `?`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn git_dir(start: &Path) -> Option<PathBuf> {
    for d in start.ancestors() {
        let c = d.join(".git");
        if c.is_dir() {
            return Some(c);
        }
        if c.is_file() {
            // A worktree: `.git` is a file holding `gitdir: <path>`.
            let text = fs::read_to_string(&c).ok()?;
            let p = text.trim().strip_prefix("gitdir:")?.trim();
            return Some(PathBuf::from(p));
        }
    }
    None
}

fn commit(git: &Path) -> Option<String> {
    let head = fs::read_to_string(git.join("HEAD")).ok()?;
    let head = head.trim();
    println!("cargo:rerun-if-changed={}", git.join("HEAD").display());
    if head.len() == 40 && head.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(head.to_string());
    }
    let r = head.strip_prefix("ref:")?.trim();
    let reff = git.join(r);
    println!("cargo:rerun-if-changed={}", reff.display());
    if let Ok(s) = fs::read_to_string(&reff) {
        return Some(s.trim().to_string());
    }
    let packed = fs::read_to_string(git.join("packed-refs")).ok()?;
    packed
        .lines()
        .find(|l| l.ends_with(&format!(" {r}")))
        .map(|l| l.split_whitespace().next().unwrap_or("").to_string())
}

fn dirty(root: &Path) -> Option<bool> {
    let out = Command::new("git")
        .args(["-C", &root.display().to_string(), "status", "--porcelain", "--untracked-files=no"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(!out.stdout.is_empty())
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets this"));
    let stamp = match git_dir(&manifest) {
        Some(git) => {
            let root = git.parent().map(Path::to_path_buf).unwrap_or_else(|| manifest.clone());
            match commit(&git) {
                Some(c) => match dirty(&root) {
                    Some(true) => format!("{c}-dirty"),
                    Some(false) => c,
                    None => format!("{c}?"),
                },
                None => "unknown".to_string(),
            }
        }
        None => "unknown".to_string(),
    };
    println!("cargo:rustc-env=V6502_COMMIT={stamp}");
    println!("cargo:rerun-if-env-changed=V6502_COMMIT");
}
