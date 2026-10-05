/**
 * #6: a page view's items are decoded by the projection's own selection schema, as upstream's
 * `decodeRow(select.schema, ...)` decodes them. `points` is a `U64Json` field: a JSON string on
 * the wire, a bigint once decoded. The R view compares it as a number, so a page that saw the
 * wire value would render differently, or not compile.
 */
import { request as httpRequest } from "node:http";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { Rendered, handleRequest, renderToString } from "foldkit/experimental/server";
import { defineMessageUnion } from "foldkit/message";
import { Entity, Order } from "foldkit-entity";
import { Query, Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { Surface } from "foldkit-surface";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote, NativeRpc, R } from "../src/index.ts";
import type { Expr, Value } from "../src/index.ts";
import { RemoteResume, planPage, record, replay } from "../src/remote-resume.ts";
import { PageSchema } from "../src/ssr-page.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

const Score = Entity.define(
  "Score",
  Schema.Struct({ id: Schema.String, name: Schema.String, points: NativeRpc.U64Json }),
);
const Scores = Query.define("Scores", {}, () =>
  Query.from(Score).pipe(Query.orderBy(Order.asc(Score.fields.name))),
);
const AppModel = Schema.Struct({ remote: Remote.Model });
const App = Surface.application({
  Model: AppModel,
  Message: defineMessageUnion({ ...Remote.messages }),
});
const Data = Remote.make({ model: App.model.remote, entities: [Score], queries: [Scores] });
const initial: typeof AppModel.Type = { remote: Remote.initial };
const rows = {
  Score: [
    { id: "s1", name: "Ada", points: "15" },
    { id: "s2", name: "Grace", points: "3" },
  ],
};
const list = Data.query(
  Scores,
  {},
  { select: Entity.select(Score, { id: true, name: true, points: true }), first: 10 },
);
const active = { scores: Data.active("Scores", () => Option.some(list)) };
const plan = planPage(Data, initial, { scores: list });
const origin = "http://reffect.test";
const template =
  '<!doctype html><html lang="en"><head><title>Placeholder</title></head>' +
  '<body><div id="root"></div></body></html>';
const BUILD_ID = "scores-build";
const group = RemoteRpc.omit("FoldkitRemoteMutate", "FoldkitRemoteLive");

const H = R.Html;
const Item = R.Struct({ id: R.String, name: R.String, points: R.U64 });
const Model = R.Struct({ scores: R.Array(Item) });
const scoreDocument = (model: Expr<Value<typeof Model>>) =>
  H.Document.make({
    title: R.String.literal("Scores"),
    body: H.ul(
      [],
      R.Array.map(R.Struct.get(model, "scores"), (score) =>
        H.li(
          [
            H.Class(
              R.Match.bool(
                R.U64.lt(R.Struct.get(score, "points"), R.U64.literal(10n)),
                R.String.literal("low"),
                R.String.literal("high"),
              ),
            ),
          ],
          [R.Struct.get(score, "name")],
        ),
      ),
    ),
  });
const scoreView = R.fn([Model], H.Document, scoreDocument);
const Flags = R.Struct({ remote: R.Unknown });
const Page = NativeRpc.witness(PageSchema);
// The views witness comes from the plan: its items are the selection's, with points a U64.
const PageRequest = R.Struct({ remote: R.Unknown, views: NativeRemote.pageViews(plan) });
const page = R.fn([PageRequest], Page, (request) =>
  H.renderToString(
    {
      init: () =>
        Model.make({
          scores: request.pipe(
            R.Struct.get("views"),
            R.Struct.get("scores"),
            R.Struct.get("items"),
          ),
        }),
      view: scoreDocument,
    },
    { buildId: BUILD_ID, flags: Flags.make({ remote: R.Struct.get(request, "remote") }) },
  ),
);
const FlagsSchema = Schema.Struct({ remote: RemoteResume });

const upstream = async (target: string, now: number) => {
  const [, exchanges] = await Effect.runPromise(
    record(Data.satisfy(initial, active, { now: () => now })).pipe(
      Effect.provide(RemoteServer.memory({ domain: Data, rows }).layer),
    ),
  );
  const response = await handleRequest(new Request(`${origin}${target}`), {
    template,
    renderPage: async () =>
      Rendered(
        await Effect.runPromise(
          renderToString(
            {
              Flags: FlagsSchema,
              init: (flags: typeof FlagsSchema.Type) => {
                const model = Effect.runSync(
                  Data.satisfy(initial, active, { now: () => flags.remote.now }).pipe(
                    Effect.provide(replay(flags.remote.exchanges)),
                  ),
                );
                const read = list.read(model);
                return { model: { scores: read._tag === "Ready" ? [...read.value.items] : [] } };
              },
              view: R.Html.toFoldkitView(scoreView),
            },
            { flags: { remote: { now, exchanges } }, buildId: BUILD_ID },
          ),
        ),
      ),
  });
  return { status: response.status, body: await response.text() };
};
const send = (address: string, target: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const [host, port] = address.split(":");
    const outgoing = httpRequest(
      { host, port: Number(port), method: "GET", path: target },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

test("a view declaring the wire form of a transformed field is refused", async () => {
  const Wire = R.Struct({ id: R.String, name: R.String, points: R.String });
  const wirePage = R.fn(
    [R.Struct({ remote: R.Unknown, views: R.Struct({ scores: R.Remote.Page(Wire) }) })],
    Page,
    () =>
      H.renderToString(scoreDocument(Model.make({ scores: R.Array.empty(Item) })), {
        buildId: BUILD_ID,
      }),
  );
  const refused = await Effect.runPromise(
    NativeRemote.compile(group, {
      domain: Data,
      rows,
      pages: { template, render: wirePage, remote: plan },
    }).pipe(Effect.flip),
  );
  expect(refused.message).toContain("NativeRemote.pageViews(plan)");
});

test(
  "a transformed field reaches the native view decoded, as upstream's view sees it",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-page-decode-" });
          const artifact = yield* NativeRemote.compile(group, {
            domain: Data,
            rows,
            pages: { template, render: page, origin, remote: plan },
          });
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
          const { address } = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
            JSON.parse(ready.value),
          );
          const native = yield* Effect.promise(() => send(address, "/scores"));
          const payload = /data-foldkit-flags="app">(.*?)<\/script>/s.exec(native.body);
          const flags = Schema.decodeUnknownSync(Schema.toCodecJson(FlagsSchema))(
            JSON.parse(payload?.[1] ?? ""),
          );
          expect(native).toEqual(
            yield* Effect.promise(() => upstream("/scores", flags.remote.now)),
          );
          // The decoded points decided each class: 15 is high, 3 is low.
          expect(native.body).toContain('<li class="high">Ada</li><li class="low">Grace</li>');
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
