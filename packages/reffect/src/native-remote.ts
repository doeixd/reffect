import { Effect, SchemaAST } from "effect";
import type { Schema } from "effect";
import type { Rpc, RpcGroup } from "effect/rpc";
import type { AnyQuery } from "foldkit-entity";
import { Foldkit } from "./foldkit.ts";
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
/** The part of a `Remote.define`/`Remote.make` descriptor the memory backend reads (NR-014). */
export interface RemoteDomain {
  readonly registry: {
    readonly entities: ReadonlyMap<string, unknown>;
    readonly queries: ReadonlyMap<
      string,
      { readonly name: string; readonly Input: Schema.Top; readonly body?: AnyQuery | undefined }
    >;
  };
}
export interface NativeRemoteOptions {
  readonly domain: RemoteDomain;
  readonly rows: MemoryRows;
  /**
   * Request hardening (docs/native-divergences.md). Remote batches whole screens into one Read,
   * so the body limit defaults to 4 MiB rather than NativeRpc's 64 KiB.
   */
  readonly limits?: { readonly bodyBytes?: number; readonly batch?: number };
}

const unsupported = (path: string, message: string) =>
  fail("REMOTE_UNSUPPORTED", "remote", path, message);
const READ = "FoldkitRemoteRead";
const QUERY = "FoldkitRemoteQuery";

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

// `Schema.decodeUnknown` of a Struct of primitives (NR-015): required keys whose values are the
// plain JS kinds or literals the field admits; excess keys are ignored; encoding is the identity.
const primitiveTest = (ast: SchemaAST.AST, value: string, path: string): string => {
  const plain = !ast.checks && !ast.encoding && !ast.context;
  if (plain && SchemaAST.isString(ast)) return `${value}.is_string()`;
  if (plain && SchemaAST.isNumber(ast)) return `${value}.is_number()`;
  if (plain && SchemaAST.isBoolean(ast)) return `${value}.is_boolean()`;
  if (plain && SchemaAST.isNull(ast)) return `${value}.is_null()`;
  if (plain && SchemaAST.isLiteral(ast)) {
    const literal = ast.literal;
    if (typeof literal === "string")
      return `${value}.as_str() == Some(${Rs.stringLiteral(literal).text})`;
    if (typeof literal === "boolean") return `${value}.as_bool() == Some(${literal})`;
    if (typeof literal === "number" && Number.isFinite(literal))
      return `${value}.as_f64() == Some(${Number.isInteger(literal) ? `${literal}.0` : String(literal)})`;
  }
  if (plain && SchemaAST.isUnion(ast) && ast.types.length)
    return `(${ast.types.map((member, i) => primitiveTest(member, value, `${path}[${i}]`)).join(" || ")})`;
  throw unsupported(path, "Query inputs must be Structs of plain primitive fields in this profile");
};
const inputValidator = (name: string, input: Schema.Top, index: number): string => {
  const ast = input.ast;
  if (!SchemaAST.isObjects(ast) || ast.indexSignatures.length || ast.checks || ast.encoding)
    throw unsupported(`queries.${name}.Input`, "Query inputs must be plain Structs");
  const tests = ast.propertySignatures.map((property) => {
    const key = String(property.name);
    if (typeof property.name !== "string" || property.type.context?.isOptional)
      throw unsupported(`queries.${name}.Input.${key}`, "Query input fields must be required");
    return `match object.get(${Rs.stringLiteral(key).text}) { Some(value) => ${primitiveTest(property.type, "value", `queries.${name}.Input.${key}`)}, None => false }`;
  });
  return `fn remote_query_valid_${index}(input: &serde_json::Value) -> bool {\n    let Some(object) = input.as_object() else { return false };\n    true${tests.map((test) => ` && (${test})`).join("")}\n}`;
};
// Memory rows must stay within each query's field kinds, so the evaluator never refuses a row.
const checkRows = (
  name: string,
  entity: string,
  fields: readonly { readonly key: string; readonly kinds: readonly string[] }[],
  rows: readonly [string, Record<string, unknown>][],
) => {
  for (const [id, row] of rows)
    for (const field of fields) {
      const value = row[field.key];
      if (value === null || value === undefined) continue;
      if (!field.kinds.includes(typeof value))
        throw unsupported(
          `rows.${entity}.${id}.${field.key}`,
          `Row value is outside the kinds query ${name} reads (${field.kinds.join(", ")})`,
        );
    }
};

/**
 * Compile a native Foldkit Remote server for the unchanged `foldkit-remote` wire group, backed by
 * memory rows as `RemoteServer.memory` is (NR-004, NR-012, NR-014). `FoldkitRemoteRead` and
 * `FoldkitRemoteQuery` are served by the ported engine; mutations wait for step 4, and streaming
 * `Live` for milestones 6–7.
 */
