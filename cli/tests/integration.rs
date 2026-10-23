//! Integration tests for the Shield CLI against a mock HTTP server
//! built on `std::net::TcpListener` (no mock crates).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

use shield::api::ApiClient;
use shield::auth::{self, CredentialStore, FileCredentialStore};
use shield::cli::{ProjectChoice, Prompter, ScanOutcome};
use shield::files::{self, Snapshot};
use shield::Result;

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct Recorded {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Recorded {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

struct MockResponse {
    status: u16,
    body: String,
    drop: bool,
}

impl MockResponse {
    fn json(status: u16, body: Value) -> Self {
        MockResponse {
            status,
            body: body.to_string(),
            drop: false,
        }
    }
    fn ok(body: Value) -> Self {
        Self::json(200, body)
    }
    fn dropped() -> Self {
        MockResponse {
            status: 0,
            body: String::new(),
            drop: true,
        }
    }
}

struct MockServer {
    base_url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
}

impl MockServer {
    fn start(handler: impl Fn(&Recorded) -> MockResponse + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let handler: Arc<dyn Fn(&Recorded) -> MockResponse + Send + Sync> = Arc::new(handler);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let Ok(clone) = stream.try_clone() else {
                    continue;
                };
                let mut reader = BufReader::new(clone);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                if method.is_empty() {
                    continue;
                }
                let mut headers = Vec::new();
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        break;
                    }
                    let trimmed = line.trim_end();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some((k, v)) = trimmed.split_once(':') {
                        let key = k.trim().to_string();
                        let value = v.trim().to_string();
                        if key.eq_ignore_ascii_case("content-length") {
                            content_length = value.parse().unwrap_or(0);
                        }
                        headers.push((key, value));
                    }
                }
                let mut body_bytes = vec![0u8; content_length];
                if content_length > 0 && reader.read_exact(&mut body_bytes).is_err() {
                    continue;
                }
                let request = Recorded {
                    method,
                    path,
                    headers,
                    body: String::from_utf8_lossy(&body_bytes).into_owned(),
                };
                recorded.lock().unwrap().push(request.clone());
                let response = handler(&request);
                if response.drop {
                    // Simulate a connection that dies mid-flight.
                    drop(stream);
                    continue;
                }
                let reason = match response.status {
                    200 => "OK",
                    201 => "Created",
                    400 => "Bad Request",
                    401 => "Unauthorized",
                    403 => "Forbidden",
                    404 => "Not Found",
                    409 => "Conflict",
                    500 => "Internal Server Error",
                    _ => "Status",
                };
                let text = format!(
                    "HTTP/1.1 {} {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    response.status,
                    reason,
                    response.body.len(),
                    response.body
                );
                let _ = stream.write_all(text.as_bytes());
                let _ = stream.flush();
            }
        });
        MockServer {
            base_url: format!("http://127.0.0.1:{port}"),
            requests,
        }
    }

    fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    fn client(&self) -> ApiClient {
        ApiClient::new(self.base_url.clone())
    }
}

