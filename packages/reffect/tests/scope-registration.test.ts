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
} from "effect";
import { NodeServices } from "@effect/platform-node";
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References";
import { open } from "node:fs/promises";
import { fstatSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  FailureFramePolicy,
  FailureFrames,
  FileLease,
  NativeRunner,
  R,
  Reference,
  ReferenceFiles,
  Rust,
} from "../src/index.ts";

const cleanup = (name: string) =>
  R.Effect.logInfo(`${name}:start`).pipe(
    R.Effect.andThen(R.Effect.sleep(5)),
    R.Effect.andThen(R.Effect.logInfo(`${name}:done`)),
  );
const officialCleanup = (name: string) =>
  Effect.logInfo(`${name}:start`).pipe(
    Effect.andThen(Effect.sleep(5)),
    Effect.andThen(Effect.logInfo(`${name}:done`)),
  );
const observe = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.match(exit, {
    onSuccess: (value) => ({ value }),
    onFailure: (cause) => ({
      error: Option.getOrUndefined(Cause.findErrorOption(cause)),
      interrupted: Cause.hasInterrupts(cause),
    }),
  });
const capture = async <A, E>(effect: Effect.Effect<A, E>) => {
  const records: { message: string; annotations: unknown; spans: string[] }[] = [];
  const exit = await Effect.runPromise(
    Effect.exit(effect).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make((event) =>
            records.push({
              message: String(event.message),
              annotations: Object.fromEntries(
                Object.entries(event.fiber.getRef(CurrentLogAnnotations)).map(([key, value]) => [
                  key,
                  typeof value === "bigint" ? String(value) : value,
                ]),
              ),
              spans: event.fiber.getRef(CurrentLogSpans).map(([label]) => label),
            }),
          ),
        ]),
      ),
    ),
  );
  return { exit: observe(exit), records };
};
const nativeRecords = (stderr: string) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith('{"schema":"reffect.log@1"'))
    .map((line) => {
      const event = JSON.parse(line);
      return {
        message: event.message,
        annotations: event.annotations,
        spans: event.spans.map((span: { label: string }) => span.label),
      };
    });

const token = R.U64.literal(9007199254740993n);
const conditional = R.fn([R.Bool], R.Unit, R.Never, (enabled) =>
  R.Effect.acquireRelease(R.Effect.succeed(token), (resource) =>
    R.Effect.logInfo("token", [["token", resource]]),
  ).pipe(
    R.Effect.asVoid,
    R.Effect.andThen(
      R.Match.bool(
        enabled,
        R.Effect.addFinalizer(() => cleanup("conditional")),
        R.Effect.void,
      ),
    ),
    R.Effect.andThen(
      R.Effect.addFinalizer(() => R.Effect.logInfo("snapshot")).pipe(
        R.Effect.annotateLogs("owner", R.U64.literal(2n)),
        R.Effect.withLogSpan("registration"),
      ),
    ),
    R.Effect.andThen(R.Effect.logInfo("body")),
    R.Effect.scoped,
    R.Effect.annotateLogs("owner", R.U64.literal(1n)),
    R.Effect.withLogSpan("session"),
  ),
);
const officialConditional = (enabled: boolean) =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.succeed(9007199254740993n), (resource) =>
      Effect.logInfo("token").pipe(Effect.annotateLogs("token", String(resource))),
    );
    if (enabled) yield* Effect.addFinalizer(() => officialCleanup("conditional"));
    yield* Effect.addFinalizer(() => Effect.logInfo("snapshot")).pipe(
      Effect.annotateLogs("owner", "2"),
      Effect.withLogSpan("registration"),
    );
    yield* Effect.logInfo("body");
  }).pipe(Effect.scoped, Effect.annotateLogs("owner", "1"), Effect.withLogSpan("session"));
const repeated = R.fn([], R.Unit, R.Never, () =>
  R.Effect.repeat(
    R.Effect.addFinalizer(() => cleanup("repeat")),
    { schedule: R.Schedule.recurs(2) },
  ).pipe(R.Effect.andThen(R.Effect.logInfo("body")), R.Effect.scoped),
);
const officialRepeated = Effect.repeat(
  Effect.addFinalizer(() => officialCleanup("repeat")),
  {
    schedule: Schedule.recurs(2),
  },
).pipe(Effect.andThen(Effect.logInfo("body")), Effect.scoped);
const recovered = R.fn([], R.U64, R.Never, () =>
  R.Effect.addFinalizer(() => cleanup("failed")).pipe(
    R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))),
    R.Effect.scoped,
    R.Effect.catchAll(() =>
      R.Effect.logInfo("recovered").pipe(R.Effect.andThen(R.Effect.succeed(R.U64.literal(9n)))),
    ),
  ),
);
const officialRecovered = Effect.addFinalizer(() => officialCleanup("failed")).pipe(
  Effect.andThen(Effect.fail(false)),
  Effect.scoped,
  Effect.catch(() => Effect.logInfo("recovered").pipe(Effect.as(9n))),
);
const retry = R.fn([], R.Unit, R.Bool, () =>
  R.Effect.retry(
    R.Effect.addFinalizer(() => cleanup("attempt")).pipe(
      R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))),
      R.Effect.asVoid,
    ),
    { schedule: R.Schedule.recurs(2) },
  ).pipe(R.Effect.scoped),
);
const officialRetry = Effect.retry(
  Effect.addFinalizer(() => officialCleanup("attempt")).pipe(
    Effect.andThen(Effect.fail(false)),
    Effect.asVoid,
  ),
  { schedule: Schedule.recurs(2) },
).pipe(Effect.scoped);
const cancel = R.fn([], R.Unit, R.Never, () =>
  R.Effect.addFinalizer(() => cleanup("outer")).pipe(
    R.Effect.andThen(R.Effect.addFinalizer(() => cleanup("inner"))),
    R.Effect.andThen(R.Effect.logInfo("use")),
    R.Effect.andThen(R.Effect.sleep(10000)),
    R.Effect.scoped,
  ),
);
const full = R.fn([], R.Unit, R.Never, () =>
  R.Effect.repeat(
    R.Effect.addFinalizer(() => R.Effect.logInfo("capacity")),
    R.Schedule.recurs(15),
  ).pipe(R.Effect.scoped),
);
const captures = R.fn([R.U64], R.Unit, R.Never, (input) =>
  R.Effect.acquireRelease(R.Effect.succeed(input), (value) =>
    R.Effect.logInfo("capture", [["value", value]]),
  ).pipe(
    R.Effect.andThen(
      R.Effect.acquireRelease(R.Effect.succeed(R.U64.add(input, R.U64.literal(1n))), (value) =>
        R.Effect.logInfo("capture", [["value", value]]),
      ),
    ),
    R.Effect.asVoid,
    R.Effect.scoped,
  ),
);
const officialCaptures = (input: bigint) =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(Effect.succeed(input), (value) =>
      Effect.logInfo("capture").pipe(Effect.annotateLogs("value", String(value))),
    );
    yield* Effect.acquireRelease(Effect.succeed(input + 1n), (value) =>
      Effect.logInfo("capture").pipe(Effect.annotateLogs("value", String(value))),
    );
  }).pipe(Effect.scoped);
