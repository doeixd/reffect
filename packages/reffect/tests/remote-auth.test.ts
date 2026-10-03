import { Context, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcMiddleware, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity, Order, Relation } from "foldkit-entity";
import { Query, Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { successValue } from "./raw-json.ts";
import { memoryQueryRun, memoryRead, memoryTables } from "./fixtures/foldkit-remote-memory.ts";

// RM-004: authentication by the checked bearer adapter, field authorization as R functions,
// against `RemoteServer.handlers` bound per request to the middleware's principal.
class CurrentPrincipal extends Context.Service<CurrentPrincipal, bigint>()(
  "reffect/test/RemotePrincipal",
) {}
class Authentication extends RpcMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal }
>()("reffect/test/RemoteAuthentication", { error: Schema.Literal("Unauthorized") }) {}
const Group = RemoteRpc.omit("FoldkitRemoteLive", "FoldkitRemoteMutate").middleware(Authentication);
const auth = NativeRpc.bearer(Authentication, CurrentPrincipal, {
  credentialsEnv: "REFFECT_REMOTE_CREDENTIALS",
});
const credentials = [
  { token: "admin-token", principal: "1" },
  { token: "member-token", principal: "2" },
  { token: "guest-token", principal: "3" },
];

const UserBase = Entity.define(
  "User",
  Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
);
const ProjectBase = Entity.define(
  "Project",
  Schema.Struct({ id: Schema.String, name: Schema.String, budget: Schema.String }),
);
const { User, Project } = Entity.relate(
  { User: UserBase, Project: ProjectBase },
  { Project: { owner: Relation.one(UserBase) } },
);
const All = Query.define("All", {}, () =>
  Query.from(Project).pipe(Query.orderBy(Order.asc(Project.fields.name))),
);
const domain = Remote.define({ entities: [User, Project], queries: [All] });
const rows = {
  User: [
    { id: "u1", name: "Ada", email: "ada@example.test" },
    { id: "u2", name: "Grace", email: "grace@example.test" },
  ],
  Project: [
    { id: "p1", name: "Borealis", budget: "10", owner: "User:u1" },
    { id: "p2", name: "Apollo", budget: "20", owner: "User:u2" },
  ],
};

const text = (value: string) => R.String.literal(value);
const is = (principal: Parameters<typeof R.U64.eq>[0], id: bigint) =>
  R.U64.eq(principal, R.U64.literal(id));
// Admins read everything; members never see emails; guests read no user field at all.
const authorizeUser = R.fn([R.U64, R.Array(R.String)], R.Array(R.String), (principal, fields) =>
  R.Array.filter(fields, (field) =>
    R.Match.bool(
      is(principal, 1n),
      R.Bool.literal(true),
      R.Boolean.and(R.Bool.not(is(principal, 3n)), R.Bool.not(R.String.eq(field, text("email")))),
    ),
  ),
);
// Guests may not follow `owner`, and no one reads `budget` but admins.
const authorizeProject = R.fn([R.U64, R.Array(R.String)], R.Array(R.String), (principal, fields) =>
  R.Array.filter(fields, (field) =>
    R.Match.bool(
      is(principal, 1n),
      R.Bool.literal(true),
      R.Boolean.and(
        R.Bool.not(R.String.eq(field, text("budget"))),
        R.Bool.not(R.Boolean.and(is(principal, 3n), R.String.eq(field, text("owner")))),
      ),
    ),
  ),
);

const envelope = (tag: string, payload: unknown, token?: string) =>
  JSON.stringify({
    _tag: "Request",
    id: "1",
    tag,
    payload,
    headers: token === undefined ? [] : [["authorization", `Bearer ${token}`]],
  });
const read = (
  token: string | undefined,
  entity: string,
  id: string,
  fields: string[],
  relations?: object,
) =>
  envelope(
    "FoldkitRemoteRead",
    { version: 4, requests: [{ entity, id, fields, ...(relations ? { relations } : {}) }] },
    token,
  );
const projectWithOwner = (token: string | undefined) =>
  read(token, "Project", "p1", ["name", "budget", "owner"], {
    owner: { entity: "User", fields: ["name", "email"] },
  });
const query = (token: string | undefined) =>
  envelope(
    "FoldkitRemoteQuery",
    {
      query: "All",
      input: {},
      window: {},
      select: {
        entity: "Project",
        fields: ["name", "budget", "owner"],
        relations: { owner: { entity: "User", fields: ["email", "name"] } },
      },
    },
    token,
  );
