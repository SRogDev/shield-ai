//! File discovery, content filtering, snapshot, and cost tiers.
//!
//! PLAN_V2 §8.1–§8.3: gitignore-aware discovery via the `ignore`
//! crate, hard exclusion of `.env*` files and of dependency /
//! generated directories, text-vs-binary decided by content (never by
//! extension), and a one-read in-memory snapshot keyed by SHA-256.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ignore::WalkBuilder;
use sha2::{Digest, Sha256};

use crate::{Error, Result};

/// Size tiers for a full scan (PLAN_V2 §3).
pub const STANDARD_MAX_FILES: usize = 100;
pub const STANDARD_MAX_BYTES: u64 = 500 * 1024;
pub const LARGE_MAX_FILES: usize = 300;
pub const LARGE_MAX_BYTES: u64 = 2 * 1024 * 1024;
pub const FULL_STANDARD_COST: u64 = 5;
pub const FULL_LARGE_COST: u64 = 12;

/// Dependency and generated-content directories, always excluded even
/// when no ignore rule covers them.
pub const EXCLUDED_DIRS: [&str; 7] = [
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    "vendor",
];

/// One file captured in the snapshot: the bytes are read exactly once
/// and these are the bytes that get uploaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotFile {
    /// Repository-relative path, `/`-separated.
    pub path: String,
    /// Lowercase hex SHA-256 of `bytes`.
    pub sha256: String,
    pub size: u64,
    pub bytes: Vec<u8>,
}

impl SnapshotFile {
    pub fn content_base64(&self) -> String {
        BASE64.encode(&self.bytes)
    }
}

/// Counts of what discovery left out, by reason (files skipped purely
/// by `.gitignore` rules are not individually observable from the
/// walker and so are not in these counts).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Exclusions {
    pub env_files: usize,
    pub binary_files: usize,
    pub dependency_dirs: usize,
    pub symlinks: usize,
}

impl Exclusions {
    pub fn total(&self) -> usize {
        self.env_files + self.binary_files + self.dependency_dirs + self.symlinks
    }
}

/// An in-memory snapshot of the selected text files under a root.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub root: PathBuf,
    pub files: Vec<SnapshotFile>,
    pub excluded: Exclusions,
}

impl Snapshot {
    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }

    pub fn get(&self, rel_path: &str) -> Option<&SnapshotFile> {
        self.files.iter().find(|f| f.path == rel_path)
    }
}

/// SHA-256, lowercase hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Text detection by content: binary if a NUL byte appears in the
/// first 8 KB or the content is not valid UTF-8. There is deliberately
/// no extension allowlist, so images/PDF/Office/media are excluded by
/// this rule whatever their names claim.
pub fn is_text_bytes(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return false;
    }
    std::str::from_utf8(bytes).is_ok()
}

/// `.env*` hard rule (PLAN_V2 §8.1): a basename starting with `.env`
/// is always excluded, gitignore or not.
fn is_env_file(file_name: &str) -> bool {
    file_name.starts_with(".env")
}

/// Discover and snapshot the selected text files under `root`.
///
/// - Respects `.gitignore` / ignore rules (`ignore` crate), including
///   in directories that are not git repositories.
/// - Never follows symlinks; symlinked entries are skipped so nothing
///   outside the scan root can be reached through one.
/// - Excludes `EXCLUDED_DIRS`, `.env*` files, and binary content.
pub fn build_snapshot(root: &Path) -> Result<Snapshot> {
    let excluded_dirs: HashSet<&str> = EXCLUDED_DIRS.iter().copied().collect();
    let pruned_dirs = Arc::new(AtomicUsize::new(0));
    let pruned_counter = Arc::clone(&pruned_dirs);

    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .parents(true)
        .sort_by_file_path(|a, b| a.cmp(b))
        .filter_entry(move |entry| {
            // The root itself always passes, even if it happens to be
            // named like an excluded directory.
            if entry.depth() == 0 {
                return true;
            }
            let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
            if is_dir {
                if let Some(name) = entry.file_name().to_str() {
                    if excluded_dirs.contains(name) {
                        pruned_counter.fetch_add(1, Ordering::Relaxed);
                        return false;
                    }
                }
            }
            true
        });

    let mut excluded = Exclusions::default();
    let mut files = Vec::new();

    for entry in builder.build() {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // unreadable entry: skip, never panic
        };
        if entry.depth() == 0 {
            continue;
        }
        // Never follow a symlink anywhere: a link could point outside
        // the scan root.
        if entry.path_is_symlink() {
            excluded.symlinks += 1;
            continue;
        }
        let is_file = entry.file_type().is_some_and(|t| t.is_file());
        if !is_file {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if is_env_file(&file_name) {
            excluded.env_files += 1;
            continue;
        }
        let rel = match entry.path().strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        // The single read of this file for the whole scan (§8.3).
        let bytes = std::fs::read(entry.path()).map_err(|e| {
            Error::new(format!("could not read {}: {e}", entry.path().display()))
        })?;
        if !is_text_bytes(&bytes) {
            excluded.binary_files += 1;
            continue;
        }
        let sha256 = sha256_hex(&bytes);
        let size = bytes.len() as u64;
        files.push(SnapshotFile {
            path: rel_path,
            sha256,
            size,
            bytes,
        });
    }

    excluded.dependency_dirs = pruned_dirs.load(Ordering::Relaxed);
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Snapshot {
        root: root.to_path_buf(),
        files,
        excluded,
    })
}

