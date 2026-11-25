//! Real agent VMs through the crate. They need a guest image described in
//! `$TEST_VM_CONFIG_DIR/isolation.json` (docs/VM.md), so they're ignored by
//! default and CI's `vm-linux` job runs them:
//!
//! ```sh
//! TEST_VM_CONFIG_DIR=<dir> cargo test --test live -- --ignored --test-threads=1
//! ```
use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use mirab::{Client, ControlErrorCode, Decision, Error, Event, EventStream, HeldStatus, Mirab};
use tokio::time::{sleep, timeout};

const STEP: Duration = Duration::from_secs(90);
const AGENT: &str = "gg.addis.agent.clienttest";

const AGENT_TS: &str = r#"import { defineAgent } from 'mirab'
export default defineAgent({
  name: 'gg.addis.agent.clienttest',
  model: 'anthropic/claude-sonnet-5-5',
  domains: ['held.test'],
  tools: {
    post: {
      description: 'Post the payment',
      command: './post.sh',
      input: { type: 'object', properties: {} },
    },
  },
  gateway: { rules: [{ host: 'held.test', method: 'POST', effect: 'request' }] },
})
"#;

const POST_SH: &str = "#!/bin/sh\ncat >/dev/null\nexec curl -sS -x http://127.0.0.1:8790 \
--cacert /usr/local/share/ca-certificates/mirab-station.crt \
-X POST -d pay=1 https://held.test/pay\n";

struct World {
    base: PathBuf,
    project: PathBuf,
    log: PathBuf,
    /// VM processes that were running before this test started.
    before: HashSet<u32>,
    mirab: Mirab,
}

/// Every VM process on this machine: vz's helper or Firecracker.
fn vm_processes() -> HashSet<u32> {
    let out = Command::new("ps")
        .args(["-axww", "-o", "pid=,command="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (pid, command) = line.trim().split_once(' ')?;
            let program = command.split_whitespace().next()?;
            let name = Path::new(program).file_name()?.to_str()?;
            matches!(name, "mirab-vz" | "firecracker").then(|| pid.parse().ok())?
        })
        .collect()
}

