//! Credential storage and the device-flow login/logout
//! (PLAN_V2 §7.2).
//!
//! The CLI token is stored in the OS credential store (via the
//! `keyring` crate) when available. On any keyring error the token
//! falls back to `~/.config/shield/credentials.json` with `0600`
//! permissions and a printed warning. The token is never printed and
//! never written into the scanned repository.

use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::api::{ApiClient, PollOutcome};
use crate::{Error, Result};

const KEYRING_SERVICE: &str = "shield-ai";
const KEYRING_USER: &str = "cli-token";

/// Where a CLI token can be stored. Implemented by the OS keyring,
/// a user-only file, and the auto-selecting combination of both.
pub trait CredentialStore {
    fn save(&self, token: &str) -> Result<()>;
    fn load(&self) -> Result<Option<String>>;
    fn delete(&self) -> Result<()>;
}

#[derive(Serialize, Deserialize)]
struct CredentialsFile {
    token: String,
}

/// File fallback store: JSON under the OS config dir.
#[derive(Debug, Clone)]
pub struct FileCredentialStore {
    path: PathBuf,
}

impl FileCredentialStore {
    pub fn new(path: PathBuf) -> Self {
        FileCredentialStore { path }
    }

    /// `~/.config/shield/credentials.json` (via `$HOME`).
    pub fn default_path() -> Result<PathBuf> {
        let home = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .ok_or_else(|| Error::new("HOME is not set; cannot locate the config directory"))?;
        Ok(PathBuf::from(home)
            .join(".config")
            .join("shield")
            .join("credentials.json"))
    }

    pub fn from_default_location() -> Result<Self> {
        Ok(FileCredentialStore::new(Self::default_path()?))
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl CredentialStore for FileCredentialStore {
    fn save(&self, token: &str) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
        let body = serde_json::to_string(&CredentialsFile {
            token: token.to_string(),
        })?;
        std::fs::write(&self.path, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    fn load(&self) -> Result<Option<String>> {
        if !self.path.exists() {
            return Ok(None);
        }
        let body = std::fs::read_to_string(&self.path)?;
        let parsed: CredentialsFile = serde_json::from_str(&body).map_err(|e| {
            Error::new(format!(
                "stored credentials at {} are unreadable: {e}",
                self.path.display()
            ))
        })?;
        if parsed.token.is_empty() {
            Ok(None)
        } else {
            Ok(Some(parsed.token))
        }
    }

    fn delete(&self) -> Result<()> {
        if self.path.exists() {
            std::fs::remove_file(&self.path)?;
        }
        Ok(())
    }
}

/// OS credential store via the `keyring` crate.
#[derive(Debug, Default)]
pub struct KeyringCredentialStore;

impl KeyringCredentialStore {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| Error::new(format!("OS credential store unavailable: {e}")))
    }
}

impl CredentialStore for KeyringCredentialStore {
    fn save(&self, token: &str) -> Result<()> {
        self.entry()?
            .set_password(token)
            .map_err(|e| Error::new(format!("could not store token in OS credential store: {e}")))
    }

    fn load(&self) -> Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(token) if !token.is_empty() => Ok(Some(token)),
            Ok(_) => Ok(None),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::new(format!(
                "could not read OS credential store: {e}"
            ))),
        }
    }

    fn delete(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::new(format!(
                "could not delete token from OS credential store: {e}"
            ))),
        }
    }
}

/// Default store: keyring first; on any keyring failure, the file
/// fallback (with a warning printed to stderr at save time).
#[derive(Debug)]
pub struct AutoCredentialStore {
    keyring: KeyringCredentialStore,
    file: FileCredentialStore,
}

impl AutoCredentialStore {
    pub fn new(file: FileCredentialStore) -> Self {
        AutoCredentialStore {
            keyring: KeyringCredentialStore,
            file,
        }
    }
}

impl CredentialStore for AutoCredentialStore {
    fn save(&self, token: &str) -> Result<()> {
        match self.keyring.save(token) {
            Ok(()) => {
                // Remove any stale fallback copy so there is exactly
                // one stored token.
                let _ = self.file.delete();
                Ok(())
            }
            Err(e) => {
                eprintln!(
                    "warning: OS credential store unavailable ({e}); storing the token in {} \
                     with owner-only (0600) permissions instead.",
                    self.file.path().display()
                );
                self.file.save(token)
            }
        }
    }

    fn load(&self) -> Result<Option<String>> {
        match self.keyring.load() {
            Ok(Some(token)) => Ok(Some(token)),
            Ok(None) => self.file.load(),
            Err(_) => self.file.load(),
        }
    }

    fn delete(&self) -> Result<()> {
        let _ = self.keyring.delete();
        self.file.delete()
    }
}

pub fn default_store() -> Result<AutoCredentialStore> {
    Ok(AutoCredentialStore::new(
        FileCredentialStore::from_default_location()?,
    ))
}

/// Run the device flow (PLAN_V2 §7.2): request a device code, print
/// the verification URL + user code, poll until approved / denied /
/// expired, then store the issued CLI token. The token itself is
/// never printed.
pub fn login(
    client: &ApiClient,
    store: &dyn CredentialStore,
    out: &mut dyn Write,
    sleeper: &dyn Fn(Duration),
) -> Result<()> {
    let start = client.device_start()?;
    writeln!(
        out,
        "To log in, open:\n  {}\nand enter the code:\n  {}",
        start.verification_url, start.user_code
    )?;
    writeln!(out, "Waiting for approval…")?;
    out.flush()?;

    let deadline = Instant::now() + Duration::from_secs(start.expires_in_sec.max(1));
    loop {
        match client.device_poll(&start.device_code)? {
            PollOutcome::Approved(token) => {
                store.save(&token)?;
                writeln!(out, "Logged in. Token stored securely.")?;
                return Ok(());
            }
            PollOutcome::Denied => {
                return Err(Error::new(
                    "login was denied in the browser; no token was stored",
                ));
            }
            PollOutcome::Expired => {
                return Err(Error::new(
                    "the device code expired before it was approved; run `shield login` again",
                ));
            }
            PollOutcome::Pending => {
                if Instant::now() >= deadline {
                    return Err(Error::new(
                        "the device code expired before it was approved; run `shield login` again",
                    ));
                }
                sleeper(Duration::from_secs(start.interval_sec));
            }
        }
    }
}

/// Log out: best-effort server-side revocation, then delete the
/// locally stored credentials.
pub fn logout(client: &ApiClient, store: &dyn CredentialStore, out: &mut dyn Write) -> Result<()> {
    if let Some(token) = store.load()? {
        // Best effort: local deletion happens even if the server
        // cannot be reached or the token was already revoked.
        let _ = client.logout(&token);
    }
    store.delete()?;
    writeln!(out, "Logged out. Local credentials deleted.")?;
    Ok(())
}