const quiet = R.fn([], R.Unit, R.Never, () =>
  R.Effect.addFinalizer(() => R.Effect.void).pipe(
    R.Effect.andThen(R.Effect.addFinalizer(() => R.Effect.void)),
    R.Effect.scoped,
  ),
);
const settled = R.fn([R.Bool], R.Unit, R.Bool, (success) =>
  R.Effect.addFinalizer(() => cleanup("settled")).pipe(
    R.Effect.andThen(R.Match.bool(success, R.Effect.void, R.Effect.fail(R.Bool.literal(false)))),
    R.Effect.scoped,
  ),
);
const maskedEnsuring = R.fn([], R.Unit, R.Never, () =>
  R.Effect.acquireRelease(
    R.Effect.logInfo("acquiring").pipe(
      R.Effect.andThen(R.Effect.sleep(5)),
      R.Effect.andThen(R.Effect.succeed(token)),
    ),
    () => R.Effect.logInfo("release"),
  ).pipe(
    R.Effect.flatMap(() =>
      R.Effect.void.pipe(R.Effect.ensuring(R.Effect.logInfo("inner-cleanup"))),
    ),
    R.Effect.scoped,
  ),
);
const frameAcquisition = R.Effect.acquireRelease(
  R.Effect.logInfo("frame-acquiring").pipe(
    R.Effect.andThen(R.Effect.sleep(5)),
    R.Effect.andThen(R.Effect.succeed(token)),
  ),
  () => R.Effect.logInfo("frame-release"),
);
const frameAdd = R.fn([], R.Unit, R.Never, () =>
  frameAcquisition.pipe(
    R.Effect.andThen(R.Effect.addFinalizer(() => R.Effect.logInfo("must-not-frame-release"))),
    R.Effect.scoped,
  ),
);
const frameAcquire = R.fn([], R.U64, R.Never, () =>
  frameAcquisition.pipe(
    R.Effect.andThen(
      R.Effect.acquireRelease(R.Effect.succeed(token), () =>
        R.Effect.logInfo("must-not-frame-release"),
      ),
    ),
    R.Effect.scoped,
  ),
);
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

test("cancellation waits for the registered prefix and preserves a settled typed failure", async () => {
  const skippedContinuation = Effect.acquireRelease(
    Effect.logInfo("acquiring").pipe(Effect.andThen(Effect.sleep(5)), Effect.as(9007199254740993n)),
    () => Effect.logInfo("release"),
  ).pipe(
    Effect.flatMap(() => Effect.void.pipe(Effect.ensuring(Effect.logInfo("inner-cleanup")))),
    Effect.scoped,
  );
  const skippedOracle = await Effect.runPromise(interruptAt(skippedContinuation, "acquiring"));
  expect(skippedOracle).toEqual({
    exit: { error: undefined, interrupted: true },
    logs: ["acquiring", "release"],
  });
  expect(
    await Effect.runPromise(interruptAt(Reference.run(maskedEnsuring, []), "acquiring")),
  ).toEqual(skippedOracle);
  const official = Effect.addFinalizer(() => officialCleanup("outer")).pipe(
    Effect.andThen(Effect.addFinalizer(() => officialCleanup("inner"))),
    Effect.andThen(Effect.logInfo("use")),
    Effect.andThen(Effect.sleep(10000)),
    Effect.scoped,
  );
  const oracle = await Effect.runPromise(interruptAt(official, "use"));
  expect(oracle).toEqual({
    exit: { error: undefined, interrupted: true },
    logs: ["use", "inner:start", "inner:done", "outer:start", "outer:done"],
  });
  expect(await Effect.runPromise(interruptAt(Reference.run(cancel, []), "use"))).toEqual(oracle);
  for (const success of [true, false]) {
    const official = Effect.addFinalizer(() => officialCleanup("settled")).pipe(
      Effect.andThen(success ? Effect.void : Effect.fail(false)),
      Effect.scoped,
    );
    const oracle = await Effect.runPromise(interruptAt(official, "settled:start"));
    expect(oracle).toEqual({
      exit: { error: success ? undefined : false, interrupted: success },
      logs: ["settled:start", "settled:done"],
    });
    expect(
      await Effect.runPromise(interruptAt(Reference.run(settled, [success]), "settled:start")),
    ).toEqual(oracle);
  }
});