const compile = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options: NativeRemoteOptions,
): Effect.Effect<RpcArtifact, CompileError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => {
        for (const tag of group.requests.keys())
          if (tag !== READ && tag !== QUERY)
            throw unsupported(
              `rpc.${tag}`,
              tag === "FoldkitRemoteLive"
                ? "Streaming Live is deferred to milestones 6–7 (NR-006)"
                : "Only FoldkitRemoteRead and FoldkitRemoteQuery are served natively so far",
            );
        const entities = Array.from(options.domain.registry.entities.keys());
        const rowTables = tables(options.rows);
        const queries = Array.from(options.domain.registry.queries.values());
        const bodiless = queries.filter((query) => query.body === undefined);
        if (bodiless.length)
          throw unsupported(
            "queries",
            `${bodiless.map((query) => `"${query.name}"`).join(", ")} ${bodiless.length === 1 ? "has" : "have"} no body to run`,
          );
        // Each body and its order-only twin (for keyset `locate`) through the milestone-1 adapter.
        const bodies: Record<string, AnyQuery> = {};
        queries.forEach((query, i) => {
          const body = query.body!;
          bodies[`q${i}`] = body;
          bodies[`q${i}_order`] = { ...body, where: [] };
        });
        const embedded = queries.length ? Foldkit.embed(bodies) : { analyses: [], rust: "" };
        const definitions = queries.map((query, i) => {
          const analysis = embedded.analyses[2 * i];
          const twin = embedded.analyses[2 * i + 1];
          const entity = analysis.entity;
          checkRows(
            query.name,
            entity,
            analysis.fields,
            rowTables.find(([name]) => name === entity)?.[1] ?? [],
          );
          const list = (slots: readonly { readonly key: string }[]) =>
            `&[${slots.map((slot) => Rs.stringLiteral(slot.key).text).join(", ")}]`;
          return {
            validator: inputValidator(query.name, query.Input, i),
            definition: `remote_engine::QueryDef { name: ${Rs.stringLiteral(query.name).text}, entity: ${Rs.stringLiteral(entity).text}, valid: remote_query_valid_${i}, fields: ${list(analysis.fields)}, inputs: ${list(analysis.inputs)}, run: foldkit_eval::r_q${i}, order: foldkit_eval::r_q${i}_order, order_fields: ${list(twin.fields)}, order_inputs: ${list(twin.inputs)} }`,
          };
        });
        return {
          entities,
          rows: JSON.stringify(Object.fromEntries(rowTables)),
          evaluator: embedded.rust,
          definitions,
        };
      },
      catch: (cause) =>
        cause instanceof CompileError ? cause : unsupported("remote", String(cause)),
    });
    const names = prepared.entities.map((entity) => `${Rs.stringLiteral(entity).text}.to_string()`);
    const server = `static REMOTE_ROWS: &str = ${Rs.stringLiteral(prepared.rows).text};
static REMOTE_MEMORY: std::sync::OnceLock<remote_engine::Memory> = std::sync::OnceLock::new();
fn remote_memory() -> &'static remote_engine::Memory {
    REMOTE_MEMORY.get_or_init(|| remote_engine::Memory::new(vec![${names.join(", ")}], &serde_json::from_str(REMOTE_ROWS).expect("embedded rows are JSON")))
}
${prepared.definitions.map((definition) => definition.validator).join("\n")}
static REMOTE_QUERIES: &[remote_engine::QueryDef] = &[${prepared.definitions.map((definition) => definition.definition).join(", ")}];
#[allow(dead_code)]
mod foldkit_eval {
${prepared.evaluator || "pub use std::cmp::Ordering;\n#[derive(Clone, Debug, PartialEq)]\npub enum Value { Null, Bool(bool), Number(f64), Text(Vec<u16>) }"}
}`;
    const procedures: Record<string, { readonly call: string }> = {};
    if (group.requests.has(READ))
      procedures[READ] = { call: "remote_engine::read(remote_memory(), payload)" };
    if (group.requests.has(QUERY))
      procedures[QUERY] = {
        call: "remote_engine::query(remote_memory(), REMOTE_QUERIES, payload)",
      };
    return yield* compileServer(
      group,
      {},
      { limits: { bodyBytes: 4 * 1024 * 1024, ...options.limits } },
      {
        procedures,
        modules: [remoteEngineRuntime, server],
        dependencies: ['ryu-js = { version = "=1.0.3", default-features = false }\n'],
        crates: ["ryu-js@1.0.3"],
      },
    );
  });

export const NativeRemote = Object.freeze({ compile });
