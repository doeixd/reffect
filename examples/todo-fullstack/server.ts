/**
 * The showcase server (milestone 9, M9-5): one native executable serving todo-remote's app over
 * SQLite. It renders the first screen from its own engine and hands the reads to the browser to
 * resume, answers Effect RPC (Read, Query, Mutate), runs the R mutation sources in one
 * transaction each, and streams Live changes after commit, with the snapshot that closes the
 * render-to-subscription gap (LIVE-015).
 *
 * With `auth`, every page and procedure needs a principal (#4): a browser signs in on the login
 * page with a configured token, which becomes an HttpOnly session cookie the page and the
 * hydrated app's RPC then carry.
 */
import { Context, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { RemoteRpc } from "foldkit-remote";
import { NativeRemote, NativeRpc } from "../../packages/reffect/src/index.ts";
import { Data } from "../todo-remote/domain.ts";
import { page, plan } from "../todo-remote/page.ts";
import { mutations } from "../todo-remote/sources.ts";
import { bindings, pgBindings } from "./db.ts";
import type { Dialect } from "./db.ts";

/** The variable the server reads its database URL from at run time; never compiled in. */
export const DATABASE_URL_ENV = "REFFECT_DATABASE_URL";
/** The variable the signed-in server reads its tokens from at run time; never compiled in. */
export const CREDENTIALS_ENV = "REFFECT_TODO_CREDENTIALS";

class CurrentUser extends Context.Service<CurrentUser, bigint>()("todo-fullstack/CurrentUser") {}
class Authentication extends RpcMiddleware.Service<Authentication, { provides: CurrentUser }>()(
  "todo-fullstack/Authentication",
  { error: Schema.Literal("Unauthorized") },
) {}

export const compileShowcase = (
  template: string,
  options: {
    readonly origin?: string;
    readonly loginPage?: string;
    /** The database the server runs on; SQLite by default. */
    readonly dialect?: Dialect;
    /** The RPC serialization, NDJSON by default; the browser must use the same one. */
    readonly serialization?: "ndjson" | "schema-binary";
    /** The RPC transport, HTTP by default; the browser must use the same one. */
    readonly transport?: "http" | "websocket";
  } = {},
) => {
  const pages = {
    template,
    render: page,
    remote: plan,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
  };
  const shared = {
    domain: Data,
    sql:
      options.dialect === "postgres"
        ? { dialect: "postgres" as const, bindings: pgBindings, databaseUrlEnv: DATABASE_URL_ENV }
        : { dialect: "sqlite" as const, bindings, databaseUrlEnv: DATABASE_URL_ENV },
    mutations,
    live: true,
    liveSnapshot: true,
    serialization: options.serialization ?? "ndjson",
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    pages,
  };
  return options.loginPage === undefined
    ? NativeRemote.compile(RemoteRpc, shared)
    : NativeRemote.compile(RemoteRpc.middleware(Authentication), {
        ...shared,
        auth: NativeRpc.bearer(Authentication, CurrentUser, {
          credentialsEnv: CREDENTIALS_ENV,
          session: { loginPage: options.loginPage },
        }),
      });
};
