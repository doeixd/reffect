/**
 * The showcase server (milestone 9, M9-5): one native executable serving todo-remote's app over
 * SQLite. It renders the first screen from its own engine and hands the reads to the browser to
 * resume, answers Effect RPC (Read, Query, Mutate), runs the R mutation sources in one
 * transaction each, and streams Live changes after commit, with the snapshot that closes the
 * render-to-subscription gap (LIVE-015).
 */
import { RemoteRpc } from "foldkit-remote";
import { NativeRemote } from "../../packages/reffect/src/index.ts";
import { Data } from "../todo-remote/domain.ts";
import { page, plan } from "../todo-remote/page.ts";
import { mutations } from "../todo-remote/sources.ts";
import { bindings } from "./db.ts";

/** The variable the server reads its database URL from at run time; never compiled in. */
export const DATABASE_URL_ENV = "REFFECT_DATABASE_URL";

export const compileShowcase = (template: string, origin?: string) =>
  NativeRemote.compile(RemoteRpc, {
    domain: Data,
    sql: { dialect: "sqlite", bindings, databaseUrlEnv: DATABASE_URL_ENV },
    mutations,
    live: true,
    liveSnapshot: true,
    serialization: "ndjson",
    pages: { template, render: page, remote: plan, ...(origin === undefined ? {} : { origin }) },
  });