// ---------------------------------------------------------------------------
// Temp dirs, prompters, helpers
// ---------------------------------------------------------------------------

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let n = TEMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("shield-test-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn write(&self, rel: &str, contents: impl AsRef<[u8]>) {
        let path = self.0.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }
    fn basename(&self) -> String {
        self.0.file_name().unwrap().to_string_lossy().into_owned()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn noop_sleeper() -> impl Fn(Duration) {
    |_| {}
}

/// Any prompt is a test failure.
struct NoPrompt;
impl Prompter for NoPrompt {
    fn confirm(&self, _q: &str) -> Result<bool> {
        panic!("confirm must not be called")
    }
    fn choose_project(&self, _p: &[shield::api::Project]) -> Result<ProjectChoice> {
        panic!("choose_project must not be called")
    }
}

/// Confirms, but picking a project is a test failure.
struct ConfirmOnly;
impl Prompter for ConfirmOnly {
    fn confirm(&self, _q: &str) -> Result<bool> {
        Ok(true)
    }
    fn choose_project(&self, _p: &[shield::api::Project]) -> Result<ProjectChoice> {
        panic!("choose_project must not be called")
    }
}

/// Declines the confirmation.
struct Decline;
impl Prompter for Decline {
    fn confirm(&self, _q: &str) -> Result<bool> {
        Ok(false)
    }
    fn choose_project(&self, _p: &[shield::api::Project]) -> Result<ProjectChoice> {
        panic!("choose_project must not be called")
    }
}

/// Confirms and returns a scripted project choice.
struct Scripted(ProjectChoice);
impl Prompter for Scripted {
    fn confirm(&self, _q: &str) -> Result<bool> {
        Ok(true)
    }
    fn choose_project(&self, _p: &[shield::api::Project]) -> Result<ProjectChoice> {
        Ok(self.0.clone())
    }
}

fn file_store(dir: &TempDir) -> FileCredentialStore {
    FileCredentialStore::new(dir.path().join("config").join("credentials.json"))
}

fn logged_in_store(dir: &TempDir) -> FileCredentialStore {
    let store = file_store(dir);
    store.save("tok-secret-123").unwrap();
    store
}

fn snapshot_paths(snapshot: &Snapshot) -> Vec<&str> {
    snapshot.files.iter().map(|f| f.path.as_str()).collect()
}

/// A backend that serves the whole happy-path scan contract.
/// `projects_body` controls the GET /api/cli/projects response and
/// `scan_status` the status the scan status endpoint reports.
fn scan_server(projects_body: Value, scan_status: &'static str) -> MockServer {
    MockServer::start(move |req| {
        let key = (req.method.as_str(), req.path.as_str());
        match key {
            ("GET", "/api/cli/projects") => MockResponse::ok(projects_body.clone()),
            ("POST", "/api/cli/projects") => {
                let name = req.json()["name"].as_str().unwrap_or("").to_string();
                MockResponse::ok(json!({ "id": "p-new", "name": name }))
            }
            ("POST", "/api/cli/repo-link") => MockResponse::ok(json!({ "ok": true })),
            ("POST", "/api/scans") => {
                let files = req.json()["files"].as_array().cloned().unwrap_or_default();
                let needed: Vec<Value> = files.iter().map(|f| f["path"].clone()).collect();
                MockResponse::ok(json!({
                    "scanId": "scan-1",
                    "costShields": 5,
                    "needed": needed,
                }))
            }
            ("PUT", "/api/scans/scan-1/files") => MockResponse::ok(json!({ "acked": true })),
            ("POST", "/api/scans/scan-1/complete") => {
                MockResponse::ok(json!({ "status": "analyzing" }))
            }
            ("GET", "/api/scans/scan-1") => MockResponse::ok(json!({
                "id": "scan-1",
                "status": scan_status,
                "costShields": 5,
            })),
            ("POST", "/api/cli/logout") => MockResponse::ok(json!({ "ok": true })),
            _ => MockResponse::json(404, json!({ "error": "not found" })),
        }
    })
}

fn single_project_body() -> Value {
    json!({
        "projects": [{ "id": "p1", "name": "Only Project" }],
        "singleProject": true
    })
}

fn run_scan(
    server: &MockServer,
    store: &dyn CredentialStore,
    dir: &TempDir,
    auto: bool,
    prompter: &dyn Prompter,
    out: &mut Vec<u8>,
) -> Result<ScanOutcome> {
    let sleeper = noop_sleeper();
    shield::cli::run_scan(
        &server.client(),
        store,
        dir.path(),
        auto,
        prompter,
        &sleeper,
        out,
    )
}

// ---------------------------------------------------------------------------
// Binary help surface
// ---------------------------------------------------------------------------

#[test]
fn binary_help_lists_exactly_the_three_commands() {
    let bin = env!("CARGO_BIN_EXE_shield");
    let output = std::process::Command::new(bin)
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    for cmd in ["login", "scan", "logout"] {
        assert!(text.contains(cmd), "help missing {cmd}: {text}");
    }
    let scan_help = std::process::Command::new(bin)
        .args(["scan", "--help"])
        .output()
        .unwrap();
    assert!(scan_help.status.success());
    assert!(String::from_utf8_lossy(&scan_help.stdout).contains("--auto"));
    let bad = std::process::Command::new(bin)
        .arg("frobnicate")
        .output()
        .unwrap();
    assert!(!bad.status.success());
}

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

fn device_server(poll_bodies: Vec<Value>) -> (MockServer, Arc<AtomicUsize>) {
    let polls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&polls);
    let server = MockServer::start(move |req| match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/cli/device/start") => MockResponse::ok(json!({
            "deviceCode": "dc-1",
            "userCode": "ABCD-EFGH",
            "verificationUrl": "http://localhost:3000/device",
            "expiresInSec": 600,
            "intervalSec": 0
        })),
        ("POST", "/api/cli/device/poll") => {
            let i = counter.fetch_add(1, Ordering::SeqCst);
            let body = poll_bodies
                .get(i)
                .unwrap_or(poll_bodies.last().unwrap())
                .clone();
            MockResponse::ok(body)
        }
        _ => MockResponse::json(404, json!({ "error": "not found" })),
    });
    (server, polls)
}

