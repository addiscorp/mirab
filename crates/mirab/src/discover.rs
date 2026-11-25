use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use crate::client::Client;
use crate::error::Error;

/// An installed mirab, not yet running.
#[derive(Debug, Clone)]
pub struct Mirab {
    program: PathBuf,
    args: Vec<OsString>,
    config_dir: Option<PathBuf>,
}

impl Mirab {
    /// Finds the installed `mirab`: on `PATH`, then in `~/.mirab/bin`, where
    /// the installer puts it.
    pub fn discover() -> Result<Self, Error> {
        let path = env::var_os("PATH").unwrap_or_default();
        let home = env::var_os("HOME").map(PathBuf::from);
        find(&path, home.as_deref())
            .map(Self::at)
            .ok_or(Error::NotInstalled)
    }

    /// The mirab at this path.
    pub fn at(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            config_dir: None,
        }
    }

    /// A mirab run through another program, such as `bun run src/mirab.ts`
    /// from a checkout.
    pub fn with_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args = args.into_iter().map(|a| a.as_ref().to_owned()).collect();
        self
    }

    /// Uses this mirab config directory instead of `~/.config/mirab`.
    pub fn config_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.config_dir = Some(dir.into());
        self
    }

    /// The program this runs.
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// What `mirab --version` says.
    pub async fn version(&self) -> Result<String, Error> {
        let output = self
            .command()
            .arg("--version")
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|source| self.launch(source))?;
        if !output.status.success() {
            return Err(Error::Incompatible {
                found: "unknown".into(),
                wanted: crate::PROTOCOL,
                detail: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    /// Starts `mirab control` and checks that it speaks this crate's protocol.
    pub async fn connect(&self) -> Result<Client, Error> {
        let mut command = self.command();
        if let Some(dir) = &self.config_dir {
            command.arg("--config-dir").arg(dir);
        }
        command
            .arg("control")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = command.spawn().map_err(|source| self.launch(source))?;
        Client::handshake(child).await
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        command
    }

    fn launch(&self, source: std::io::Error) -> Error {
        Error::Launch {
            program: self.program.clone(),
            source,
        }
    }
}

fn find(path: &OsStr, home: Option<&Path>) -> Option<PathBuf> {
    env::split_paths(path)
        .chain(home.map(|h| h.join(".mirab/bin")))
        .map(|dir| dir.join("mirab"))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("mirab-discover-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn program(dir: &Path, mode: u32) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join("mirab");
        fs::write(&path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn path_comes_before_the_install_directory() {
        let root = scratch("order");
        let on_path = program(&root.join("bin"), 0o755);
        program(&root.join("home/.mirab/bin"), 0o755);
        let path = env::join_paths([root.join("bin")]).unwrap();
        assert_eq!(find(&path, Some(&root.join("home"))), Some(on_path));
    }

    #[test]
    fn falls_back_to_the_install_directory() {
        let root = scratch("fallback");
        let installed = program(&root.join("home/.mirab/bin"), 0o755);
        let path = env::join_paths([root.join("empty")]).unwrap();
        assert_eq!(find(&path, Some(&root.join("home"))), Some(installed));
    }

    #[test]
    fn a_file_that_cannot_run_is_not_mirab() {
        let root = scratch("mode");
        program(&root.join("bin"), 0o644);
        let path = env::join_paths([root.join("bin")]).unwrap();
        assert_eq!(find(&path, None), None);
    }
}
