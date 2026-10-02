import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
} from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  FailureFrames,
  NativeRunner,
  R,
  Reference,
  Rust,
  SourceArtifacts,
  type Computation,
  type Expr,
  type StaticContext,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const A = R.Context.service("test/resource-a@1", R.U64);
const B = R.Context.service("test/resource-b@1", R.U64);
const Size = R.Context.service("test/file-size@1", R.U64);

const release = (name: string) =>
  R.Effect.logInfo(`release ${name}`).pipe(R.Effect.andThen(R.Effect.sleep(1)));
const resource = (name: string, value: bigint) =>
  R.Effect.logInfo(`acquire ${name}`).pipe(
    R.Effect.andThen(R.Effect.addFinalizer(() => release(name))),
    R.Effect.andThen(R.Effect.succeed(R.U64.literal(value))),
  );
const layerA = R.Layer.effect(A, resource("A", 1n));
const layerB = R.Layer.effect(B, resource("B", 2n));
const sum = (a: Expr<bigint>, b: Expr<bigint>) =>
  R.Effect.logInfo("body").pipe(R.Effect.andThen(R.Effect.succeed(R.U64.add(a, b))));

const sequential = R.fn([], R.U64, R.Never, () =>
  R.Layer.provide(R.Layer.sequence(layerA, layerB), (ctx) => sum(ctx.get(A), ctx.get(B))),
);
const shared = R.fn([], R.U64, R.Never, () =>
  R.Layer.provide(R.Layer.sequence(layerA, R.Layer.sequence(layerA, layerB)), (ctx) =>
    sum(ctx.get(A), ctx.get(B)),
  ),
);
const fresh = R.fn([], R.U64, R.Never, () =>
  R.Layer.provide(R.Layer.sequence(R.Layer.fresh(layerA), R.Layer.fresh(layerA)), (ctx) =>
    sum(ctx.get(A), ctx.get(A)),
  ),
);
const nestedWith = (inner: (body: Computation<bigint>) => Computation<bigint>) =>
  R.fn([], R.U64, R.Never, () =>
    R.Layer.provide(layerA, (outer) =>
      R.Effect.logInfo("outer").pipe(
        R.Effect.andThen(inner(R.Effect.succeed(outer.get(A)))),
        R.Effect.flatMap((value) =>
          R.Effect.logInfo("after inner").pipe(R.Effect.andThen(R.Effect.succeed(value))),
        ),
      ),
    ),
  );
const innerBody = (ctx: StaticContext<typeof A>) =>
  R.Effect.logInfo("inner").pipe(R.Effect.andThen(R.Effect.succeed(ctx.get(A))));
const nested = nestedWith(() => R.Layer.provide(layerA, innerBody));
const nestedFresh = nestedWith(() => R.Layer.provide(R.Layer.fresh(layerA), innerBody));
const nestedLocal = nestedWith(() => R.Layer.provide(layerA, innerBody, { local: true }));
const failing = R.Layer.effect(
  B,
  R.Effect.logInfo("acquire F").pipe(
    R.Effect.andThen(R.Effect.addFinalizer(() => release("F"))),
    R.Effect.andThen(
      R.Match.bool(
        R.Bool.literal(false),
        R.Effect.succeed(R.U64.literal(2n)),
        R.Effect.fail(R.Bool.literal(false)),
      ),
    ),
  ),
);
// Constructed per call so `ok` is the function's own binder.
const acquisitionFailure = R.fn([R.Bool], R.U64, R.Bool, (ok) =>
  R.Layer.provide(
    R.Layer.sequence(
      layerA,
      R.Layer.effect(
        B,
        R.Effect.logInfo("acquire F").pipe(
          R.Effect.andThen(R.Effect.addFinalizer(() => release("F"))),
          R.Effect.andThen(
            R.Match.bool(
              ok,
              R.Effect.succeed(R.U64.literal(2n)),
              R.Effect.fail(R.Bool.literal(false)),
            ),
          ),
        ),
      ),
    ),
    (ctx) => sum(ctx.get(A), ctx.get(B)),
  ),
);
const bodyFailure = R.fn([], R.U64, R.Bool, () =>
  R.Layer.provide(layerA, () =>
    R.Effect.logInfo("body").pipe(R.Effect.andThen(R.Effect.fail(R.Bool.literal(true)))),
  ),
);
const cancel = R.fn([], R.Unit, R.Never, () =>
  R.Layer.provide(R.Layer.sequence(layerA, layerB), () =>
    R.Effect.logInfo("use").pipe(R.Effect.andThen(R.Effect.sleep(10000))),
  ),
);

