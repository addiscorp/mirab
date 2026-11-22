# mirab (Rust client)

Run and control [mirab](https://github.com/addiscorp/mirab) agents from Rust.
Each agent runs whole inside a VM on your machine and never holds a
credential.

This crate talks to the `mirab` you have installed, through `mirab control`.
It doesn't bundle or download mirab:

```sh
curl -fsSL https://mirab-releases.addis.gg/install.sh | sh
```

```rust,no_run
use mirab::{Event, Mirab};

async fn run() -> Result<(), mirab::Error> {
    let client = Mirab::discover()?.connect().await?;
    let session = client.start("/path/to/project").await?;
    let mut events = session.events()?;
    session.send("Summarise the open issues").await?;

    while let Some(event) = events.next().await {
        if let Event::Message { message, .. } = event? {
            if message.answers.is_some() {
                println!("{}", message.text);
                break;
            }
        }
    }
    session.stop().await?;
    client.shutdown().await?;
    Ok(())
}
```

What it covers: finding the installed mirab and checking its protocol, reading
an agent's manifest, starting, stopping and listing sessions, sending messages,
streaming typed events, listing and answering requests held for a person, and
running terminal agents as sub-agents in VMs.

Text from a VM is untrusted. Answer a held request with a yes only for a person
who was shown it, and pass the hash they were shown. No secret passes through
this crate: the station on your machine gets keys from harar.

The types in `protocol.rs` are generated from mirab's protocol definition
(`src/control/protocol.ts`), and mirab's CI fails if they differ.

MIT licensed.