test("Scope requirements and execution capacity refuse before filesystem IO", async () => {
  const pending = R.Effect.addFinalizer(() => R.Effect.void);
  const capacity = (runs: number) =>
    R.Effect.repeat(pending, { schedule: R.Schedule.recurs(runs - 1) });
  let sharedSequence = pending;
  for (let i = 1; i < 17; i++) sharedSequence = R.Effect.andThen(sharedSequence, pending);
  const sharedSeventeen = R.fn([], R.Unit, R.Never, () => sharedSequence.pipe(R.Effect.scoped));
  const recoveredSeventeen = R.fn([], R.Unit, R.Never, () =>
    capacity(8).pipe(
      R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))),
      R.Effect.catchAll(() => capacity(9)),
      R.Effect.scoped,
    ),
  );
  const registeredSeventeen = R.fn([], R.Unit, R.Bool, () =>
    R.File.acquireReadOnly("must-not-open", () => capacity(16)).pipe(R.Effect.scoped),
  );
  const acquisitionSeventeen = R.fn([], R.Unit, R.Never, () =>
    R.Effect.acquireRelease(capacity(16), () => R.Effect.void).pipe(R.Effect.scoped),
  );
  const programs = [
    sharedSeventeen,
    recoveredSeventeen,
    registeredSeventeen,
    acquisitionSeventeen,
    R.fn([], R.Unit, R.Never, () => pending),
    R.fn([], R.U64, R.Never, () =>
      R.Effect.acquireRelease(R.Effect.succeed(token), () => R.Effect.void),
    ),
    R.fn([], R.Unit, R.Bool, () => R.File.acquireReadOnly("must-not-open", () => R.Effect.void)),
    R.fn([], R.Unit, R.Never, () => capacity(17).pipe(R.Effect.scoped)),
    R.fn([], R.Unit, R.Never, () =>
      R.Effect.repeat(pending, R.Schedule.forever).pipe(R.Effect.scoped),
    ),
    R.fn([], R.Unit, R.Bool, () =>
      R.Effect.retry(
        pending.pipe(R.Effect.andThen(R.Effect.fail(R.Bool.literal(false))), R.Effect.asVoid),
        R.Schedule.recurs(16),
      ).pipe(R.Effect.scoped),
    ),
    R.fn([], R.Unit, R.Never, () => R.Effect.addFinalizer(() => pending).pipe(R.Effect.scoped)),
  ];
  for (const fn of programs)
    expect(await Effect.runPromise(Compile.check(R.program({ fn })).pipe(Effect.isFailure))).toBe(
      true,
    );
  for (const runs of [1, 15, 16]) {
    const fn = R.fn([], R.Unit, R.Never, () => capacity(runs).pipe(R.Effect.scoped));
    expect(await Effect.runPromise(Compile.check(R.program({ fn })).pipe(Effect.isSuccess))).toBe(
      true,
    );
  }
  const branch = R.fn([R.Bool], R.Unit, R.Never, (choose) =>
    R.Match.bool(choose, capacity(16), capacity(16)).pipe(R.Effect.scoped),
  );
  expect(await Effect.runPromise(Compile.check(R.program({ branch })).pipe(Effect.isSuccess))).toBe(
    true,
  );
  const nested = R.fn([], R.Unit, R.Never, () =>
    capacity(16).pipe(R.Effect.andThen(capacity(16).pipe(R.Effect.scoped)), R.Effect.scoped),
  );
  expect(await Effect.runPromise(Compile.check(R.program({ nested })).pipe(Effect.isSuccess))).toBe(
    true,
  );
  const freshPerIteration = R.fn([], R.Unit, R.Never, () =>
    R.Effect.repeat(capacity(16).pipe(R.Effect.scoped), R.Schedule.forever),
  );
  expect(
    await Effect.runPromise(Compile.check(R.program({ freshPerIteration })).pipe(Effect.isSuccess)),
  ).toBe(true);
  const lexicalFile = R.fn([], R.Unit, R.Bool, () =>
    R.File.scoped("must-not-open", () => capacity(16)).pipe(R.Effect.scoped),
  );
  expect(
    await Effect.runPromise(Compile.check(R.program({ lexicalFile })).pipe(Effect.isSuccess)),
  ).toBe(true);
  let opens = 0;
  const files = Layer.succeed(
    ReferenceFiles,
    ReferenceFiles.of({
      open: () =>
        Effect.sync(() => {
          opens++;
          return new FileLease(Effect.succeed(5n), Effect.void);
        }),
    }),
  );
  const overflow = R.fn([], R.Unit, R.Bool, () =>
    R.Effect.repeat(
      R.File.acquireReadOnly("must-not-open", () => R.Effect.void),
      R.Schedule.recurs(16),
    ).pipe(R.Effect.scoped),
  );
  expect(
    await Effect.runPromise(
      Reference.run(overflow, []).pipe(Effect.provide(files), Effect.isFailure),
    ),
  ).toBe(true);
  expect(opens).toBe(0);
  const beforeOpen = R.fn([], R.Unit, R.Bool, () =>
    R.Effect.fail(R.Bool.literal(false)).pipe(
      R.Effect.andThen(R.File.acquireReadOnly("must-not-open", () => R.Effect.void)),
      R.Effect.scoped,
    ),
  );
  expect(
    observe(
      await Effect.runPromise(
        Effect.exit(Reference.run(beforeOpen, []).pipe(Effect.provide(files))),
      ),
    ),
  ).toEqual({ error: false, interrupted: false });
  expect(opens).toBe(0);
  const delayedBorrow = R.fn([], R.Unit, R.Bool, () =>
    R.File.acquireReadOnly("must-not-open", (file) =>
      R.Effect.addFinalizer(() =>
        file.size.pipe(
          R.Effect.catchAll(() => R.Effect.succeed(R.U64.literal(0n))),
          R.Effect.asVoid,
        ),
      ),
    ).pipe(R.Effect.scoped),
  );
  expect(
    await Effect.runPromise(Compile.check(R.program({ delayedBorrow })).pipe(Effect.isFailure)),
  ).toBe(true);
});

test("unused wide function arguments are not retained by no-op finalizer variants", async () => {
  const wide = R.fn([R.U64, R.U64, R.U64, R.U64, R.U64, R.U64, R.U64, R.U64], R.Unit, R.Never, () =>
    R.Effect.addFinalizer(() => R.Effect.void).pipe(R.Effect.scoped),
  );
  for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
    const artifact = await Effect.runPromise(
      Compile.make(R.program({ wide })).pipe(
        Compile.withTarget(Rust.tokio),
        Compile.withFailureFrames(policy),
        Compile.run,
      ),
    );
    const variants = artifact.files["src/lib.rs"].match(/\benum ScopeFinalizer\s*\{([^}]+)\}/)?.[1];
    expect(variants).toBeDefined();
    expect(variants).not.toMatch(/\bu64\b/);
  }
});