const EA = Context.Service<bigint>("test/resource-a@1");
const EB = Context.Service<bigint>("test/resource-b@1");
const officialRelease = (name: string) =>
  Effect.logInfo(`release ${name}`).pipe(Effect.andThen(Effect.sleep(1)));
const officialResource = (name: string, value: bigint) =>
  Effect.logInfo(`acquire ${name}`).pipe(
    Effect.andThen(Effect.addFinalizer(() => officialRelease(name))),
    Effect.as(value),
  );
const OA = Layer.effect(EA, officialResource("A", 1n));
const OB = Layer.effect(EB, officialResource("B", 2n));
const officialSum = Effect.gen(function* () {
  yield* Effect.logInfo("body");
  return (yield* EA) + (yield* EB);
});
const officialNested = (inner: Layer.Layer<bigint, never, never>, local = false) =>
  Effect.gen(function* () {
    yield* Effect.logInfo("outer");
    const value = yield* Effect.gen(function* () {
      yield* Effect.logInfo("inner");
      return yield* EA;
    }).pipe(Effect.provide(inner, { local }));
    yield* Effect.logInfo("after inner");
    return value;
  }).pipe(Effect.provide(OA));
const officialFailing = (ok: boolean) =>
  Layer.effect(
    EB,
    Effect.logInfo("acquire F").pipe(
      Effect.andThen(Effect.addFinalizer(() => officialRelease("F"))),
      Effect.andThen(ok ? Effect.succeed(2n) : Effect.fail(false)),
    ),
  );

const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({
      error: Option.getOrUndefined(Cause.findErrorOption(cause)),
      interrupted: Cause.hasInterrupts(cause),
    }),
  });
const capture = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const logs: string[] = [];
    const exit = yield* Effect.exit(effect).pipe(
      Effect.provide(Logger.layer([Logger.make((event) => logs.push(String(event.message)))])),
    );
    return { exit: observe(exit), logs };
  });
const interruptAt = <A, E>(body: Effect.Effect<A, E>, at: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const logs: string[] = [];
      const fiber = yield* body.pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((event) => {
              const message = String(event.message);
              logs.push(message);
              if (message === at) Deferred.doneUnsafe(reached, Effect.void);
            }),
          ]),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(reached).pipe(Effect.timeout("3 seconds"));
      yield* Fiber.interrupt(fiber);
      return { exit: observe(yield* Fiber.await(fiber)), logs };
    }),
  );

const cases = [
  {
    name: "sequential",
    fn: sequential,
    args: [] as const,
    official: officialSum.pipe(Effect.provide(Layer.provideMerge(OB, OA))),
    expected: ["acquire A", "acquire B", "body", "release B", "release A"],
  },
  {
    name: "shared",
    fn: shared,
    args: [] as const,
    official: officialSum.pipe(Effect.provide(Layer.provideMerge(OB, Layer.provideMerge(OA, OA)))),
    expected: ["acquire A", "acquire B", "body", "release B", "release A"],
  },
  {
    name: "fresh",
    fn: fresh,
    args: [] as const,
    official: Effect.gen(function* () {
      yield* Effect.logInfo("body");
      return (yield* EA) * 2n;
    }).pipe(Effect.provide(Layer.provideMerge(Layer.fresh(OA), Layer.fresh(OA)))),
    expected: ["acquire A", "acquire A", "body", "release A", "release A"],
  },
  {
    name: "nested",
    fn: nested,
    args: [] as const,
    official: officialNested(OA),
    expected: ["acquire A", "outer", "inner", "after inner", "release A"],
  },
  {
    name: "nestedFresh",
    fn: nestedFresh,
    args: [] as const,
    official: officialNested(Layer.fresh(OA)),
    expected: ["acquire A", "outer", "acquire A", "inner", "release A", "after inner", "release A"],
  },
  {
    name: "nestedLocal",
    fn: nestedLocal,
    args: [] as const,
    official: officialNested(OA, true),
    expected: ["acquire A", "outer", "acquire A", "inner", "release A", "after inner", "release A"],
  },
] as const;

