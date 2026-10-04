import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { asyncRuntime } from "../src/async-runtime.ts";
import { deferredStateRuntime } from "../src/deferred-state-runtime.ts";
import { deferredTurnRuntime } from "../src/deferred-turn-runtime.ts";
import { deferredCoordinatorRuntime } from "../src/deferred-coordinator-runtime.ts";
import { deferredTurnOracle } from "./fixtures/deferred-turn-oracle.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const execute = promisify(execFile);
const harness = String.raw`
use std::sync::Mutex;
fn log(trace: &Mutex<Vec<&'static str>>, event: &'static str) { trace.lock().unwrap().push(event); }
async fn scenario(kind: &str) {
    let bank = DeferredTurns::<4>::new();
    let owner = DeferredState::<u64, bool, 3>::new();
    let trace = Mutex::new(Vec::new());
    let (first_cancel, first_rx) = tokio::sync::watch::channel(false);
    let (second_cancel, second_rx) = tokio::sync::watch::channel(false);
    let (producer_cancel, producer_rx) = tokio::sync::watch::channel(false);
    let mut first_ctx = AsyncContext::new(first_rx);
    let mut second_ctx = AsyncContext::new(second_rx);
    let mut producer_ctx = AsyncContext::new(producer_rx);
    let masked = kind == "interrupt-masked-producer";
    if masked { producer_ctx.interruptible = false; }
    let first = DeferredTurnHandle::new(&bank, 1);
    let second = DeferredTurnHandle::new(&bank, 2);
    let producer = DeferredTurnHandle::new(&bank, 3);
    let first_future = first.task(async {
        assert_eq!(first.wait(&owner, &mut first_ctx).await.unwrap(), 7);
        log(&trace, "w1:resumed");
        if kind == "waiter-yields" {
            first.semantic(tokio::task::yield_now()).await;
            log(&trace, "w1:after-yield");
        }
        if kind == "interrupt-next-waiter" {
            log(&trace, "interrupt-w2"); second_cancel.send(true).unwrap();
        }
        if kind == "interrupt-producer" || masked {
            log(&trace, "interrupt-producer"); producer_cancel.send(true).unwrap();
        }
    });
    let second_future = second.task(async {
        match second.wait(&owner, &mut second_ctx).await {
            Ok(7) => log(&trace, "w2:resumed"),
            Err(AsyncError::Interrupted) => {
                // Match the official oracle's synchronous cleanup prefix.
                second_ctx.interruptible = false;
                log(&trace, "w2:cleanup");
            }
            other => panic!("Unexpected waiter outcome: {other:?}"),
        }
    });
    let producer_future = producer.task(async {
        let completion = producer.complete::<_, _, (), 3>(&owner, &mut producer_ctx, Ok(7)).await;
        match completion {
            Ok(true) => log(&trace, "producer:true"),
            Err(AsyncError::Interrupted) => {},
            other => panic!("Unexpected completion outcome: {other:?}"),
        }
        assert!(owner.is_done());
        if kind == "interrupt-producer" || masked {
            producer_ctx.interruptible = true;
            assert!(producer_ctx.is_cancelled());
            producer_ctx.interruptible = false;
            producer.sleep::<()>(&mut producer_ctx, 1).await.unwrap();
            log(&trace, "producer:cleanup");
        } else {
            assert!(!producer.complete::<_, _, (), 3>(&owner, &mut producer_ctx, Err(true)).await.unwrap());
            assert_eq!(producer.wait(&owner, &mut producer_ctx).await.unwrap(), 7);
        }
    });
    if kind == "reversed-registration" {
        deferred_join3(&bank, [2, 1, 3], second_future, first_future, producer_future).await;
    } else {
        deferred_join3(&bank, [1, 2, 3], first_future, second_future, producer_future).await;
    }
    assert!(owner.state.lock().unwrap().slots.iter().all(Option::is_none));
    assert!(bank.priority().is_none());
    let values: Vec<_> = trace.into_inner().unwrap().iter().map(|x| format!("\"{x}\"")).collect();
    println!("CASE:{kind}:[{}]", values.join(","));
    drop(first_cancel);
}
async fn typed_cases() {
    let bank = DeferredTurns::<3>::new();
    let owner = DeferredState::<bool, u64, 2>::new();
    let (_a, rx_a) = tokio::sync::watch::channel(false);
    let (_b, rx_b) = tokio::sync::watch::channel(false);
    let mut ctx_a = AsyncContext::new(rx_a);
    let mut ctx_b = AsyncContext::new(rx_b);
    let a = DeferredTurnHandle::new(&bank, 1);
    let b = DeferredTurnHandle::new(&bank, 2);
    let wait = a.task(async {
        assert!(matches!(a.wait(&owner, &mut ctx_a).await, Err(AsyncError::Fail(19))));
    });
    let complete = b.task(async {
        assert!(b.complete::<_, _, (), 2>(&owner, &mut ctx_b, Err(19)).await.unwrap());
        assert!(matches!(b.wait(&owner, &mut ctx_b).await, Err(AsyncError::Fail(19))));
    });
    deferred_join2(&bank, [1, 2], wait, complete).await;
    // A canceled caller cannot commit a previously empty owner.
    let empty = DeferredState::<(), (), 1>::new();
    let (cancel, receiver) = tokio::sync::watch::channel(true);
    let mut ctx = AsyncContext::new(receiver);
    assert!(matches!(a.complete::<_, _, (), 1>(&empty, &mut ctx, Ok(())).await, Err(AsyncError::Interrupted)));
    assert!(!empty.is_done());
    assert!(matches!(a.wait(&empty, &mut ctx).await, Err(AsyncError::Interrupted)));
    assert!(empty.state.lock().unwrap().slots.iter().all(Option::is_none));
    drop(cancel);
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        for _ in 0..10 {
            for kind in ["reversed-registration", "waiter-yields", "interrupt-next-waiter", "interrupt-producer", "interrupt-masked-producer"] {
                scenario(kind).await;
            }
            typed_cases().await;
        }
        println!("LAYOUT:handle={},context={}", std::mem::size_of::<DeferredTurnHandle<4>>(), std::mem::size_of::<AsyncContext>());
    }).await.expect("Real coordinator progress");
}
`;

test(
  "private Deferred coordinator preserves real context masking and cancellation",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-deferred-coordinator-"));
    try {
      await writeFile(
        join(directory, "main.rs"),
        [
          asyncRuntime(false, false),
          deferredTurnRuntime(),
          deferredStateRuntime(),
          deferredCoordinatorRuntime(),
          harness,
        ].join("\n"),
      );
      await writeFile(
        join(directory, "Cargo.toml"),
        `[package]\nname = "reffect_deferred_coordinator"\nversion = "0.1.0"\nedition = "2021"\n[[bin]]\nname = "coordinator"\npath = "main.rs"\n[dependencies]\ntokio = { version = "=1.53.1", features = ["rt", "macros", "sync", "time"] }\n`,
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
      expect(debug.stdout).toContain("LAYOUT:handle=16,context=24");
      for (const scenario of [
        "reversed-registration",
        "waiter-yields",
        "interrupt-next-waiter",
        "interrupt-producer",
        "interrupt-masked-producer",
      ] as const) {
        const official = await Effect.runPromise(deferredTurnOracle(scenario));
        const lines = debug.stdout
          .split("\n")
          .filter((line) => line.startsWith(`CASE:${scenario}:`));
        expect(lines).toHaveLength(10);
        for (const line of lines)
          expect(JSON.parse(line.slice(`CASE:${scenario}:`.length))).toEqual(official.trace);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
