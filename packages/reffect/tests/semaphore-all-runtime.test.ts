import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Deferred, Effect, Exit, Fiber, Semaphore } from "effect";
import { expect, test } from "vite-plus/test";
import { asyncRuntime } from "../src/async-runtime.ts";
import { semaphoreAllRuntime } from "../src/semaphore-all-runtime.ts";
import { semaphoreDispatchRuntime } from "../src/semaphore-dispatch-runtime.ts";
import { semaphoreTaskRuntime } from "../src/semaphore-task-runtime.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const kinds = ["early", "holder", "parent-cleanup", "selected", "success", "success2"];

// The group itself is actual All: awaiting its root fiber only observes its final exit.
const oracle = (kind: string) =>
  Effect.gen(function* () {
    const events: string[] = [];
    const log = (message: string) =>
      Effect.sync(() => {
        events.push(message);
      });
    const owner = yield* Semaphore.make(1);
    const release = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    if (kind === "success2") {
      const exit = yield* Effect.exit(
        Effect.all([owner.withPermit(log("A:enter")), owner.withPermit(log("B:enter"))], {
          concurrency: "unbounded",
        }),
      );
      return { events, success: Exit.isSuccess(exit) };
    }
    if (kind === "early") {
      const exit = yield* Effect.exit(
        Effect.all(
          [
            log("first:interrupt").pipe(Effect.andThen(Effect.interrupt)),
            log("unstarted:A"),
            log("unstarted:B"),
          ],
          { concurrency: "unbounded" },
        ),
      );
      return { events, success: Exit.isSuccess(exit) };
    }
    if (kind === "selected") {
      yield* Semaphore.take(owner, 1);
      const peer = (name: string) =>
        log(`${name}:start`).pipe(
          Effect.andThen(Deferred.await(cleanup)),
          Effect.ensuring(
            log(`${name}:cleanup-start`).pipe(
              Effect.andThen(Deferred.await(cleanup)),
              Effect.andThen(log(`${name}:cleanup-end`)),
            ),
          ),
        );
      const selected = log("B:attempt").pipe(
        Effect.andThen(owner.withPermit(log("B:enter").pipe(Effect.andThen(Effect.interrupt)))),
        Effect.ensuring(log("B:cleanup")),
      );
      const parent = yield* Effect.forkChild(
        Effect.all([peer("A"), selected, peer("C")], { concurrency: "unbounded" }),
        { startImmediately: true },
      );
      expect(events).toEqual(["A:start", "B:attempt", "C:start"]);
      yield* Semaphore.release(owner, 1);
      yield* Effect.yieldNow;
      const prefixes = events.slice(-2);
      const unfinished = parent.pollUnsafe() === undefined;
      yield* Deferred.succeed(cleanup, undefined);
      expect(prefixes).toEqual(["A:cleanup-start", "C:cleanup-start"]);
      expect(unfinished).toBe(true);
      const exit = yield* Fiber.await(parent);
      return { events, success: Exit.isSuccess(exit) };
    }
    const holder = owner.withPermit(
      log("holder:enter").pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(kind === "success" ? log("holder:exit") : Effect.interrupt),
        Effect.ensuring(
          kind === "success"
            ? Effect.void
            : log("holder:cleanup-start").pipe(
                Effect.andThen(Deferred.await(cleanup)),
                Effect.andThen(log("holder:cleanup-end")),
              ),
        ),
      ),
    );
    const waiter = (name: string) =>
      log(`${name}:attempt`).pipe(
        Effect.andThen(owner.withPermit(log(`${name}:enter`))),
        Effect.ensuring(log(`${name}:cleanup`)),
      );
    const parent = yield* Effect.forkChild(
      Effect.all([holder, waiter("A"), waiter("B")], { concurrency: "unbounded" }),
      { startImmediately: true },
    );
    expect(events).toEqual(["holder:enter", "A:attempt", "B:attempt"]);
    yield* Deferred.succeed(release, undefined);
    if (kind !== "success") {
      yield* Effect.yieldNow;
      expect(events.at(-1)).toBe("holder:cleanup-start");
      expect(events).not.toContain("A:enter");
      if (kind === "parent-cleanup") {
        yield* Effect.forkChild(Fiber.interrupt(parent), { startImmediately: true });
        yield* Effect.yieldNow;
        expect(events).toContain("A:cleanup");
        expect(events).toContain("B:cleanup");
      }
      yield* Deferred.succeed(cleanup, undefined);
    }
    const exit = yield* Fiber.await(parent);
    return { events, success: Exit.isSuccess(exit) };
  });

