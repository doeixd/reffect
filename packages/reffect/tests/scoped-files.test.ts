import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { NodeServices } from "@effect/platform-node";
import { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { FetchHttpClient, HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { request as httpRequest } from "node:http";
import { open } from "node:fs/promises";
import { fstatSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  Computation,
  FailureFrames,
  FileLease,
  NativeRpc,
  NativeRunner,
  R,
  Reference,
  ReferenceFiles,
  RpcCodecs,
  Rust,
  Source,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const messages = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message);
const observed = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({
      error: Option.getOrUndefined(Cause.findErrorOption(cause)),
      interrupted: Cause.hasInterrupts(cause),
    }),
  });

test("scoped files refuse escaped operations, invalid paths and forged cleanup channels", async () => {
  let escaped: Computation<bigint, boolean> = R.Effect.succeed(R.U64.literal(0n));
  const inside = R.File.scoped("unused", (file) => {
    escaped = file.size;
    return file.size;
  });
  const fn = R.fn([], R.U64, R.Bool, () => inside.pipe(R.Effect.flatMap(() => escaped)));
  const codes = await Effect.runPromise(
    Compile.run(R.program({ fn }), Rust.tokio).pipe(
      Effect.match({
        onSuccess: () => [],
        onFailure: (error) => error.diagnostics.map((d) => d.code),
      }),
    ),
  );
  expect(codes).toContain("RESOURCE_ESCAPE");
  for (const path of ["", "a\0b", "\ud800", "a".repeat(4097)])
    expect(() => R.File.scoped(path, () => R.Effect.void)).toThrow();
  const wrongCleanup = Computation.make(R.Unit, R.Never, {
    _tag: "Fail",
    error: R.Bool.literal(false),
  });
  const invalid = R.fn([], R.Unit, R.Bool, () =>
    R.File.scoped("unused", () => R.Effect.void, wrongCleanup),
  );
  expect(
    await Effect.runPromise(Compile.check(R.program({ invalid })).pipe(Effect.isFailure)),
  ).toBe(true);
  R.File.scoped(
    "unused",
    () => R.Effect.void,
    // @ts-expect-error Cleanup must be non-failing.
    R.Effect.fail(R.Bool.literal(false)),
  );
  R.File.scoped("unused", (file) =>
    // @ts-expect-error A borrowed file reference is not a returnable Expr.
    R.Effect.succeed(file),
  );
});

