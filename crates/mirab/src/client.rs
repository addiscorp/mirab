use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::error::Error;
use crate::events::{EventStream, Queue};
use crate::protocol::*;

/// How long `mirab control` has to answer `hello`.
const HELLO_TIMEOUT: Duration = Duration::from_secs(30);
/// How long [`Client::shutdown`] waits for every VM to stop.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(120);
/// How much of mirab's stderr is kept to explain a failure.
const STDERR_LINES: usize = 20;
/// How long a mirab that ended has to finish saying why.
const STDERR_DRAIN: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
struct Response {
    id: Option<i64>,
    ok: bool,
    #[serde(default)]
    result: Value,
    error: Option<ControlError>,
}

type Reply = Result<Value, Error>;

#[derive(Default)]
struct Routes {
    pending: HashMap<i64, oneshot::Sender<Reply>>,
    queues: HashMap<String, Arc<Queue>>,
    taken: HashSet<String>,
    closed: bool,
}

impl Routes {
    fn queue(&mut self, session: &str) -> Arc<Queue> {
        let queue = self.queues.entry(session.to_owned()).or_default().clone();
        if self.closed {
            queue.close();
        }
        queue
    }
}

struct Shared {
    routes: Mutex<Routes>,
    /// To the task that owns the pipe. Taking it closes mirab's stdin, which
    /// is what tells mirab to stop its VMs; the reader tasks hold `Shared`,
    /// so the pipe can't simply live here.
    stdin: Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>,
    next: AtomicI64,
    stderr: Mutex<VecDeque<String>>,
}

impl Shared {
    fn detail(&self) -> Option<String> {
        let lines = self.stderr.lock().unwrap();
        (!lines.is_empty()).then(|| Vec::from(lines.clone()).join("\n"))
    }

    async fn call<O: Operation>(&self, params: &O) -> Result<O::Result, Error> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut routes = self.routes.lock().unwrap();
            if routes.closed {
                return Err(Error::Disconnected {
                    detail: self.detail(),
                });
            }
            routes.pending.insert(id, tx);
        }
        // A caller that gives up (a dropped future) leaves no entry behind.
        let guard = Forget { shared: self, id };
        let mut line = serde_json::to_vec(&serde_json::json!({
            "id": id,
            "op": O::OP,
            "params": params,
        }))
        .map_err(|e| Error::Protocol(e.to_string()))?;
        line.push(b'\n');
        let queued = self
            .stdin
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|writer| writer.send(line).is_ok());
        if !queued {
            return Err(Error::Disconnected {
                detail: self.detail(),
            });
        }
        let value = rx.await.map_err(|_| Error::Disconnected {
            detail: self.detail(),
        })??;
        drop(guard);
        serde_json::from_value(value).map_err(|e| Error::Protocol(format!("{}: {e}", O::OP)))
    }
}

struct Forget<'a> {
    shared: &'a Shared,
    id: i64,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        self.shared.routes.lock().unwrap().pending.remove(&self.id);
    }
}

fn session_of(event: &Event) -> &str {
    match event {
        Event::Message { session, .. }
        | Event::Held { session, .. }
        | Event::Asked { session, .. }
        | Event::Decided { session, .. }
        | Event::Sent { session, .. }
        | Event::Denied { session, .. }
        | Event::Log { session, .. }
        | Event::Exited { session, .. }
        | Event::SpawnState { session, .. }
        | Event::SpawnExited { session, .. } => session,
    }
}

/// Whether this event is the last its session will send.
fn ends(event: &Event) -> bool {
    matches!(event, Event::SpawnExited { .. })
}

