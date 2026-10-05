/**
 * Milestone 8B step 1d: a page reads its request's cookies and the instant it is served, as the
 * pinned upstream SSR example's `flagsForRequest` does (`readCountCookie`, `new Date()`), and
 * answers as upstream `handleRequest` around the same render.
 */
import { request as httpRequest } from "node:http";
import { DateTime, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Rendered, handleRequest } from "foldkit/experimental/server";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page } from "./fixtures/ssr-todos.ts";

const H = R.Html;
const COUNT_COOKIE = "foldkit-ssr-count";
const PageRequest = R.Struct({ url: R.String, cookie: R.String, now: R.DateTime.Utc });
// The example's readCountCookie: parseHeader, Record.get, Number.parse, isSafeInteger, else 0.
const countOf = (cookie: Parameters<typeof R.Cookies.parseHeader>[0]) =>
  R.Cookies.parseHeader(cookie).pipe(
    R.Record.get(R.String.literal(COUNT_COOKIE)),
    R.Option.flatMap((text) => R.Number.parse(text)),
    R.Option.filter((count) => R.Number.isSafeInteger(count)),
    R.Option.getOrElse(() => R.Number.literal(0)),
  );
const page = R.fn([PageRequest], Page, (request) =>
  H.renderToString(
    H.Document.make({
      title: R.String.concat(
        R.String.literal("Count "),
        R.String.fromNumber(countOf(R.Struct.get(request, "cookie"))),
      ),
      body: H.main(
        [H.Id("root")],
        [
          H.p([H.Id("count")], [R.String.fromNumber(countOf(R.Struct.get(request, "cookie")))]),
          H.p([H.Id("at")], [R.DateTime.formatIso(R.Struct.get(request, "now"))]),
          H.p([H.Id("url")], [R.Struct.get(request, "url")]),
        ],
      ),
    }),
    { buildId: BUILD_ID },
  ),
);
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const Group = RpcGroup.make(Rpc.make("Ping", { payload: {}, success: Schema.String }));
const ping = R.fn([], R.String, () => R.String.literal("pong"));
const origin = "http://reffect.test";

interface Answer {
  readonly status: number;
  readonly body: string;
  readonly vary: string | undefined;
}
const send = (address: string, cookie: string | undefined) =>
  new Promise<Answer>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      {
        host,
        port: Number(port),
        method: "GET",
        path: "/counter",
        headers: cookie === undefined ? {} : { cookie },
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            vary: response.headers.vary,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
/** Upstream, with the request's cookie as a Web Request reads it and the native page's instant. */
const upstream = async (cookie: string | undefined, at: string) => {
  const request = new Request(`${origin}/counter`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  const rendered = await Effect.runPromise(
    Reference.run(page, [
      {
        url: request.url,
        cookie: request.headers.get("cookie") ?? "",
        now: DateTime.makeUnsafe(Date.parse(at)),
      },
    ]),
  );
  if (rendered._tag !== "Success") throw new Error("The page did not render");
  const response = await handleRequest(request, {
    template,
    renderPage: async () => Rendered(rendered.success),
  });
  return { status: response.status, body: await response.text() };
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
  "a page reads its cookies and its instant as the upstream example's Flags do",
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
            const native = yield* Effect.promise(() => send(address, cookie));
            const at = /<p id="at">([^<]*)<\/p>/.exec(native.body)?.[1];
            if (at === undefined) throw new Error(`No instant in ${native.body}`);
            // The instant is the server's clock when it answered.
            expect(Date.parse(at)).toBeGreaterThanOrEqual(before - 1000);
            const expected = yield* Effect.promise(() => upstream(cookie, at));
            expect({ status: native.status, body: native.body }, String(cookie)).toEqual(expected);
            // A page reading cookies differs by them.
            expect(native.vary).toContain("Cookie");
            counts.push(/<p id="count">([^<]*)<\/p>/.exec(native.body)?.[1] ?? "");
          }
          expect(counts).toEqual(["0", "0", "7", "0", "70", "12", "0", "31", "-3", "1000"]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
