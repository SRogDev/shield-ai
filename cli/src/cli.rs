//! Command-line surface and command orchestration.
//!
//! Exactly three top-level commands (PLAN_V2 §8): `login`, `scan`,
//! `logout`. `--help` comes from clap on the binary and every
//! subcommand.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::{Parser, Subcommand};

use crate::api::{ApiClient, CompleteOutcome, FileManifestEntry, Project};
use crate::auth::{self, CredentialStore};
use crate::files::{self, Snapshot};
use crate::{Error, Result};

#[derive(Parser, Debug)]
#[command(
    name = "shield",
    version,
    about = "Shield AI — security analysis for AI-built apps. Security that lets you build."
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Log in with the device flow (opens a verification URL + code).
    Login,
    /// Scan a local project and upload it for analysis.
    Scan {
        /// Project directory to scan.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Skip only the confirmation prompt (never auth, project
        /// resolution, or size limits).
        #[arg(long)]
        auto: bool,
    },
    /// Log out: revoke the CLI token and delete local credentials.
    Logout,
}

/// User interaction, injectable so tests can script or forbid prompts.
pub trait Prompter {
    /// Ask a yes/no question; only an explicit yes is `true`.
    fn confirm(&self, question: &str) -> Result<bool>;
    /// Ask which project a repository belongs to.
    fn choose_project(&self, projects: &[Project]) -> Result<ProjectChoice>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectChoice {
    /// An existing project id.
    Existing(String),
    /// Create a new project with this name.
    New(String),
}

/// Prompter backed by stdin/stdout for real terminal use.
pub struct InteractivePrompter;

impl InteractivePrompter {
    fn read_line(&self, prompt: &str) -> Result<String> {
        print!("{prompt}");
        std::io::stdout().flush()?;
        let mut line = String::new();
        let read = std::io::stdin().read_line(&mut line)?;
        if read == 0 {
            return Err(Error::new("no input received (stdin closed)"));
        }
        Ok(line.trim().to_string())
    }
}

impl Prompter for InteractivePrompter {
    fn confirm(&self, question: &str) -> Result<bool> {
        let answer = self.read_line(&format!("{question} [y/N] "))?;
        Ok(matches!(answer.to_ascii_lowercase().as_str(), "y" | "yes"))
    }

    fn choose_project(&self, projects: &[Project]) -> Result<ProjectChoice> {
        if projects.is_empty() {
            let name = self.read_line("No projects yet. Name for the new project: ")?;
            if name.is_empty() {
                return Err(Error::new("project name must not be empty"));
            }
            return Ok(ProjectChoice::New(name));
        }
        println!("Which project does this repository belong to?");
        for (i, p) in projects.iter().enumerate() {
            println!("  {}) {}", i + 1, p.name);
        }
        let answer = self.read_line("Enter a project number, or 'n' to create a new project: ")?;
        if answer.eq_ignore_ascii_case("n") {
            let name = self.read_line("Name for the new project: ")?;
            if name.is_empty() {
                return Err(Error::new("project name must not be empty"));
            }
            return Ok(ProjectChoice::New(name));
        }
        let n: usize = answer
            .parse()
            .map_err(|_| Error::new(format!("'{answer}' is not a project number")))?;
        if n == 0 || n > projects.len() {
            return Err(Error::new(format!(
                "project number {n} is out of range (1..={})",
                projects.len()
            )));
        }
        Ok(ProjectChoice::Existing(projects[n - 1].id.clone()))
    }
}

/// The final, server-reported state of a scan run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOutcome {
    pub scan_id: String,
    /// Status string exactly as the server reported it.
    pub status: String,
    pub cost_shields: u64,
    pub files_uploaded: usize,
}

fn real_sleeper(d: Duration) {
    std::thread::sleep(d);
}

/// Entry point used by `main`.
pub fn execute(cli: Cli) -> Result<()> {
    let client = ApiClient::new(crate::api::base_url_from_env());
    let mut out = std::io::stdout();
    match cli.command {
        Commands::Login => {
            let store = auth::default_store()?;
            auth::login(&client, &store, &mut out, &real_sleeper)
        }
        Commands::Logout => {
            let store = auth::default_store()?;
            auth::logout(&client, &store, &mut out)
        }
        Commands::Scan { path, auto } => {
            let store = auth::default_store()?;
            let outcome = run_scan(
                &client,
                &store,
                &path,
                auto,
                &InteractivePrompter,
                &real_sleeper,
                &mut out,
            )?;
            writeln!(
                out,
                "Scan {} finished uploading; server status: {}",
                outcome.scan_id, outcome.status
            )?;
            Ok(())
        }
    }
}

