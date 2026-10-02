import { Console, Effect, FileSystem } from "effect";
import { NodeServices, NodeRuntime } from "@effect/platform-node";
import {
  CargoApi,
  Compile,
  FailureFrames,
  R,
  Rust,
  SourceArtifacts,
} from "../../packages/reffect/src/index.ts";
import { Application } from "./program.ts";

const nativeMain = `
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let shutdown_ms = match std::env::args().nth(1) {
        Some(value) => Some(value.parse::<u64>()?),
        None => None,
    };
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let application = reffect_generated::r_Application(&mut ctx);
    tokio::pin!(application);
    let shutdown = async {
        match shutdown_ms {
            Some(ms) => tokio::time::sleep(std::time::Duration::from_millis(ms)).await,
            None => tokio::signal::ctrl_c().await.expect("Unable to install Ctrl-C handler"),
        }
    };
    tokio::select! {
        result = &mut application => { assert!(result.is_ok()); },
        _ = shutdown => {
            sender.send(true)?;
            assert!(matches!(application.await, Err(reffect_generated::AsyncError::Interrupted)));
        },
    }
    Ok(())
}
`;

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const artifact = yield* Compile.make(R.program({ Application })).pipe(
      Compile.withTarget(Rust.tokio),
      Compile.withSourceArtifacts(SourceArtifacts.None),
      Compile.withFailureFrames(FailureFrames.None),
      Compile.run,
    );
    const directory = yield* CargoApi.write(
      artifact,
      process.argv[2] ?? "examples/heartbeat/generated",
    );
    // Signal handling is executable-owned; the compiled library needs only its existing async features.
    yield* fs.writeFileString(
      `${directory}/Cargo.toml`,
      artifact.files["Cargo.toml"].replace('"sync"', '"sync", "signal"'),
    );
    yield* fs.writeFileString(`${directory}/src/main.rs`, nativeMain);
    yield* CargoApi.fetch(directory);
    yield* CargoApi.build(directory, "release");
    yield* Console.log(
      `Native heartbeat: ${directory}/target/release/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