#[test]
fn device_flow_approved_stores_token_and_never_prints_it() {
    let (server, _polls) = device_server(vec![
        json!({ "status": "pending" }),
        json!({ "status": "approved", "token": "tok-secret-123" }),
    ]);
    let dir = TempDir::new("login-ok");
    let store = file_store(&dir);
    let sleeper = noop_sleeper();
    let mut out: Vec<u8> = Vec::new();
    auth::login(&server.client(), &store, &mut out, &sleeper).unwrap();

    assert_eq!(store.load().unwrap().as_deref(), Some("tok-secret-123"));
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("http://localhost:3000/device"), "{text}");
    assert!(text.contains("ABCD-EFGH"), "{text}");
    assert!(!text.contains("tok-secret-123"), "token leaked: {text}");

    let poll = server
        .requests()
        .into_iter()
        .find(|r| r.path == "/api/cli/device/poll")
        .unwrap();
    assert_eq!(poll.json()["deviceCode"], json!("dc-1"));
}

#[test]
fn device_flow_denied_stores_nothing() {
    let (server, _polls) = device_server(vec![json!({ "status": "denied" })]);
    let dir = TempDir::new("login-denied");
    let store = file_store(&dir);
    let sleeper = noop_sleeper();
    let mut out: Vec<u8> = Vec::new();
    let err = auth::login(&server.client(), &store, &mut out, &sleeper).unwrap_err();
    assert!(err.message().contains("denied"), "{err}");
    assert_eq!(store.load().unwrap(), None);
}

#[test]
fn device_flow_expired_stores_nothing() {
    let (server, _polls) = device_server(vec![json!({ "status": "expired" })]);
    let dir = TempDir::new("login-expired");
    let store = file_store(&dir);
    let sleeper = noop_sleeper();
    let mut out: Vec<u8> = Vec::new();
    let err = auth::login(&server.client(), &store, &mut out, &sleeper).unwrap_err();
    assert!(err.message().contains("expired"), "{err}");
    assert_eq!(store.load().unwrap(), None);
}

// ---------------------------------------------------------------------------
// Credential storage / logout
// ---------------------------------------------------------------------------

#[test]
fn credential_store_round_trip_permissions_and_logout_deletion() {
    let dir = TempDir::new("creds");
    let store = file_store(&dir);
    store.save("tok-secret-123").unwrap();

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(store.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "credentials file must be owner-only");
    }
    assert_eq!(store.load().unwrap().as_deref(), Some("tok-secret-123"));
    assert!(
        !store.path().starts_with(dir.path().join("repo")),
        "credentials must not be written into a repo directory"
    );

    let server = scan_server(single_project_body(), "completed");
    let mut out: Vec<u8> = Vec::new();
    auth::logout(&server.client(), &store, &mut out).unwrap();
    assert_eq!(store.load().unwrap(), None);
    assert!(!store.path().exists());

    let logout_req = server
        .requests()
        .into_iter()
        .find(|r| r.path == "/api/cli/logout")
        .expect("logout must ask the server to revoke the token");
    assert_eq!(
        logout_req.header("authorization"),
        Some("Bearer tok-secret-123")
    );
}