const corpus: ReadonlyArray<readonly [string, string]> = [
  ...["admin-token", "member-token", "guest-token"].flatMap((token) => [
    [`${token}: project with owner`, projectWithOwner(token)] as const,
    [`${token}: query select`, query(token)] as const,
    [`${token}: a user's email`, read(token, "User", "u1", ["email"])] as const,
  ]),
  ["missing token", projectWithOwner(undefined)],
  ["wrong token", projectWithOwner("nope")],
  ["missing token, query", query(undefined)],
];

const oracle = Effect.gen(function* () {
  const tables = memoryTables(rows);
  const authorizer =
    (fn: typeof authorizeUser) => (principal: bigint, fields: ReadonlyArray<string>) =>
      Effect.runSync(Reference.run(fn, [principal, fields]).pipe(Effect.orDie));
  const server = RemoteServer.make<bigint>({
    entities: [
      RemoteServer.entity<bigint>(
        { name: "User" },
        { read: memoryRead(tables, "User"), authorize: authorizer(authorizeUser) },
      ),
      RemoteServer.entity<bigint>(
        { name: "Project" },
        { read: memoryRead(tables, "Project"), authorize: authorizer(authorizeProject) },
      ),
    ],
    queries: [RemoteServer.query(All, memoryQueryRun(tables, All))],
  });
  const authentication = Layer.succeed(Authentication, (effect, metadata) => {
    const token =
      metadata.headers.authorization?.slice(0, 7).toLowerCase() === "bearer "
        ? metadata.headers.authorization.slice(7)
        : undefined;
    const credential = credentials.find((c) => c.token === token);
    if (!credential) return Effect.fail("Unauthorized" as const);
    return effect.pipe(Effect.provideService(CurrentPrincipal, BigInt(credential.principal)));
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([
      Group.toLayer({
        // `handlers` binds one principal, so each request binds the middleware's.
        FoldkitRemoteRead: (payload) =>
          Effect.flatMap(CurrentPrincipal, (principal) =>
            RemoteServer.handlers(server, principal).FoldkitRemoteRead(payload),
          ),
        FoldkitRemoteQuery: (payload) =>
          Effect.flatMap(CurrentPrincipal, (principal) =>
            RemoteServer.handlers(server, principal).FoldkitRemoteQuery(payload),
          ),
      }),
      authentication,
      RpcSerialization.layerJson,
    ]),
  );
  return HttpEffect.toWebHandler(http);
});

test("authorize needs auth, matching functions and protected reads", async () => {
  const missingAuth = await Effect.runPromise(
    NativeRemote.compile(Group, { domain, rows, authorize: { User: authorizeUser } }).pipe(
      Effect.flip,
    ),
  );
  expect(missingAuth.message).toContain("authenticated principal");
  const unknownEntity = await Effect.runPromise(
    NativeRemote.compile(Group, { domain, rows, auth, authorize: { Nope: authorizeUser } }).pipe(
      Effect.flip,
    ),
  );
  expect(unknownEntity.message).toContain("no entity Nope");
  const Public = RemoteRpc.omit("FoldkitRemoteLive", "FoldkitRemoteMutate");
  const unprotected = await Effect.runPromise(
    NativeRemote.compile(Public, { domain, rows, auth, authorize: { User: authorizeUser } }).pipe(
      Effect.flip,
    ),
  );
  expect(unprotected.message).toContain("must carry the auth middleware");
});

test(
  "native field authorization matches RemoteServer.handlers bound to each principal",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const official = yield* oracle;
          const officialPost = (body: string) =>
            Effect.promise(async () => {
              const response = await official(
                new Request("http://reffect.test/rpc", { method: "POST", body }),
              );
              return { status: response.status, body: await response.text() };
            });
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-remote-auth-" });
          const artifact = yield* NativeRemote.compile(Group, {
            domain,
            rows,
            auth,
            authorize: { User: authorizeUser, Project: authorizeProject },
          });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
            { env: { REFFECT_REMOTE_CREDENTIALS: JSON.stringify(credentials) }, extendEnv: true },
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
          // Each principal sees a different answer, so authorization is really exercised.
          const answer = (label: string) => answers.get(label) ?? "";
          expect(answer("admin-token: project with owner")).toContain("ada@example.test");
          expect(answer("member-token: project with owner")).not.toContain("ada@example.test");
          // Withheld fields are settled by name, never answered.
          expect(answer("member-token: project with owner")).not.toContain('"budget":"10"');
          expect(answer("member-token: project with owner")).toContain('"fields":["budget"]');
          expect(answer("guest-token: project with owner")).not.toContain('"Ada"');
          expect(answer("guest-token: a user's email")).toContain('"entities":[]');
          expect(answer("missing token")).toContain("Unauthorized");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
