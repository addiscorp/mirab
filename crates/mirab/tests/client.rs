//! The client against small stand-in `mirab` programs, and against the real
//! `mirab control` from this checkout (no VM).
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use mirab::{ControlErrorCode, Error, Event, Mirab, PROTOCOL};
use tokio::time::timeout;

const LIMIT: Duration = Duration::from_secs(20);
const HELLO: &str =
    r#"read -r line; printf '{"id":1,"ok":true,"result":{"protocol":1,"version":"9.9.9"}}\n'"#;

fn stand_in(name: &str, body: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mirab-client-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("mirab");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn checkout() -> Mirab {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    Mirab::at("bun").with_args(["run".into(), repo.join("src/mirab.ts")])
}

#[tokio::test]
async fn an_older_mirab_without_control_is_incompatible() {
    let old = stand_in(
        "old",
        "echo \"error: unknown command 'control'\" >&2; exit 1",
    );
    let error = timeout(LIMIT, Mirab::at(old).connect())
        .await
        .unwrap()
        .err()
        .unwrap();
    let Error::Incompatible { detail, wanted, .. } = error else {
        panic!("{error:?}");
    };
    assert_eq!(wanted, PROTOCOL);
    assert!(detail.contains("unknown command"), "{detail}");
}

#[tokio::test]
async fn another_protocol_is_refused_at_connect() {
    let next = stand_in(
        "next",
        r#"read -r line; printf '{"id":1,"ok":true,"result":{"protocol":99,"version":"42.0.0"}}\n'"#,
    );
    let error = timeout(LIMIT, Mirab::at(next).connect())
        .await
        .unwrap()
        .err()
        .unwrap();
    assert!(
        matches!(&error, Error::Incompatible { found, .. } if found == "42.0.0"),
        "{error:?}"
    );
}

#[tokio::test]
async fn answers_reach_their_callers_out_of_order() {
    // Holds two spawns, then answers the second first, each with the name it
    // was asked for: a caller given the other's frame would get the wrong one.
    let body = format!(
        r#"{HELLO}
read -r a; read -r b
field() {{ printf '%s' "$2" | sed "s/.*\"$1\":\"*\([a-z0-9]*\).*/\1/"; }}
for line in "$b" "$a"; do
  printf '{{"id":%s,"ok":true,"result":{{"session":"%s"}}}}\n' "$(field id "$line")" "$(field name "$line")"
done
cat >/dev/null"#
    );
    let client = Mirab::at(stand_in("order", &body)).connect().await.unwrap();
    assert_eq!(client.version(), "9.9.9");
    let (first, second) = timeout(LIMIT, async {
        tokio::join!(
            client.spawn("sh", &[], "/w", Some("one")),
            client.spawn("sh", &[], "/w", Some("two")),
        )
    })
    .await
    .unwrap();
    assert_eq!(first.unwrap().id(), "one");
    assert_eq!(second.unwrap().id(), "two");
}

#[tokio::test]
async fn a_mirab_that_dies_fails_what_is_waiting() {
    let body = format!("{HELLO}\nread -r line\necho 'it broke' >&2\nexit 3");
    let client = Mirab::at(stand_in("dies", &body)).connect().await.unwrap();
    let error = timeout(LIMIT, client.sessions())
        .await
        .expect("a dead mirab must not hang the caller")
        .err()
        .unwrap();
    assert!(matches!(error, Error::Disconnected { .. }), "{error:?}");
}

#[tokio::test]
async fn events_are_routed_to_their_session_and_end_with_it() {
    let session =
        r#"{"session":"s_a","agent":"a","person":"p","channel":"c","zone":"z","project":"/p"}"#;
    let body = format!(
        r#"{HELLO}
read -r line
printf '{{"event":"log","session":"s_b","line":"other"}}\n'
printf '{{"event":"log","session":"s_a","line":"mine"}}\n'
printf '{{"id":2,"ok":true,"result":{session}}}\n'
printf '{{"event":"exited","session":"s_a","code":0}}\n'
exit 0"#
    );
    let client = Mirab::at(stand_in("route", &body)).connect().await.unwrap();
    let started = client.start("/p").await.unwrap();
    let mut events = started.events().unwrap();
    let first = timeout(LIMIT, events.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(first, Event::Log { ref line, .. } if line == "mine"),
        "{first:?}"
    );
    let second = timeout(LIMIT, events.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(second, Event::Exited { code: 0, .. }),
        "{second:?}"
    );
    assert!(timeout(LIMIT, events.next()).await.unwrap().is_none());
}

#[tokio::test]
async fn the_real_control_server_shakes_hands_and_answers_errors() {
    let mirab = checkout();
    let version = timeout(LIMIT, mirab.version()).await.unwrap().unwrap();
    let client = timeout(LIMIT, mirab.connect()).await.unwrap().unwrap();
    assert_eq!(client.version(), version);
    assert!(client.sessions().await.unwrap().is_empty());
    assert!(client.spawned().await.unwrap().is_empty());
    let missing = client.manifest("/no/such/project").await;
    assert!(
        matches!(missing, Err(Error::Control { .. })),
        "{:?}",
        missing.err()
    );
    let status = timeout(LIMIT, client.shutdown()).await.unwrap().unwrap();
    assert!(status.success());
}

#[test]
fn every_error_code_has_a_wire_name() {
    let code: ControlErrorCode = serde_json::from_str("\"hash_mismatch\"").unwrap();
    assert_eq!(code, ControlErrorCode::HashMismatch);
}
