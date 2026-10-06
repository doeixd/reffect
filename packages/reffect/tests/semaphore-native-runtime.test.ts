import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Fiber, Semaphore } from "effect";
import { expect, test } from "vite-plus/test";
import { semaphoreNativeRuntime } from "../src/semaphore-native-runtime.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const execute = promisify(execFile);
const oracle = (kind: string) =>
  Effect.gen(function* () {
    const events: string[] = [];
    const log = (event: string) =>
      Effect.sync(() => {
        events.push(event);
      });
    const semaphore = yield* Semaphore.make(1);
    if (kind === "barging") {
      let waiter: Fiber.Fiber<void> | undefined;
      yield* semaphore.withPermit(
        Effect.gen(function* () {
          yield* log("holder:enter");
          waiter = yield* Effect.forkChild(semaphore.withPermit(log("waiter:enter")));
          yield* Effect.sleep(5);
          yield* log("holder:exit");
        }),
      );
      yield* log("holder:after-release");
      yield* semaphore.withPermit(log("holder:barge"));
      yield* log("holder:after-barge");
      if (waiter) yield* Fiber.join(waiter);
    } else if (kind === "queued-cancel") {
      let survivor: Fiber.Fiber<void> | undefined;
      yield* semaphore.withPermit(
        Effect.gen(function* () {
          yield* log("holder:enter");
          const canceled = yield* Effect.forkChild(
            semaphore
              .withPermit(log("canceled:entered"))
              .pipe(Effect.ensuring(log("canceled:cleanup"))),
          );
          yield* Effect.sleep(5);
          yield* Fiber.interrupt(canceled);
          yield* log("canceled:joined");
          survivor = yield* Effect.forkChild(semaphore.withPermit(log("survivor:enter")));
          yield* Effect.sleep(5);
          yield* log("holder:exit");
        }),
      );
      yield* log("holder:after-release");
      if (survivor) yield* Fiber.join(survivor);
    } else {
      const holder = yield* Effect.forkChild(
        semaphore.withPermit(
          Effect.gen(function* () {
            yield* log("holder:enter");
            yield* Effect.never;
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* log("holder:cleanup-start");
                yield* Effect.sleep(5);
                yield* log("holder:cleanup-end");
              }),
            ),
          ),
        ),
      );
      yield* Effect.sleep(5);
      const waiter = yield* Effect.forkChild(semaphore.withPermit(log("waiter:enter")));
      yield* Effect.sleep(5);
      yield* Fiber.interrupt(holder);
      yield* Fiber.join(waiter);
    }
    return events;
  });

const harness = String.raw`
use std::sync::{Arc, Mutex};
fn log(events: &Arc<Mutex<Vec<&'static str>>>, event: &'static str) { events.lock().unwrap().push(event); }
async fn sleep() { tokio::time::sleep(std::time::Duration::from_millis(5)).await; }
async fn scenario(kind: &str) {
    let owner = ExperimentalSemaphore::<3>::new(1);
    let events = Arc::new(Mutex::new(Vec::new()));
    if kind == "barging" {
        let held = owner.acquire().await;
        log(&events, "holder:enter");
        let waiter_owner = owner.clone(); let waiter_events = events.clone();
        let waiter = tokio::spawn(async move {
            let _permit = waiter_owner.acquire().await;
            log(&waiter_events, "waiter:enter");
        });
        sleep().await;
        assert_eq!(owner.waiting(), 1);
        log(&events, "holder:exit");
        drop(held);
        log(&events, "holder:after-release");
        let barged = owner.acquire().await;
        log(&events, "holder:barge");
        drop(barged);
        log(&events, "holder:after-barge");
        waiter.await.unwrap();
    } else if kind == "queued-cancel" {
        let held = owner.acquire().await;
        log(&events, "holder:enter");
        let canceled_owner = owner.clone(); let canceled_events = events.clone();
        let (cancel, mut rx) = tokio::sync::watch::channel(false);
        let canceled = tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = rx.changed() => {},
                _permit = canceled_owner.acquire() => log(&canceled_events, "canceled:entered"),
            }
            log(&canceled_events, "canceled:cleanup");
        });
        sleep().await;
        assert_eq!(owner.waiting(), 1);
        cancel.send(true).unwrap(); canceled.await.unwrap();
        assert_eq!(owner.waiting(), 0);
        log(&events, "canceled:joined");
        let survivor_owner = owner.clone(); let survivor_events = events.clone();
        let survivor = tokio::spawn(async move {
            let _permit = survivor_owner.acquire().await;
            log(&survivor_events, "survivor:enter");
        });
        sleep().await;
        assert_eq!(owner.waiting(), 1);
        log(&events, "holder:exit"); drop(held);
        log(&events, "holder:after-release");
        survivor.await.unwrap();
    } else {
        let holder_owner = owner.clone(); let holder_events = events.clone();
        let (cancel, mut rx) = tokio::sync::watch::channel(false);
        let holder = tokio::spawn(async move {
            let held = holder_owner.acquire().await;
            log(&holder_events, "holder:enter");
            rx.changed().await.unwrap();
            log(&holder_events, "holder:cleanup-start");
            sleep().await;
            log(&holder_events, "holder:cleanup-end");
            drop(held);
        });
        sleep().await;
        let waiter_owner = owner.clone(); let waiter_events = events.clone();
        let waiter = tokio::spawn(async move {
            let _permit = waiter_owner.acquire().await;
            log(&waiter_events, "waiter:enter");
        });
        sleep().await;
        assert_eq!(owner.waiting(), 1);
        cancel.send(true).unwrap(); holder.await.unwrap(); waiter.await.unwrap();
    }
    assert_eq!(owner.available(), 1);
    assert_eq!(owner.waiting(), 0);
    let trace: Vec<_> = events.lock().unwrap().iter().map(|event| format!("\"{event}\"")).collect();
    println!("CASE:{kind}:[{}]", trace.join(","));
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for _ in 0..10 {
            for kind in ["barging", "queued-cancel", "holder-cancel"] { scenario(kind).await; }
        }
    }).await.expect("Semaphore experiment progress");
}
`;

test(
  "private scheduled Semaphore experiment compares barging and cancellation traces",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-semaphore-experiment-"));
    try {
      await writeFile(join(directory, "main.rs"), `${semaphoreNativeRuntime()}\n${harness}`);
      await writeFile(
        join(directory, "Cargo.toml"),
        `[package]\nname="reffect_semaphore_experiment"\nversion="0.1.0"\nedition="2021"\n[[bin]]\nname="experiment"\npath="main.rs"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n`,
      );
      const options = {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
      };
      const debug = await execute("cargo", ["run", "--offline", "--quiet"], options);
      const release = await execute("cargo", ["run", "--release", "--offline", "--quiet"], options);
      expect(release.stdout).toEqual(debug.stdout);
      for (const kind of ["barging", "queued-cancel", "holder-cancel"]) {
        const official = await Effect.runPromise(oracle(kind));
        const prefix = `CASE:${kind}:`;
        const lines = debug.stdout.split("\n").filter((line) => line.startsWith(prefix));
        expect(lines).toHaveLength(10);
        for (const line of lines) expect(JSON.parse(line.slice(prefix.length))).toEqual(official);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
