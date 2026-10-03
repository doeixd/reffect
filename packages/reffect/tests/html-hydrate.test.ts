// @vitest-environment happy-dom
import { request as httpRequest } from "node:http";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Runtime } from "foldkit";
import { expect, test, vi } from "vite-plus/test";
import { CargoApi, NativeRpc, R } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import {
  BUILD_ID,
  Message,
  ModelSchema,
  PageSchema,
  todoPage,
  todoView,
} from "./fixtures/ssr-todos.ts";
import type { Model } from "./fixtures/ssr-todos.ts";

// Milestone 8A step 4 (SSR-011): the stock client adopts native HTML. As in foldkit 0.165.0's own
// runtime/hydrateBoot.test.ts, the server's element objects must survive hydration, and events
// must then dispatch on them.
const model: Model = {
  heading: "Todos",
  todos: [
    { id: "t1", title: "Write the domain", done: true },
    { id: "t2", title: "Render it natively", done: false },
  ],
};
const Group = RpcGroup.make(Rpc.make("Render", { payload: ModelSchema, success: PageSchema }));

/** A POST with Node's own HTTP client: happy-dom replaces the global fetch. */
const post = (url: string, body: string) =>
  new Promise<string>((resolve, reject) => {
    const outgoing = httpRequest(url, { method: "POST" }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => resolve(text));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });

/** The native server's HTML for `model`. */
const nativeHtml = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-html-hydrate-" });
    const artifact = yield* NativeRpc.compile(Group, { Render: NativeRpc.bind(todoPage) });
    const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
    yield* CargoApi.fetch(directory);
    yield* CargoApi.build(directory, "debug");
    const child = yield* ChildProcess.make(
      `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
      ["--port", "0"],
    );
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    const ready = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(child.stdout))).pipe(
      Effect.timeout("10 seconds"),
    );
    if (!Option.isSome(ready)) throw new Error("Missing ready record");
    const { address } = Schema.decodeUnknownSync(
      Schema.Struct({ schema: Schema.Literal("reffect.rpc.ready@1"), address: Schema.String }),
    )(JSON.parse(ready.value));
    const response = yield* Effect.promise(() =>
      post(
        `http://${address}/rpc`,
        JSON.stringify({ _tag: "Request", id: "1", tag: "Render", payload: model, headers: [] }),
      ),
    );
    // A JSON RPC body answers with the list of its messages: one Exit here.
    const [exit] = Schema.decodeUnknownSync(
      Schema.Tuple([
        Schema.Struct({
          exit: Schema.Struct({
            value: Schema.Struct({
              _tag: Schema.Literal("Success"),
              success: Schema.Struct({ html: Schema.String, title: Schema.String }),
            }),
          }),
        }),
      ]),
    )(JSON.parse(response));
    return exit.exit.value.success.html;
  }),
).pipe(Effect.provide(NodeServices.layer));

test(
  "the stock client hydrates native HTML, keeping the server's nodes",
  async () => {
    document.body.innerHTML = await Effect.runPromise(nativeHtml);
    const serverRoot = document.querySelector("[data-foldkit-app]");
    const serverItems = Array.from(document.querySelectorAll("li"));
    const serverBoxes = Array.from(document.querySelectorAll<HTMLInputElement>("input"));
    expect(serverRoot).not.toBeNull();
    expect(serverItems).toHaveLength(2);
    expect(serverBoxes.map((box) => box.checked)).toEqual([true, false]);

    const application = Runtime.makeApplication({
      Model: ModelSchema,
      init: () => ({ model }),
      update: (current: Model, message: Message) => ({
        model: {
          ...current,
          todos: current.todos.map((todo) =>
            todo.id === message.id ? { ...todo, done: !todo.done } : todo,
          ),
        },
      }),
      view: R.Html.toFoldkitView(todoView),
      container: document.getElementById("does-not-exist"),
    });
    Runtime.hydrate(application, { buildId: BUILD_ID });

    // Adoption strips the stamp from the server's own root, which stays connected.
    await vi.waitFor(() => expect(document.querySelector("[data-foldkit-app]")).toBeNull());
    expect(serverRoot?.isConnected).toBe(true);
    expect(Array.from(document.querySelectorAll("li"))).toEqual(serverItems);
    for (const [i, item] of Array.from(document.querySelectorAll("li")).entries())
      expect(item).toBe(serverItems[i]);

    // A click on the adopted node reaches update, and the same input reflects the new Model.
    serverItems[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(serverBoxes[1]!.checked).toBe(true));
    expect(document.querySelectorAll("input")[1]).toBe(serverBoxes[1]);
  },
  nativeTestBudget(0) + 240000,
);