/// Full scan command: snapshot → cost preview → confirmation →
/// project resolution → upload → completion → status report.
#[allow(clippy::too_many_arguments)]
pub fn run_scan(
    client: &ApiClient,
    store: &dyn CredentialStore,
    path: &Path,
    auto: bool,
    prompter: &dyn Prompter,
    sleeper: &dyn Fn(Duration),
    out: &mut dyn Write,
) -> Result<ScanOutcome> {
    let token = store
        .load()?
        .ok_or_else(|| Error::new("not logged in — run `shield login` first"))?;

    let root = std::fs::canonicalize(path)
        .map_err(|e| Error::new(format!("cannot access scan path {}: {e}", path.display())))?;
    if !root.is_dir() {
        return Err(Error::new(format!(
            "scan path {} is not a directory",
            root.display()
        )));
    }

    let snapshot = files::build_snapshot(&root)?;
    if snapshot.files.is_empty() {
        return Err(Error::new(format!(
            "no text files selected under {} — nothing to scan",
            root.display()
        )));
    }
    // Size limits are enforced before any upload, auto or not (§8.2).
    let cost = files::full_scan_cost(snapshot.file_count(), snapshot.total_size())?;

    writeln!(out, "{}", files::format_preview(&root, &snapshot, cost))?;
    out.flush()?;
    if !auto && !prompter.confirm("Upload these files to Shield for analysis?")? {
        return Err(Error::new("scan cancelled by user"));
    }

    let project_id = resolve_project(
        client,
        &token,
        &files::repo_name(&root),
        files::remote_url_hash(&root).as_deref(),
        auto,
        prompter,
    )?;

    upload_snapshot(client, &token, &project_id, &snapshot, sleeper, out)
}

/// Project resolution (PLAN_V2 §8.5).
///
/// Single-project users are never prompted. A server-side repo link
/// resolves automatically. Otherwise the user picks or creates a
/// project interactively and the choice is stored as a repo link.
/// With `auto`, an unresolved multi-project repo is a clear error.
pub fn resolve_project(
    client: &ApiClient,
    token: &str,
    repo_name: &str,
    remote_url_hash: Option<&str>,
    auto: bool,
    prompter: &dyn Prompter,
) -> Result<String> {
    let resp = client.list_projects(token)?;

    if resp.single_project {
        if let Some(sole) = resp.projects.first() {
            return Ok(sole.id.clone());
        }
    }

    if let Some(link) = resp
        .linked_repos
        .iter()
        .find(|l| l.repo_name == repo_name && l.remote_url_hash.as_deref() == remote_url_hash)
    {
        return Ok(link.project_id.clone());
    }

    if auto {
        return Err(Error::new(
            "this repository is not linked to a project yet, and --auto cannot choose one. \
             Run `shield scan` once without --auto to pick or create a project for this repo.",
        ));
    }

    match prompter.choose_project(&resp.projects)? {
        ProjectChoice::Existing(id) => {
            client.link_repo(token, &id, repo_name, remote_url_hash)?;
            Ok(id)
        }
        ProjectChoice::New(name) => {
            let project = client.create_project(token, &name)?;
            client.link_repo(token, &project.id, repo_name, remote_url_hash)?;
            Ok(project.id)
        }
    }
}

/// Create the scan on the server, upload exactly the files it still
/// needs from the in-memory snapshot, complete it, and report the
/// server-reported status. Analysis is never claimed locally — the
/// status string is whatever the server says.
pub fn upload_snapshot(
    client: &ApiClient,
    token: &str,
    project_id: &str,
    snapshot: &Snapshot,
    sleeper: &dyn Fn(Duration),
    out: &mut dyn Write,
) -> Result<ScanOutcome> {
    let manifest: Vec<FileManifestEntry> = snapshot
        .files
        .iter()
        .map(|f| FileManifestEntry {
            path: f.path.clone(),
            sha256: f.sha256.clone(),
            size: f.size,
        })
        .collect();
    let created = client.create_scan(token, project_id, "full", &manifest)?;
    let scan_id = created.scan_id.clone();

    let mut uploaded = 0usize;
    uploaded += upload_files(
        client,
        token,
        &scan_id,
        snapshot,
        &created.needed,
        sleeper,
        out,
    )?;

    // Completion: analysis starts only once every file is acked.
    // On 409/missing, upload the missing files and complete again
    // (at most 2 re-upload rounds).
    let mut rounds = 0;
    loop {
        match client.complete_scan(token, &scan_id)? {
            CompleteOutcome::Started(_) => break,
            CompleteOutcome::Missing(missing) => {
                rounds += 1;
                if rounds > 2 {
                    return Err(Error::new(format!(
                        "server still reports missing files after 2 re-upload rounds: {}",
                        missing.join(", ")
                    )));
                }
                writeln!(
                    out,
                    "Server is missing {} file(s); re-uploading…",
                    missing.len()
                )?;
                uploaded +=
                    upload_files(client, token, &scan_id, snapshot, &missing, sleeper, out)?;
            }
        }
    }

    // Poll the server status a few times and report it verbatim.
    let mut status = client.get_scan(token, &scan_id)?;
    for _ in 0..4 {
        if status.status == "completed" || status.status == "failed" {
            break;
        }
        sleeper(Duration::from_secs(2));
        status = client.get_scan(token, &scan_id)?;
    }
    writeln!(
        out,
        "Scan {scan_id}: server status is \"{}\" (cost: {} Shields, {uploaded} file(s) uploaded).",
        status.status, status.cost_shields
    )?;
    Ok(ScanOutcome {
        scan_id,
        status: status.status,
        cost_shields: status.cost_shields,
        files_uploaded: uploaded,
    })
}