test("registered real files outlive their use callback and masked acquisition cancellation closes once", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({
          prefix: "reffect-registration-oracle-",
        });
        const path = `${parent}/input-é`;
        yield* fs.writeFileString(path, "hello");
        for (const engine of ["official", "reference"] as const)
          for (const phase of ["normal", "failure", "acquire"] as const) {
            const opened = yield* Deferred.make<void>();
            const gate = yield* Deferred.make<void>();
            const events: string[] = [];
            let fd = -1;
            let closeAttempts = 0;
            const files = Layer.succeed(
              ReferenceFiles,
              ReferenceFiles.of({
                open: Effect.fn("registration.open")(function* (name: string) {
                  const file = yield* Effect.tryPromise({
                    try: () => open(name, "r"),
                    catch: () => false,
                  });
                  fd = file.fd;
                  events.push("opened");
                  yield* Deferred.succeed(opened, undefined);
                  if (phase === "acquire") yield* Deferred.await(gate);
                  return new FileLease(
                    Effect.tryPromise({
                      try: async () => (await file.stat({ bigint: true })).size,
                      catch: () => false,
                    }),
                    Effect.sync(() => {
                      closeAttempts++;
                    }).pipe(
                      Effect.andThen(Effect.promise(() => file.close())),
                      Effect.tap(() =>
                        Effect.sync(() => {
                          expect(() => fstatSync(fd)).toThrow();
                          events.push("closed");
                        }),
                      ),
                    ),
                  );
                }),
              }),
            );
            const fn = R.fn([], R.U64, R.Bool, () =>
              R.File.acquireReadOnly(
                path,
                (file) =>
                  (phase === "acquire"
                    ? file.size.pipe(R.Effect.ensuring(R.Effect.logInfo("file-inner-cleanup")))
                    : file.size
                  ).pipe(
                    R.Effect.flatMap((size) =>
                      phase === "failure"
                        ? R.Effect.fail(R.Bool.literal(false))
                        : R.Effect.succeed(size),
                    ),
                  ),
                cleanup("file"),
              ).pipe(
                R.Effect.flatMap((size) =>
                  R.Effect.logInfo("after-registration").pipe(
                    R.Effect.andThen(R.Effect.succeed(size)),
                  ),
                ),
                R.Effect.scoped,
              ),
            );
            const logger = Logger.layer([
              Logger.make((event) => {
                const message = String(event.message);
                if (message === "after-registration") expect(fstatSync(fd).size).toBe(5);
                if (message === "file:start") expect(() => fstatSync(fd)).toThrow();
                events.push(message);
              }),
            ]);
            const official = Effect.acquireRelease(
              Effect.flatMap(ReferenceFiles, (files) => files.open(path)),
              (lease) => lease.close.pipe(Effect.andThen(officialCleanup("file"))),
            ).pipe(
              Effect.flatMap((lease) =>
                phase === "acquire"
                  ? lease.size.pipe(Effect.ensuring(Effect.logInfo("file-inner-cleanup")))
                  : lease.size,
              ),
              Effect.flatMap((size) =>
                phase === "failure" ? Effect.fail(false) : Effect.succeed(size),
              ),
              Effect.flatMap((size) => Effect.logInfo("after-registration").pipe(Effect.as(size))),
              Effect.scoped,
            );
            const fiber = yield* (engine === "official" ? official : Reference.run(fn, [])).pipe(
              Effect.provide([files, logger]),
              Effect.forkScoped,
            );
            if (phase === "acquire") {
              yield* Deferred.await(opened);
              const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
              yield* Effect.yieldNow;
              expect(events).toEqual(["opened"]);
              expect(fstatSync(fd).size).toBe(5);
              yield* Deferred.succeed(gate, undefined);
              yield* Fiber.join(interruption);
              expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
            } else
              expect(observe(yield* Fiber.await(fiber))).toEqual(
                phase === "failure" ? { error: false, interrupted: false } : { value: 5n },
              );
            expect(events).toEqual([
              "opened",
              ...(phase === "normal" ? ["after-registration"] : []),
              "closed",
              "file:start",
              "file:done",
            ]);
            expect(closeAttempts).toBe(1);
          }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

test("official, reference and native registration traces agree across policies and profiles", async () => {
  const cases = [
    {
      name: "conditional",
      fn: conditional,
      args: [true] as const,
      official: officialConditional(true),
    },
    {
      name: "conditional",
      fn: conditional,
      args: [false] as const,
      official: officialConditional(false),
    },
  ];
  const conditionals: Awaited<ReturnType<typeof capture<void, never>>>[] = [];
  for (const item of cases) {
    const oracle = await capture(item.official);
    expect(await capture(Reference.run(item.fn, item.args))).toEqual(oracle);
    conditionals.push(oracle);
  }
  const repeats = await capture(officialRepeated);
  expect(repeats.records.map((record) => record.message)).toEqual([
    "body",
    "repeat:start",
    "repeat:done",
    "repeat:start",
    "repeat:done",
    "repeat:start",
    "repeat:done",
  ]);
  expect(await capture(Reference.run(repeated, []))).toEqual(repeats);
  const recovery = await capture(officialRecovered);
  expect(await capture(Reference.run(recovered, []))).toEqual(recovery);
  const retries = await capture(officialRetry);
  expect(await capture(Reference.run(retry, []))).toEqual(retries);
  const capacity = await capture(
    Effect.repeat(
      Effect.addFinalizer(() => Effect.logInfo("capacity")),
      Schedule.recurs(15),
    ).pipe(Effect.asVoid, Effect.scoped),
  );
  expect(capacity.records).toHaveLength(16);
  expect(await capture(Reference.run(full, []))).toEqual(capacity);
  const captured = await capture(officialCaptures(9007199254740993n));
  expect(captured.records.map((record) => record.annotations)).toEqual([
    { value: "9007199254740994" },
    { value: "9007199254740993" },
  ]);
  expect(await capture(Reference.run(captures, [9007199254740993n]))).toEqual(captured);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const parent = yield* fs.makeTempDirectoryScoped({
          prefix: "reffect-registration-native-",
        });
        const path = `${parent}/input`;
        yield* fs.writeFileString(path, "hello");
        const file = R.fn([], R.U64, R.Bool, () =>
          R.File.acquireReadOnly(path, (handle) => handle.size, cleanup("file")).pipe(
            R.Effect.flatMap((size) =>
              R.Effect.logInfo("after-registration").pipe(
                R.Effect.andThen(R.Effect.sleep(5)),
                R.Effect.andThen(R.Effect.succeed(size)),
              ),
            ),
            R.Effect.scoped,
          ),
        );
        const fileHold = R.fn([], R.Unit, R.Bool, () =>
          R.Effect.addFinalizer(() => cleanup("gate-prior")).pipe(
            R.Effect.andThen(
              R.File.acquireReadOnly(
                path,
                () => R.Effect.void.pipe(R.Effect.ensuring(R.Effect.logInfo("file-inner-cleanup"))),
                cleanup("file"),
              ),
            ),
            R.Effect.andThen(R.Effect.logInfo("file-use")),
            R.Effect.andThen(R.Effect.sleep(10000)),
            R.Effect.scoped,
          ),
        );
        const frameFile = R.fn([], R.Unit, R.Bool, () =>
          frameAcquisition.pipe(
            R.Effect.andThen(
              R.File.acquireReadOnly(
                path,
                () => R.Effect.void,
                R.Effect.logInfo("must-not-frame-release"),
              ),
            ),
            R.Effect.scoped,
          ),
        );
        const fileRepeated = R.fn([], R.Unit, R.Bool, () =>
          R.Effect.repeat(
            R.File.acquireReadOnly(path, () => R.Effect.void, cleanup("repeated-file")),
            R.Schedule.recurs(2),
          ).pipe(
            R.Effect.andThen(R.Effect.logInfo("files-registered")),
            R.Effect.andThen(R.Effect.sleep(5)),
            R.Effect.scoped,
          ),
        );
        const repeatedFilesOracle = yield* Effect.promise(() =>
          capture(
            Effect.repeat(
              Effect.acquireRelease(
                Effect.tryPromise({ try: () => open(path, "r"), catch: () => false }),
                (lease) =>
                  Effect.promise(() => lease.close()).pipe(
                    Effect.andThen(officialCleanup("repeated-file")),
                  ),
              ).pipe(Effect.asVoid),
              Schedule.recurs(2),
            ).pipe(
              Effect.andThen(Effect.logInfo("files-registered")),
              Effect.andThen(Effect.sleep(5)),
              Effect.scoped,
            ),
          ),
        );
        expect(yield* Effect.promise(() => capture(Reference.run(fileRepeated, [])))).toEqual(
          repeatedFilesOracle,
        );
        const missing = R.fn([], R.Unit, R.Bool, () =>
          R.Effect.addFinalizer(() => cleanup("prior")).pipe(
            R.Effect.andThen(
              R.File.acquireReadOnly(
                `${parent}/missing`,
                () => R.Effect.logInfo("must-not-use"),
                R.Effect.logInfo("must-not-close"),
              ),
            ),
            R.Effect.andThen(R.Effect.addFinalizer(() => R.Effect.logInfo("must-not-register"))),
            R.Effect.scoped,
          ),
        );
        const missingOracle = yield* Effect.promise(() =>
          capture(
            Effect.addFinalizer(() => officialCleanup("prior")).pipe(
              Effect.andThen(
                Effect.acquireRelease(
                  Effect.tryPromise({
                    try: () => open(`${parent}/missing`, "r"),
                    catch: () => false,
                  }),
                  (lease) =>
                    Effect.promise(() => lease.close()).pipe(
                      Effect.andThen(Effect.logInfo("must-not-close")),
                    ),
                ).pipe(Effect.andThen(Effect.logInfo("must-not-use"))),
              ),
              Effect.andThen(Effect.addFinalizer(() => Effect.logInfo("must-not-register"))),
              Effect.scoped,
            ),
          ),
        );
        expect(yield* Effect.promise(() => capture(Reference.run(missing, [])))).toEqual(
          missingOracle,
        );
        const program = R.program({
          conditional,
          repeated,
          recovered,
          retry,
          full,
          captures,
          missing,
          cancel,
          settled,
          quiet,
          file,
          fileHold,
          fileRepeated,
          maskedEnsuring,
          frameAdd,
          frameAcquire,
          frameFile,
        });
        for (const policy of [FailureFrames.Bounded, FailureFrames.None]) {
          const artifact = yield* Compile.make(program).pipe(
            Compile.withTarget(Rust.tokio),
            Compile.withFailureFrames(policy),
            Compile.run,
          );
          const directory = yield* CargoApi.write(artifact, `${parent}/${policy._tag}`);
          yield* CargoApi.fetch(directory);
          for (const profile of ["debug", "release"] as const) {
            yield* fs.writeFileString(
              `${directory}/src/lib.rs`,
              instrumentFileEvidence(artifact.files["src/lib.rs"]),
            );
            yield* fs.writeFileString(`${directory}/src/main.rs`, cancellationFrameProbe(policy));
            yield* CargoApi.build(directory, profile);
            const result = yield* CargoApi.run(directory, "probe", [], profile);
            const expected = [
              ...conditionals.flatMap((item) => item.records),
              ...repeats.records,
              ...recovery.records,
              ...retries.records,
              ...capacity.records,
              ...captured.records,
              ...missingOracle.records,
            ];
            const records = nativeRecords(result.stderr);
            expect(records.slice(0, expected.length)).toEqual(expected);
            expect(records.slice(expected.length).map((record) => record.message)).toEqual([
              "use",
              "inner:start",
              "inner:done",
              "outer:start",
              "outer:done",
              "settled:start",
              "settled:done",
              "settled:start",
              "settled:done",
              "acquiring",
              "release",
              "frame-acquiring",
              "frame-release",
              "frame-acquiring",
              "frame-release",
              "frame-acquiring",
              "frame-release",
              "after-registration",
              "file:start",
              "file:done",
              ...repeatedFilesOracle.records.map((record) => record.message),
              "file:start",
              "file:done",
              "gate-prior:start",
              "gate-prior:done",
              "file:start",
              "file:done",
              "gate-prior:start",
              "gate-prior:done",
            ]);
            expect(result.stdout).toContain("registration conformance");
            expect(result.stdout).toContain("identity conformance: callback-return=1,closed=1");
            expect(result.stdout).toContain("identity conformance: repeated-live=3,closed=3");
            expect(result.stdout).toContain(
              "post-open gate conformance: opened=1,body=0,closed=1,prior=1",
            );
            const cancellationFrames = result.stdout
              .split("\n")
              .filter((line) => line.startsWith("scope.cancel.frames:"));
            if (FailureFrames.isNone(policy)) expect(cancellationFrames).toEqual([]);
            else {
              expect(cancellationFrames).toHaveLength(3);
              for (const [index, kind] of [
                "addFinalizer",
                "acquireRelease",
                "registeredFile",
              ].entries()) {
                const line = cancellationFrames[index];
                const prefix = `scope.cancel.frames:${kind}:`;
                expect(line.startsWith(prefix)).toBe(true);
                const frames = Schema.decodeUnknownSync(
                  Schema.Array(Schema.Struct({ kind: Schema.String })),
                )(JSON.parse(line.slice(prefix.length)));
                expect(frames[0]?.kind).toBe(kind);
                expect(frames.map((frame) => frame.kind)).not.toContain(kind.toLowerCase());
              }
            }
            console.info(`scope registration ${policy._tag}/${profile}: ${result.stdout.trim()}`);
            yield* fs.writeFileString(`${directory}/src/lib.rs`, artifact.files["src/lib.rs"]);
            yield* fs.writeFileString(`${directory}/src/main.rs`, artifact.files["src/main.rs"]);
            yield* CargoApi.build(directory, profile);
            const native = yield* NativeRunner.run(artifact, directory, "file", file, [], profile);
            expect(observe(native)).toEqual({ value: 5n });
            if (!FailureFrames.isNone(policy)) {
              const nativeFailure = yield* NativeRunner.runWithFrames(
                artifact,
                directory,
                "retry",
                retry,
                [],
                profile,
              );
              const referenceFailure = yield* Reference.runWithFrames(
                retry,
                [],
                "functions.retry.body",
              );
              expect(nativeFailure.frames.map(({ path, kind }) => ({ path, kind }))).toEqual(
                referenceFailure.frames,
              );
              expect(nativeFailure.omitted).toBe(referenceFailure.omitted);
            }
          }
          const scalarArtifact = yield* Compile.make(R.program({ quiet })).pipe(
            Compile.withTarget(Rust.tokio),
            Compile.withFailureFrames(policy),
            Compile.run,
          );
          expect(scalarArtifact.files["src/lib.rs"]).not.toContain("reffect.log@1");
          expect(scalarArtifact.files["src/lib.rs"]).not.toContain("std::fs::File");
          const scalarDirectory = yield* CargoApi.write(
            scalarArtifact,
            `${parent}/scalar-${policy._tag}`,
          );
          yield* CargoApi.fetch(scalarDirectory);
          yield* fs.writeFileString(`${scalarDirectory}/src/main.rs`, quietProbe);
          for (const profile of ["debug", "release"] as const) {
            yield* CargoApi.build(scalarDirectory, profile);
            const result = yield* CargoApi.run(scalarDirectory, "probe", [], profile);
            expect(result.stdout).toMatch(
              /context=\d+,quiet_future=\d+,construction_allocations=0/,
            );
            expect(nativeRecords(result.stderr)).toEqual([]);
            console.info(`scope scalar costs ${policy._tag}/${profile}: ${result.stdout.trim()}`);
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.provide(Logger.layer([]))),
  );
}, 360000);

const allocatorPrelude = String.raw`
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
`;
const instrumentFileEvidence = (source: string): string => {
  const openCall = "std::fs::File::open(";
  const emitLog = 'eprintln!("{}", log_record);';
  expect(source.split(openCall).length - 1).toBe(5);
  expect(source).toContain(emitLog);
  const instrumented = source
    .replaceAll(openCall, "crate::scope_test_hook::open(")
    .replaceAll(emitLog, `crate::scope_test_hook::observe_log(&log_record); ${emitLog}`);
  expect(instrumented).not.toContain(openCall);
  return instrumented + fileEvidenceHook;
};

// Fixture-only instrumentation observes borrowed identities; it never clones or closes files.
const fileEvidenceHook = String.raw`
pub mod scope_test_hook {
    use std::sync::Mutex;
    struct Gate {
        opened: tokio::sync::oneshot::Sender<()>,
        release: std::sync::mpsc::Receiver<()>,
    }
    struct Evidence {
        identities: [usize; 16],
        len: usize,
        closed: usize,
        done: usize,
        callback_return: usize,
        repeated_live: usize,
        body: usize,
        prior: usize,
        gate: Option<Gate>,
    }
    static EVIDENCE: Mutex<Evidence> = Mutex::new(Evidence {
        identities: [0; 16], len: 0, closed: 0, done: 0,
        callback_return: 0, repeated_live: 0, body: 0, prior: 0, gate: None,
    });
    #[cfg(windows)]
    fn identity(file: &std::fs::File) -> usize {
        use std::os::windows::io::AsRawHandle;
        file.as_raw_handle() as usize
    }
    #[cfg(unix)]
    fn identity(file: &std::fs::File) -> usize {
        use std::os::fd::AsRawFd;
        file.as_raw_fd() as usize
    }
    #[cfg(windows)]
    fn valid(raw: usize) -> bool {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetHandleInformation(handle: *mut std::ffi::c_void, flags: *mut u32) -> i32;
            fn GetLastError() -> u32;
        }
        let mut flags = 0;
        let success = unsafe { GetHandleInformation(raw as *mut std::ffi::c_void, &mut flags) };
        if success == 0 { assert_eq!(unsafe { GetLastError() }, 6, "expected ERROR_INVALID_HANDLE"); }
        success != 0
    }
    #[cfg(unix)]
    fn valid(raw: usize) -> bool {
        unsafe extern "C" { fn fcntl(fd: std::ffi::c_int, cmd: std::ffi::c_int, ...) -> std::ffi::c_int; }
        // F_GETFD = 1 on the admitted Unix probe hosts; this query does not create ownership.
        let result = unsafe { fcntl(raw as std::ffi::c_int, 1) };
        if result == -1 { assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(9), "expected EBADF"); }
        result != -1
    }
    #[cfg(not(any(windows, unix)))]
    compile_error!("identity-specific file evidence requires a Windows or Unix host");
    pub fn reset() {
        let mut state = EVIDENCE.lock().unwrap();
        assert!(state.gate.is_none());
        for raw in &state.identities[..state.len] { assert!(!valid(*raw)); }
        state.len = 0;
        state.closed = 0;
        state.done = 0;
        state.callback_return = 0;
        state.repeated_live = 0;
        state.body = 0;
        state.prior = 0;
    }
    pub fn arm() -> (tokio::sync::oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
        reset();
        let (opened, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        EVIDENCE.lock().unwrap().gate = Some(Gate { opened, release: wait });
        (ready, release)
    }
    pub fn open(path: impl AsRef<std::path::Path>) -> std::io::Result<std::fs::File> {
        let file = std::fs::File::open(path)?;
        let raw = identity(&file);
        let gate = {
            let mut state = EVIDENCE.lock().unwrap();
            assert!(valid(raw));
            let index = state.len;
            assert!(index < state.identities.len());
            state.identities[index] = raw;
            state.len += 1;
            state.gate.take()
        };
        if let Some(gate) = gate {
            gate.opened.send(()).expect("probe receives opened notification");
            gate.release.recv().expect("probe releases acquisition");
            assert!(valid(raw), "the worker still owns its actual File before returning");
        }
        Ok(file)
    }
    pub fn assert_opened_gate() {
        let state = EVIDENCE.lock().unwrap();
        assert_eq!(state.len, 1);
        assert!(valid(state.identities[0]));
        assert_eq!((state.body, state.closed, state.done, state.prior), (0, 0, 0, 0));
    }
    pub fn observe_log(record: &str) {
        let mut state = EVIDENCE.lock().unwrap();
        if record.contains("\"message\":\"after-registration\"") {
            assert_eq!(state.len, 1);
            assert!(valid(state.identities[0]), "File must survive callback return");
            state.callback_return += 1;
        }
        if record.contains("\"message\":\"files-registered\"") {
            assert_eq!(state.len, 3);
            for raw in &state.identities[..state.len] { assert!(valid(*raw)); }
            state.repeated_live += 1;
        }
        if record.contains("\"message\":\"file-use\"") || record.contains("\"message\":\"file-inner-cleanup\"") { state.body += 1; }
        if record.contains("\"message\":\"file:start\"") || record.contains("\"message\":\"repeated-file:start\"") {
            assert_eq!(state.closed, state.done, "previous awaited cleanup must finish first");
            assert!(state.closed < state.len, "release starts exactly once per acquired File");
            let index = state.len - state.closed - 1;
            assert!(!valid(state.identities[index]), "actual File must close before cleanup starts");
            for raw in &state.identities[..index] { assert!(valid(*raw), "earlier files remain live until their turn"); }
            state.closed += 1;
        }
        if record.contains("\"message\":\"file:done\"") || record.contains("\"message\":\"repeated-file:done\"") {
            state.done += 1;
            assert_eq!(state.done, state.closed);
        }
        if record.contains("\"message\":\"gate-prior:start\"") {
            assert_eq!((state.closed, state.done), (1, 1), "file cleanup finishes before prior finalizer");
            state.prior += 1;
        }
    }
    pub fn assert_closed(expected: usize, callback_return: usize, repeated_live: usize, prior: usize) {
        let state = EVIDENCE.lock().unwrap();
        assert_eq!((state.len, state.closed, state.done), (expected, expected, expected));
        assert_eq!((state.callback_return, state.repeated_live, state.body, state.prior), (callback_return, repeated_live, 0, prior));
        for raw in &state.identities[..state.len] { assert!(!valid(*raw)); }
        println!("file identities={:?},closed={}", &state.identities[..state.len], state.closed);
    }
}
`;
const quietProbe =
  allocatorPrelude +
  String.raw`
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let before = ALLOCS.load(Ordering::SeqCst);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let future_bytes = { let future = reffect_generated::r_quiet(&mut ctx); std::mem::size_of_val(&future) };
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before);
    println!("context={},quiet_future={},construction_allocations=0", std::mem::size_of_val(&ctx), future_bytes);
    reffect_generated::r_quiet(&mut ctx).await.unwrap();
}
`;
const nativeProbe =
  allocatorPrelude +
  String.raw`
use std::future::Future;
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
fn handles() -> usize { 0 }
fn main() { tokio::runtime::Builder::new_current_thread().enable_all().max_blocking_threads(1).build().unwrap().block_on(run()); }
async fn run() {
    tokio::task::spawn_blocking(|| ()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let before = ALLOCS.load(Ordering::SeqCst);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let future_bytes = { let f = reffect_generated::r_quiet(&mut ctx); std::mem::size_of_val(&f) };
    assert_eq!(ALLOCS.load(Ordering::SeqCst), before, "context/unpolled future construction allocated");
    println!("context={},quiet_future={},construction_allocations=0", std::mem::size_of_val(&ctx), future_bytes);
    reffect_generated::r_quiet(&mut ctx).await.unwrap();
    reffect_generated::r_conditional(&mut ctx, true).await.unwrap();
    reffect_generated::r_conditional(&mut ctx, false).await.unwrap();
    reffect_generated::r_repeated(&mut ctx).await.unwrap();
    assert_eq!(reffect_generated::r_recovered(&mut ctx).await.unwrap(), 9);
    assert!(matches!(reffect_generated::r_retry(&mut ctx).await, Err(reffect_generated::AsyncError::Fail(false))));
    reffect_generated::r_full(&mut ctx).await.unwrap();
    reffect_generated::r_captures(&mut ctx, 9007199254740993).await.unwrap();
    assert!(matches!(reffect_generated::r_missing(&mut ctx).await, Err(reffect_generated::AsyncError::Fail(false))));
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let future = reffect_generated::r_cancel(&mut ctx);
    tokio::pin!(future);
    std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); sender.send(true).unwrap(); std::task::Poll::Ready(()) }).await;
    assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    for success in [true, false] {
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let mut ctx = reffect_generated::AsyncContext::new(receiver);
        let future = reffect_generated::r_settled(&mut ctx, success);
        tokio::pin!(future);
        std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); sender.send(true).unwrap(); std::task::Poll::Ready(()) }).await;
        let result = future.await;
        if success { assert!(matches!(result, Err(reffect_generated::AsyncError::Interrupted))); }
        else { assert!(matches!(result, Err(reffect_generated::AsyncError::Fail(false)))); }
    }
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    {
        let future = reffect_generated::r_maskedEnsuring(&mut ctx);
        tokio::pin!(future);
        std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); sender.send(true).unwrap(); std::task::Poll::Ready(()) }).await;
        assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    }
    macro_rules! interrupted_registration {
        ($entry:ident, $label:literal) => {{
            let (sender, receiver) = tokio::sync::watch::channel(false);
            let mut ctx = reffect_generated::AsyncContext::new(receiver);
            {
                let future = reffect_generated::$entry(&mut ctx);
                tokio::pin!(future);
                std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); sender.send(true).unwrap(); std::task::Poll::Ready(()) }).await;
                assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
            }
            /* CAPTURE_FRAME_OUTPUT */
        }};
    }
    interrupted_registration!(r_frameAdd, "addFinalizer");
    interrupted_registration!(r_frameAcquire, "acquireRelease");
    interrupted_registration!(r_frameFile, "registeredFile");
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let baseline = handles();
    reffect_generated::scope_test_hook::reset();
    let future = reffect_generated::r_file(&mut ctx);
    tokio::pin!(future);
    #[cfg(any(windows, target_os = "linux"))]
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        #[cfg(any(windows, target_os = "linux"))]
        if handles() == baseline + 1 { return std::task::Poll::Ready(()); }
        std::task::Poll::Pending
    }).await;
    assert_eq!(future.await.unwrap(), 5);
    reffect_generated::scope_test_hook::assert_closed(1, 1, 0, 0);
    println!("identity conformance: callback-return=1,closed=1");
    assert_eq!(handles(), baseline);
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    reffect_generated::scope_test_hook::reset();
    let future = reffect_generated::r_fileRepeated(&mut ctx);
    tokio::pin!(future);
    #[cfg(any(windows, target_os = "linux"))]
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        if handles() == baseline + 3 { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
    }).await;
    future.await.unwrap();
    reffect_generated::scope_test_hook::assert_closed(3, 0, 1, 0);
    println!("identity conformance: repeated-live=3,closed=3");
    assert_eq!(handles(), baseline);
    let (ready_send, ready_recv) = std::sync::mpsc::channel();
    let (gate_send, gate_recv) = std::sync::mpsc::channel();
    let blocker = tokio::task::spawn_blocking(move || { ready_send.send(()).unwrap(); gate_recv.recv().unwrap(); });
    ready_recv.recv().unwrap();
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    reffect_generated::scope_test_hook::reset();
    let future = reffect_generated::r_fileHold(&mut ctx);
    tokio::pin!(future);
    std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); sender.send(true).unwrap(); std::task::Poll::Ready(()) }).await;
    gate_send.send(()).unwrap();
    assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    reffect_generated::scope_test_hook::assert_closed(1, 0, 0, 1);
    blocker.await.unwrap();
    drop(ready_recv);
    assert_eq!(handles(), baseline);
    let (ready, release) = reffect_generated::scope_test_hook::arm();
    let (sender, receiver) = tokio::sync::watch::channel(false);
    let mut ctx = reffect_generated::AsyncContext::new(receiver);
    let future = reffect_generated::r_fileHold(&mut ctx);
    tokio::pin!(future);
    std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending()); std::task::Poll::Ready(()) }).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), ready).await.unwrap().unwrap();
    reffect_generated::scope_test_hook::assert_opened_gate();
    sender.send(true).unwrap();
    std::future::poll_fn(|cx| { assert!(future.as_mut().poll(cx).is_pending(), "masked acquisition must not finish before worker returns"); std::task::Poll::Ready(()) }).await;
    reffect_generated::scope_test_hook::assert_opened_gate();
    release.send(()).unwrap();
    assert!(matches!(future.await, Err(reffect_generated::AsyncError::Interrupted)));
    reffect_generated::scope_test_hook::assert_closed(1, 0, 0, 1);
    assert_eq!(handles(), baseline);
    println!("post-open gate conformance: opened=1,body=0,closed=1,prior=1");
    println!("registration conformance");
}
`;
const cancellationFrameProbe = (policy: FailureFramePolicy) => {
  expect(nativeProbe.split("/* CAPTURE_FRAME_OUTPUT */")).toHaveLength(2);
  return nativeProbe.replace(
    "/* CAPTURE_FRAME_OUTPUT */",
    FailureFrames.isNone(policy)
      ? ""
      : String.raw`
            let (frames, omitted) = ctx.take_frames();
            assert_eq!(omitted, 0);
            assert!(!frames.is_empty());
            println!("scope.cancel.frames:{}:[{}]", $label, frames.join(","));
            assert_eq!(ctx.take_frames(), (Vec::new(), 0));
  `,
  );
};
