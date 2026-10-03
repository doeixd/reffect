import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { RemoteRpc } from "foldkit-remote";
import { query, source } from "foldkit-remote-drizzle";
import { RemoteServer } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";
import { ByStatus, Search, domain } from "./fixtures/remote-sql-domain.ts";
import { sqlBackends } from "./fixtures/sql-database.ts";
import type { SqlBackend, SqlDatabase } from "./fixtures/sql-database.ts";

// Milestone 5 steps 3 and 5: Read and Query through SQLx on SQLite and Postgres, against the
// official server with upstream foldkit-remote-drizzle sources over the same database (SQLX-002).
const Group = RemoteRpc.omit("FoldkitRemoteLive", "FoldkitRemoteMutate");

const envelope = (tag: string, payload: unknown) =>
  JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] });
const read = (requests: unknown[]) => envelope("FoldkitRemoteRead", { version: 4, requests });
const ask = (name: string, input: unknown, window: object = {}, select?: object) =>
  envelope("FoldkitRemoteQuery", {
    query: name,
    input,
    window,
    ...(select === undefined ? {} : { select }),
  });
const projectFields = ["name", "rank", "done", "note", "owner"];
const ownerSelect = {
  entity: "Project",
  fields: ["name", "owner"],
  relations: { owner: { entity: "User", fields: ["name", "email"] } },
};
const corpus: ReadonlyArray<readonly [string, string]> = [
  [
    "one project with its owner",
    read([
      {
        entity: "Project",
        id: "p01",
        fields: projectFields,
        relations: { owner: { entity: "User", fields: ["name", "email"] } },
      },
    ]),
  ],
  [
    "a batch in mixed order with a missing id",
    read([
      { entity: "Project", id: "p09", fields: ["name"] },
      { entity: "Project", id: "p02", fields: ["name", "note"] },
      { entity: "Project", id: "zz", fields: ["name"] },
      { entity: "Project", id: "p05", fields: ["owner"] },
    ]),
  ],
  [
    "undeclared fields are settled",
    read([{ entity: "Project", id: "p01", fields: ["name", "nope", "ownerId"] }]),
  ],
  ["the id field", read([{ entity: "User", id: "u2", fields: ["id", "email"] }])],
  [
    "a window on a singular relation",
    read([{ entity: "Project", id: "p01", fields: ["owner"], windows: { owner: { first: 1 } } }]),
  ],
  ["an unknown entity", read([{ entity: "Nope", id: "x", fields: ["name"] }])],
  ["active, default window", ask("ByStatus", { status: "active" })],
  ["active, first 2", ask("ByStatus", { status: "active" }, { first: 2 })],
  ["active, after a cursor", ask("ByStatus", { status: "active" }, { first: 2, after: "p04" })],
  ["active, last 2", ask("ByStatus", { status: "active" }, { last: 2 })],
  ["active, before a cursor", ask("ByStatus", { status: "active" }, { last: 3, before: "p10" })],
  ["a cursor outside the query", ask("ByStatus", { status: "active" }, { first: 2, after: "p01" })],
  ["a cursor that is gone", ask("ByStatus", { status: "active" }, { first: 2, after: "zz" })],
  ["first and last together", ask("ByStatus", { status: "active" }, { first: 1, last: 1 })],
  ["first 0", ask("ByStatus", { status: "draft" }, { first: 0 })],
  ["a fractional window falls back", ask("ByStatus", { status: "draft" }, { first: 1.5 })],
  ["select through the owner", ask("ByStatus", { status: "draft" }, { first: 3 }, ownerSelect)],
  ["search ignores ASCII case", ask("Search", { term: "APOLLO" })],
  ["search for an underscore", ask("Search", { term: "_" })],
  // SQLite's lower() is ASCII-only; Postgres folds all of Unicode (SQLX-013).
  ["search folds per database", ask("Search", { term: "éCLIPSE" })],
  ["search for a percent", ask("Search", { term: "%" })],
  ["search for nothing", ask("Search", { term: "" })],
  ["input of the wrong kind", ask("Search", { term: 5 })],
  ["an unknown query", ask("Nope", {})],
];