test("resource Layers match official provide/memo/release traces in the reference", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      for (const item of cases) {
        const oracle = yield* capture(item.official);
        expect(oracle.logs, item.name).toEqual(item.expected);
        expect(yield* capture(Reference.run(item.fn, [])), item.name).toEqual(oracle);
      }
      for (const ok of [true, false]) {
        const oracle = yield* capture(
          officialSum.pipe(Effect.provide(Layer.provideMerge(officialFailing(ok), OA))),
        );
        expect(oracle.logs).toEqual(
          ok
            ? ["acquire A", "acquire F", "body", "release F", "release A"]
            : ["acquire A", "acquire F", "release F", "release A"],
        );
        expect(yield* capture(Reference.run(acquisitionFailure, [ok]))).toEqual(oracle);
      }
      const bodyOracle = yield* capture(
        Effect.logInfo("body").pipe(Effect.andThen(Effect.fail(true)), Effect.provide(OA)),
      );
      expect(bodyOracle).toEqual({
        exit: { error: true, interrupted: false },
        logs: ["acquire A", "body", "release A"],
      });
      expect(yield* capture(Reference.run(bodyFailure, []))).toEqual(bodyOracle);
      const cancelOracle = yield* interruptAt(
        Effect.logInfo("use").pipe(
          Effect.andThen(Effect.sleep(10000)),
          Effect.provide(Layer.provideMerge(OB, OA)),
        ),
        "use",
      );
      expect(cancelOracle).toEqual({
        exit: { error: undefined, interrupted: true },
        logs: ["acquire A", "acquire B", "use", "release B", "release A"],
      });
      expect(yield* interruptAt(Reference.run(cancel, []), "use")).toEqual(cancelOracle);
    }),
  );
});

test("resource Layer staging tracks errors, refuses escapes and shares the scope budget", async () => {
  expect(failing.resource).toBe(true);
  expect(R.Layer.succeed(A, R.U64.literal(1n)).resource).toBe(false);
  expect(R.Layer.effect(A, R.Effect.succeed(R.U64.literal(1n))).resource).toBe(false);
  // A registration discharged inside the acquisition does not outlive it.
  expect(R.Layer.effect(A, resource("A", 1n).pipe(R.Effect.scoped)).resource).toBe(false);
  // Non-resource graphs keep the existing unwrapped expansion.
  const plain = R.Layer.provide(R.Layer.succeed(A, R.U64.literal(1n)), (ctx) =>
    R.Effect.succeed(ctx.get(A)),
  );
  expect(plain.node._tag).toBe("Succeed");
  expect(R.Layer.provide(layerA, (ctx) => R.Effect.succeed(ctx.get(A))).node._tag).toBe("Scope");
  expect(() => R.Layer.provide(failing, () => R.Effect.fail(R.U64.literal(1n)))).toThrow(
    "same witness",
  );

  // A computation staged inside one provide and used outside it would reuse a foreign binder.
  let escaped: Computation<bigint> | undefined;
  const outer = R.Layer.provide(layerA, () => {
    escaped = R.Layer.provide(layerA, (ctx) => R.Effect.succeed(ctx.get(A)));
    return R.Effect.void;
  });
  const escape = R.fn([], R.U64, R.Never, () => outer.pipe(R.Effect.andThen(escaped!)));
  expect(await Effect.runPromise(Compile.check(R.program({ escape })).pipe(Effect.isFailure))).toBe(
    true,
  );

  const pending = R.Effect.addFinalizer(() => R.Effect.void);
  const registrations = (count: number) =>
    R.Effect.repeat(pending, { schedule: R.Schedule.recurs(count - 1) });
  const sixteen = R.Layer.effect(
    A,
    registrations(16).pipe(R.Effect.andThen(R.Effect.succeed(R.U64.literal(1n)))),
  );
  const fits = R.fn([], R.U64, R.Never, () =>
    R.Layer.provide(sixteen, (ctx) => R.Effect.succeed(ctx.get(A))),
  );
  const exceeds = R.fn([], R.U64, R.Never, () =>
    R.Layer.provide(sixteen, (ctx) => pending.pipe(R.Effect.andThen(R.Effect.succeed(ctx.get(A))))),
  );
  expect(await Effect.runPromise(Compile.check(R.program({ fits })).pipe(Effect.isSuccess))).toBe(
    true,
  );
  expect(
    await Effect.runPromise(Compile.check(R.program({ exceeds })).pipe(Effect.isFailure)),
  ).toBe(true);

  const typeContracts = () => {
    // @ts-expect-error The acquisition error remains in provide's error channel.
    const erased: Computation<bigint, never> = R.Layer.provide(failing, (ctx) =>
      R.Effect.succeed(ctx.get(B)),
    );
    void erased;
    const tracked: Computation<bigint, boolean> = R.Layer.provide(
      R.Layer.sequence(layerA, failing),
      (ctx) => R.Effect.succeed(ctx.get(A)),
    );
    void tracked;
  };
  void typeContracts;
});

