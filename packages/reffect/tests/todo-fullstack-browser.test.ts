/**
 * #4 in the showcase: todo-fullstack started with auth, its browser app served by Vite (as
 * `vp dev examples/todo-remote/web`) and driven in headless Chrome. A browser without the
 * session cookie gets the login page (401); signing in with the configured token sets the
 * HttpOnly cookie, the page renders and hydrates, a toggle commits through RPC authenticated by
 * the cookie alone, and the change survives a reload. Skipped without Chrome.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { createServer } from "vite-plus";
import { expect, test } from "vite-plus/test";
import { CargoApi } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";
import { CHROME, chrome } from "./fixtures/cdp.ts";
import {
  CREDENTIALS_ENV,
  DATABASE_URL_ENV,
  compileShowcase,
} from "../../../examples/todo-fullstack/server.ts";
import { seed, sqliteUrl } from "../../../examples/todo-fullstack/db.ts";

const examples = resolve(process.cwd(), "../../examples");
const template = readFileSync(`${examples}/todo-remote/web/index.html`, "utf8");
const loginPage = readFileSync(`${examples}/todo-fullstack/login.html`, "utf8");
const token = "showcase-test-token";

test.skipIf(!existsSync(CHROME))(
  "the signed-in showcase: login page, cookie, hydration and a toggle in Chrome",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-showcase-auth-" });
          const database = `${parent}/todos.db`;
          seed(database);
          const artifact = yield* compileShowcase(template, { loginPage });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
            {
              env: {
                [DATABASE_URL_ENV]: sqliteUrl(database),
                [CREDENTIALS_ENV]: JSON.stringify([{ token, principal: "1" }]),
              },
              extendEnv: true,
            },
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(Schema.Struct({ address: Schema.String }))(
            JSON.parse(ready.value),
          );

          // The browser app, as `vp dev` serves it, forwarding pages, /rpc and /session.
          process.env.TODO_REMOTE_PORT = address.split(":")[1];
          const vite = yield* Effect.promise(() =>
            createServer({
              root: `${examples}/todo-remote/web`,
              logLevel: "silent",
              server: { host: "127.0.0.1", port: 0, strictPort: false },
            }),
          );
          yield* Effect.addFinalizer(() => Effect.promise(() => vite.close()));
          yield* Effect.promise(() => vite.listen());
          const listening = vite.httpServer?.address();
          if (listening === null || listening === undefined || typeof listening === "string")
            throw new Error("Vite is not listening on a port");
          const site = `http://127.0.0.1:${listening.port}`;

          const browser = yield* Effect.promise(() => chrome(9500 + (process.pid % 300)));
          yield* Effect.addFinalizer(() => Effect.promise(browser.close));
          const until = async (expression: string, what: string) => {
            for (let i = 0; i < 300; i++) {
              if ((await browser.evaluate(expression)) === true) return;
              await browser.sleep(200);
            }
            throw new Error(`Timed out waiting for ${what}`);
          };
          const todos = () =>
            browser.evaluate(
              `[...document.querySelectorAll("#todos li")].map((li) => li.dataset.id + ":" + li.className)`,
            );
          yield* Effect.promise(async () => {
            // No cookie: the login page, still a 401.
            expect(await browser.navigate(`${site}/`)).toBe(401);
            expect(await browser.evaluate("document.title")).toBe("Sign in");
            await browser.evaluate(
              `document.getElementById("token").value = ${JSON.stringify(token)};
               document.getElementById("login").requestSubmit(); true`,
            );
            // The login reloads the page, which now renders the app.
            await until(`document.querySelector("[data-foldkit-app]") !== null`, "the app page");
            expect(await browser.evaluate("document.title")).toBe("Native Remote todos");
            expect(await browser.evaluate("document.cookie")).toBe("");
            // Ordered by title: "Compile it natively" (t2), then "Write the domain" (t1).
            expect(await todos()).toEqual(["t2:open", "t1:done"]);
            // The hydrated app toggles t2 through RPC, authenticated by the cookie alone. Vite
            // compiles the client on first load, so the page is given time to hydrate.
            await browser.sleep(4000);
            await browser.evaluate(
              `document.querySelector('li[data-id="t2"] input').click(); true`,
            );
            await until(
              `document.querySelector('li[data-id="t2"]')?.className === "done"`,
              "the toggle",
            );
            // The commit survives a reload, which renders it on the server.
            expect(await browser.navigate(`${site}/`)).toBe(200);
            expect(await todos()).toEqual(["t2:done", "t1:done"]);
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