const oracle = (db: SqlDatabase, bindings: SqlBackend["bindings"]) =>
  Effect.gen(function* () {
    const layer = db.layer;
    const server = RemoteServer.make({
      entities: [source(bindings.User), source(bindings.Project)],
      queries: [
        query(ByStatus, { entity: bindings.Project }),
        query(Search, { entity: bindings.Project }),
      ],
    });
    const handlers = RemoteServer.handlers(server, undefined);
    const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
      Effect.provide([
        Group.toLayer({
          FoldkitRemoteRead: (payload) =>
            handlers.FoldkitRemoteRead(payload).pipe(Effect.provide(layer)),
          FoldkitRemoteQuery: (payload) =>
            handlers.FoldkitRemoteQuery(payload).pipe(Effect.provide(layer)),
        }),
        RpcSerialization.layerJson,
      ]),
    );
    return HttpEffect.toWebHandler(http);
  });

for (const backend of sqlBackends)
  test.skipIf(backend.unavailable !== undefined)(
    `native Read and Query over ${backend.dialect} match upstream's Drizzle sources over the same database`,
    async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const open = yield* backend.databases;
            const db = yield* open("remote");
            const parent = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
              prefix: "reffect-remote-sql-",
            });
            const official = yield* oracle(db, backend.bindings);
            const officialPost = (body: string) =>
              Effect.promise(async () => {
                const response = await official(
                  new Request("http://reffect.test/rpc", { method: "POST", body }),
                );
                return { status: response.status, body: await response.text() };
              });
            const artifact = yield* NativeRemote.compile(Group, {
              domain,
              sql: {
                dialect: backend.dialect,
                bindings: backend.bindings,
                databaseUrlEnv: "REFFECT_DATABASE_URL",
              },
            });
            const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
            yield* CargoApi.fetch(directory);
            yield* CargoApi.build(directory, "debug");
            const child = yield* ChildProcess.make(
              `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
              ["--port", "0"],
              {
                env: { REFFECT_DATABASE_URL: db.readOnlyUrl },
                extendEnv: true,
              },
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
            const post = (body: string) =>
              Effect.promise(async () => {
                const response = await fetch(`http://${address}/rpc`, { method: "POST", body });
                return { status: response.status, body: await response.text() };
              });
            const answers = new Map<string, string>();
            for (const [label, body] of corpus) {
              const native = yield* post(body);
              const reference = yield* officialPost(body);
              answers.set(label, reference.body);
              expect(native.status, label).toBe(reference.status);
              expect(JSON.parse(native.body), label).toStrictEqual(JSON.parse(reference.body));
              expect(successValue(native.body), `${label} raw key order`).toStrictEqual(
                successValue(reference.body),
              );
            }
            // The paths are really reached, not only agreeing failures.
            const answer = (label: string) => answers.get(label) ?? "";
            expect(answer("one project with its owner")).toContain('"owner":"User:u2"');
            expect(answer("a window on a singular relation")).toContain("cannot be windowed");
            expect(answer("a cursor that is gone")).toContain("no longer resolves");
            expect(answer("first and last together")).toContain("cannot combine");
            expect(answer("select through the owner")).toContain('"entity":"User"');
            expect(answer("search for an underscore")).toContain('"id":"p05"');
            // foldkit-remote-drizzle 0.9.1 refuses a NUL search as a protocol defect; native answers
            // the same message as a typed RemoteQueryError (registered in native divergences).
            const nul = ask("Search", { term: "a\u0000b" });
            const message =
              '[foldkit-remote-drizzle] query \\"Search\\" searches for text holding a NUL character';
            const officialNul = (yield* officialPost(nul)).body;
            expect(officialNul).toContain('"_tag":"Defect"');
            expect(officialNul).toContain(message);
            const nativeNul = (yield* post(nul)).body;
            expect(nativeNul).toContain('"_tag":"RemoteQueryError"');
            expect(nativeNul).toContain(message);
            if (backend.dialect === "postgres")
              expect(answer("search folds per database")).toContain('"id":"p04"');
            else expect(answer("search folds per database")).toContain('"edges":[]');
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      );
    },
    nativeTestBudget(0) + 300000,
  );
