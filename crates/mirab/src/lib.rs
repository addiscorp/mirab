//! A Rust client for [mirab](https://github.com/addiscorp/mirab): run and
//! control agents in VMs on your own machine.
//!
//! The crate talks to the `mirab` you have installed, through `mirab control`
//! (JSON lines on a pipe). It never bundles or downloads mirab, and no secret
//! passes through it: the station on your machine gets keys from harar, and
//! a held request names them only by their placeholders.
//!
//! ```no_run
//! use mirab::{Decision, Event, Mirab};
//!
//! # async fn run() -> Result<(), mirab::Error> {
//! let client = Mirab::discover()?.connect().await?;
//! let session = client.start("/path/to/project").await?;
//! let mut events = session.events()?;
//! session.send("Open the pull request").await?;
//!
//! while let Some(event) = events.next().await {
//!     match event? {
//!         Event::Message { message, .. } if message.from == session.info().agent => {
//!             println!("{}", message.text);
//!         }
//!         // Show the person exactly what is waiting, then pass on their answer.
//!         Event::Held { request, .. } => {
//!             session.decide(&request.id, Decision::No, None).await?;
//!         }
//!         _ => {}
//!     }
//! }
//! session.stop().await?;
//! client.shutdown().await?;
//! # Ok(())
//! # }
//! ```
//!
//! # Trust
//!
//! Everything that comes out of a VM is untrusted: message text, log lines,
//! the bytes of a held request. Answer [`Decision::Yes`] only for a person who
//! was shown that request, and pass the hash they were shown.
//!
//! Starting a project for the first time records what its agent asks to reach
//! as approved, as `mirab dev` does. Widening it later is deliberately not in
//! this crate: that's `mirab manifest approve`, in the person's own terminal.
#![warn(missing_docs)]

mod client;
mod discover;
mod error;
mod events;
/// The wire types, generated from mirab's protocol definition.
#[rustfmt::skip]
pub mod protocol;

pub use client::{Client, Session, SpawnedAgent};
pub use discover::Mirab;
pub use error::Error;
pub use events::EventStream;
pub use protocol::{
    AvailabilityResult, AvailabilityResultReason, ChannelMessage, ControlErrorCode, Decision,
    Event, GuestEntry, HeldRequest, HeldRequestEntry, HeldStatus, Manifest, ManifestResult,
    PROTOCOL, PendingReach, SessionInfo, SpawnStopResult, SpawnedSession, StopResult, SyncSummary,
};