test("official scoped registration awaits acquisition and closes actual leases before cleanup", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-file-oracle-" });
        const path = `${parent}/input`;
        yield* fs.writeFileString(path, "hello");
        for (const phase of ["acquire", "use", "cleanup"] as const) {
          const acquired = yield* Deferred.make<void>();
          const unblock = yield* Deferred.make<void>();
          const atUse = yield* Deferred.make<void>();
          const atCleanup = yield* Deferred.make<void>();
          const events: string[] = [];
          let descriptor = -1;
          const files = Layer.succeed(
            ReferenceFiles,
            ReferenceFiles.of({
              open: Effect.fn("TestFiles.open")(function* (name: string) {
                events.push("acquire");
                const file = yield* Effect.tryPromise({
                  try: () => open(name, "r"),
                  catch: () => false,
                });
                descriptor = file.fd;
                yield* Deferred.succeed(acquired, undefined);
                if (phase === "acquire") yield* Deferred.await(unblock);
                events.push("acquired");
                return new FileLease(
                  Effect.tryPromise({
                    try: async () => (await file.stat({ bigint: true })).size,
                    catch: () => false,
                  }),
                  Effect.promise(() => file.close()).pipe(
                    Effect.tap(() => Effect.sync(() => events.push("closed"))),
                  ),
                );
              }),
            }),
          );
          const fn = R.fn([], R.Unit, R.Bool, () =>
            R.File.scoped(
              path,
              () =>
                R.Log.info("use").pipe(
                  R.Effect.flatMap(() => (phase === "use" ? R.Effect.sleep(10000) : R.Effect.void)),
                ),
              R.Log.info("cleanup").pipe(
                R.Effect.flatMap(() => R.Effect.sleep(5)),
                R.Effect.flatMap(() => R.Log.info("cleaned")),
              ),
            ),
          );
          const logger = Logger.layer([
            Logger.make((event) => {
              const message = String(event.message);
              events.push(message);
              if (message === "use") Deferred.doneUnsafe(atUse, Effect.void);
              if (message === "cleanup") {
                expect(() => fstatSync(descriptor)).toThrow();
                Deferred.doneUnsafe(atCleanup, Effect.void);
              }
            }),
          ]);
          const fiber = yield* Reference.run(fn, []).pipe(
            Effect.provide([files, logger]),
            Effect.forkScoped,
          );
          yield* Deferred.await(
            phase === "acquire" ? acquired : phase === "use" ? atUse : atCleanup,
          );
          const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
          if (phase === "acquire") {
            yield* Effect.yieldNow;
            expect(events).toEqual(["acquire"]);
            yield* Deferred.succeed(unblock, undefined);
          }
          yield* Fiber.join(interrupt);
          expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
          expect(events).toEqual([
            "acquire",
            "acquired",
            ...(phase === "acquire" ? [] : ["use"]),
            "closed",
            "cleanup",
            "cleaned",
          ]);
          expect(() => fstatSync(descriptor)).toThrow();
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test(
  "real file ownership, borrowed helpers and cancellation agree in native debug/release",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-scoped-files-" });
          const path = `${parent}/input-é`;
          yield* fs.writeFileString(path, "hello");
          const cleanup = R.Log.info("close:start").pipe(
            R.Effect.flatMap(() => R.Effect.sleep(5)),
            R.Effect.flatMap(() => R.Log.info("close:done")),
          );
          const normal = R.fn([R.Bool], R.U64, R.Bool, (allowed) =>
            R.File.scoped(
              path,
              (file) =>
                file.size.pipe(
                  R.Effect.flatMap((size) =>
                    R.Effect.sleep(1).pipe(
                      R.Effect.flatMap(() =>
                        R.Match.bool(allowed, R.Effect.succeed(size), R.Effect.fail(allowed)),
                      ),
                    ),
                  ),
                ),
              cleanup,
            ),
          );
          const missing = R.fn([], R.Unit, R.Bool, () =>
            R.File.scoped(
              `${parent}/missing`,
              () => R.Log.info("must-not-use"),
              R.Log.info("must-not-close"),
            ),
          );
          const nested = R.fn([], R.U64, R.Bool, () =>
            R.File.scoped(
              path,
              (outer) =>
                R.File.scoped(
                  path,
                  (inner) =>
                    inner.size.pipe(
                      R.Effect.flatMap((a) =>
                        outer.size.pipe(R.Effect.map((b) => R.U64.add(a, b))),
                      ),
                    ),
                  R.Log.info("inner"),
                ),
              R.Log.info("outer"),
            ),
          );
          const cancel = R.fn([], R.Unit, R.Bool, () =>
            R.File.scoped(
              path,
              () => R.Log.info("use").pipe(R.Effect.flatMap(() => R.Effect.sleep(10000))),
              cleanup,
            ),
          );
          const recover = R.fn([], R.U64, R.Never, () =>
            normal.body.pipe(
              R.Effect.catchAll(() =>
                R.Log.info("recover").pipe(
                  R.Effect.flatMap(() => R.Effect.succeed(R.U64.literal(9n))),
                ),
              ),
            ),
          );
          // normal.body has a function-local argument; use an independently scoped failure for recovery.
          const recovered = R.fn([], R.U64, R.Never, () =>
            R.File.scoped(path, () => R.Effect.fail(R.Bool.literal(false)), cleanup).pipe(
              R.Effect.catchAll(() =>
                R.Log.info("recover").pipe(
                  R.Effect.flatMap(() => R.Effect.succeed(R.U64.literal(9n))),
                ),
              ),
            ),
          );
          expect(yield* Compile.check(R.program({ recover })).pipe(Effect.isFailure)).toBe(true);
          const mapped = normal.pipe(Source.at(Source.site(Source.file("files.ts", "file"), 0, 4)));
          const program = R.program({ normal: mapped, missing, nested, cancel, recovered });
          expect(yield* Compile.run(program).pipe(Effect.isFailure)).toBe(true);
          const group = RpcGroup.make(
            Rpc.make("Size", {
              payload: { allowed: Schema.Boolean },
              success: RpcCodecs.U64Json,
              error: Schema.Boolean,
            }),
          );
          const rpc = yield* NativeRpc.compile(group, {
            Size: NativeRpc.bind(mapped, ["allowed"]),
          });
          expect(rpc.runtime.handlerProfile).toBe("suspended-scalars");
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(policy),
              Compile.run,
            );
            expect(artifact.explanation.services).toEqual([Rust.scopedFiles]);
            expect((yield* Compile.analyzeOwnership(artifact.explanation)).mode).toBe(
              "lexical-files",
            );
            expect(artifact.files["src/lib.rs"]).toContain("&std::fs::File");
            expect(artifact.files["src/lib.rs"]).not.toMatch(/try_clone|Box<dyn|Vec<Finalizer/);
            expect(artifact.sources.files.some((file) => file.path === "files.ts")).toBe(true);
            const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
            yield* CargoApi.fetch(directory);
            for (const profile of ["debug", "release"] as const) {
              yield* CargoApi.build(directory, profile);
              for (const allowed of [true, false]) {
                const native = yield* NativeRunner.run(
                  artifact,
                  directory,
                  "normal",
                  mapped,
                  [allowed],
                  profile,
                );
                const reference = yield* Effect.exit(Reference.run(mapped, [allowed]));
                expect(observed(native)).toEqual(observed(reference));
                expect(observed(native)).toEqual(
                  allowed ? { value: 5n } : { error: false, interrupted: false },
                );
                if (!FailureFrames.isNone(policy) && !allowed) {
                  const nativeFrames = yield* NativeRunner.runWithFrames(
                    artifact,
                    directory,
                    "normal",
                    mapped,
                    [allowed],
                    profile,
                  );
                  const referenceFrames = yield* Reference.runWithFrames(
                    mapped,
                    [allowed],
                    "functions.normal.body",
                  );
                  expect(nativeFrames.frames.map(({ path, kind }) => ({ path, kind }))).toEqual(
                    referenceFrames.frames,
                  );
                }
              }
              expect(
                observed(
                  yield* NativeRunner.run(artifact, directory, "missing", missing, [], profile),
                ),
              ).toEqual({ error: false, interrupted: false });
              expect(
                observed(
                  yield* NativeRunner.run(artifact, directory, "nested", nested, [], profile),
                ),
              ).toEqual({ value: 10n });
              expect(
                observed(
                  yield* NativeRunner.run(artifact, directory, "recovered", recovered, [], profile),
                ),
              ).toEqual({ value: 9n });
              const referenceLogs: string[] = [];
              yield* Reference.run(nested, []).pipe(
                Effect.provide(
                  Logger.layer([Logger.make((event) => referenceLogs.push(String(event.message)))]),
                ),
              );
              expect(referenceLogs).toEqual(["inner", "outer"]);
              const probe = nativeProbe;
              yield* fs.writeFileString(`${directory}/src/main.rs`, probe);
              yield* CargoApi.build(directory, profile);
              const result = yield* CargoApi.run(directory, "probe", [], profile);
              expect(messages(result.stderr)).toEqual([
                "close:start",
                "close:done",
                "use",
                "close:start",
                "close:done",
                "close:start",
                "close:done",
                "inner",
                "outer",
              ]);
              expect(result.stdout).toContain("file ownership conformance");
              console.info(`scoped files ${policy._tag}/${profile}: ${result.stdout.trim()}`);
              yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
            }
            const stripped = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(policy),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(stripped.files["src/lib.rs"]).toContain("std::fs::File::open");
            if (FailureFrames.isNone(policy)) expect(stripped.files).toEqual(artifact.files);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([]))),
    );
  },
  nativeTestBudget(0) + 180000,
);

