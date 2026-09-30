import { Effect } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cargo, Compile, R, Reference } from "reffect";

const Add = R.fn([R.U64, R.U64], R.U64, (a, b) => a.pipe(R.U64.add(b)));
const program = R.program({ Add });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const artifact = yield* program.pipe(Compile.run);
    yield* Effect.log("Generated Rust", { source: artifact.files["src/lib.rs"] });
    const inputs: readonly [bigint, bigint] = [R.U64.max, 1n];
    const expected = yield* Reference.run(Add, inputs);
    const cargo = yield* Cargo;
    const results = yield* cargo.validate(artifact, [{ name: "Add", args: inputs, expected }], ".");
    yield* Effect.log("Reference/native parity", {
      expected: expected.toString(),
      commands: results.length,
    });
  }).pipe(Effect.provide(Cargo.layer), Effect.provide(NodeServices.layer)),
);