fn route(shared: &Shared, line: &str) -> Result<(), Error> {
    let frame: Value = serde_json::from_str(line).map_err(|e| Error::Protocol(e.to_string()))?;
    if frame.get("event").is_some() {
        let event: Event =
            serde_json::from_value(frame).map_err(|e| Error::Protocol(e.to_string()))?;
        let queue = shared.routes.lock().unwrap().queue(session_of(&event));
        let last = ends(&event);
        queue.push(event);
        if last {
            queue.close();
        }
        return Ok(());
    }
    let response: Response =
        serde_json::from_value(frame).map_err(|e| Error::Protocol(e.to_string()))?;
    let Some(id) = response.id else {
        let error = response.error.map(|e| e.message).unwrap_or_default();
        return Err(Error::Protocol(format!("mirab refused a line: {error}")));
    };
    let reply = if response.ok {
        Ok(response.result)
    } else {
        Err(match response.error {
            Some(e) => Error::Control {
                code: e.code,
                message: e.message,
            },
            None => Error::Protocol("an error with no detail".into()),
        })
    };
    if let Some(tx) = shared.routes.lock().unwrap().pending.remove(&id) {
        let _ = tx.send(reply);
    }
    Ok(())
}

async fn read_frames(
    shared: Arc<Shared>,
    stdout: impl AsyncRead + Unpin,
    stderr_read: JoinHandle<()>,
) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        // One bad frame doesn't take down every other session's stream.
        if let Err(error) = route(&shared, &line) {
            let mut stderr = shared.stderr.lock().unwrap();
            stderr.push_back(error.to_string());
            if stderr.len() > STDERR_LINES {
                stderr.pop_front();
            }
        }
    }
    // Why it ended is on stderr, which closes separately. Bounded: a process
    // mirab left behind could hold that pipe open.
    let _ = tokio::time::timeout(STDERR_DRAIN, stderr_read).await;
    let detail = shared.detail();
    let mut routes = shared.routes.lock().unwrap();
    routes.closed = true;
    for (_, tx) in routes.pending.drain() {
        let _ = tx.send(Err(Error::Disconnected {
            detail: detail.clone(),
        }));
    }
    for queue in routes.queues.values() {
        queue.close();
    }
}

/// Owns mirab's stdin; when the sender goes, the pipe closes.
async fn write_frames(mut stdin: ChildStdin, mut lines: mpsc::UnboundedReceiver<Vec<u8>>) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

async fn read_stderr(shared: Arc<Shared>, stderr: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut kept = shared.stderr.lock().unwrap();
        kept.push_back(line);
        if kept.len() > STDERR_LINES {
            kept.pop_front();
        }
    }
}

/// A running `mirab control`. Dropping it closes the pipe, and mirab stops
/// every VM it started; [`Client::shutdown`] also waits for that.
pub struct Client {
    shared: Arc<Shared>,
    child: AsyncMutex<Child>,
    version: String,
}