const nativeProbe = String.raw`
use std::future::Future;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 { ALLOCS.fetch_add(1, Ordering::SeqCst); System.alloc(layout) }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) { System.dealloc(ptr, layout) }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 { ALLOCS.fetch_add(1, Ordering::SeqCst); System.realloc(ptr, layout, size) }
}
#[global_allocator] static ALLOCATOR: Counting = Counting;
#[cfg(target_os = "linux")]
fn handles() -> usize { std::fs::read_dir("/proc/self/fd").unwrap().count() }
#[cfg(windows)]
fn handles() -> usize {
    #[link(name = "kernel32")]
    unsafe extern "system" { fn GetCurrentProcess() -> *mut std::ffi::c_void; fn GetProcessHandleCount(process: *mut std::ffi::c_void, count: *mut u32) -> i32; }
    let mut count = 0;
    unsafe { assert_ne!(GetProcessHandleCount(GetCurrentProcess(), &mut count), 0); }
    count as usize
}
#[cfg(not(any(windows, target_os = "linux")))]
compile_error!("live file handle conformance requires a Windows or Linux counter");
fn main() {
    tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(1).build().unwrap().block_on(run());
}
async fn run() {
    tokio::task::spawn_blocking(|| ()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    let baseline = handles();
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let before = ALLOCS.load(Ordering::SeqCst);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let normal_size = { let f = reffect_generated::r_normal(&mut ctx, true); std::mem::size_of_val(&f) };
    let nested_size = { let f = reffect_generated::r_nested(&mut ctx); std::mem::size_of_val(&f) };
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
    println!("context={},normal={},nested={}", std::mem::size_of_val(&ctx), normal_size, nested_size);
    // Occupy the only blocking worker: acquisition cannot finish before cancellation.
    let (ready_send, ready_recv) = std::sync::mpsc::channel();
    let (gate_send, gate_recv) = std::sync::mpsc::channel();
    let blocker = tokio::task::spawn_blocking(move || { ready_send.send(()).unwrap(); gate_recv.recv().unwrap(); });
    ready_recv.recv().unwrap();
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    {
        let future = reffect_generated::r_cancel(&mut ctx);
        tokio::pin!(future);
        std::future::poll_fn(|cx| match future.as_mut().poll(cx) {
            std::task::Poll::Pending => std::task::Poll::Ready(()),
            _ => panic!("acquisition was not suspended"),
        }).await;
        sender.send(true).unwrap();
        gate_send.send(()).unwrap();
        assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    }
    blocker.await.unwrap();
    drop(ready_recv);
    assert_eq!(handles(), baseline);
    // Cancel during use, once the live File is observable.
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    {
        let future = reffect_generated::r_cancel(&mut ctx);
        tokio::pin!(future);
        std::future::poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            if handles() > baseline { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
        }).await;
        sender.send(true).unwrap();
        assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    }
    assert_eq!(handles(), baseline);
    // Wait for the owned handle to be closed before cancelling awaited cleanup.
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    {
        let future = reffect_generated::r_normal(&mut ctx, true);
        tokio::pin!(future);
        let mut saw_file = false;
        std::future::poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            let count = handles();
            saw_file |= count > baseline;
            if saw_file && count == baseline { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
        }).await;
        sender.send(true).unwrap();
        assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    }
    assert_eq!(handles(), baseline);
    let (sender, receiver) = tokio::sync::watch::channel(false);
    sender.send(true).unwrap();
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    assert!(matches!(reffect_generated::r_cancel(&mut ctx).await, Err(reffect_generated::AsyncError::Interrupted)));
    assert_eq!(handles(), baseline);
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    assert_eq!(reffect_generated::r_nested(&mut ctx).await.unwrap(), 10);
    assert_eq!(handles(), baseline);
    println!("file ownership conformance");
}
`;

