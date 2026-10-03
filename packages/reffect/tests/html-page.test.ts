import { request as httpRequest } from "node:http";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { HOST_METHOD_ANSWERS, Rendered, handleRequest } from "foldkit/experimental/server";
import { expect, test } from "vite-plus/test";
import { CargoApi, CompileError, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page, todoDocument } from "./fixtures/ssr-todos.ts";

// Milestone 8A step 5 (SSR-007): native pages answer as foldkit's handleRequest with the same
// template and the same rendered application.
const Todo = R.Struct({ id: R.String, title: R.String, done: R.Bool });
const text = (value: string) => R.String.literal(value);
const page = R.fn([], Page, () =>
  R.Html.renderToString(
    todoDocument(
      R.Struct({ heading: R.String, todos: R.Array(Todo) }).make({
        heading: text(`Todos & "more"`),
        todos: R.Array.make(
          Todo.make({ id: text("t1"), title: text("Write it"), done: R.Bool.literal(true) }),
        ),
      }),
    ),
    { buildId: BUILD_ID },
  ),
);
const template =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Placeholder</title></head>' +
  '<body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>';
const Group = RpcGroup.make(Rpc.make("Ping", { payload: {}, success: Schema.String }));
const ping = R.fn([], R.String, () => text("pong"));

interface Answer {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly vary: string | undefined;
  readonly allow: string | undefined;
  readonly body: string;
}
type Case = readonly [
  label: string,
  method: string,
  target: string,
  headers?: Record<string, string>,
];
const corpus: ReadonlyArray<Case> = [
  ["root", "GET", "/"],
  ["index.html", "GET", "/index.html"],
  ["Index.HTML", "GET", "/Index.HTML"],
  ["dot segments to index", "GET", "/a/../index.html"],
  ["a page", "GET", "/todos"],
  ["a path asset", "GET", "/app.js"],
  ["an upper-case asset", "GET", "/x.JS"],
  ["an encoded asset", "GET", "/%2e%2e/x.css"],
  ["a malformed escape", "GET", "/%zz"],
  ["a destination asset", "GET", "/img", { "sec-fetch-dest": "image" }],
  ["a document destination", "GET", "/img", { "sec-fetch-dest": "document" }],
  ["json only", "GET", "/todos", { accept: "application/json" }],
  ["html refused", "GET", "/todos", { accept: "text/html;q=0" }],
  ["specific wins", "GET", "/todos", { accept: "*/*;q=1, text/html;q=0" }],
  ["hex quality", "GET", "/todos", { accept: "text/*;q=0x1" }],
  ["empty quality", "GET", "/todos", { accept: "text/html;q=" }],
  ["quoted comma", "GET", "/todos", { accept: 'text/plain;x="a,b", text/html;q=0.5' }],
  ["empty accept", "GET", "/todos", { accept: "" }],
  ["head", "HEAD", "/"],
  ["head of a page", "HEAD", "/todos"],
  ["post", "POST", "/form"],
];

/** A raw HTTP exchange: the target is sent as written. */
const send = (address: string, method: string, target: string, headers: Record<string, string>) =>
  new Promise<Answer>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      { host, port: Number(port), method, path: target, headers },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"],
            vary: response.headers.vary,
            allow: response.headers.allow,
            body,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

/** What upstream handleRequest answers for the same request and rendered application. */
const upstream = async (method: string, target: string, headers: Record<string, string>) => {
  const rendered = await Effect.runPromise(Reference.run(page, []));
  if (rendered._tag !== "Success") throw new Error("The page did not render");
  const response = await handleRequest(
    new Request(`http://reffect.test${target}`, { method, headers }),
    { template, renderPage: async () => Rendered(rendered.success) },
  );
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    vary: response.headers.get("vary") ?? undefined,
    allow: response.headers.get("allow") ?? undefined,
    body: await response.text(),
  } satisfies Answer;
};

test("a page that is not a Result of Rendered, or a template without a root, is refused", async () => {
  const wrong = await Effect.runPromise(
    NativeRpc.compile(
      Group,
      { Ping: NativeRpc.bind(ping) },
      { pages: { template, render: ping } },
    ).pipe(Effect.flip),
  );
  expect(wrong).toBeInstanceOf(CompileError);
  expect(wrong.message).toContain("R.Result(R.Html.Rendered, R.Html.RenderError)");
  const noRoot = await Effect.runPromise(
    NativeRpc.compile(
      Group,
      { Ping: NativeRpc.bind(ping) },
      {
        pages: {
          template: "<html><head><title>x</title></head><body></body></html>",
          render: page,
        },
      },
    ).pipe(Effect.flip),
  );
  expect(noRoot.message.length).toBeGreaterThan(0);
});

test(
  "native pages answer as upstream handleRequest",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-html-page-" });
          const artifact = yield* NativeRpc.compile(
            Group,
            { Ping: NativeRpc.bind(ping) },
            { pages: { template, render: page } },
          );
          expect(artifact.runtime.crates).toContain("url@2.5.8");
          expect(artifact.runtime.ported.map((port) => port.ref.id)).toEqual([
            "effect/rpc-http@1",
            "foldkit/ssr-serialize@1",
            "foldkit/ssr-host@1",
          ]);
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

          const answers = new Map<string, Answer>();
          for (const [label, method, target, headers = {}] of corpus) {
            const native = yield* Effect.promise(() => send(address, method, target, headers));
            const expected = yield* Effect.promise(() => upstream(method, target, headers));
            answers.set(label, expected);
            expect(native, label).toEqual(expected);
          }
          // The corpus reaches every branch.
          expect(answers.get("root")?.body).toContain('data-foldkit-app="app"');
          expect(answers.get("root")?.body).toContain('<title>Todos &amp; "more"</title>');
          expect(answers.get("a page")?.vary).toBe("Accept, Sec-Fetch-Dest");
          expect(answers.get("a path asset")?.status).toBe(404);
          expect(answers.get("a destination asset")?.vary).toBe("Sec-Fetch-Dest");
          expect(answers.get("json only")?.status).toBe(404);
          expect(answers.get("hex quality")?.status).toBe(200);
          expect(answers.get("head")?.body).toBe("");
          // The Fetch API cannot build these methods; the host refuses them as upstream does.
          for (const method of ["TRACE", "TRACK"]) {
            const native = yield* Effect.promise(() => send(address, method, "/", {}));
            expect(native.status, method).toBe(HOST_METHOD_ANSWERS.refusedStatus);
            expect(native.allow, method).toBe(HOST_METHOD_ANSWERS.allow);
          }
          // The RPC path is still the RPC server.
          const pong = yield* Effect.promise(() =>
            fetch(`http://${address}/rpc`, {
              method: "POST",
              body: JSON.stringify({
                _tag: "Request",
                id: "1",
                tag: "Ping",
                payload: {},
                headers: [],
              }),
            }).then((r) => r.text()),
          );
          expect(pong).toContain('"value":"pong"');
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
