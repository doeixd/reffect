import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { asyncRuntime } from "../src/async-runtime.ts";
import { deferredGeneratedRuntime } from "../src/deferred-generated-runtime.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const execute = promisify(execFile);
const harness = String.raw`
async fn parent_during_broadcast() {
    let bank = DeferredTurns::<4>::new();
    let owner = DeferredState::<u64, std::convert::Infallible, 4>::new();
    let trace = std::sync::Mutex::new(Vec::new());
    let (parent_cancel, parent) = tokio::sync::watch::channel(false);
    let (cancel0, rx0) = tokio::sync::watch::channel(false);
    let (cancel1, rx1) = tokio::sync::watch::channel(false);
    let (cancel2, rx2) = tokio::sync::watch::channel(false);
    let mut ctx0 = AsyncContext::new(rx0);
    let mut ctx1 = AsyncContext::new(rx1);
    let mut ctx2 = AsyncContext::new(rx2);
    let first = DeferredTurnHandle::new(&bank, 1);
    let second = DeferredTurnHandle::new(&bank, 2);
    let producer = DeferredTurnHandle::new(&bank, 3);
    let a = first.task(async {
        assert_eq!(first.wait(&owner, &mut ctx0).await.unwrap(), 7);
        trace.lock().unwrap().push("first-prefix");
        parent_cancel.send(true).unwrap();
        true
    });
    let b = second.task(async {
        assert!(matches!(second.wait(&owner, &mut ctx1).await, Err(AsyncError::Interrupted)));
        ctx1.interruptible = false;
        second.sleep::<()>(&mut ctx1, 2).await.unwrap();
        trace.lock().unwrap().push("waiter-cleanup");
        false
    });
    let c = producer.task(async {
        assert!(matches!(producer.complete::<_, _, (), 4>(&owner, &mut ctx2, Ok(7)).await, Err(AsyncError::Interrupted)));
        ctx2.interruptible = false;
        producer.sleep::<()>(&mut ctx2, 2).await.unwrap();
        trace.lock().unwrap().push("producer-cleanup");
        false
    });
    assert!(!coordinated_task_group3(&bank, [1,2,3], [2,3,4], 0, a,cancel0,b,cancel1,c,cancel2,parent,true,false).await);
    assert!(bank.priority().is_none());
    assert!(owner.state.lock().unwrap().slots.iter().all(Option::is_none));
    assert!(owner.is_done());
    let trace = trace.lock().unwrap();
    assert_eq!(trace.len(), 3);
    assert_eq!(trace[0], "first-prefix");
    assert!(trace.contains(&"waiter-cleanup") && trace.contains(&"producer-cleanup"));
}
async fn false_child() {
    let bank = DeferredTurns::<3>::new();
    let owner = DeferredState::<(), std::convert::Infallible, 3>::new();
    let (parent_cancel, parent) = tokio::sync::watch::channel(false);
    let (cancel0, rx0) = tokio::sync::watch::channel(false);
    let (cancel1, rx1) = tokio::sync::watch::channel(false);
    let mut ctx0 = AsyncContext::new(rx0);
    let mut ctx1 = AsyncContext::new(rx1);
    let first = DeferredTurnHandle::new(&bank, 1);
    let second = DeferredTurnHandle::new(&bank, 2);
    let cleaned = std::cell::Cell::new(false);
    let a = first.task(async { first.sleep::<()>(&mut ctx0, 1).await.unwrap(); false });
    let b = second.task(async {
        assert!(matches!(second.wait(&owner, &mut ctx1).await, Err(AsyncError::Interrupted)));
        ctx1.interruptible = false;
        second.sleep::<()>(&mut ctx1, 2).await.unwrap();
        cleaned.set(true);
        false
    });
    assert!(!coordinated_task_group2(&bank,[1,2],[2,3],0,a,cancel0,b,cancel1,parent,true,false).await);
    assert!(cleaned.get());
    assert!(owner.state.lock().unwrap().slots.iter().all(Option::is_none));
    assert!(bank.priority().is_none());
    drop(parent_cancel);
}
async fn masked_last_child() {
    let bank = DeferredTurns::<3>::new();
    let (parent_cancel, parent) = tokio::sync::watch::channel(false);
    let (cancel0, rx0) = tokio::sync::watch::channel(false);
    let (cancel1, rx1) = tokio::sync::watch::channel(false);
    let _ctx0 = AsyncContext::new(rx0);
    let mut ctx1 = AsyncContext::new(rx1);
    let first = DeferredTurnHandle::new(&bank, 1);
    let second = DeferredTurnHandle::new(&bank, 2);
    let cleaned = std::cell::Cell::new(false);
    let a = first.task(async { true });
    let b = second.task(async {
        ctx1.interruptible = false;
        parent_cancel.send(true).unwrap();
        second.sleep::<()>(&mut ctx1, 2).await.unwrap();
        cleaned.set(true);
        true
    });
    assert!(!coordinated_task_group2(&bank,[1,2],[2,3],0,a,cancel0,b,cancel1,parent,true,false).await);
    assert!(cleaned.get());
}
async fn watch_updates_and_mask() {
    for (update, interruptible) in [(false, true), (true, false)] {
        let bank = DeferredTurns::<3>::new();
        let (parent_cancel, parent) = tokio::sync::watch::channel(false);
        let (cancel0, rx0) = tokio::sync::watch::channel(false);
        let (cancel1, rx1) = tokio::sync::watch::channel(false);
        let mut ctx0 = AsyncContext::new(rx0);
        let mut ctx1 = AsyncContext::new(rx1);
        let first = DeferredTurnHandle::new(&bank, 1);
        let second = DeferredTurnHandle::new(&bank, 2);
        parent_cancel.send(update).unwrap();
        let a = first.task(async { first.sleep::<()>(&mut ctx0, 1).await.unwrap(); true });
        let b = second.task(async { second.sleep::<()>(&mut ctx1, 1).await.unwrap(); true });
        assert!(coordinated_task_group2(&bank,[1,2],[2,3],0,a,cancel0,b,cancel1,parent,interruptible,false).await);
        assert!(bank.priority().is_none());
    }
}
async fn independent_nested_waiter(producer_first: bool) {
    let bank = DeferredTurns::<6>::new();
    let owner = DeferredState::<u64, std::convert::Infallible, 6>::new();
    let finalized = DeferredState::<(), std::convert::Infallible, 6>::new();
    let trace = std::sync::Mutex::new(Vec::new());
    let (_parent_cancel, parent) = tokio::sync::watch::channel(false);
    let (producer_cancel, producer_rx) = tokio::sync::watch::channel(false);
    let (race_cancel, race_rx) = tokio::sync::watch::channel(false);
    let (survivor_cancel, survivor_rx) = tokio::sync::watch::channel(false);
    let (loser_cancel, loser_rx) = tokio::sync::watch::channel(false);
    let (winner_cancel, winner_rx) = tokio::sync::watch::channel(false);
    let producer_slot = if producer_first { 1 } else { 5 };
    let survivor_slot = if producer_first { 5 } else { 1 };
    let producer = DeferredTurnHandle::new(&bank, producer_slot);
    let race = DeferredTurnHandle::new(&bank, 2);
    let loser = DeferredTurnHandle::new(&bank, 3);
    let winner = DeferredTurnHandle::new(&bank, 4);
    let survivor = DeferredTurnHandle::new(&bank, survivor_slot);
    let mut producer_ctx = AsyncContext::new(producer_rx);
    let mut loser_ctx = AsyncContext::new(loser_rx);
    let mut winner_ctx = AsyncContext::new(winner_rx);
    let mut survivor_ctx = AsyncContext::new(survivor_rx);
    let a = producer.task(async {
        producer.wait(&finalized, &mut producer_ctx).await.unwrap();
        trace.lock().unwrap().push("producer-finalization-observed");
        assert!(producer.complete::<_, _, (), 6>(&owner, &mut producer_ctx, Ok(7)).await.unwrap());
        trace.lock().unwrap().push("producer-after-complete");
        true
    });
    let b = race.task(async {
        let l = loser.task(async {
            trace.lock().unwrap().push("loser-start");
            assert!(matches!(loser.wait(&owner, &mut loser_ctx).await, Err(AsyncError::Interrupted)));
            loser_ctx.interruptible = false;
            loser.sleep::<()>(&mut loser_ctx, 2).await.unwrap();
            trace.lock().unwrap().push("loser-cleanup");
            loser.complete::<_, _, (), 6>(&finalized, &mut loser_ctx, Ok(())).await.unwrap();
            trace.lock().unwrap().push("loser-cleanup-after-signal");
            false
        });
        let w = winner.task(async {
            winner.sleep::<()>(&mut winner_ctx, 1).await.unwrap();
            trace.lock().unwrap().push("race-winner");
            true
        });
        assert!(coordinated_task_group2(&bank,[3,4],[4,5],2,l,loser_cancel,w,winner_cancel,race_rx,true,true).await);
        trace.lock().unwrap().push("race-after-cleanup");
        true
    });
    let c = survivor.task(async {
        assert_eq!(survivor.wait(&owner, &mut survivor_ctx).await.unwrap(), 7);
        trace.lock().unwrap().push("survivor-prefix");
        true
    });
    let success = if producer_first {
        coordinated_task_group3(&bank,[1,2,5],[2,5,6],0,a,producer_cancel,b,race_cancel,c,survivor_cancel,parent,true,false).await
    } else {
        coordinated_task_group3(&bank,[1,2,5],[2,5,6],0,c,survivor_cancel,b,race_cancel,a,producer_cancel,parent,true,false).await
    };
    assert!(success);
    assert!(bank.priority().is_none());
    assert!(owner.state.lock().unwrap().slots.iter().all(Option::is_none));
    assert!(finalized.state.lock().unwrap().slots.iter().all(Option::is_none));
    let trace = trace.lock().unwrap();
    let position = |event| trace.iter().position(|item| *item == event).unwrap();
    assert!(position("loser-start") < position("race-winner"));
    assert!(position("loser-cleanup") < position("producer-finalization-observed"));
    assert!(position("producer-finalization-observed") < position("survivor-prefix"));
    assert!(position("survivor-prefix") < position("producer-after-complete"));
    assert!(position("loser-cleanup-after-signal") < position("race-after-cleanup"));
}
async fn race_parent_during_loser_cleanup() {
    let bank = DeferredTurns::<3>::new();
    let owner = DeferredState::<(), std::convert::Infallible, 3>::new();
    let (parent_cancel, parent) = tokio::sync::watch::channel(false);
    let (cancel0, rx0) = tokio::sync::watch::channel(false);
    let (cancel1, rx1) = tokio::sync::watch::channel(false);
    let first = DeferredTurnHandle::new(&bank, 1);
    let second = DeferredTurnHandle::new(&bank, 2);
    let mut ctx0 = AsyncContext::new(rx0);
    let mut ctx1 = AsyncContext::new(rx1);
    let cleaned = std::cell::Cell::new(false);
    let a = first.task(async { first.sleep::<()>(&mut ctx0, 1).await.unwrap(); true });
    let b = second.task(async {
        assert!(matches!(second.wait(&owner, &mut ctx1).await, Err(AsyncError::Interrupted)));
        ctx1.interruptible = false;
        parent_cancel.send(true).unwrap();
        second.sleep::<()>(&mut ctx1, 2).await.unwrap();
        cleaned.set(true);
        false
    });
    assert!(!coordinated_task_group2(&bank,[1,2],[2,3],0,a,cancel0,b,cancel1,parent,true,true).await);
    assert!(cleaned.get());
    assert!(owner.state.lock().unwrap().slots.iter().all(Option::is_none));
    assert!(bank.priority().is_none());
}
async fn immediate_race_winner() {
    let bank = DeferredTurns::<3>::new();
    let (_parent_cancel, parent) = tokio::sync::watch::channel(false);
    let (cancel0, _rx0) = tokio::sync::watch::channel(false);
    let (cancel1, _rx1) = tokio::sync::watch::channel(false);
    let first = DeferredTurnHandle::new(&bank, 1);
    let second = DeferredTurnHandle::new(&bank, 2);
    let a = first.task(async { true });
    let b = second.task(async { panic!("Official race never starts a later loser after synchronous success"); });
    assert!(coordinated_task_group2(&bank,[1,2],[2,3],0,a,cancel0,b,cancel1,parent,true,true).await);
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        for _ in 0..10 { parent_during_broadcast().await; false_child().await; masked_last_child().await; watch_updates_and_mask().await; independent_nested_waiter(true).await; independent_nested_waiter(false).await; immediate_race_winner().await; race_parent_during_loser_cleanup().await; }
        println!("cleanup-drained");
    }).await.expect("Cancellation and broadcasts progress");
}
`;

test(
  "generated Deferred All and nested Race drain cancellation cleanup and route subtree turns",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "reffect-deferred-generated-runtime-"));
    try {
      await writeFile(
        join(directory, "main.rs"),
        [asyncRuntime(false, false), deferredGeneratedRuntime(), harness].join("\n"),
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
      expect(debug.stdout).toContain("cleanup-drained");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