impl World {
    fn new(name: &str) -> Self {
        let source = PathBuf::from(
            std::env::var_os("TEST_VM_CONFIG_DIR").expect("TEST_VM_CONFIG_DIR names a VM config"),
        );
        let isolation = fs::read_to_string(source.join("isolation.json")).unwrap();
        let mut parsed: serde_json::Value = serde_json::from_str(&isolation).unwrap();
        // Unset paths default to the config directory's own vm/ (as `bun run
        // vm:image` leaves them). This test runs mirab with another config
        // directory, so name them where they are.
        let vm = parsed["vm"]
            .as_object_mut()
            .expect("isolation.json has a vm block");
        for (key, file) in [
            ("kernel", "vmlinux"),
            ("rootfs", "rootfs.ext4"),
            ("vz", "mirab-vz"),
        ] {
            let default = source.join("vm").join(file);
            if !vm.contains_key(key) && default.exists() {
                vm.insert(key.into(), default.to_string_lossy().into_owned().into());
            }
        }
        let isolation = parsed.to_string();
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let repo = repo.canonicalize().unwrap();
        // A short path: the fixture's harar socket lives under it.
        let base = repo.join(format!(".tmp/l-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let config = base.join("c");
        let project = base.join("p");
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(project.join("agent")).unwrap();
        fs::write(config.join("isolation.json"), isolation).unwrap();
        fs::write(project.join("agent/agent.ts"), AGENT_TS).unwrap();
        fs::write(project.join("agent/instructions.md"), "Be brief.\n").unwrap();
        fs::write(project.join("post.sh"), POST_SH).unwrap();
        fs::set_permissions(project.join("post.sh"), fs::Permissions::from_mode(0o755)).unwrap();
        let log = base.join("world.jsonl");
        fs::write(&log, "").unwrap();
        let fixture = repo.join("crates/mirab/tests/support/control-fixture.ts");
        let mirab =
            Mirab::at("bun").with_args([fixture.as_os_str(), config.as_os_str(), log.as_os_str()]);
        Self {
            base,
            project,
            log,
            before: vm_processes(),
            mirab,
        }
    }

    async fn connect(&self) -> Client {
        // The fixture takes its arguments itself; `control` is ignored by it.
        timeout(STEP, self.mirab.connect()).await.unwrap().unwrap()
    }

    fn reached(&self) -> Vec<serde_json::Value> {
        fs::read_to_string(&self.log)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// VM processes started since this test began (the live tests run one
    /// at a time). Their pids are checked later even once reparented.
    fn vms(&self) -> HashSet<u32> {
        &vm_processes() - &self.before
    }

    /// Waits for these VM processes to be gone.
    async fn assert_gone(&self, vms: &HashSet<u32>) {
        assert!(!vms.is_empty(), "no VM was seen running");
        for _ in 0..120 {
            if vms.is_disjoint(&vm_processes()) {
                return;
            }
            sleep(Duration::from_millis(250)).await;
        }
        panic!("a VM is still running: {:?}", vms & &vm_processes());
    }
}

impl Drop for World {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
}

async fn until<T>(events: &mut EventStream, mut pick: impl FnMut(&Event) -> Option<T>) -> T {
    let found = timeout(STEP, async {
        loop {
            let event = events
                .next()
                .await
                .expect("the stream ended early")
                .expect("the stream failed");
            if let Some(found) = pick(&event) {
                return found;
            }
        }
    })
    .await;
    found.expect("timed out waiting for an event")
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "boots a real VM: needs TEST_VM_CONFIG_DIR"]
async fn a_turn_a_held_request_and_a_clean_stop() {
    let world = World::new("turn");
    let client = world.connect().await;

    let read = timeout(STEP, client.manifest(&world.project))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read.manifest.name, AGENT);
    assert!(read.manifest.tools.contains_key("post"));

    let session = timeout(STEP, client.start(&world.project))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.info().agent, AGENT);
    assert_eq!(session.info().person, "gg.addis.human.tester");
    assert_eq!(client.sessions().await.unwrap().len(), 1);
    let mut events = session.events().unwrap();
    assert!(matches!(session.events(), Err(Error::EventsTaken)));
    let vms = world.vms();
    assert!(!vms.is_empty(), "the session has a VM");

    // A turn, streamed: the reply answers the message that asked.
    let asked = session.send("hello").await.unwrap();
    let reply = until(&mut events, |e| match e {
        Event::Message { message, .. } if message.answers.as_deref() == Some(&asked) => {
            Some(message.clone())
        }
        _ => None,
    })
    .await;
    assert_eq!(reply.text, "pong: hello");
    assert_eq!(reply.from, AGENT);

    // The agent's write is held: nothing reaches the host yet.
    session.send("post it").await.unwrap();
    let held = until(&mut events, |e| match e {
        Event::Held { request, .. } => Some(request.clone()),
        _ => None,
    })
    .await;
    assert_eq!(
        (held.host.as_str(), held.method.as_str()),
        ("held.test", "POST")
    );
    assert!(world.reached().is_empty(), "held means not sent");
    let listed = session.requests().await.unwrap();
    let entry = listed.iter().find(|r| r.id == held.id).unwrap();
    assert_eq!(entry.status, HeldStatus::Held);
    assert_eq!(entry.hash, held.hash);

    // A yes for other bytes is refused, and sends nothing.
    let wrong = session
        .decide(&held.id, Decision::Yes, Some("not-the-hash"))
        .await;
    assert!(matches!(
        wrong,
        Err(Error::Control {
            code: ControlErrorCode::HashMismatch,
            ..
        })
    ));
    assert!(world.reached().is_empty());

    // The yes for what was shown sends it, once.
    session
        .decide(&held.id, Decision::Yes, Some(&held.hash))
        .await
        .unwrap();
    let status = until(&mut events, |e| match e {
        Event::Sent {
            request, status, ..
        } if *request == held.id => Some(status.clone()),
        _ => None,
    })
    .await;
    assert_eq!(serde_json::to_value(&status).unwrap(), 200);
    let reached = world.reached();
    assert_eq!(reached.len(), 1, "sent exactly once: {reached:?}");
    assert_eq!(reached[0]["method"], "POST");
    assert_eq!(reached[0]["url"], "/pay");
    assert_eq!(reached[0]["body"], "pay=1");
    let again = session
        .decide(&held.id, Decision::Yes, Some(&held.hash))
        .await;
    assert!(matches!(
        again,
        Err(Error::Control {
            code: ControlErrorCode::NotWaiting,
            ..
        })
    ));

    // Stop: the VM goes, and the client says what came back.
    let stopped = timeout(STEP, session.stop()).await.unwrap().unwrap();
    assert!(stopped.sync.is_some());
    assert!(client.sessions().await.unwrap().is_empty());
    world.assert_gone(&vms).await;
    let status = timeout(STEP, client.shutdown()).await.unwrap().unwrap();
    assert!(status.success());
    assert!(world.vms().is_empty(), "{:?}", world.vms());
}

/// The shape a program ships: one compiled, signed `mirab` with no Bun and
/// no source beside it. `TEST_MIRAB_BINARY` names it. No model call is made.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "boots a real VM from a compiled binary: needs TEST_MIRAB_BINARY"]
async fn a_compiled_binary_boots_an_agent() {
    let binary = std::env::var_os("TEST_MIRAB_BINARY").expect("TEST_MIRAB_BINARY names a binary");
    let world = World::new("bin");
    let config = world.base.join("c");
    fs::write(
        config.join("station.json"),
        format!(
            r#"{{"harar":{{"socket":"{}"}},"models":{{"anthropic":{{"key":"personal/anthropic/API_KEY"}}}}}}"#,
            world.base.join("no-harar.sock").display()
        ),
    )
    .unwrap();
    let client = timeout(STEP, Mirab::at(&binary).config_dir(&config).connect())
        .await
        .unwrap()
        .unwrap();
    let available = client.availability().await.unwrap();
    assert!(available.available, "{available:?}");
    let session = timeout(STEP, client.start(&world.project))
        .await
        .unwrap()
        .unwrap();
    let mut events = session.events().unwrap();
    until(&mut events, |e| match e {
        Event::Message { message, .. } if message.text.contains("is here") => Some(()),
        _ => None,
    })
    .await;
    let vms = world.vms();

    // Guest files, through the same binary.
    session
        .put_file("/workspace/granted.txt", "aGVsbG8=", None)
        .await
        .unwrap();
    assert_eq!(
        session.get_file("/workspace/granted.txt").await.unwrap(),
        "aGVsbG8="
    );
    let listed = session.list_files("/workspace").await.unwrap();
    assert!(listed.iter().any(|e| e.p == "granted.txt"));
    let refused = session.get_file("/workspace/../etc/passwd").await;
    assert!(matches!(
        refused,
        Err(Error::Control {
            code: ControlErrorCode::BadRequest,
            ..
        })
    ));

    let stopped = timeout(STEP, session.stop()).await.unwrap().unwrap();
    let sync = stopped.sync.expect("what came back");
    assert!(sync.written.iter().any(|p| p == "granted.txt"), "{sync:?}");
    assert_eq!(
        fs::read_to_string(world.project.join("granted.txt")).unwrap(),
        "hello"
    );
    client.shutdown().await.unwrap();
    world.assert_gone(&vms).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "boots a real VM: needs TEST_VM_CONFIG_DIR"]
async fn dropping_the_client_stops_its_vms() {
    let world = World::new("drop");
    let client = world.connect().await;
    let session = timeout(STEP, client.start(&world.project))
        .await
        .unwrap()
        .unwrap();
    let vms = world.vms();
    drop(session);
    drop(client);
    world.assert_gone(&vms).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "boots a real VM: needs TEST_VM_CONFIG_DIR"]
async fn a_sub_agent_runs_in_a_vm_and_stops() {
    let world = World::new("spawn");
    let client = world.connect().await;
    let name = format!("rc-{}", std::process::id());
    let agent = timeout(
        STEP,
        client.spawn("sh", &["-c", "sleep 300"], &world.project, Some(&name)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(agent.id(), name);
    let vms = world.vms();
    assert!(!vms.is_empty(), "the sub-agent has a VM");
    let listed = client.spawned().await.unwrap();
    assert_eq!(listed.iter().filter(|s| s.session == name).count(), 1);
    let mut events = agent.events().unwrap();
    timeout(STEP, agent.stop(Some(Duration::from_secs(1))))
        .await
        .unwrap()
        .unwrap();
    until(&mut events, |e| {
        matches!(e, Event::SpawnExited { .. }).then_some(())
    })
    .await;
    world.assert_gone(&vms).await;
    assert!(client.spawned().await.unwrap().is_empty());
    client.shutdown().await.unwrap();
}