/// Upload the snapshot files whose paths are in `paths`, each with
/// bounded retry (max 3 attempts, backoff between them).
fn upload_files(
    client: &ApiClient,
    token: &str,
    scan_id: &str,
    snapshot: &Snapshot,
    paths: &[String],
    sleeper: &dyn Fn(Duration),
    out: &mut dyn Write,
) -> Result<usize> {
    let wanted: HashSet<&str> = paths.iter().map(String::as_str).collect();
    let mut count = 0usize;
    for file in &snapshot.files {
        if !wanted.contains(file.path.as_str()) {
            continue;
        }
        upload_one_with_retry(client, token, scan_id, file, sleeper)?;
        writeln!(out, "  uploaded {}", file.path)?;
        count += 1;
    }
    // A path the server wants but the snapshot does not have is a
    // hard inconsistency — surface it rather than completing short.
    for path in paths {
        if snapshot.get(path).is_none() {
            return Err(Error::new(format!(
                "server asked for file '{path}' which is not in the local snapshot"
            )));
        }
    }
    Ok(count)
}

fn upload_one_with_retry(
    client: &ApiClient,
    token: &str,
    scan_id: &str,
    file: &files::SnapshotFile,
    sleeper: &dyn Fn(Duration),
) -> Result<()> {
    const MAX_ATTEMPTS: u32 = 3;
    let mut attempt = 0;
    loop {
        attempt += 1;
        match client.upload_file(token, scan_id, file) {
            Ok(()) => return Ok(()),
            Err(e) if e.is_retryable() && attempt < MAX_ATTEMPTS => {
                sleeper(Duration::from_millis(250 * u64::from(attempt)));
            }
            Err(e) => {
                return Err(Error::new(format!(
                    "upload of {} failed after {attempt} attempt(s): {}",
                    file.path,
                    e.message()
                )));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{CommandFactory, Parser};

    #[test]
    fn command_surface_is_exactly_login_scan_logout() {
        // clap's own invariants.
        Cli::command().debug_assert();

        assert!(matches!(
            Cli::try_parse_from(["shield", "login"]).unwrap().command,
            Commands::Login
        ));
        assert!(matches!(
            Cli::try_parse_from(["shield", "logout"]).unwrap().command,
            Commands::Logout
        ));
        match Cli::try_parse_from(["shield", "scan"]).unwrap().command {
            Commands::Scan { path, auto } => {
                assert_eq!(path, PathBuf::from("."));
                assert!(!auto);
            }
            other => panic!("expected scan, got {other:?}"),
        }
        match Cli::try_parse_from(["shield", "scan", "src", "--auto"])
            .unwrap()
            .command
        {
            Commands::Scan { path, auto } => {
                assert_eq!(path, PathBuf::from("src"));
                assert!(auto);
            }
            other => panic!("expected scan, got {other:?}"),
        }
        // No other top-level commands exist.
        assert!(Cli::try_parse_from(["shield", "status"]).is_err());
        assert!(Cli::try_parse_from(["shield", "analyze"]).is_err());
        assert!(Cli::try_parse_from(["shield"]).is_err());
    }

    #[test]
    fn help_is_available_on_binary_and_subcommands() {
        for args in [
            vec!["shield", "--help"],
            vec!["shield", "login", "--help"],
            vec!["shield", "scan", "--help"],
            vec!["shield", "logout", "--help"],
        ] {
            let err = Cli::try_parse_from(args).unwrap_err();
            assert_eq!(
                err.kind(),
                clap::error::ErrorKind::DisplayHelp,
                "args: {err}"
            );
        }
    }
}
