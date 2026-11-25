use std::path::PathBuf;

use crate::protocol::ControlErrorCode;

/// What can go wrong talking to mirab.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// No `mirab` on `PATH` or in `~/.mirab/bin`.
    #[error("mirab isn't installed: https://mirab-releases.addis.gg/install.sh")]
    NotInstalled,

    /// The program couldn't be run.
    #[error("couldn't run {program}: {source}")]
    Launch {
        /// What was run.
        program: PathBuf,
        /// Why it didn't start.
        source: std::io::Error,
    },

    /// The installed mirab has no control interface, or speaks another version.
    #[error("mirab {found} can't be used by this client (protocol {wanted}): {detail}")]
    Incompatible {
        /// The version it reports, or `unknown`.
        found: String,
        /// The protocol this crate speaks.
        wanted: i64,
        /// What it said.
        detail: String,
    },

    /// mirab answered a request with an error.
    #[error("{message}")]
    Control {
        /// What kind of failure.
        code: ControlErrorCode,
        /// mirab's own sentence about it.
        message: String,
    },

    /// mirab sent something this crate can't read.
    #[error("mirab sent an unreadable frame: {0}")]
    Protocol(String),

    /// The `mirab control` process is gone.
    #[error("mirab control ended{}", .detail.as_deref().map(|d| format!(": {d}")).unwrap_or_default())]
    Disconnected {
        /// The end of what it printed to stderr, if anything.
        detail: Option<String>,
    },

    /// A session's events can be taken once.
    #[error("this session's events are already being read")]
    EventsTaken,

    /// The reader fell too far behind and the stream was cut. Nothing was
    /// lost on mirab's side: [`Session::requests`](crate::Session::requests)
    /// still lists what is held.
    #[error("the event stream fell more than {0} events behind")]
    EventsLagged(usize),

    /// Reading or writing the pipe failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