const harness = String.raw`
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll, Waker};
use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};
#[derive(Default)] struct Gate { open: AtomicBool, waker: Mutex<Option<Waker>> }
impl Gate {
    fn open(&self) {
        self.open.store(true, Ordering::SeqCst);
        if let Some(waker) = self.waker.lock().unwrap().take() { waker.wake(); }
    }
    async fn wait(&self) {
        std::future::poll_fn(|cx| {
            let mut waker = self.waker.lock().unwrap();
            if self.open.load(Ordering::SeqCst) { Poll::Ready(()) }
            else { *waker = Some(cx.waker().clone()); Poll::Pending }
        }).await
    }
}
fn log(events: &Mutex<Vec<&'static str>>, message: &'static str) { events.lock().unwrap().push(message); }
async fn wait(task: ScanTask<'_, 4>, ctx: &mut AsyncContext, gate: &Gate) -> bool {
    if ctx.is_cancelled() { return false; }
    task.semantic(async {
        tokio::select! { biased;
            _ = ctx.cancellation.changed() => false,
            _ = gate.wait() => true,
        }
    }).await
}
async fn holder(task: ScanTask<'_, 4>, owner: &ScanSemaphore<4>, mut ctx: AsyncContext,
    release: &Gate, cleanup: &Gate, events: &Mutex<Vec<&'static str>>, kind: &str) -> bool {
    let Ok(permit) = task.acquire(owner, &mut ctx).await else { return false; };
    log(events, "holder:enter");
    let released = wait(task, &mut ctx, release).await;
    let success = released && kind == "success";
    if success { log(events, "holder:exit"); }
    else {
        ctx.interruptible = false;
        log(events, "holder:cleanup-start");
        task.semantic(cleanup.wait()).await;
        log(events, "holder:cleanup-end");
        ctx.interruptible = true;
    }
    // INNER masked cleanup retains ownership through its authored suspension.
    drop(permit); success && !ctx.is_cancelled()
}
async fn waiter(task: ScanTask<'_, 4>, owner: &ScanSemaphore<4>, mut ctx: AsyncContext,
    events: &Mutex<Vec<&'static str>>, name: &str) -> bool {
    if ctx.is_cancelled() { return false; }
    log(events, if name == "A" { "A:attempt" } else { "B:attempt" });
    let success = if let Ok(permit) = task.acquire(owner, &mut ctx).await {
        log(events, if name == "A" { "A:enter" } else { "B:enter" }); drop(permit); true
    } else { false };
    log(events, if name == "A" { "A:cleanup" } else { "B:cleanup" }); success
}
fn pending<F: Future>(future: Pin<&mut F>, cx: &mut Context<'_>) { assert!(future.poll(cx).is_pending()); }
fn ready<F: Future<Output=bool>>(future: Pin<&mut F>, cx: &mut Context<'_>) -> bool {
    match future.poll(cx) { Poll::Ready(success) => success, Poll::Pending => panic!("Expected settled All") }
}
fn report(kind: &str, success: bool, owner: &ScanSemaphore<4>, events: &Mutex<Vec<&'static str>>) {
    assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
    println!("CASE:{kind}:{{\"events\":{:?},\"success\":{success}}}", events.lock().unwrap());
}
fn scenario(kind: &str) {
    let owner = ScanSemaphore::<4>::new(1); let bank = ScanTasks::<4>::new();
    let release = Gate::default(); let cleanup = Gate::default(); let events = Mutex::new(Vec::new());
    let (cc, cr) = tokio::sync::watch::channel(false);
    let (ac, ar) = tokio::sync::watch::channel(false);
    let (bc, br) = tokio::sync::watch::channel(false);
    let (pc, pr) = tokio::sync::watch::channel(false);
    let c = holder(ScanTask::new(&bank, 0), &owner, AsyncContext::new(cr), &release, &cleanup, &events, kind);
    let a = waiter(ScanTask::new(&bank, 1), &owner, AsyncContext::new(ar), &events, "A");
    let b = waiter(ScanTask::new(&bank, 2), &owner, AsyncContext::new(br), &events, "B");
    tokio::pin!(c, a, b);
    let group = scan_all3(&owner, &bank, [0, 1, 2], c.as_mut(), a.as_mut(), b.as_mut(), [cc, ac, bc], pr);
    tokio::pin!(group); let mut cx = Context::from_waker(Waker::noop());
    pending(group.as_mut(), &mut cx); assert_eq!(owner.available(), 0); assert_eq!(owner.waiting(), 2);
    release.open();
    if kind != "success" {
        pending(group.as_mut(), &mut cx);
        assert_eq!(owner.available(), 0); assert_eq!(owner.waiting(), 2);
        if kind == "parent-cleanup" {
            pc.send(true).unwrap(); pending(group.as_mut(), &mut cx);
            assert_eq!(owner.available(), 0); assert_eq!(owner.waiting(), 0);
        }
        cleanup.open();
    }
    let success = ready(group.as_mut(), &mut cx);
    if kind != "success" {
        assert!(!events.lock().unwrap().contains(&"A:enter"), "Terminal All must cancel A before queued body reuse");
        assert!(!events.lock().unwrap().contains(&"B:enter"), "Terminal All must cancel B before queued body reuse");
    }
    report(kind, success, &owner, &events);
}
fn early(preflight: bool) {
    let owner = ScanSemaphore::<4>::new(1); let bank = ScanTasks::<4>::new(); let events = Mutex::new(Vec::new());
    let (ac, _ar) = tokio::sync::watch::channel(false);
    let (bc, _br) = tokio::sync::watch::channel(false);
    let (cc, _cr) = tokio::sync::watch::channel(false);
    let (pc, pr) = tokio::sync::watch::channel(false);
    let a = async { log(&events, "first:interrupt"); false };
    let b = async { log(&events, "unstarted:A"); true };
    let c = async { log(&events, "unstarted:B"); true };
    tokio::pin!(a, b, c);
    let group = scan_all3(&owner, &bank, [0, 1, 2], a.as_mut(), b.as_mut(), c.as_mut(), [ac, bc, cc], pr);
    tokio::pin!(group); let mut cx = Context::from_waker(Waker::noop());
    if preflight { pc.send(true).unwrap(); }
    let success = ready(group.as_mut(), &mut cx); assert!(!success);
    if preflight { assert!(events.lock().unwrap().is_empty()); println!("PREFLIGHT:passed"); }
    else { report("early", success, &owner, &events); }
}
async fn peer(task: ScanTask<'_, 4>, mut ctx: AsyncContext, gate: &Gate,
    events: &Mutex<Vec<&'static str>>, name: &str) -> bool {
    log(events, if name == "A" { "A:start" } else { "C:start" });
    let success = wait(task, &mut ctx, gate).await;
    ctx.interruptible = false;
    log(events, if name == "A" { "A:cleanup-start" } else { "C:cleanup-start" });
    task.semantic(gate.wait()).await;
    log(events, if name == "A" { "A:cleanup-end" } else { "C:cleanup-end" });
    ctx.interruptible = true; success && !ctx.is_cancelled()
}
fn selected() {
    let owner = ScanSemaphore::<4>::new(1); let bank = ScanTasks::<4>::new();
    let events = Mutex::new(Vec::new()); let gate = Gate::default();
    let (ac, ar) = tokio::sync::watch::channel(false);
    let (bc, br) = tokio::sync::watch::channel(false);
    let (cc, cr) = tokio::sync::watch::channel(false);
    let (_pc, pr) = tokio::sync::watch::channel(false);
    let mut cx = Context::from_waker(Waker::noop());
    let held = match Pin::new(&mut owner.acquire(3)).poll(&mut cx) { Poll::Ready(permit) => permit, _ => panic!() };
    let a = peer(ScanTask::new(&bank, 0), AsyncContext::new(ar), &gate, &events, "A");
    let b = async {
        let mut ctx = AsyncContext::new(br); log(&events, "B:attempt");
        let permit = ScanTask::new(&bank, 1).acquire(&owner, &mut ctx).await.unwrap();
        log(&events, "B:enter"); drop(permit); log(&events, "B:cleanup"); false
    };
    let c = peer(ScanTask::new(&bank, 2), AsyncContext::new(cr), &gate, &events, "C");
    tokio::pin!(a, b, c);
    let group = scan_all3(&owner, &bank, [0, 1, 2], a.as_mut(), b.as_mut(), c.as_mut(), [ac, bc, cc], pr);
    tokio::pin!(group); pending(group.as_mut(), &mut cx); assert_eq!(owner.waiting(), 1);
    drop(held); pending(group.as_mut(), &mut cx);
    assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
    assert_eq!(*events.lock().unwrap(), vec!["A:start", "B:attempt", "C:start", "B:enter", "B:cleanup", "A:cleanup-start", "C:cleanup-start"]);
    gate.open(); let success = ready(group.as_mut(), &mut cx); report("selected", success, &owner, &events);
    assert!(!success);
}
// Native phase probes: signaling cancellation inside a turn is an invariant, not an authored Effect oracle.
fn phase(selected: bool) {
    let owner = ScanSemaphore::<4>::new(1); let bank = ScanTasks::<4>::new(); let events = Mutex::new(Vec::new());
    let (ac, ar) = tokio::sync::watch::channel(false); let (bc, br) = tokio::sync::watch::channel(false);
    let (pc, pr) = tokio::sync::watch::channel(false); let mut cx = Context::from_waker(Waker::noop());
    let held = if selected { match Pin::new(&mut owner.acquire(3)).poll(&mut cx) {
        Poll::Ready(permit) => Some(permit), _ => panic!()
    }} else { None };
    let a = async {
        let mut ctx = AsyncContext::new(ar);
        let permit = ScanTask::new(&bank, 0).acquire(&owner, &mut ctx).await.unwrap();
        log(&events, "A:enter"); pc.send(true).unwrap(); drop(permit); true
    };
    let b = waiter(ScanTask::new(&bank, 1), &owner, AsyncContext::new(br), &events, "B");
    tokio::pin!(a, b);
    let group = scan_all2(&owner, &bank, [0, 1], a.as_mut(), b.as_mut(), [ac, bc], pr);
    tokio::pin!(group);
    if selected { pending(group.as_mut(), &mut cx); assert_eq!(owner.waiting(), 2); drop(held); }
    assert!(!ready(group.as_mut(), &mut cx));
    assert!(!events.lock().unwrap().contains(&"B:enter"));
    assert_eq!(owner.available(), 1); assert_eq!(owner.waiting(), 0);
    println!("PHASE:{selected}:passed");
}
fn success2() {
    let owner = ScanSemaphore::<4>::new(1); let bank = ScanTasks::<4>::new(); let events = Mutex::new(Vec::new());
    let (ac, ar) = tokio::sync::watch::channel(false); let (bc, br) = tokio::sync::watch::channel(false);
    let (_pc, pr) = tokio::sync::watch::channel(false);
    let a = async {
        let mut ctx = AsyncContext::new(ar);
        let permit = ScanTask::new(&bank, 0).acquire(&owner, &mut ctx).await.unwrap();
        log(&events, "A:enter"); drop(permit); true
    };
    let b = async {
        let mut ctx = AsyncContext::new(br);
        let permit = ScanTask::new(&bank, 1).acquire(&owner, &mut ctx).await.unwrap();
        log(&events, "B:enter"); drop(permit); true
    };
    tokio::pin!(a, b);
    let group = scan_all2(&owner, &bank, [0, 1], a.as_mut(), b.as_mut(), [ac, bc], pr);
    tokio::pin!(group); let mut cx = Context::from_waker(Waker::noop());
    let success = ready(group.as_mut(), &mut cx); assert!(success); report("success2", success, &owner, &events);
}
#[tokio::main(flavor="current_thread")]
async fn main() {
    for _ in 0..10 {
        early(false); scenario("holder"); scenario("parent-cleanup"); selected(); scenario("success"); success2();
    }
    early(true); phase(false); phase(true);
}
`;

