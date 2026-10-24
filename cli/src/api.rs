//! Backend API client.
//!
//! Mirrors, by hand, the Zod contracts in `packages/shared`
//! (PLAN_V2 §8.6): same paths, same field names, same shapes.
//! All scan endpoints require the Bearer CLI token issued by the
//! device flow (PLAN_V2 §7.2).

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::files::SnapshotFile;
use crate::{Error, Result};

/// Default API base URL when `SHIELD_API_URL` is not set.
pub const DEFAULT_API_BASE: &str = "http://localhost:3000";

/// Resolve the API base URL: `SHIELD_API_URL` env var, else localhost.
pub fn base_url_from_env() -> String {
    match std::env::var("SHIELD_API_URL") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT_API_BASE.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Contract types (mirror of packages/shared Zod schemas)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStartResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_in_sec: u64,
    pub interval_sec: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePollResponse {
    status: String,
    token: Option<String>,
}

/// Outcome of one device-flow poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollOutcome {
    Pending,
    Approved(String),
    Denied,
    Expired,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkedRepo {
    pub repo_name: String,
    pub remote_url_hash: Option<String>,
    pub project_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsResponse {
    pub projects: Vec<Project>,
    pub single_project: bool,
    #[serde(default)]
    pub linked_repos: Vec<LinkedRepo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectRequest {
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkRepoRequest {
    project_id: String,
    repo_name: String,
    remote_url_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManifestEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateScanRequest {
    project_id: String,
    action: String,
    files: Vec<FileManifestEntry>,
    /// Required by the backend contract (@shield/shared CreateScanRequest):
    /// retries of THIS invocation reuse the same key so the server can
    /// deduplicate the scan and the Shield debit.
    idempotency_key: String,
}

/// One key per scan invocation: unique across invocations (time + pid),
/// stable across retries within the invocation (derived once here).
fn new_idempotency_key(project_id: &str, files: &[FileManifestEntry]) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let first_hash = files.first().map(|f| f.sha256.as_str()).unwrap_or("");
    let material = format!("{project_id}:{nanos}:{}:{first_hash}", std::process::id());
    let digest = crate::files::sha256_hex(material.as_bytes());
    format!("cli-{}", &digest[..32])
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScanResponse {
    pub scan_id: String,
    pub cost_shields: u64,
    #[serde(default)]
    pub needed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadFileRequest {
    path: String,
    sha256: String,
    content_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
struct CompleteResponse {
    status: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MissingResponse {
    #[serde(default)]
    missing: Vec<String>,
}

/// Result of the explicit completion step (PLAN_V2 §8.4): analysis
/// starts only after every required file is acknowledged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompleteOutcome {
    /// Server accepted completion; value is the server-reported status.
    Started(String),
    /// Server refused with 409: these paths are still missing.
    Missing(Vec<String>),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatusResponse {
    pub id: String,
    pub status: String,
    pub cost_shields: u64,
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

struct RawResponse {
    status: u16,
    body: String,
}

#[derive(Clone)]
pub struct ApiClient {
    base_url: String,
    agent: ureq::Agent,
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(60)))
            .http_status_as_error(false)
            .build()
            .into();
        ApiClient {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            agent,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> Result<RawResponse> {
        let url = self.url(path);
        let auth = token.map(|t| format!("Bearer {t}"));
        // ureq types body-less and body-carrying request builders
        // differently, so each method dispatches separately.
        let sent = match (method, &body) {
            ("GET", _) => {
                let mut builder = self.agent.get(&url);
                if let Some(auth) = &auth {
                    builder = builder.header("Authorization", auth);
                }
                builder.call()
            }
            ("POST", Some(value)) => {
                let mut builder = self.agent.post(&url);
                if let Some(auth) = &auth {
                    builder = builder.header("Authorization", auth);
                }
                builder.send_json(value)
            }
            ("PUT", Some(value)) => {
                let mut builder = self.agent.put(&url);
                if let Some(auth) = &auth {
                    builder = builder.header("Authorization", auth);
                }
                builder.send_json(value)
            }
            ("POST" | "PUT", None) => {
                // All Shield POST/PUT endpoints accept an empty JSON
                // object; call sites pass a body, this is a safeguard.
                let empty = serde_json::json!({});
                let mut builder = if method == "POST" {
                    self.agent.post(&url)
                } else {
                    self.agent.put(&url)
                };
                if let Some(auth) = &auth {
                    builder = builder.header("Authorization", auth);
                }
                builder.send_json(&empty)
            }
            (other, _) => {
                return Err(Error::new(format!(
                    "unsupported HTTP method {other} for Shield API"
                )))
            }
        };
        let mut response =
            sent.map_err(|e| Error::retryable(format!("network error contacting Shield: {e}")))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|e| Error::retryable(format!("failed reading Shield response: {e}")))?;
        Ok(RawResponse { status, body })
    }

    /// Perform a request and decode a 2xx JSON body; turn any other
    /// status into a clear, human error (5xx marked retryable).
    fn request_json<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> Result<T> {
        let raw = self.request(method, path, token, body)?;
        if (200..300).contains(&raw.status) {
            serde_json::from_str(&raw.body)
                .map_err(|e| Error::new(format!("invalid response from Shield server: {e}")))
        } else {
            Err(http_error(raw.status, &raw.body))
        }
    }

    // -- Device flow (PLAN_V2 §7.2) ----------------------------------------

    pub fn device_start(&self) -> Result<DeviceStartResponse> {
        self.request_json(
            "POST",
            "/api/cli/device/start",
            None,
            Some(serde_json::json!({})),
        )
    }

    pub fn device_poll(&self, device_code: &str) -> Result<PollOutcome> {
        let resp: DevicePollResponse = self.request_json(
            "POST",
            "/api/cli/device/poll",
            None,
            Some(serde_json::json!({ "deviceCode": device_code })),
        )?;
        match resp.status.as_str() {
            "approved" => match resp.token {
                Some(token) if !token.is_empty() => Ok(PollOutcome::Approved(token)),
                _ => Err(Error::new(
                    "server approved the login but returned no token",
                )),
            },
            "denied" => Ok(PollOutcome::Denied),
            "expired" => Ok(PollOutcome::Expired),
            // "pending" and any non-terminal status keep polling until
            // the device code's own expiry stops the loop.
            _ => Ok(PollOutcome::Pending),
        }
    }

    /// Best-effort server-side token revocation on logout.
    pub fn logout(&self, token: &str) -> Result<()> {
        let raw = self.request(
            "POST",
            "/api/cli/logout",
            Some(token),
            Some(serde_json::json!({})),
        )?;
        if (200..300).contains(&raw.status) {
            Ok(())
        } else {
            Err(http_error(raw.status, &raw.body))
        }
    }

    // -- Projects / repo links (§8.5) ---------------------------------------

    pub fn list_projects(&self, token: &str) -> Result<ProjectsResponse> {
        self.request_json("GET", "/api/cli/projects", Some(token), None)
    }

    pub fn create_project(&self, token: &str, name: &str) -> Result<Project> {
        let req = CreateProjectRequest {
            name: name.to_string(),
        };
        self.request_json(
            "POST",
            "/api/cli/projects",
            Some(token),
            Some(serde_json::to_value(&req)?),
        )
    }

    pub fn link_repo(
        &self,
        token: &str,
        project_id: &str,
        repo_name: &str,
        remote_url_hash: Option<&str>,
    ) -> Result<()> {
        let req = LinkRepoRequest {
            project_id: project_id.to_string(),
            repo_name: repo_name.to_string(),
            remote_url_hash: remote_url_hash.map(str::to_string),
        };
        let _: serde_json::Value = self.request_json(
            "POST",
            "/api/cli/repo-link",
            Some(token),
            Some(serde_json::to_value(&req)?),
        )?;
        Ok(())
    }

    // -- Scans ---------------------------------------------------------------

    pub fn create_scan(
        &self,
        token: &str,
        project_id: &str,
        action: &str,
        files: &[FileManifestEntry],
    ) -> Result<CreateScanResponse> {
        let req = CreateScanRequest {
            project_id: project_id.to_string(),
            action: action.to_string(),
            files: files.to_vec(),
            idempotency_key: new_idempotency_key(project_id, files),
        };
        self.request_json(
            "POST",
            "/api/scans",
            Some(token),
            Some(serde_json::to_value(&req)?),
        )
    }

    /// Upload one file's captured snapshot bytes (never a re-read).
    pub fn upload_file(&self, token: &str, scan_id: &str, file: &SnapshotFile) -> Result<()> {
        let req = UploadFileRequest {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            content_base64: file.content_base64(),
        };
        let _: serde_json::Value = self.request_json(
            "PUT",
            &format!("/api/scans/{scan_id}/files"),
            Some(token),
            Some(serde_json::to_value(&req)?),
        )?;
        Ok(())
    }

    /// Explicit completion step. A 409 with `{missing: [...]}` is a
    /// normal outcome, not an error.
    pub fn complete_scan(&self, token: &str, scan_id: &str) -> Result<CompleteOutcome> {
        let raw = self.request(
            "POST",
            &format!("/api/scans/{scan_id}/complete"),
            Some(token),
            Some(serde_json::json!({})),
        )?;
        if raw.status == 409 {
            let parsed: MissingResponse = serde_json::from_str(&raw.body)
                .map_err(|e| Error::new(format!("invalid 409 response from server: {e}")))?;
            return Ok(CompleteOutcome::Missing(parsed.missing));
        }
        if (200..300).contains(&raw.status) {
            let parsed: CompleteResponse = serde_json::from_str(&raw.body)
                .map_err(|e| Error::new(format!("invalid response from Shield server: {e}")))?;
            return Ok(CompleteOutcome::Started(parsed.status));
        }
        Err(http_error(raw.status, &raw.body))
    }

    pub fn get_scan(&self, token: &str, scan_id: &str) -> Result<ScanStatusResponse> {
        self.request_json("GET", &format!("/api/scans/{scan_id}"), Some(token), None)
    }
}

/// Build a human error from an HTTP status + body, extracting the
/// server's `error` / `message` field when present.
fn http_error(status: u16, body: &str) -> Error {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                "no response body".to_string()
            } else {
                trimmed.chars().take(200).collect()
            }
        });
    let message = match status {
        401 | 403 => {
            format!("authentication failed (HTTP {status}): {detail} — try `shield login` again")
        }
        _ => format!("Shield server error (HTTP {status}): {detail}"),
    };
    if status >= 500 {
        Error::retryable(message)
    } else {
        Error::new(message)
    }
}