#[test]
fn logout_deletes_local_credentials_even_if_server_is_unreachable() {
    let dir = TempDir::new("logout-offline");
    let store = logged_in_store(&dir);
    // Port 9 (discard) is closed: revocation fails, deletion must not.
    let client = ApiClient::new("http://127.0.0.1:9");
    let mut out: Vec<u8> = Vec::new();
    auth::logout(&client, &store, &mut out).unwrap();
    assert_eq!(store.load().unwrap(), None);
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

#[test]
fn gitignore_is_respected() {
    let dir = TempDir::new("gitignore");
    dir.write(".gitignore", "secret-notes.txt\n");
    dir.write("main.rs", "fn main() {}\n");
    dir.write("secret-notes.txt", "do not upload\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    let paths = snapshot_paths(&snapshot);
    assert!(paths.contains(&"main.rs"), "{paths:?}");
    assert!(!paths.contains(&"secret-notes.txt"), "{paths:?}");
}

#[test]
fn env_files_are_excluded_even_when_not_gitignored() {
    let dir = TempDir::new("env");
    dir.write(".env", "SECRET=1\n");
    dir.write(".env.local", "SECRET=2\n");
    dir.write(".env.example", "SECRET=3\n");
    dir.write("app.rs", "fn app() {}\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    assert_eq!(snapshot_paths(&snapshot), vec!["app.rs"]);
    assert_eq!(snapshot.excluded.env_files, 3);
}

#[test]
fn binary_is_excluded_by_content_and_odd_text_extensions_are_included() {
    let dir = TempDir::new("content");
    // Misleading extension, binary content (NUL byte).
    dir.write("fake.rs", b"PK\x03\x04\x00binary".as_slice());
    // Invalid UTF-8 without a NUL byte.
    dir.write("blob.dat", [0xff, 0xfe, b'a'].as_slice());
    // Text with extensions no allowlist would contain.
    dir.write("notes.weirdext", "plain text\n");
    dir.write("data.xyz", "{\"json\": true}\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    assert_eq!(
        snapshot_paths(&snapshot),
        vec!["data.xyz", "notes.weirdext"]
    );
    assert_eq!(snapshot.excluded.binary_files, 2);
}

#[test]
fn dependency_and_generated_directories_are_excluded() {
    let dir = TempDir::new("deps");
    for d in [
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        "vendor",
        ".git",
    ] {
        dir.write(&format!("{d}/pkg/code.js"), "console.log(1)\n");
    }
    dir.write("src/main.rs", "fn main() {}\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    assert_eq!(snapshot_paths(&snapshot), vec!["src/main.rs"]);
    assert!(
        snapshot.excluded.dependency_dirs >= 6,
        "excluded dirs: {:?}",
        snapshot.excluded
    );
}

#[test]
fn symlinks_are_never_followed_out_of_the_root() {
    let outside = TempDir::new("outside");
    outside.write("secret.rs", "fn secret() {}\n");
    let dir = TempDir::new("links");
    dir.write("real.rs", "fn real() {}\n");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            outside.path().join("secret.rs"),
            dir.path().join("linked.rs"),
        )
        .unwrap();
        let snapshot = files::build_snapshot(dir.path()).unwrap();
        assert_eq!(snapshot_paths(&snapshot), vec!["real.rs"]);
        assert_eq!(snapshot.excluded.symlinks, 1);
    }
}

// ---------------------------------------------------------------------------
// Snapshot immutability: uploaded bytes are the captured bytes
// ---------------------------------------------------------------------------

#[test]
fn uploaded_payload_is_the_snapshot_bytes_even_after_the_file_changes() {
    let dir = TempDir::new("snapshot");
    dir.write("app.rs", "original contents\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    // The working tree changes after the snapshot is taken.
    dir.write("app.rs", "modified on disk afterwards\n");

    let server = scan_server(single_project_body(), "completed");
    let sleeper = noop_sleeper();
    let mut out: Vec<u8> = Vec::new();
    let outcome = shield::cli::upload_snapshot(
        &server.client(),
        "tok-secret-123",
        "p1",
        &snapshot,
        &sleeper,
        &mut out,
    )
    .unwrap();
    assert_eq!(outcome.status, "completed");

    let requests = server.requests();
    let put = requests
        .iter()
        .find(|r| r.method == "PUT")
        .expect("a file upload must have happened");
    let body = put.json();
    let decoded = BASE64
        .decode(body["contentBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(decoded, b"original contents\n");
    assert_eq!(
        body["sha256"].as_str().unwrap(),
        files::sha256_hex(b"original contents\n")
    );
    let create = requests
        .iter()
        .find(|r| r.method == "POST" && r.path == "/api/scans")
        .unwrap();
    assert_eq!(
        create.json()["files"][0]["sha256"].as_str().unwrap(),
        files::sha256_hex(b"original contents\n")
    );
}

// ---------------------------------------------------------------------------
// Resumable upload semantics
// ---------------------------------------------------------------------------

#[test]
fn interrupted_upload_is_retried_and_then_completes() {
    let dir = TempDir::new("retry");
    dir.write("a.rs", "fn a() {}\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    let put_attempts = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&put_attempts);
    let server = MockServer::start(move |req| {
        match (req.method.as_str(), req.path.as_str()) {
            ("POST", "/api/scans") => MockResponse::ok(json!({
                "scanId": "scan-1", "costShields": 5, "needed": ["a.rs"]
            })),
            ("PUT", "/api/scans/scan-1/files") => {
                if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                    MockResponse::dropped() // first attempt dies on the wire
                } else {
                    MockResponse::ok(json!({ "acked": true }))
                }
            }
            ("POST", "/api/scans/scan-1/complete") => {
                MockResponse::ok(json!({ "status": "analyzing" }))
            }
            ("GET", "/api/scans/scan-1") => MockResponse::ok(json!({
                "id": "scan-1", "status": "completed", "costShields": 5
            })),
            _ => MockResponse::json(404, json!({ "error": "not found" })),
        }
    });
    let sleeper = noop_sleeper();
    let mut out: Vec<u8> = Vec::new();
    let outcome = shield::cli::upload_snapshot(
        &server.client(),
        "tok-secret-123",
        "p1",
        &snapshot,
        &sleeper,
        &mut out,
    )
    .unwrap();
    assert_eq!(outcome.status, "completed");
    assert_eq!(put_attempts.load(Ordering::SeqCst), 2);
    assert_eq!(
        server
            .requests()
            .iter()
            .filter(|r| r.path.ends_with("/complete"))
            .count(),
        1
    );
}

#[test]
fn a_file_that_never_uploads_means_no_complete_call() {
    let dir = TempDir::new("never");
    dir.write("a.rs", "fn a() {}\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    let put_attempts = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&put_attempts);
    let server = MockServer::start(move |req| match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/scans") => MockResponse::ok(json!({
            "scanId": "scan-1", "costShields": 5, "needed": ["a.rs"]
        })),
        ("PUT", "/api/scans/scan-1/files") => {
            counter.fetch_add(1, Ordering::SeqCst);
            MockResponse::dropped()
        }
        _ => MockResponse::json(404, json!({ "error": "not found" })),
    });
    let sleeper = noop_sleeper();
    let mut out: Vec<u8> = Vec::new();
    let err = shield::cli::upload_snapshot(
        &server.client(),
        "tok-secret-123",
        "p1",
        &snapshot,
        &sleeper,
        &mut out,
    )
    .unwrap_err();
    assert!(err.message().contains("a.rs"), "{err}");
    assert_eq!(
        put_attempts.load(Ordering::SeqCst),
        3,
        "bounded retry = max 3 attempts"
    );
    assert!(
        server
            .requests()
            .iter()
            .all(|r| !r.path.ends_with("/complete")),
        "complete must never be called while a file is unacknowledged"
    );
}

#[test]
fn complete_409_reuploads_missing_and_status_is_polled_only_after() {
    let dir = TempDir::new("missing");
    dir.write("a.rs", "fn a() {}\n");
    dir.write("b.rs", "fn b() {}\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    let completes = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&completes);
    let server = MockServer::start(move |req| match (req.method.as_str(), req.path.as_str()) {
        ("POST", "/api/scans") => MockResponse::ok(json!({
            "scanId": "scan-1", "costShields": 5, "needed": ["a.rs", "b.rs"]
        })),
        ("PUT", "/api/scans/scan-1/files") => MockResponse::ok(json!({ "acked": true })),
        ("POST", "/api/scans/scan-1/complete") => {
            if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                MockResponse::json(409, json!({ "missing": ["b.rs"] }))
            } else {
                MockResponse::ok(json!({ "status": "analyzing" }))
            }
        }
        ("GET", "/api/scans/scan-1") => MockResponse::ok(json!({
            "id": "scan-1", "status": "completed", "costShields": 5
        })),
        _ => MockResponse::json(404, json!({ "error": "not found" })),
    });
    let sleeper = noop_sleeper();
    let mut out: Vec<u8> = Vec::new();
    let outcome = shield::cli::upload_snapshot(
        &server.client(),
        "tok-secret-123",
        "p1",
        &snapshot,
        &sleeper,
        &mut out,
    )
    .unwrap();
    assert_eq!(outcome.status, "completed");

    let requests = server.requests();
    let index_of = |pred: &dyn Fn(&Recorded) -> bool| {
        requests.iter().position(pred).expect("request not found")
    };
    let complete_indices: Vec<usize> = requests
        .iter()
        .enumerate()
        .filter(|(_, r)| r.method == "POST" && r.path.ends_with("/complete"))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(complete_indices.len(), 2);
    // b.rs was uploaded once before the first complete and again after
    // the 409; the first status poll happens only after the successful
    // complete.
    let b_uploads: Vec<usize> = requests
        .iter()
        .enumerate()
        .filter(|(_, r)| r.method == "PUT" && r.json()["path"] == json!("b.rs"))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(b_uploads.len(), 2);
    assert!(b_uploads[0] < complete_indices[0]);
    assert!(complete_indices[0] < b_uploads[1] && b_uploads[1] < complete_indices[1]);
    let first_get = index_of(&|r: &Recorded| r.method == "GET");
    assert!(first_get > complete_indices[1]);
}

// ---------------------------------------------------------------------------
// Full scan command flows
// ---------------------------------------------------------------------------

#[test]
fn size_limit_is_a_hard_error_before_any_request() {
    let dir = TempDir::new("toobig");
    let big = vec![b'a'; (files::LARGE_MAX_BYTES + 1) as usize];
    dir.write("big.txt", big.as_slice());
    let home = TempDir::new("toobig-home");
    let store = logged_in_store(&home);
    let server = scan_server(single_project_body(), "completed");
    let mut out: Vec<u8> = Vec::new();
    let err = run_scan(&server, &store, &dir, true, &NoPrompt, &mut out).unwrap_err();
    assert!(err.message().contains("snapshot too large"), "{err}");
    assert!(
        server.requests().is_empty(),
        "no request may be made for an oversize snapshot"
    );
}

#[test]
fn auto_skips_confirmation_and_single_project_user_is_never_prompted() {
    let dir = TempDir::new("auto");
    dir.write("main.rs", "fn main() {}\n");
    let home = TempDir::new("auto-home");
    let store = logged_in_store(&home);
    let server = scan_server(single_project_body(), "completed");
    let mut out: Vec<u8> = Vec::new();
    // NoPrompt panics if either prompt fires.
    let outcome = run_scan(&server, &store, &dir, true, &NoPrompt, &mut out).unwrap();
    assert_eq!(outcome.scan_id, "scan-1");
    assert_eq!(outcome.status, "completed");
    assert_eq!(outcome.cost_shields, 5);

    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("Files selected: 1"), "{text}");
    assert!(text.contains("Cost: 5 Shields"), "{text}");
    assert!(
        text.contains("processed by external AI models"),
        "privacy notice missing: {text}"
    );
    // The Bearer token goes out on scan endpoints.
    let projects_req = server
        .requests()
        .into_iter()
        .find(|r| r.path == "/api/cli/projects")
        .unwrap();
    assert_eq!(
        projects_req.header("authorization"),
        Some("Bearer tok-secret-123")
    );
}

#[test]
fn declining_the_confirmation_cancels_before_any_request() {
    let dir = TempDir::new("decline");
    dir.write("main.rs", "fn main() {}\n");
    let home = TempDir::new("decline-home");
    let store = logged_in_store(&home);
    let server = scan_server(single_project_body(), "completed");
    let mut out: Vec<u8> = Vec::new();
    let err = run_scan(&server, &store, &dir, false, &Decline, &mut out).unwrap_err();
    assert!(err.message().contains("cancelled"), "{err}");
    assert!(server.requests().is_empty());
}

#[test]
fn scan_without_login_is_a_clear_error() {
    let dir = TempDir::new("nologin");
    dir.write("main.rs", "fn main() {}\n");
    let store = file_store(&dir); // never saved a token
    let server = scan_server(single_project_body(), "completed");
    let mut out: Vec<u8> = Vec::new();
    let err = run_scan(&server, &store, &dir, true, &NoPrompt, &mut out).unwrap_err();
    assert!(err.message().contains("shield login"), "{err}");
}

#[test]
fn multi_project_user_picks_a_project_and_the_repo_is_linked() {
    let dir = TempDir::new("pick");
    dir.write("main.rs", "fn main() {}\n");
    let home = TempDir::new("pick-home");
    let store = logged_in_store(&home);
    let server = scan_server(
        json!({
            "projects": [
                { "id": "p1", "name": "One" },
                { "id": "p2", "name": "Two" }
            ],
            "singleProject": false
        }),
        "completed",
    );
    let mut out: Vec<u8> = Vec::new();
    let prompter = Scripted(ProjectChoice::Existing("p2".to_string()));
    let outcome = run_scan(&server, &store, &dir, false, &prompter, &mut out).unwrap();
    assert_eq!(outcome.status, "completed");

    let requests = server.requests();
    let link = requests
        .iter()
        .find(|r| r.path == "/api/cli/repo-link")
        .expect("repo link must be stored server-side");
    let link_body = link.json();
    assert_eq!(link_body["projectId"], json!("p2"));
    assert_eq!(link_body["repoName"], json!(dir.basename()));
    assert!(link_body["remoteUrlHash"].is_null());
    let create = requests
        .iter()
        .find(|r| r.method == "POST" && r.path == "/api/scans")
        .unwrap();
    assert_eq!(create.json()["projectId"], json!("p2"));
    assert_eq!(create.json()["action"], json!("full"));
}

#[test]
fn multi_project_user_can_create_a_project_during_resolution() {
    let dir = TempDir::new("create");
    dir.write("main.rs", "fn main() {}\n");
    let home = TempDir::new("create-home");
    let store = logged_in_store(&home);
    let server = scan_server(
        json!({
            "projects": [{ "id": "p1", "name": "One" }],
            "singleProject": false
        }),
        "completed",
    );
    let mut out: Vec<u8> = Vec::new();
    let prompter = Scripted(ProjectChoice::New("Fresh App".to_string()));
    run_scan(&server, &store, &dir, false, &prompter, &mut out).unwrap();

    let requests = server.requests();
    let create_project = requests
        .iter()
        .find(|r| r.method == "POST" && r.path == "/api/cli/projects")
        .expect("project creation request missing");
    assert_eq!(create_project.json()["name"], json!("Fresh App"));
    let link = requests
        .iter()
        .find(|r| r.path == "/api/cli/repo-link")
        .unwrap();
    assert_eq!(link.json()["projectId"], json!("p-new"));
    let create_scan = requests
        .iter()
        .find(|r| r.method == "POST" && r.path == "/api/scans")
        .unwrap();
    assert_eq!(create_scan.json()["projectId"], json!("p-new"));
}

#[test]
fn auto_with_unresolved_multi_project_repo_fails_with_instructions() {
    let dir = TempDir::new("autofail");
    dir.write("main.rs", "fn main() {}\n");
    let home = TempDir::new("autofail-home");
    let store = logged_in_store(&home);
    let server = scan_server(
        json!({
            "projects": [
                { "id": "p1", "name": "One" },
                { "id": "p2", "name": "Two" }
            ],
            "singleProject": false
        }),
        "completed",
    );
    let mut out: Vec<u8> = Vec::new();
    let err = run_scan(&server, &store, &dir, true, &NoPrompt, &mut out).unwrap_err();
    assert!(err.message().contains("without --auto"), "{err}");
    assert!(
        server
            .requests()
            .iter()
            .all(|r| !(r.method == "POST" && r.path == "/api/scans")),
        "no scan may be created for an unresolved repo"
    );
}

#[test]
fn a_server_side_repo_link_resolves_without_prompting() {
    let dir = TempDir::new("linked");
    dir.write("main.rs", "fn main() {}\n");
    let home = TempDir::new("linked-home");
    let store = logged_in_store(&home);
    let server = scan_server(
        json!({
            "projects": [
                { "id": "p1", "name": "One" },
                { "id": "p-linked", "name": "Linked" }
            ],
            "singleProject": false,
            "linkedRepos": [{
                "repoName": dir.basename(),
                "remoteUrlHash": null,
                "projectId": "p-linked"
            }]
        }),
        "completed",
    );
    let mut out: Vec<u8> = Vec::new();
    // ConfirmOnly panics if choose_project fires.
    let outcome = run_scan(&server, &store, &dir, false, &ConfirmOnly, &mut out).unwrap();
    assert_eq!(outcome.status, "completed");
    let requests = server.requests();
    let create_scan = requests
        .iter()
        .find(|r| r.method == "POST" && r.path == "/api/scans")
        .unwrap();
    assert_eq!(create_scan.json()["projectId"], json!("p-linked"));
    assert!(
        requests.iter().all(|r| r.path != "/api/cli/repo-link"),
        "an existing link must not be re-created"
    );
}

#[test]
fn server_status_is_reported_verbatim() {
    let dir = TempDir::new("verbatim");
    dir.write("main.rs", "fn main() {}\n");
    let home = TempDir::new("verbatim-home");
    let store = logged_in_store(&home);
    // The mock never moves past "analyzing": the CLI must say exactly
    // that, never claim the analysis ran.
    let server = scan_server(single_project_body(), "analyzing");
    let mut out: Vec<u8> = Vec::new();
    let outcome = run_scan(&server, &store, &dir, true, &NoPrompt, &mut out).unwrap();
    assert_eq!(outcome.status, "analyzing");
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("\"analyzing\""), "{text}");
    let polls = server
        .requests()
        .iter()
        .filter(|r| r.method == "GET" && r.path == "/api/scans/scan-1")
        .count();
    assert_eq!(polls, 5, "initial status read + 4 polls");
}

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