test(
  "private Never-error All interrupts siblings before reuse and awaits masked inner cleanup",
  async () => {
    const official = new Map<string, { events: string[]; success: boolean }>();
    for (const kind of kinds) official.set(kind, await Effect.runPromise(oracle(kind)));
    const directory = await mkdtemp(join(tmpdir(), "reffect-semaphore-all-"));
    try {
      await writeFile(
        join(directory, "main.rs"),
        [
          asyncRuntime(false, false),
          semaphoreDispatchRuntime(),
          semaphoreTaskRuntime(),
          semaphoreAllRuntime(),
          harness,
        ].join("\n"),
      );
      await writeFile(
        join(directory, "Cargo.toml"),
        `[package]\nname="reffect_semaphore_all"\nversion="0.1.0"\nedition="2021"\n[[bin]]\nname="all"\npath="main.rs"\n[dependencies]\ntokio={version="=1.53.1",features=["rt","macros","sync","time"]}\n`,
      );
      const execute = promisify(execFile);
      const options = {
        cwd: directory,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CARGO_INCREMENTAL: "0", CARGO_PROFILE_DEV_DEBUG: "0" },
      };
      const debug = await execute("cargo", ["run", "--offline", "--quiet"], options);
      const release = await execute("cargo", ["run", "--release", "--offline", "--quiet"], options);
      expect(release.stdout).toEqual(debug.stdout);
      for (const kind of kinds) {
        const prefix = `CASE:${kind}:`;
        const lines = debug.stdout.split("\n").filter((line) => line.startsWith(prefix));
        expect(lines).toHaveLength(10);
        for (const line of lines)
          expect(JSON.parse(line.slice(prefix.length))).toEqual(official.get(kind));
      }
      expect(debug.stdout).toContain("PREFLIGHT:passed");
      expect(debug.stdout).toContain("PHASE:false:passed");
      expect(debug.stdout).toContain("PHASE:true:passed");
      const events: string[] = [];
      const preflight = await Effect.runPromiseExit(
        Effect.interrupt.pipe(
          Effect.andThen(
            Effect.all(
              [
                Effect.sync(() => {
                  events.push("unstarted");
                }),
                Effect.void,
              ],
              { concurrency: "unbounded" },
            ),
          ),
        ),
      );
      expect(Exit.isFailure(preflight)).toBe(true);
      expect(events).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  nativeTestBudget(0) * 2,
);
