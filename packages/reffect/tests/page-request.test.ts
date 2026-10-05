/**
 * Milestone 8B steps 1d and 1e: a page reads its request's method, cookies and the instant it is
 * served, and answers upstream's server entry, as the pinned upstream SSR example's `renderPage`
 * does (`readCountCookie`, `new Date()`, the `OPTIONS` preflight, `Rendered(..., { headers })`).
 * Each answer must equal upstream `handleRequest` around the same entry.
 */
import { request as httpRequest } from "node:http";
import { DateTime, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import {
  HOST_METHOD_ANSWERS,
  Rendered,
  Responded,
  handleRequest,
} from "foldkit/experimental/server";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import type { Expr, Value } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID } from "./fixtures/ssr-todos.ts";

const H = R.Html;
const COUNT_COOKIE = "foldkit-ssr-count";
const PageRequest = R.Struct({
  url: R.String,
  method: R.String,
  cookie: R.String,
  now: R.DateTime.Utc,
});
type PageRequest = Expr<Value<typeof PageRequest>>;
// The example's readCountCookie: parseHeader, Record.get, Number.parse, isSafeInteger, else 0.
const countOf = (request: PageRequest) =>
  R.Cookies.parseHeader(R.Struct.get(request, "cookie")).pipe(
    R.Record.get(R.String.literal(COUNT_COOKIE)),
    R.Option.flatMap((text) => R.Number.parse(text)),
    R.Option.filter((count) => R.Number.isSafeInteger(count)),
    R.Option.getOrElse(() => R.Number.literal(0)),
  );
const render = (request: PageRequest) =>
  H.renderToString(
    H.Document.make({
      title: R.String.concat(R.String.literal("Count "), R.String.fromNumber(countOf(request))),
      body: H.main(
        [H.Id("root")],
        [
          H.p([H.Id("count")], [R.String.fromNumber(countOf(request))]),
          H.p([H.Id("at")], [R.DateTime.formatIso(R.Struct.get(request, "now"))]),
          H.p([H.Id("url")], [R.Struct.get(request, "url")]),
        ],
      ),
    }),
    { buildId: BUILD_ID },
  );
const header = (name: string, value: string) =>
  H.Header.make({ name: R.String.literal(name), value: R.String.literal(value) });
// The example's renderPage: a preflight answers 204 with the host's allow list; anything else is
// the render with its caching headers.
const page = R.fn([PageRequest], H.Entry, (request) =>
  R.Match.bool(
    R.String.eq(R.Struct.get(request, "method"), R.String.literal("OPTIONS")),
    H.responded({
      status: R.Number.literal(204),
      headers: R.Array.make(header("allow", HOST_METHOD_ANSWERS.allow)),
    }),
    H.rendered(render(request), {
      headers: R.Array.make(
        header("cache-control", "private, no-store"),
        header("vary", "cookie"),
        header("x-content-type-options", "nosniff"),
      ),
    }),
  ),
);
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const Group = RpcGroup.make(Rpc.make("Ping", { payload: {}, success: Schema.String }));
const ping = R.fn([], R.String, () => R.String.literal("pong"));
const origin = "http://reffect.test";

/** What both hosts must agree on: status, body and the headers a page sets or the host merges. */
interface Answer {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}
const COMPARED = ["content-type", "cache-control", "vary", "x-content-type-options", "allow"];
const send = (address: string, method: string, cookie: string | undefined) =>
  new Promise<Answer>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      {
        host,
        port: Number(port),
        method,
        path: "/counter",
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
          resolve({
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
/** Upstream, with the request as a Web Request reads it and the native page's instant. */
const upstream = async (method: string, cookie: string | undefined, at: string) => {
  const request = new Request(`${origin}/counter`, {
    method,
    headers: cookie === undefined ? {} : { cookie },
  });
  const entry = await Effect.runPromise(
    Reference.run(page, [
      {
        url: request.url,
        method: request.method,
        cookie: request.headers.get("cookie") ?? "",
        now: DateTime.makeUnsafe(Date.parse(at)),
      },
    ]),
  );
  const response = await handleRequest(request, {
    template,
    renderPage: async () => {
      if (entry._tag === "Responded")
        return Responded(
          new Response(entry.body, {
            status: entry.status,
            headers: entry.headers.map(({ name, value }): [string, string] => [name, value]),
          }),
        );
      if (entry.page._tag !== "Success") throw new Error("The page did not render");
      return Rendered(entry.page.success, {
        status: entry.status,
        headers: entry.headers.map(({ name, value }): [string, string] => [name, value]),
      });
    },
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: Object.fromEntries(
      COMPARED.map((name) => [name, response.headers.get(name) ?? undefined]),
    ),
  } satisfies Answer;
};
// Latin-1 cookie bytes, written to the socket as such: Node sends header strings as latin1.
const cookies = [
  undefined,
  "",
  `${COUNT_COOKIE}=7`,
  `${COUNT_COOKIE}=x`,
  `a=1; ${COUNT_COOKIE}=%37%30`,
  `${COUNT_COOKIE}="12"`,
  `${COUNT_COOKIE}=9007199254740992`,
  `${COUNT_COOKIE}= 0x1F `,
  `${COUNT_COOKIE}=-3; ${COUNT_COOKIE}=4`,
  `café=1; ${COUNT_COOKIE}=1e3`,
];

test(
  "a page reads its request and answers upstream's server entry, as the upstream example does",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-page-request-" });
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

          const counts: Array<string> = [];
          const before = Date.now();
          for (const cookie of cookies) {
            const native = yield* Effect.promise(() => send(address, "GET", cookie));
            const at = /<p id="at">([^<]*)<\/p>/.exec(native.body)?.[1];
            if (at === undefined) throw new Error(`No instant in ${native.body}`);
            // The instant is the server's clock when it answered.
            expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1000);
            const expected = yield* Effect.promise(() => upstream("GET", cookie, at));
            expect(native, String(cookie)).toEqual(expected);
            counts.push(/<p id="count">([^<]*)<\/p>/.exec(native.body)?.[1] ?? "");
          }
          expect(counts).toEqual(["0", "0", "7", "0", "70", "12", "0", "31", "-3", "1000"]);
          // The authored Vary keeps its spelling, and the negotiated fields follow it.
          expect((yield* Effect.promise(() => send(address, "GET", undefined))).headers.vary).toBe(
            "cookie, Accept, Sec-Fetch-Dest",
          );
          // The preflight is a complete response, and HEAD the page without its body.
          for (const method of ["OPTIONS", "HEAD"]) {
            const native = yield* Effect.promise(() => send(address, method, undefined));
            const expected = yield* Effect.promise(() =>
              upstream(method, undefined, new Date().toISOString()),
            );
            expect(native, method).toEqual(expected);
          }
          expect((yield* Effect.promise(() => send(address, "OPTIONS", undefined))).status).toBe(
            204,
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
