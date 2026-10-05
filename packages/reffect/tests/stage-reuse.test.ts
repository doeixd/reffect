import { Effect, Tracer } from "effect";
import { expect, test } from "vite-plus/test";
import { Compile, Plan, R } from "../src/index.ts";

// #31: every stage re-ran the stages before it, so one Compile.run checked about eight times.
// Stage outputs are immutable, so each stage now runs once per value it is given.
const counting = <A, E>(effect: Effect.Effect<A, E>) => {
  const names: string[] = [];
  const tracer = Tracer.make({
    span(options) {
      names.push(options.name);
      return new Tracer.NativeSpan(options);
    },
  });
  return Effect.runPromise(Effect.provideService(effect, Tracer.Tracer, tracer)).then((value) => ({
    value,
    count: (name: string) => names.filter((n) => n === name).length,
  }));
};
const add = R.fn([R.U64, R.U64], R.U64, (a, b) => R.U64.add(a, b));
const effectful = R.fn([R.U64], R.U64, R.U64, (a) =>
  R.Match.bool(R.U64.lt(a, R.U64.literal(9n)), R.Effect.succeed(a), R.Effect.fail(a)),
);

test("one compile checks, derives and verifies once", async () => {
  for (const program of [R.program({ add }), R.program({ add, effectful })]) {
    const { value, count } = await counting(Compile.run(program));
    expect(value.files["src/lib.rs"].length).toBeGreaterThan(0);
    for (const stage of ["Compile.check", "Compile.derive", "Compile.plan", "Compile.verify"])
      expect(count(stage), stage).toBe(1);
  }
});

test("a hand-made plan is still verified, and diagnostics are unchanged", async () => {
  const program = R.program({ add });
  const analysis = await Effect.runPromise(Compile.derive(program));
  const planned = await Effect.runPromise(Compile.plan(analysis));
  // The same contents through the public constructor: not a plan verify produced.
  const forged = Plan.make(analysis, planned.target, [], planned.crates);
  const refused = await Effect.runPromise(
    Compile.verify(forged).pipe(
      Effect.flip,
      Effect.map((error) => error.diagnostics.map((d) => d.code)),
    ),
  );
  expect(refused).toEqual(["INVALID_PLAN"]);
  // Re-verifying a verified plan answers with it, without planning again.
  const verified = await Effect.runPromise(Compile.verify(planned));
  const again = await counting(Compile.verify(verified));
  expect(again.value).toBe(verified);
  expect(again.count("Compile.plan")).toBe(0);
});