impl Client {
    pub(crate) async fn handshake(mut child: Child) -> Result<Self, Error> {
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");
        let (writer, lines) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            routes: Mutex::default(),
            stdin: Mutex::new(Some(writer)),
            next: AtomicI64::new(1),
            stderr: Mutex::default(),
        });
        tokio::spawn(write_frames(stdin, lines));
        let stderr_read = tokio::spawn(read_stderr(shared.clone(), stderr));
        tokio::spawn(read_frames(shared.clone(), stdout, stderr_read));
        let hello = shared.call(&HelloParams { protocol: PROTOCOL });
        let answer = tokio::time::timeout(HELLO_TIMEOUT, hello).await;
        let incompatible = |found: String, detail: String| Error::Incompatible {
            found,
            wanted: PROTOCOL,
            detail,
        };
        let hello = match answer {
            Ok(Ok(hello)) => hello,
            Ok(Err(Error::Control {
                code: ControlErrorCode::UnsupportedProtocol,
                message,
            })) => return Err(incompatible("unknown".into(), message)),
            // An older mirab has no `control` command: it says so and exits.
            Ok(Err(Error::Disconnected { detail })) => {
                return Err(incompatible(
                    "unknown".into(),
                    detail.unwrap_or_else(|| "it exited without answering".into()),
                ));
            }
            Ok(Err(other)) => return Err(other),
            Err(_) => {
                let _ = child.start_kill();
                return Err(incompatible(
                    "unknown".into(),
                    "it didn't answer in time".into(),
                ));
            }
        };
        if hello.protocol != PROTOCOL {
            return Err(incompatible(
                hello.version,
                format!("it speaks protocol {}", hello.protocol),
            ));
        }
        Ok(Self {
            shared,
            child: AsyncMutex::new(child),
            version: hello.version,
        })
    }

    /// The version of the mirab this is connected to.
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Whether VMs can run here, and if not, why. Downloads nothing.
    pub async fn availability(&self) -> Result<AvailabilityResult, Error> {
        self.shared.call(&AvailabilityParams {}).await
    }

    /// The agent in `project`, as mirab reads it (in a VM that boots for it),
    /// and anything it asks for that a person hasn't approved.
    pub async fn manifest(&self, project: impl AsRef<Path>) -> Result<ManifestResult, Error> {
        let project = absolute(project.as_ref())?;
        self.shared.call(&ManifestParams { project }).await
    }

    /// Boots the agent in `project` in its own VM.
    pub async fn start(&self, project: impl AsRef<Path>) -> Result<Session, Error> {
        let project = absolute(project.as_ref())?;
        let info = self.shared.call(&StartParams { project }).await?;
        Ok(self.session(info))
    }

    /// The sessions running in this client.
    pub async fn sessions(&self) -> Result<Vec<Session>, Error> {
        let list = self.shared.call(&SessionsParams {}).await?;
        Ok(list.sessions.into_iter().map(|s| self.session(s)).collect())
    }

    /// Runs a terminal agent (`claude`, `codex`, ...) as a sub-agent, always
    /// in a VM, working on `cwd`.
    pub async fn spawn(
        &self,
        agent: &str,
        args: &[&str],
        cwd: impl AsRef<Path>,
        name: Option<&str>,
    ) -> Result<SpawnedAgent, Error> {
        let result = self
            .shared
            .call(&SpawnParams {
                agent: agent.to_owned(),
                args: args.iter().map(|a| (*a).to_owned()).collect(),
                cwd: absolute(cwd.as_ref())?,
                name: name.map(str::to_owned),
            })
            .await?;
        Ok(SpawnedAgent {
            id: result.session,
            shared: self.shared.clone(),
        })
    }

    /// The sub-agents this client spawned that are still running.
    pub async fn spawned(&self) -> Result<Vec<SpawnedSession>, Error> {
        Ok(self.shared.call(&SpawnedParams {}).await?.sessions)
    }

    /// Stops everything this client started and waits for mirab to exit.
    pub async fn shutdown(self) -> Result<ExitStatus, Error> {
        self.shared.stdin.lock().unwrap().take();
        let mut child = self.child.lock().await;
        match tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await {
            Ok(status) => Ok(status?),
            Err(_) => {
                child.start_kill()?;
                Ok(child.wait().await?)
            }
        }
    }

    fn session(&self, info: SessionInfo) -> Session {
        Session {
            info,
            shared: self.shared.clone(),
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.shared.stdin.lock().unwrap().take();
    }
}

fn absolute(path: &Path) -> Result<String, Error> {
    let full = std::path::absolute(path)?;
    full.into_os_string()
        .into_string()
        .map_err(|_| Error::Protocol("a path that isn't UTF-8".into()))
}

/// An agent running in its VM.
pub struct Session {
    info: SessionInfo,
    shared: Arc<Shared>,
}

impl Session {
    /// Who and where this session is.
    pub fn info(&self) -> &SessionInfo {
        &self.info
    }

    /// The session's id.
    pub fn id(&self) -> &str {
        &self.info.session
    }

    /// Its events, from its start. Can be taken once.
    pub fn events(&self) -> Result<EventStream, Error> {
        take_events(&self.shared, &self.info.session)
    }

