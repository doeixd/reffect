/**
 * Milestone 8B step 3 (docs/research/ssr-codemod.md): the R builders translated from the pinned
 * upstream SSR example, served natively, answer as the pinned example's own `renderPage` does.
 * The reference runs the vendored, unmodified `entry.server.ts` through Vite, with the build id
 * the Foldkit Vite plugin would compile in; its clock is the native page's instant.
 */
import { request as httpRequest } from "node:http";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { handleRequest } from "foldkit/experimental/server";
import type { EntryResult } from "foldkit/experimental/server";
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { CargoApi, NativeRpc, R } from "../src/index.ts";
import { page } from "../../../examples/ssr-8b/page.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { UPSTREAM_BUILD_ID, upstreamSsrVite } from "./fixtures/upstream-ssr-vite.ts";

const BUILD_ID = UPSTREAM_BUILD_ID;
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const origin = "http://reffect.test";
const Group = RpcGroup.make(Rpc.make("Ping", { payload: {}, success: Schema.String }));
const ping = R.fn([], R.String, () => R.String.literal("pong"));

// The pinned renderPage, loaded as the example's own build loads it.
let vite: Awaited<ReturnType<typeof upstreamSsrVite>>;
let renderPage: (request: Request) => Promise<EntryResult>;
beforeAll(async () => {
  vite = await upstreamSsrVite();
  const entry = (await vite.ssrLoadModule("/src/entry.server.ts")) as {
    readonly renderPage: (request: Request) => Promise<EntryResult>;
  };
  renderPage = entry.renderPage;
}, 120000);
afterAll(async () => {
  vi.useRealTimers();
  await vite?.close();
});

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}
const COMPARED = ["content-type", "cache-control", "vary", "x-content-type-options", "allow"];
const send = (address: string, method: string, cookie: string | undefined) =>
  new Promise<Answer>((resolveAnswer, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      {
        host,
        port: Number(port),
        method,
        path: "/",
        headers: cookie === undefined ? {} : { cookie },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const value = (name: string) => {
            const raw = response.headers[name];
            return Array.isArray(raw) ? raw.join(", ") : raw;
          };
          resolveAnswer({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: Object.fromEntries(COMPARED.map((name) => [name, value(name)])),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
/** The pinned example's answer to the same request, at the instant the native page names. */
const upstream = async (method: string, cookie: string | undefined, at: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  try {
    const response = await handleRequest(
      new Request(`${origin}/`, { method, headers: cookie === undefined ? {} : { cookie } }),
      { template, renderPage },
    );
    return {
      status: response.status,
      body: await response.text(),
      headers: Object.fromEntries(
        COMPARED.map((name) => [name, response.headers.get(name) ?? undefined]),
      ),
    } satisfies Answer;
  } finally {
    vi.useRealTimers();
  }
};
const COUNT = "foldkit-ssr-count";
const cookies = [
  undefined,
  `${COUNT}=7`,
  `${COUNT}=x`,
  `a=1; ${COUNT}=%37%30`,
  `${COUNT}="12"`,
  `${COUNT}=9007199254740992`,
  `${COUNT}=-3; ${COUNT}=4`,
  `café=1; ${COUNT}=1e3`,
];

test(
  "the translated example answers as the pinned example's own renderPage",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-ssr-8b-" });
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

          const bodies: Array<string> = [];
          for (const cookie of cookies) {
            const native = yield* Effect.promise(() => send(address, "GET", cookie));
            const at = /Rendered on the Server at ([^<]*)</.exec(native.body)?.[1];
            if (at === undefined) throw new Error(`No instant in ${native.body}`);
            const expected = yield* Effect.promise(() => upstream("GET", cookie, at));
            expect(native, String(cookie)).toEqual(expected);
            bodies.push(native.body);
          }
          // What the comparison covers: the stamped build, the count from the cookie, the
          // parse-equivalence block, and the Flags handoff with the native instant.
          expect(bodies[0]).toContain(`data-foldkit-build="${BUILD_ID}"`);
          expect(bodies[1]).toContain("<title>Count 7</title>");
          expect(bodies[3]).toContain("<title>Count 70</title>");
          expect(bodies[7]).toContain("<title>Count 1000</title>");
          expect(bodies[0]).toContain('<pre id="equivalence-pre">\n\nleading</pre>');
          expect(bodies[0]).toContain('<option value="a" selected="">A</option>');
          expect(bodies[0]).toMatch(
            /data-foldkit-flags="app">\{"initialCount":0,"renderedAt":"[^"]+","renderedOn":"Server"\}/,
          );
          for (const method of ["OPTIONS", "HEAD"]) {
            const native = yield* Effect.promise(() => send(address, method, undefined));
            const expected = yield* Effect.promise(() =>
              upstream(method, undefined, new Date().toISOString()),
            );
            expect(native, method).toEqual(expected);
            if (method === "OPTIONS") expect(native.status).toBe(204);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
