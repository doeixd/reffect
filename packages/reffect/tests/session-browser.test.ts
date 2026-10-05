/**
 * #4 step 4: session cookies in a real browser (headless Chrome over CDP). The server-side rules
 * are covered in remote-auth.test.ts; this checks what Chrome itself does with them: it stores the
 * __Host- cookie on loopback, keeps it from script (HttpOnly), sends it on navigations and on
 * same-origin RPC, and also sends it from another port of the same host, which is same-site, so
 * only the server's Fetch Metadata check refuses that request.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Context, Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { RpcMiddleware } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { Entity, Order } from "foldkit-entity";
import { Query, Remote, RemoteRpc } from "foldkit-remote";
import { expect, test } from "vite-plus/test";
import { CargoApi, NativeRemote, NativeRpc, R } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { BUILD_ID, Page, todoDocument } from "./fixtures/ssr-todos.ts";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

class CurrentPrincipal extends Context.Service<CurrentPrincipal, bigint>()(
  "reffect/test/SessionPrincipal",
) {}
class Authentication extends RpcMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal }
>()("reffect/test/SessionAuthentication", { error: Schema.Literal("Unauthorized") }) {}
const Group = RemoteRpc.omit("FoldkitRemoteLive", "FoldkitRemoteMutate").middleware(Authentication);
const Note = Entity.define("Note", Schema.Struct({ id: Schema.String, text: Schema.String }));
const Notes = Query.define("Notes", {}, () =>
  Query.from(Note).pipe(Query.orderBy(Order.asc(Note.fields.text))),
);
const domain = Remote.define({ entities: [Note], queries: [Notes] });
const rows = { Note: [{ id: "n1", text: "Signed in by cookie" }] };
const noteRead = { version: 4, requests: [{ entity: "Note", id: "n1", fields: ["text"] }] };
const PageTodo = R.Struct({ id: R.String, title: R.String, done: R.Bool });
const page = R.fn([R.Struct({ url: R.String, remote: R.Unknown })], Page, (request) =>
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
const template =
  '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>';
const credentials = [{ token: "member-token", principal: "2" }];
const rpcRead = JSON.stringify({
  _tag: "Request",
  id: "1",
  tag: "FoldkitRemoteRead",
  payload: noteRead,
  headers: [],
});

/** A minimal CDP client over Chrome's own WebSocket endpoint. */
const chrome = async (port: number) => {
  const profile = mkdtempSync(join(tmpdir(), "reffect-cdp-"));
  const browser = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let socketUrl: string | undefined;
  for (let i = 0; i < 100 && socketUrl === undefined; i++) {
    try {
      const targets: ReadonlyArray<{ type: string; webSocketDebuggerUrl: string }> = await (
        await fetch(`http://127.0.0.1:${port}/json`)
      ).json();
      socketUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  if (socketUrl === undefined) throw new Error("Chrome did not start");
  const socket = new WebSocket(socketUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  let next = 0;
  const pending = new Map<number, (result: unknown) => void>();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === "number") pending.get(message.id)?.(message.result);
    else events.push(message);
  });
  const send = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      pending.set(id, (result) => resolve((result ?? {}) as Record<string, unknown>));
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return (result.result as { value?: unknown } | undefined)?.value;
  };
  /** Navigates and resolves with the document's status once it has loaded. */
  const navigate = async (url: string): Promise<number> => {
    const from = events.length;
    await send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      const loaded = events.slice(from).some((event) => event.method === "Page.loadEventFired");
      const response = events
        .slice(from)
        .find(
          (event) =>
            event.method === "Network.responseReceived" &&
            (event.params as { type?: string }).type === "Document",
        );
      if (loaded && response)
        return (response.params as { response: { status: number } }).response.status;
      await sleep(50);
    }
    throw new Error(`No document for ${url}`);
  };
  await send("Network.enable");
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    send,
    evaluate,
    navigate,
    events,
    sleep,
    // Chrome holds its profile until it has exited (Windows refuses to delete it before).
    close: async () => {
      socket.close();
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
};