    /// Says `text` to the agent as the person; returns the message's id,
    /// which the agent's reply names in `answers`.
    pub async fn send(&self, text: &str) -> Result<String, Error> {
        let params = SendParams {
            session: self.info.session.clone(),
            text: text.to_owned(),
        };
        Ok(self.shared.call(&params).await?.message)
    }

    /// The requests this agent's gateway holds, newest first.
    pub async fn requests(&self) -> Result<Vec<HeldRequestEntry>, Error> {
        let params = RequestsParams {
            session: self.info.session.clone(),
        };
        Ok(self.shared.call(&params).await?.requests)
    }

    /// A person's answer to a held request. A yes names the `hash` of the
    /// request they were shown, and is sent once by the gateway.
    pub async fn decide(
        &self,
        request: &str,
        decision: Decision,
        hash: Option<&str>,
    ) -> Result<(), Error> {
        let params = DecideParams {
            session: self.info.session.clone(),
            request: request.to_owned(),
            decision,
            hash: hash.map(str::to_owned),
        };
        self.shared.call(&params).await.map(|_| ())
    }

    /// Writes a file in the guest (`content` as base64, at most 32 MiB
    /// decoded). Under `/workspace`, it comes back to the project at stop.
    pub async fn put_file(
        &self,
        path: &str,
        content_base64: &str,
        mode: Option<u32>,
    ) -> Result<(), Error> {
        let params = FilePutParams {
            session: self.info.session.clone(),
            path: path.to_owned(),
            content: content_base64.to_owned(),
            mode: mode.map(i64::from),
        };
        self.shared.call(&params).await.map(|_| ())
    }

    /// A guest file's bytes, as base64.
    pub async fn get_file(&self, path: &str) -> Result<String, Error> {
        let params = FileGetParams {
            session: self.info.session.clone(),
            path: path.to_owned(),
        };
        Ok(self.shared.call(&params).await?.content)
    }

    /// Everything under a guest directory.
    pub async fn list_files(&self, root: &str) -> Result<Vec<GuestEntry>, Error> {
        let params = FileListParams {
            session: self.info.session.clone(),
            root: root.to_owned(),
        };
        Ok(self.shared.call(&params).await?.entries)
    }

    /// Stops the agent and its VM. What it changed comes back to the project;
    /// the summary says what did, and what was kept aside.
    pub async fn stop(&self) -> Result<StopResult, Error> {
        let params = StopParams {
            session: self.info.session.clone(),
        };
        let result = self.shared.call(&params).await;
        // No more events will come for it.
        let queue = self.shared.routes.lock().unwrap().queue(&self.info.session);
        queue.close();
        result
    }
}

fn take_events(shared: &Shared, session: &str) -> Result<EventStream, Error> {
    let mut routes = shared.routes.lock().unwrap();
    if !routes.taken.insert(session.to_owned()) {
        return Err(Error::EventsTaken);
    }
    Ok(EventStream::new(routes.queue(session)))
}

/// A sub-agent started with [`Client::spawn`].
pub struct SpawnedAgent {
    id: String,
    shared: Arc<Shared>,
}

impl SpawnedAgent {
    /// Its session id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Its state changes. Can be taken once.
    pub fn events(&self) -> Result<EventStream, Error> {
        take_events(&self.shared, &self.id)
    }

    /// Queues `text` for the agent's next turn.
    pub async fn send(&self, text: &str) -> Result<(), Error> {
        let params = SpawnSendParams {
            session: self.id.clone(),
            text: text.to_owned(),
        };
        self.shared.call(&params).await.map(|_| ())
    }

    /// Hangs up the agent, and kills it after `grace` (at most a minute).
    pub async fn stop(&self, grace: Option<Duration>) -> Result<SpawnStopResult, Error> {
        let params = SpawnStopParams {
            session: self.id.clone(),
            grace_ms: grace.map(|g| g.as_millis().min(60_000) as i64),
        };
        self.shared.call(&params).await
    }
}