/// Shield cost of a full scan for a snapshot of this shape
/// (PLAN_V2 §3). Above the large tier this is a hard error — never a
/// silent truncation.
pub fn full_scan_cost(file_count: usize, total_bytes: u64) -> Result<u64> {
    if file_count <= STANDARD_MAX_FILES && total_bytes <= STANDARD_MAX_BYTES {
        Ok(FULL_STANDARD_COST)
    } else if file_count <= LARGE_MAX_FILES && total_bytes <= LARGE_MAX_BYTES {
        Ok(FULL_LARGE_COST)
    } else {
        Err(Error::new(format!(
            "snapshot too large: {file_count} files / {total_bytes} bytes exceeds the maximum \
             full-scan snapshot of {LARGE_MAX_FILES} files / {LARGE_MAX_BYTES} bytes"
        )))
    }
}

/// The pre-upload preview (PLAN_V2 §8.2).
pub fn format_preview(root: &Path, snapshot: &Snapshot, cost_shields: u64) -> String {
    let ex = &snapshot.excluded;
    format!(
        "Shield scan preview\n\
         \x20 Root: {}\n\
         \x20 Files selected: {}\n\
         \x20 Total size: {} bytes\n\
         \x20 Excluded: {} counted ({} .env files, {} binary files, {} \
         dependency/generated directories, {} symlinks; plus anything \
         covered by .gitignore rules)\n\
         \x20 Cost: {cost_shields} Shields\n\
         \x20 Notice: the selected source files will be transmitted to Shield \
         and processed by external AI models. Shield does not persist your \
         source code.",
        root.display(),
        snapshot.file_count(),
        snapshot.total_size(),
        ex.total(),
        ex.env_files,
        ex.binary_files,
        ex.dependency_dirs,
        ex.symlinks,
    )
}

/// Repository identity, name part: the scan root's folder basename.
pub fn repo_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "project".to_string())
}

/// Repository identity, remote part (§8.5): SHA-256 of the
/// `remote.origin.url` string when this is a git repository with a
/// remote, else `None`. The raw remote URL never leaves the machine.
pub fn remote_url_hash(root: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["config", "--get", "remote.origin.url"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(sha256_hex(url.as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vector() {
        // FIPS 180-4 example: SHA-256("abc").
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn text_detection_by_content() {
        assert!(is_text_bytes(b"fn main() {}\n"));
        assert!(is_text_bytes("héllo wörld".as_bytes()));
        assert!(is_text_bytes(b""));
        // NUL byte in the first 8 KB -> binary.
        assert!(!is_text_bytes(b"PK\x03\x04rest"));
        assert!(!is_text_bytes(&[b'a', 0, b'b']));
        // Invalid UTF-8 without any NUL -> binary.
        assert!(!is_text_bytes(&[0xff, 0xfe, b'a']));
        // A real U+FFFD encoded as valid UTF-8 is text.
        assert!(is_text_bytes("�".as_bytes()));
    }

    #[test]
    fn env_basename_rule() {
        assert!(is_env_file(".env"));
        assert!(is_env_file(".env.local"));
        assert!(is_env_file(".envrc"));
        assert!(!is_env_file("env.rs"));
        assert!(!is_env_file("config.env"));
    }

    #[test]
    fn full_scan_cost_tiers() {
        assert_eq!(full_scan_cost(1, 10).unwrap(), 5);
        assert_eq!(full_scan_cost(100, STANDARD_MAX_BYTES).unwrap(), 5);
        assert_eq!(full_scan_cost(101, STANDARD_MAX_BYTES).unwrap(), 12);
        assert_eq!(full_scan_cost(100, STANDARD_MAX_BYTES + 1).unwrap(), 12);
        assert_eq!(full_scan_cost(300, LARGE_MAX_BYTES).unwrap(), 12);
        let err = full_scan_cost(301, 10).unwrap_err();
        assert!(err.message().contains("snapshot too large"), "{err}");
        let err = full_scan_cost(10, LARGE_MAX_BYTES + 1).unwrap_err();
        assert!(err.message().contains("snapshot too large"), "{err}");
    }
}
