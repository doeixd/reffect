/**
 * #18: a Remote store call or live signal inside a finalizer is refused while compiling. Natively
 * a failed store call there cannot be reported (the masked finalizer path panics), where the
 * reference would answer a defect, so the profile refuses it as it refuses Launch in cleanup.
 */
import { Effect } from "effect";
import { RemoteRpc } from "foldkit-remote";
import { expect, test } from "vite-plus/test";
import { CompileError, NativeRemote, R } from "../src/index.ts";
import { AddTodo, Data, rows } from "../../../examples/todo-remote/domain.ts";

const group = RemoteRpc.omit("FoldkitRemoteLive");
const text = (value: string) => R.literal(R.String, value);
const added = (id: ReturnType<typeof text>) =>
  R.Effect.succeed(
    NativeRemote.outcome(AddTodo).make({ output: R.Struct({ id: R.String }).make({ id }) }),
  );
const compile = (mutation: ReturnType<typeof NativeRemote.mutation>) =>
  Effect.runPromise(
    NativeRemote.compile(group, { domain: Data, rows, mutations: [mutation] }).pipe(Effect.flip),
  );
const compileLive = (mutation: ReturnType<typeof NativeRemote.mutation>) =>
  Effect.runPromise(
    NativeRemote.compile(RemoteRpc, {
      domain: Data,
      rows,
      mutations: [mutation],
      live: true,
      serialization: "ndjson",
    }).pipe(Effect.flip),
  );

test("a store write in a finalizer is refused", async () => {
  const error = await compile(
    NativeRemote.mutation(AddTodo, ({ input }) =>
      R.Effect.ensuring(
        added(R.Struct.get(input, "id")),
        R.RemoteStore.write(
          "Todo",
          R.Struct.get(input, "id"),
          R.Struct({ title: R.String }).make({ title: R.Struct.get(input, "title") }),
        ),
      ),
    ),
  );
  expect(error).toBeInstanceOf(CompileError);
  expect(error.diagnostics.map((diagnostic) => diagnostic.code)).toContain("STORE_CLEANUP");
});

test("a live signal in a finalizer is refused", async () => {
  const error = await compileLive(
    NativeRemote.mutation(AddTodo, ({ input }) =>
      R.Effect.ensuring(
        added(R.Struct.get(input, "id")),
        R.LiveHub.deleted({ entity: "Todo", id: R.Struct.get(input, "id") }),
      ),
    ),
  );
  expect(error).toBeInstanceOf(CompileError);
  expect(error.diagnostics.map((diagnostic) => diagnostic.code)).toContain("STORE_CLEANUP");
});

test("the same calls in the body still compile", async () => {
  const body = NativeRemote.mutation(AddTodo, ({ input }) =>
    R.Effect.flatMap(
      R.RemoteStore.write(
        "Todo",
        R.Struct.get(input, "id"),
        R.Struct({ title: R.String }).make({ title: R.Struct.get(input, "title") }),
      ),
      () => added(R.Struct.get(input, "id")),
    ),
  );
  const compiled = await Effect.runPromise(
    NativeRemote.compile(group, { domain: Data, rows, mutations: [body] }),
  );
  expect(compiled.files["src/main.rs"]).toBeDefined();
});