test("stock RPC clients and socket disconnect await real file scope cleanup", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-file-rpc-" });
        const path = `${parent}/input`;
        yield* fs.writeFileString(path, "hello");
        const handler = R.fn([R.Bool], R.U64, R.Bool, (wait) =>
          R.File.scoped(
            path,
            (file) =>
              file.size.pipe(
                R.Effect.flatMap((size) =>
                  R.Log.info("opened").pipe(
                    R.Effect.flatMap(() =>
                      R.Match.bool(wait, R.Effect.sleep(10000), R.Effect.void),
                    ),
                    R.Effect.flatMap(() => R.Effect.succeed(size)),
                  ),
                ),
              ),
            R.Log.info("closed").pipe(
              R.Effect.flatMap(() => R.Effect.sleep(5)),
              R.Effect.flatMap(() => R.Log.info("cleaned")),
            ),
          ),
        );
        const missing = R.fn([], R.U64, R.Bool, () =>
          R.File.scoped(`${parent}/missing`, (file) => file.size),
        );
        const group = RpcGroup.make(
          Rpc.make("Size", {
            payload: { wait: Schema.Boolean },
            success: RpcCodecs.U64Json,
            error: Schema.Boolean,
          }),
          Rpc.make("Missing", {
            payload: Schema.Undefined,
            success: RpcCodecs.U64Json,
            error: Schema.Boolean,
          }),
        );
        const waitUntil = (condition: () => boolean) =>
          Effect.sync(condition).pipe(
            Effect.repeat({ while: (ready) => !ready, schedule: Schedule.spaced("2 millis") }),
            Effect.timeout("5 seconds"),
          );
        const scenario = (transport: typeof fetch, url: string, logs: string[]) =>
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* RpcClient.make(group, { disableTracing: true }).pipe(
                Effect.provide(
                  RpcClient.layerProtocolHttp({ url }).pipe(
                    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerJson]),
                  ),
                ),
                Effect.provideService(FetchHttpClient.Fetch, transport),
              );
              expect(yield* client.Size({ wait: false })).toBe(5n);
              expect(yield* client.Missing(undefined).pipe(Effect.flip)).toBe(false);
              yield* waitUntil(() => logs.length === 3);
              expect(logs).toEqual(["opened", "closed", "cleaned"]);
              const fiber = yield* client.Size({ wait: true }).pipe(Effect.forkScoped);
              yield* waitUntil(() => logs.length === 4);
              yield* Fiber.interrupt(fiber);
              expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
              yield* waitUntil(() => logs.length === 6);
              expect(logs).toEqual(["opened", "closed", "cleaned", "opened", "closed", "cleaned"]);
            }),
          );
        const oracleLogs: string[] = [];
        const oracle = group.toLayer({
          Size: (payload) =>
            Reference.run(handler, [payload.wait]).pipe(
              Effect.catchTag("CompileError", Effect.die),
            ),
          Missing: () =>
            Reference.run(missing, []).pipe(Effect.catchTag("CompileError", Effect.die)),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const http = yield* RpcServer.toHttpEffect(group, { disableTracing: true });
            const web = HttpEffect.toWebHandler(http.pipe(Effect.interruptible));
            const transport: typeof fetch = (input, init) => web(new Request(input, init));
            yield* scenario(transport, "http://reffect.test/rpc", oracleLogs);
          }),
        ).pipe(
          Effect.provide([oracle, RpcSerialization.layerJson]),
          Effect.provide(
            Logger.layer([Logger.make((event) => oracleLogs.push(String(event.message)))]),
          ),
        );
        for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
          const artifact = yield* NativeRpc.compile(
            group,
            { Size: NativeRpc.bind(handler, ["wait"]), Missing: NativeRpc.bind(missing, []) },
            { failureFrames: policy },
          );
          const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
          yield* CargoApi.fetch(directory);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(directory, profile);
            yield* Effect.scoped(
              Effect.gen(function* () {
                const logs: string[] = [];
                const server = yield* ChildProcess.make(
                  `${directory}/target/${profile}/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
                  ["--port", "0"],
                );
                yield* Stream.runForEach(
                  Stream.splitLines(Stream.decodeText(server.stderr)),
                  (line) =>
                    Effect.sync(() => {
                      if (line.startsWith('{"schema":"reffect.log@1"'))
                        logs.push(JSON.parse(line).message);
                    }),
                ).pipe(Effect.forkScoped);
                const ready = yield* Stream.runHead(
                  Stream.splitLines(Stream.decodeText(server.stdout)),
                ).pipe(Effect.timeout("5 seconds"));
                if (!Option.isSome(ready)) throw new Error("Missing native ready record");
                const address = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
                  JSON.parse(ready.value),
                ).address;
                const url = `http://${address}/rpc`;
                yield* scenario(globalThis.fetch, url, logs);
                expect(logs).toEqual(oracleLogs);
                const outgoing = httpRequest(url, { method: "POST" });
                outgoing.on("error", () => {});
                outgoing.end(
                  JSON.stringify([
                    {
                      _tag: "Request",
                      id: "disconnect",
                      tag: "Size",
                      payload: { wait: true },
                      headers: [],
                    },
                    {
                      _tag: "Request",
                      id: "skip",
                      tag: "Size",
                      payload: { wait: false },
                      headers: [],
                    },
                  ]),
                );
                yield* waitUntil(() => logs.length === 7);
                outgoing.destroy();
                yield* waitUntil(() => logs.length === 9);
                expect(logs.slice(6)).toEqual(["opened", "closed", "cleaned"]);
                const response = yield* Effect.promise(() =>
                  fetch(url, {
                    method: "POST",
                    body: JSON.stringify({
                      _tag: "Request",
                      id: "after",
                      tag: "Size",
                      payload: { wait: false },
                      headers: [],
                    }),
                  }).then((r) => r.json()),
                );
                expect(response).toEqual([
                  { _tag: "Exit", requestId: "after", exit: { _tag: "Success", value: "5" } },
                ]);
                yield* waitUntil(() => logs.length === 12);
                expect(logs.slice(9)).toEqual(["opened", "closed", "cleaned"]);
              }),
            );
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}, 300000);