test.skipIf(!existsSync(CHROME))(
  "Chrome keeps the session cookie from script and its cross-port posts are refused",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-session-browser-" });
          const artifact = yield* NativeRemote.compile(Group, {
            domain,
            rows,
            auth: NativeRpc.bearer(Authentication, CurrentPrincipal, {
              credentialsEnv: "REFFECT_SESSION_CREDENTIALS",
              session: true,
            }),
            pages: {
              template,
              render: page,
              remote: { reads: [{ _tag: "Read", request: noteRead }], views: {} },
            },
          });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
            { env: { REFFECT_SESSION_CREDENTIALS: JSON.stringify(credentials) }, extendEnv: true },
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
            JSON.parse(ready.value),
          );
          const site = `http://${address}`;

          // Another port of the same host: cross-origin, but the same site.
          const attacker = createServer((_request, response) => {
            response.setHeader("content-type", "text/html");
            response.end("<!doctype html><title>other port</title>");
          });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => attacker.listen(0, "127.0.0.1", resolve)),
          );
          yield* Effect.addFinalizer(() => Effect.sync(() => attacker.close()));
          const attackerPort = (attacker.address() as AddressInfo).port;

          const browser = yield* Effect.promise(() => chrome(9400 + (process.pid % 500)));
          yield* Effect.addFinalizer(() => Effect.promise(browser.close));
          yield* Effect.promise(async () => {
            expect(await browser.navigate(`${site}/`)).toBe(401);
            // An empty 401 shows Chrome's own error page, so the site's origin is first opened
            // with a bearer header; from then on only the cookie is sent.
            await browser.send("Network.setExtraHTTPHeaders", {
              headers: { authorization: "Bearer member-token" },
            });
            expect(await browser.navigate(`${site}/`)).toBe(200);
            await browser.send("Network.setExtraHTTPHeaders", { headers: {} });
            // Login from the page's own origin: Chrome sends Sec-Fetch-Site: same-origin.
            const login = await browser.evaluate(
              `fetch("/session", { method: "POST", headers: { authorization: "Bearer member-token" } }).then((r) => r.status)`,
            );
            expect(login).toBe(204);
            // HttpOnly: the token never reaches script.
            expect(await browser.evaluate("document.cookie")).toBe("");
            expect(await browser.navigate(`${site}/`)).toBe(200);
            expect(
              await browser.evaluate(`document.querySelector("[data-foldkit-app]") !== null`),
            ).toBe(true);
            // The hydrated client's same-origin RPC carries the cookie and nothing else.
            const read = await browser.evaluate(
              `fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(rpcRead)} }).then((r) => r.text())`,
            );
            expect(read).toContain("Signed in by cookie");

            // From another port of the same host, Chrome sends the cookie (SameSite=Lax allows
            // same-site requests) with Sec-Fetch-Site: same-site; the server refuses it.
            expect(await browser.navigate(`http://127.0.0.1:${attackerPort}/`)).toBe(200);
            const from = browser.events.length;
            await browser.evaluate(
              `fetch(${JSON.stringify(`${site}/rpc`)}, { method: "POST", mode: "no-cors", credentials: "include", body: ${JSON.stringify(rpcRead)} }).then(() => true)`,
            );
            await browser.sleep(300);
            // The headers Chrome actually sent: the extra-info event of the /rpc request.
            const posted = browser.events
              .slice(from)
              .find(
                (event) =>
                  event.method === "Network.requestWillBeSent" &&
                  (event.params as { request: { url: string } }).request.url === `${site}/rpc`,
              );
            const postedId = (posted?.params as { requestId?: string } | undefined)?.requestId;
            const sent = browser.events
              .slice(from)
              .find(
                (event) =>
                  event.method === "Network.requestWillBeSentExtraInfo" &&
                  (event.params as { requestId?: string }).requestId === postedId,
              );
            // CDP reports the names as sent on the wire, so they are matched without case.
            const headers = new Map(
              Object.entries(
                (sent?.params as { headers?: Record<string, string> } | undefined)?.headers ?? {},
              ).map(([name, value]) => [name.toLowerCase(), value] as const),
            );
            expect(headers.get("cookie")).toBe("__Host-reffect-session=member-token");
            expect(headers.get("sec-fetch-site")).toBe("same-site");
            const response = browser.events
              .slice(from)
              .find(
                (event) =>
                  event.method === "Network.responseReceived" &&
                  (event.params as { response: { url: string } }).response.url === `${site}/rpc`,
              );
            const requestId = (response?.params as { requestId?: string } | undefined)?.requestId;
            const body = await browser.send("Network.getResponseBody", { requestId });
            expect(String(body.body)).toContain("Unauthorized");
            expect(String(body.body)).not.toContain("Signed in by cookie");

            // Logout from the page's own origin clears the cookie.
            expect(await browser.navigate(`${site}/`)).toBe(200);
            const logout = await browser.evaluate(
              `fetch("/session", { method: "DELETE" }).then((r) => r.status)`,
            );
            expect(logout).toBe(204);
            expect(await browser.navigate(`${site}/`)).toBe(401);
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 180000,
);