#[test]
fn remote_url_hash_is_the_sha256_of_the_git_remote() {
    let dir = TempDir::new("gitrepo");
    dir.write("main.rs", "fn main() {}\n");
    for args in [
        vec!["init", "-q"],
        vec![
            "remote",
            "add",
            "origin",
            "https://example.com/acme/repo.git",
        ],
    ] {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(&args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }
    assert_eq!(
        files::remote_url_hash(dir.path()),
        Some(files::sha256_hex(b"https://example.com/acme/repo.git"))
    );
    assert_eq!(files::repo_name(dir.path()), dir.basename());

    let plain = TempDir::new("nogit");
    assert_eq!(files::remote_url_hash(plain.path()), None);
}

// ---------------------------------------------------------------------------
// Preview formatting
// ---------------------------------------------------------------------------

#[test]
fn preview_shows_root_counts_cost_and_notice() {
    let dir = TempDir::new("preview");
    dir.write("main.rs", "fn main() {}\n");
    dir.write(".env", "SECRET=1\n");
    let snapshot = files::build_snapshot(dir.path()).unwrap();
    let text = files::format_preview(dir.path(), &snapshot, 5);
    assert!(text.contains(&dir.path().display().to_string()), "{text}");
    assert!(text.contains("Files selected: 1"), "{text}");
    assert!(text.contains("Cost: 5 Shields"), "{text}");
    assert!(text.contains(".env"), "{text}");
    assert!(text.contains("transmitted to Shield"), "{text}");
    assert!(text.contains("external AI models"), "{text}");
}
