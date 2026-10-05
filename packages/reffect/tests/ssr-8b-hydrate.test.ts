// @vitest-environment happy-dom
/**
 * Milestone 8B step 3 (docs/research/ssr-codemod.md): the stock client of the pinned upstream
 * SSR example, its unmodified `entry.ts`, hydrates the page the translated R builders serve
 * natively. As in foldkit's own hydration tests, the server's nodes must survive adoption, and an
 * event on them must then reach the pinned `update`.
 */
import { request as httpRequest } from "node:http";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test, vi } from "vite-plus/test";
import { CargoApi, NativeRpc, R } from "../src/index.ts";
import { page } from "../../../examples/ssr-8b/page.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { upstreamSsrVite } from "./fixtures/upstream-ssr-vite.ts";

const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const Group = RpcGroup.make(Rpc.make("Ping", { payload: {}, success: Schema.String }));
const ping = R.fn([], R.String, () => R.String.literal("pong"));

/** A GET with Node's own HTTP client: happy-dom replaces the global fetch. */
const get = (address: string, cookie: string) =>
  new Promise<string>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      { host, port: Number(port), method: "GET", path: "/", headers: { cookie } },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve(text));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

/** The native page for a count cookie of 7. */
const nativePage = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-ssr-8b-hydrate-" });
    const artifact = yield* NativeRpc.compile(
      Group,
      { Ping: NativeRpc.bind(ping) },
      { pages: { template, render: page, origin: "http://reffect.test" } },
    );
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
    return yield* Effect.promise(() => get(address, "foldkit-ssr-count=7"));
  }),
).pipe(Effect.provide(NodeServices.layer));

test(
  "the pinned example's own client hydrates the translated page, keeping the server's nodes",
  async () => {
    const html = await Effect.runPromise(nativePage);
    const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
    if (body === undefined) throw new Error(`No body in ${html}`);
    document.body.innerHTML = body;
    const serverRoot = document.querySelector("[data-foldkit-app]");
    const serverCount = document.getElementById("count");
    const buttons = Array.from(document.querySelectorAll("button"));
    expect(serverCount?.textContent).toBe("7");
    expect(buttons.map((button) => button.textContent)).toEqual(["-", "+"]);

    // The unmodified entry.ts: makeApplication, then Runtime.hydrate with the compiled build id.
    const vite = await upstreamSsrVite();
    try {
      await vite.ssrLoadModule("/src/entry.ts");
      // Adoption strips the stamp from the server's own root, which stays connected.
      await vi.waitFor(() => expect(document.querySelector("[data-foldkit-app]")).toBeNull());
      expect(serverRoot?.isConnected).toBe(true);
      expect(document.getElementById("count")).toBe(serverCount);
      // A click on the adopted "+" reaches the pinned update, and the same node shows 8.
      buttons[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => expect(serverCount?.textContent).toBe("8"));
      expect(document.getElementById("count")).toBe(serverCount);
    } finally {
      await vite.close();
    }
  },
  nativeTestBudget(0) + 240000,
);
