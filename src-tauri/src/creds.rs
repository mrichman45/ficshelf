//! The AO3 password, kept in the operating system's own credential store.
//!
//! On Linux that is the Secret Service — KDE Wallet under Plasma, GNOME
//! Keyring elsewhere — and on Windows it is Credential Manager. In both cases
//! the secret is held by the desktop session, unlocked with the user's own
//! login, and is never written to this app's database, its config, or any file
//! it controls.
//!
//! The username is not a secret and lives in the settings table, so the app
//! can show who is signed in without unlocking the keyring.
//!
//! Phones have no `keyring` backend. There, `SUPPORTED` is false, nothing is
//! ever stored, and the user signs in once per launch.

use anyhow::Result;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use desktop::*;
#[cfg(any(target_os = "android", target_os = "ios"))]
pub use phone::*;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
    use anyhow::{Context, Result};
    use keyring::Entry;

    pub const SUPPORTED: bool = true;

    const SERVICE: &str = "ficshelf-ao3";

    fn entry(username: &str) -> Result<Entry> {
        Entry::new(SERVICE, username).context("opening the system credential store")
    }

    pub fn store(username: &str, password: &str) -> Result<()> {
        entry(username)?
            .set_password(password)
            .context("saving the password to the system credential store")
    }

    /// The stored password, or `None` if there is not one. A keyring that is
    /// locked or unavailable is an error rather than a `None`, so the caller can
    /// say so instead of silently behaving as though the user never signed in.
    pub fn load(username: &str) -> Result<Option<String>> {
        match entry(username)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).context("reading the password from the system credential store"),
        }
    }

    pub fn forget(username: &str) -> Result<()> {
        match entry(username)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).context("removing the password from the system credential store"),
        }
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod phone {
    use anyhow::Result;

    pub const SUPPORTED: bool = false;

    pub fn store(_username: &str, _password: &str) -> Result<()> {
        Ok(())
    }

    pub fn load(_username: &str) -> Result<Option<String>> {
        Ok(None)
    }

    pub fn forget(_username: &str) -> Result<()> {
        Ok(())
    }
}

#[allow(dead_code)]
fn _signatures_match() -> Result<()> {
    // Both halves must offer the same three functions.
    store("", "")?;
    let _ = load("")?;
    forget("")
}
