import { Effect } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import { CompileError, fail } from "./kernel.ts";
import { compileServer } from "./native-rpc.ts";
import type { RpcArtifact } from "./native-rpc.ts";
import { remoteEngineRuntime } from "./remote-engine.ts";
import { Rs } from "./rust-emit.ts";

/** One entity's rows in their wire shape (`foldkit-remote-server`'s `MemoryRows`). */
export type MemoryRows = {
  readonly [entity: string]: ReadonlyArray<
    { readonly id: string | number } & Record<string, unknown>
  >;
};
export interface NativeRemoteOptions {
  /** The domain's entity names: the memory backend serves exactly these (its registry). */
  readonly entities: readonly string[];
  readonly rows: MemoryRows;
}

const unsupported = (path: string, message: string) =>
  fail("REMOTE_UNSUPPORTED", "remote", path, message);
const READ = "FoldkitRemoteRead";

// Rows must be JSON data, and relation lists string refs: the profile the port reproduces (NR-011).
const tables = (rows: MemoryRows): [string, [string, Record<string, unknown>][]][] =>
  Object.entries(rows).map(([entity, list]) => {
    const table = new Map<string, Record<string, unknown>>();
    for (const row of list) {
      const copy: Record<string, unknown> = { ...row };
      const json: unknown = JSON.parse(JSON.stringify(copy));
      if (JSON.stringify(json) !== JSON.stringify(copy) || !isDeepJson(copy))
        throw unsupported(`rows.${entity}`, "Memory rows must be JSON data");
      for (const [field, value] of Object.entries(copy))
        if (Array.isArray(value) && value.some((item) => typeof item !== "string"))
          throw unsupported(
            `rows.${entity}.${field}`,
            "Array fields of memory rows must hold string refs in this profile",
          );
      table.set(String(row.id), copy);
    }
    return [entity, Array.from(table)];
  });
const isDeepJson = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) ||
  (Array.isArray(value) && value.every(isDeepJson)) ||
  (typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value as object).every(isDeepJson));

/**
 * Compile a native Foldkit Remote server for the unchanged `foldkit-remote` wire group, backed by
 * memory rows (NR-004, NR-012). `FoldkitRemoteRead` is served by the ported read engine;
 * Mutate and Query wait for steps 3–4, and streaming `Live` for milestones 6–7.
 */
const compile = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options: NativeRemoteOptions,
): Effect.Effect<RpcArtifact, CompileError> =>
  Effect.gen(function* () {
    const memory = yield* Effect.try({
      try: () => {
        for (const tag of group.requests.keys())
          if (tag !== READ)
            throw unsupported(
              `rpc.${tag}`,
              tag === "FoldkitRemoteLive"
                ? "Streaming Live is deferred to milestones 6–7 (NR-006)"
                : "Only FoldkitRemoteRead is served natively so far",
            );
        if (!group.requests.has(READ)) throw unsupported("group", "Expected FoldkitRemoteRead");
        const entities = Array.from(new Set(options.entities));
        if (entities.some((entity) => typeof entity !== "string"))
          throw unsupported("entities", "Entity names are strings");
        return { entities, rows: JSON.stringify(Object.fromEntries(tables(options.rows))) };
      },
      catch: (cause) =>
        cause instanceof CompileError ? cause : unsupported("rows", String(cause)),
    });
    const names = memory.entities.map((entity) => `${Rs.stringLiteral(entity).text}.to_string()`);
    const server = `static REMOTE_ROWS: &str = ${Rs.stringLiteral(memory.rows).text};
static REMOTE_MEMORY: std::sync::OnceLock<remote_engine::Memory> = std::sync::OnceLock::new();
fn remote_memory() -> &'static remote_engine::Memory {
    REMOTE_MEMORY.get_or_init(|| remote_engine::Memory::new(vec![${names.join(", ")}], &serde_json::from_str(REMOTE_ROWS).expect("embedded rows are JSON")))
}`;
    return yield* compileServer(
      group,
      {},
      {},
      {
        procedures: { [READ]: { call: "remote_engine::read(remote_memory(), payload)" } },
        modules: [remoteEngineRuntime, server],
        dependencies: ['ryu-js = { version = "=1.0.3", default-features = false }\n'],
        crates: ["ryu-js@1.0.3"],
      },
    );
  });

export const NativeRemote = Object.freeze({ compile });