test(
  "native resource Layers agree with the reference across policies and profiles",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-resource-layer-" });
          const path = `${parent}/input-é`;
          yield* fs.writeFileString(path, "hello");
          const fileLayer = R.Layer.effect(
            Size,
            R.File.acquireReadOnly(
              path,
              (file) => file.size,
              R.Effect.logInfo("file closed").pipe(R.Effect.andThen(R.Effect.sleep(1))),
            ),
          );
          const file = R.fn([], R.U64, R.Bool, () =>
            R.Layer.provide(fileLayer, (ctx) =>
              R.Effect.logInfo("body", [["size", ctx.get(Size)]]).pipe(
                R.Effect.andThen(R.Effect.succeed(ctx.get(Size))),
              ),
            ),
          );
          const fileReference = yield* capture(Reference.run(file, []));
          expect(fileReference).toEqual({ exit: { value: 5n }, logs: ["body", "file closed"] });

          const functions = {
            ...Object.fromEntries(cases.map((item) => [item.name, item.fn])),
            acquisitionFailure,
            bodyFailure,
            cancel,
            file,
          };
          const program = R.program(functions);
          for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
            const artifact = yield* Compile.make(program).pipe(
              Compile.withTarget(Rust.tokio),
              Compile.withFailureFrames(policy),
              Compile.withSourceArtifacts(SourceArtifacts.None),
              Compile.run,
            );
            expect(artifact.explanation.crates).toEqual(["tokio@1.53.1"]);
            for (const token of ["HashMap", "dyn Future", "test/resource-a@1"])
              expect(artifact.files["src/lib.rs"]).not.toContain(token);
            const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
            for (const profile of ["debug", "release"] as const) {
              yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
              yield* CargoApi.build(directory, profile);
              for (const item of cases) {
                const raw = yield* CargoApi.run(directory, item.name, [], profile);
                expect(raw.exitCode, item.name).toBe(0);
                expect(messages(raw.stderr), item.name).toEqual(item.expected);
                const exit = yield* NativeRunner.run(
                  artifact,
                  directory,
                  item.name,
                  item.fn,
                  [],
                  profile,
                );
                expect(observe(exit), item.name).toEqual(
                  (yield* capture(Reference.run(item.fn, []))).exit,
                );
              }
              const fileRaw = yield* CargoApi.run(directory, "file", [], profile);
              expect(fileRaw.exitCode).toBe(0);
              expect(messages(fileRaw.stderr)).toEqual(fileReference.logs);
              expect(fileRaw.stdout.trim()).toBe("ok:u64:5");
              // Failure and cancellation run in-process to avoid nonzero process exits.
              yield* fs.writeFileString(`${directory}/src/main.rs`, probe);
              yield* CargoApi.build(directory, profile);
              const result = yield* CargoApi.run(directory, "probe", [], profile);
              expect(result.exitCode).toBe(0);
              expect(sections(result.stderr)).toEqual({
                "failure-ok": ["acquire A", "acquire F", "body", "release F", "release A"],
                "failure-err": ["acquire A", "acquire F", "release F", "release A"],
                body: ["acquire A", "body", "release A"],
                cancel: ["acquire A", "acquire B", "use", "release B", "release A"],
              });
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);

const messages = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => JSON.parse(line).message as string);
const sections = (stderr: string) => {
  const result: Record<string, string[]> = {};
  let current: string[] | undefined;
  for (const line of stderr.split("\n")) {
    if (line.startsWith("case:")) result[line.slice(5).trim()] = current = [];
    else if (line.startsWith('{"schema":"reffect.log@1"')) current?.push(JSON.parse(line).message);
  }
  return result;
};
const probe = `
use std::future::Future;
fn main() { tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(run()); }
fn context() -> (tokio::sync::watch::Sender<bool>, reffect_generated::AsyncContext) {
    let (sender, receiver) = tokio::sync::watch::channel(false);
    (sender, reffect_generated::AsyncContext::new(receiver))
}
async fn run() {
    let (_s, mut ctx) = context();
    eprintln!("case:failure-ok");
    assert_eq!(reffect_generated::r_acquisitionFailure(&mut ctx, true).await.unwrap(), 3);
    eprintln!("case:failure-err");
    assert!(matches!(reffect_generated::r_acquisitionFailure(&mut ctx, false).await, Err(reffect_generated::AsyncError::Fail(false))));
    eprintln!("case:body");
    assert!(matches!(reffect_generated::r_bodyFailure(&mut ctx).await, Err(reffect_generated::AsyncError::Fail(true))));
    eprintln!("case:cancel");
    let (sender, mut ctx) = context();
    let future = reffect_generated::r_cancel(&mut ctx);
    tokio::pin!(future);
    std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); sender.send(true).unwrap(); std::task::Poll::Ready(()) }).await;
    assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
}
`;
