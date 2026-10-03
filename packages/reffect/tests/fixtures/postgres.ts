/**
 * A throwaway Postgres 18 server for the milestone 5 dialect tests (SQLX-017): one container per
 * test, published on a loopback port with a random password, removed when the scope closes.
 * The database collates by code point and lowercases all of Unicode (`PG_UNICODE_FAST`), so
 * results do not depend on the host's libc or ICU.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { Scope } from "effect";
import pg from "pg";

export const POSTGRES_IMAGE = "postgres:18.6-alpine";
const run = promisify(execFile);

/** Why Postgres tests cannot run here, or undefined when Docker answers. */
export const postgresUnavailable: string | undefined = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "pipe",
      timeout: 20000,
    });
    return undefined;
  } catch {
    return "Docker is not available; the Postgres dialect tests need it (SQLX-017)";
  }
})();

export interface PostgresServer {
  /** A connection URL for one database on this server. */
  readonly url: (database: string) => string;
  /** A new, empty database and a pool on it, closed with the scope. */
  readonly database: (name: string) => Effect.Effect<pg.Pool, never, Scope.Scope>;
}

const connect = async (url: string) => {
  // The entrypoint initializes on a socket only, so TCP answers once the real server is up.
  for (let attempt = 0; ; attempt++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("select 1");
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      if (attempt >= 120) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
};

export const postgresServer: Effect.Effect<PostgresServer, never, Scope.Scope> = Effect.gen(
  function* () {
    const password = randomBytes(16).toString("hex");
    const id = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const { stdout } = await run("docker", [
          "run",
          "-d",
          "--rm",
          "-p",
          "127.0.0.1::5432",
          "-e",
          `POSTGRES_PASSWORD=${password}`,
          "-e",
          "POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale-provider=builtin --builtin-locale=PG_UNICODE_FAST",
          POSTGRES_IMAGE,
        ]);
        return stdout.trim();
      }),
      (container) =>
        Effect.promise(() => run("docker", ["rm", "-f", container]).catch(() => undefined)),
    );
    const address = yield* Effect.promise(async () => {
      const { stdout } = await run("docker", ["port", id, "5432/tcp"]);
      return stdout.trim().split(/\r?\n/)[0];
    });
    const url = (database: string) => `postgres://postgres:${password}@${address}/${database}`;
    const admin = yield* Effect.acquireRelease(
      Effect.promise(() => connect(url("postgres"))),
      (client) => Effect.promise(() => client.end().catch(() => undefined)),
    );
    const database = (name: string) =>
      Effect.gen(function* () {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) return yield* Effect.die(`Bad database name ${name}`);
        yield* Effect.promise(() => admin.query(`create database ${name}`));
        return yield* Effect.acquireRelease(
          Effect.sync(() => new pg.Pool({ connectionString: url(name), max: 4 })),
          (pool) => Effect.promise(() => pool.end().catch(() => undefined)),
        );
      });
    return { url, database };
  },
);
