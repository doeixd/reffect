import { Context, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { RpcMiddleware, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity, Order, Relation } from "foldkit-entity";
import { Mutation, Query, Remote, RemoteRpc } from "foldkit-remote";
import { RemoteServer, RemoteServerError } from "foldkit-remote-server";
import { expect, test } from "vite-plus/test";
import { CargoApi, CompileError, NativeRemote, NativeRpc, R, Reference } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page, todoDocument } from "./fixtures/ssr-todos.ts";
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
const Group = RemoteRpc.omit("FoldkitRemoteLive").middleware(Authentication);
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
// RM-004c: a source's own policy reads the principal.
const Claim = Mutation.make("Claim", {
  Input: { note: Schema.String },
  Output: { admin: Schema.Boolean, note: Schema.String },
});
const domain = Remote.define({ entities: [User, Project], queries: [All], mutations: [Claim] });
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

const claim = NativeRemote.mutation(Claim, ({ input, principal }) =>
  R.Match.bool(
    is(principal, 3n),
    R.Effect.fail(NativeRemote.ServerError.make({ message: text("Guests cannot claim") })),
    R.Effect.succeed(
      NativeRemote.outcome(Claim).make({
        output: R.Struct({ admin: R.Bool, note: R.String }).make({
          admin: is(principal, 1n),
          note: R.Struct.get(input, "note"),
        }),
      }),
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
  ...["admin-token", "member-token", "guest-token"].map(
    (token) =>
      [
        `${token}: claim`,
        envelope(
          "FoldkitRemoteMutate",
          { requestId: "r", mutation: "Claim", input: { note: "é" } },
          token,
        ),
      ] as const,
  ),
  [
    "missing token, claim",
    envelope("FoldkitRemoteMutate", { requestId: "r", mutation: "Claim", input: { note: "" } }),
  ],
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
    mutations: [
      RemoteServer.mutation(Claim, ({ input, principal }) =>
        Reference.run(claim.fn, [principal, input]).pipe(
          Effect.catch((error) =>
            error instanceof CompileError
              ? Effect.die(error)
              : Effect.fail(
                  new RemoteServerError({
                    message: Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(
                      error,
                    ).message,
                  }),
                ),
          ),
          Effect.map(Schema.decodeUnknownSync(Schema.Struct({ output: Claim.Output }))),
        ),
      ),
    ],
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
        FoldkitRemoteMutate: (payload) =>
          Effect.flatMap(CurrentPrincipal, (principal) =>
            RemoteServer.handlers(server, principal).FoldkitRemoteMutate(payload),
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
  // A source reading the principal on a public Mutate has no principal to read.
  const publicMutate = await Effect.runPromise(
    NativeRemote.compile(Public, { domain, rows, auth, mutations: [claim] }).pipe(Effect.flip),
  );
  expect(publicMutate.message).toContain("needs Mutate to carry the auth middleware");
  expect(claim.principal).toBe(true);
});

// M9-3 step 2a: a page's reads run under the page request's own principal.
const pageRead = {
  version: 4,
  requests: [{ entity: "Project", id: "p1", fields: ["name", "budget"] }],
};
const PageTodo = R.Struct({ id: R.String, title: R.String, done: R.Bool });
// The page reads its URL and the exchanges it carries; it has no views (#13).
const PageRequest = R.Struct({ url: R.String, remote: R.Unknown });
const page = R.fn([PageRequest], Page, (request) =>
  R.Html.renderToString(
    {
      init: () =>
        R.Struct({ heading: R.String, todos: R.Array(PageTodo) }).make({
          heading: R.Struct.get(request, "url"),
          todos: R.Array.empty(PageTodo),
        }),
      view: todoDocument,
    },
    {
      buildId: BUILD_ID,
      flags: R.Struct({ remote: R.Unknown }).make({ remote: R.Struct.get(request, "remote") }),
    },
  ),
);
const pageTemplate =
  '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';

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
            mutations: [claim],
            pages: {
              template: pageTemplate,
              render: page,
              // A hand-written plan: one raw read and no views.
              remote: { reads: [{ _tag: "Read", request: pageRead }], views: {} },
            },
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
          expect(answer("admin-token: claim")).toContain('"admin":true');
          expect(answer("member-token: claim")).toContain('"admin":false');
          expect(answer("guest-token: claim")).toContain("Guests cannot claim");
          expect(answer("missing token, claim")).toContain("Unauthorized");

          // Pages: no bearer, no read; with one, the read RPC's own answer for that principal.
          const getPage = (token?: string, path = "/") =>
            Effect.promise(async () => {
              const response = await fetch(`http://${address}${path}`, {
                headers: token ? { authorization: `Bearer ${token}` } : {},
              });
              return {
                status: response.status,
                body: await response.text(),
                vary: response.headers.get("vary"),
              };
            });
          expect((yield* getPage()).status).toBe(401);
          // A negotiated page (not index.html) says what it varies by, even when refused (#28).
          const negotiated = yield* getPage(undefined, "/projects");
          expect(negotiated.status).toBe(401);
          expect(negotiated.vary).toBe("Accept, Sec-Fetch-Dest");
          expect((yield* getPage("not-a-token")).status).toBe(401);
          const pageAnswers: Array<string> = [];
          for (const token of ["admin-token", "member-token"]) {
            const rendered = yield* getPage(token);
            expect(rendered.status, token).toBe(200);
            const payload = /data-foldkit-flags="app">(.*?)<\/script>/s.exec(rendered.body);
            const recorded = JSON.parse(payload?.[1] ?? "null").remote.exchanges[0];
            expect(recorded.request, token).toStrictEqual(pageRead);
            const rpc = yield* post(read(token, "Project", "p1", ["name", "budget"]));
            expect(recorded.answer, token).toStrictEqual(JSON.parse(rpc.body)[0].exit.value);
            pageAnswers.push(JSON.stringify(recorded.answer));
          }
          // The member's page is denied the budget the admin's shows.
          expect(pageAnswers[0]).toContain('"budget":"10"');
          expect(pageAnswers[1]).not.toContain('"budget":"10"');
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);

// #4 (docs/research/cookie-sessions.md): the same configured tokens in a __Host- session cookie.
// The bearer path above is checked against the stock server; the cookie path must answer exactly
// as the bearer path does for the same token, and only where the CSRF rules admit it.
const sessionAuth = NativeRpc.bearer(Authentication, CurrentPrincipal, {
  credentialsEnv: "REFFECT_REMOTE_CREDENTIALS",
  session: { maxAge: 3600 },
});
const pageOrigin = "http://reffect.test";

test("session adapters are checked when compiled", async () => {
  expect(() =>
    NativeRpc.bearer(Authentication, CurrentPrincipal, {
      credentialsEnv: "REFFECT_REMOTE_CREDENTIALS",
      session: { cookie: "session" },
    }),
  ).toThrow(CompileError);
  expect(() =>
    NativeRpc.bearer(Authentication, CurrentPrincipal, {
      credentialsEnv: "REFFECT_REMOTE_CREDENTIALS",
      session: { maxAge: 0 },
    }),
  ).toThrow(CompileError);
  expect(() =>
    NativeRpc.bearer(Authentication, CurrentPrincipal, {
      credentialsEnv: "REFFECT_REMOTE_CREDENTIALS",
      session: { loginPage: "" },
    }),
  ).toThrow(CompileError);
  // A session cookie authenticates pages, so it needs them.
  const pageless = await Effect.runPromise(
    NativeRemote.compile(Group, {
      domain,
      rows,
      auth: sessionAuth,
      authorize: { User: authorizeUser, Project: authorizeProject },
      mutations: [claim],
    }).pipe(Effect.flip),
  );
  expect(pageless.message).toContain("give pages");
});

test(
  "a session cookie signs pages and same-origin RPC in, and nothing cross-site",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-session-" });
          const artifact = yield* NativeRemote.compile(Group, {
            domain,
            rows,
            auth: sessionAuth,
            authorize: { User: authorizeUser, Project: authorizeProject },
            mutations: [claim],
            pages: {
              template: pageTemplate,
              render: page,
              origin: pageOrigin,
              remote: { reads: [{ _tag: "Read", request: pageRead }], views: {} },
            },
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
          const { address } = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
            JSON.parse(ready.value),
          );
          const send = (path: string, init: RequestInit) =>
            Effect.promise(async () => {
              const response = await fetch(`http://${address}${path}`, init);
              return {
                status: response.status,
                body: await response.text(),
                cookie: response.headers.get("set-cookie"),
                vary: response.headers.get("vary"),
              };
            });
          const sameOrigin = { "sec-fetch-site": "same-origin" };

          // Login exchanges a configured bearer token for the cookie, from the page's own origin.
          const login = yield* send("/session", {
            method: "POST",
            headers: { ...sameOrigin, authorization: "Bearer member-token" },
          });
          expect(login.status).toBe(204);
          expect(login.cookie).toBe(
            "__Host-reffect-session=member-token; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600",
          );
          const refusedLogins: ReadonlyArray<readonly [string, Record<string, string>, number]> = [
            ["unknown token", { ...sameOrigin, authorization: "Bearer nope" }, 401],
            [
              "cross-site",
              { "sec-fetch-site": "cross-site", authorization: "Bearer member-token" },
              403,
            ],
            [
              "foreign origin",
              { origin: "http://evil.test", authorization: "Bearer member-token" },
              403,
            ],
          ];
          for (const [label, headers, status] of refusedLogins) {
            const refused = yield* send("/session", { method: "POST", headers });
            expect(refused.status, label).toBe(status);
            expect(refused.cookie, label).toBeNull();
          }
          // Without Fetch Metadata, the page's own Origin is accepted (OWASP's fallback).
          const viaOrigin = yield* send("/session", {
            method: "POST",
            headers: { origin: pageOrigin, authorization: "Bearer member-token" },
          });
          expect(viaOrigin.status).toBe(204);

          // Pages: the cookie reads as its token's principal; the page varies by Cookie.
          const cookie = { cookie: "__Host-reffect-session=member-token" };
          const viaCookie = yield* send("/", { headers: cookie });
          const viaBearer = yield* send("/", { headers: { authorization: "Bearer member-token" } });
          expect(viaCookie.status).toBe(200);
          const exchanges = (body: string) =>
            JSON.parse(/data-foldkit-flags="app">(.*?)<\/script>/s.exec(body)?.[1] ?? "null").remote
              .exchanges;
          expect(exchanges(viaCookie.body)).toStrictEqual(exchanges(viaBearer.body));
          expect((yield* send("/projects", { headers: cookie })).vary).toBe(
            "Accept, Sec-Fetch-Dest, Cookie",
          );
          const refusedPages: ReadonlyArray<readonly [string, string | undefined]> = [
            ["no cookie", undefined],
            ["forged", "__Host-reffect-session=forged-token"],
            [
              "sent twice",
              "__Host-reffect-session=member-token; __Host-reffect-session=admin-token",
            ],
            ["another name", "reffect-session=member-token"],
          ];
          for (const [label, value] of refusedPages) {
            const refused = yield* send("/", {
              headers: value === undefined ? {} : { cookie: value },
            });
            expect(refused.status, label).toBe(401);
          }

          // RPC: the cookie answers as the bearer only from the page's origin with the RPC body.
          const json = { "content-type": "application/json" };
          const rpc = (headers: Record<string, string>, body: string) =>
            send("/rpc", { method: "POST", headers, body });
          const plainRead = read(undefined, "Project", "p1", ["name", "budget"]);
          const bearer = yield* rpc(
            json,
            read("member-token", "Project", "p1", ["name", "budget"]),
          );
          const accepted = yield* rpc({ ...cookie, ...sameOrigin, ...json }, plainRead);
          expect(accepted.body).toBe(bearer.body);
          expect(accepted.body).toContain("Borealis");
          const mutation = envelope("FoldkitRemoteMutate", {
            requestId: "r",
            mutation: "Claim",
            input: { note: "n" },
          });
          const claimed = yield* rpc({ ...cookie, ...sameOrigin, ...json }, mutation);
          expect(claimed.body).toContain('"admin":false');
          const deniedRequests: ReadonlyArray<readonly [string, Record<string, string>]> = [
            ["cross-site", { ...cookie, ...json, "sec-fetch-site": "cross-site" }],
            ["same-site subdomain", { ...cookie, ...json, "sec-fetch-site": "same-site" }],
            ["foreign origin", { ...cookie, ...json, origin: "http://evil.test" }],
            ["no origin at all", { ...cookie, ...json }],
            ["a form's text/plain", { ...cookie, ...sameOrigin, "content-type": "text/plain" }],
            ["no content type", { ...cookie, ...sameOrigin }],
            [
              "a wrong bearer beside the cookie",
              { ...cookie, ...sameOrigin, ...json, authorization: "Bearer nope" },
            ],
          ];
          for (const [label, headers] of deniedRequests) {
            const denied = yield* rpc(headers, mutation);
            expect(denied.body, label).toContain("Unauthorized");
            expect(denied.body, label).not.toContain('"admin"');
          }

          // Logout clears the cookie, from the page's own origin only.
          const logout = yield* send("/session", { method: "DELETE", headers: sameOrigin });
          expect(logout.status).toBe(204);
          expect(logout.cookie).toBe(
            "__Host-reffect-session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
          );
          const crossLogout = yield* send("/session", {
            method: "DELETE",
            headers: { "sec-fetch-site": "cross-site" },
          });
          expect(crossLogout.status).toBe(403);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
