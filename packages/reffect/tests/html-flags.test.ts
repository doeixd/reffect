import { request as httpRequest } from "node:http";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Rendered, handleRequest, renderToString } from "foldkit/experimental/server";
import { expect, test } from "vite-plus/test";
import { CargoApi, CompileError, NativeRpc, R } from "../src/index.ts";
import type { Expr, Value } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page, todoDocument, todoView } from "./fixtures/ssr-todos.ts";

// Milestone 9 step 1 (M9-1): a page reads its request URL, derives Flags, and renders with
// upstream's Flags payload; native answers equal handleRequest around upstream renderToString.
const origin = "http://reffect.test";
const FlagsSchema = Schema.Struct({ url: Schema.String, note: Schema.String });
const Flags = NativeRpc.witness(FlagsSchema);
const note = `</script><b class="x">&amp;`;
const Todo = R.Struct({ id: R.String, title: R.String, done: R.Bool });
/** init: the heading is the URL the page was asked for. */
const init = (flags: Expr<Value<typeof Flags>>) =>
  R.Struct({ heading: R.String, todos: R.Array(Todo) }).make({
    heading: R.Struct.get(flags, "url"),
    todos: R.Array.make(
      Todo.make({
        id: R.String.literal("t1"),
        title: R.Struct.get(flags, "note"),
        done: R.Bool.literal(false),
      }),
    ),
  });
const page = R.fn([R.String], Page, (url) => {
  const flags = R.Struct({ url: R.String, note: R.String }).make({
    url,
    note: R.String.literal(note),
  });
  return R.Html.renderToString(todoDocument(init(flags)), { buildId: BUILD_ID, flags });
});
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const Group = RpcGroup.make(Rpc.make("Ping", { payload: {}, success: Schema.String }));
const ping = R.fn([], R.String, () => R.String.literal("pong"));

/** Upstream: the same Flags, init and view through renderToString and handleRequest. */
const upstream = async (method: string, target: string) => {
  const response = await handleRequest(new Request(`${origin}${target}`, { method }), {
    template,
    renderPage: async (request) => {
      const rendered = await Effect.runPromise(
        renderToString(
          {
            Flags: FlagsSchema,
            init: (flags: typeof FlagsSchema.Type) => ({
              model: {
                heading: flags.url,
                todos: [{ id: "t1", title: flags.note, done: false }],
              },
            }),
            view: R.Html.toFoldkitView(todoView),
          },
          { flags: { url: request.url, note }, buildId: BUILD_ID },
        ),
      );
      return Rendered(rendered);
    },
  });
  return { status: response.status, body: await response.text() };
};
const send = (address: string, method: string, target: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest({ host, port: Number(port), method, path: target }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });

test("Flags holding Numbers, and origins with a path, are refused", async () => {
  expect(() =>
    R.Html.renderToString(
      todoDocument(
        init(
          R.Struct({ url: R.String, note: R.String }).make({
            url: R.String.literal("x"),
            note: R.String.literal("n"),
          }),
        ),
      ),
      { buildId: BUILD_ID, flags: R.Number.literal(1) },
    ),
  ).toThrow(CompileError);
  const pathOrigin = await Effect.runPromise(
    NativeRpc.compile(
      Group,
      { Ping: NativeRpc.bind(ping) },
      { pages: { template, render: page, origin: "http://reffect.test/app" } },
    ).pipe(Effect.flip),
  );
  expect(pathOrigin.message).toContain("scheme, host and port");
});

test(
  "native pages read the URL and carry Flags as upstream renderToString does",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-html-flags-" });
          const artifact = yield* NativeRpc.compile(
            Group,
            { Ping: NativeRpc.bind(ping) },
            { pages: { template, render: page, origin } },
          );
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(
            Schema.Struct({
              schema: Schema.Literal("reffect.rpc.ready@1"),
              address: Schema.String,
            }),
          )(JSON.parse(ready.value));
          const answers = new Map<string, string>();
          for (const target of [
            "/",
            "/todos?q=%3Cx%3E&y=1",
            "/a/../b",
            "/index.html",
            "/%C3%A9?%C3%BC=1",
          ]) {
            const native = yield* Effect.promise(() => send(address, "GET", target));
            const expected = yield* Effect.promise(() => upstream("GET", target));
            answers.set(target, expected.body);
            expect(native, target).toEqual(expected);
          }
          // The Flags payload is there, its `<` escaped, and the URL reached init.
          const root = answers.get("/todos?q=%3Cx%3E&y=1") ?? "";
          expect(root).toContain('<script type="application/json" data-foldkit-flags="app">');
          expect(root).toContain("\\u003c/script>");
          expect(root).toContain("<h1>http://reffect.test/todos?q=%3Cx%3E&amp;y=1</h1>");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
