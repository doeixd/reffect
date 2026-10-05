import { Effect, Match, Schema, SchemaAST } from "effect";
import { flow } from "./flow.ts";
import { pageRequest } from "./ssr-page.ts";
import type { PagePlan, PlannedGetView, PlannedViews } from "./remote-resume.ts";
import { Rpc, type RpcGroup } from "effect/rpc";
import type { AnyQuery } from "foldkit-entity";
import { EffectFn, EffectIR, type Computation } from "./effect-ir.ts";
import { mapError } from "./error-recovery.ts";
import { Foldkit } from "./foldkit.ts";
import {
  CompileError,
  Expr,
  Fn,
  IRType,
  NeverType,
  StringType,
  U64Type,
  UnknownType,
  fail,
  structLayout,
  type Value,
} from "./kernel.ts";
import { compileServer, NativeRpc } from "./native-rpc.ts";
import { RpcBearer } from "./rpc-auth.ts";
import type { CompileOptions, RpcArtifact, WireValue } from "./native-rpc.ts";
import { ArrayIR, Literals, Struct, TaggedUnion, optionalKey } from "./records.ts";
import { SchemaIR, StableStringify } from "./schema-json.ts";
import { planQuery, storageOf } from "./sql-plan.ts";
import type { BindingLike, SqlDialect, SqlParam, SqlStatement, SqlStorage } from "./sql-plan.ts";
import { sqlRuntime } from "./sql-runtime.ts";
import { remoteEngineRuntime } from "./remote-engine.ts";
import { PortedRuntimes } from "./ported-runtime.ts";
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
  /** The memory backend's rows, as `RemoteServer.memory` takes them. Exclusive with `sql`. */
  readonly rows?: MemoryRows;
  /**
   * A SQLite backend (milestone 5, SQLX-001..007): `foldkit-remote-drizzle` bindings by entity,
   * and the environment variable holding the database URL at run time (never compiled in).
   */
  readonly sql?: {
    /** The database the bindings describe (SQLX-009); only its SQLx driver is a dependency. */
    readonly dialect: SqlDialect;
    readonly bindings: Readonly<Record<string, BindingLike>>;
    readonly databaseUrlEnv: string;
  };
  /** Mutation sources, as `RemoteServer.memory`'s `mutations` gives them (RM-001). */
  readonly mutations?: ReadonlyArray<NativeRemoteMutation>;
  /**
   * The bearer adapter for the middleware the application added to the Remote contract
   * (RM-004a). Its `u64` principal is the one `RemoteServer.handlers` would be bound to.
   */
  readonly auth?: RpcBearer;
  /**
   * Entity sources' `authorize(principal, fields)` as R functions (RM-004b); entities without one
   * read every requested field, as the memory backend does. Requires `auth`.
   */
  readonly authorize?: {
    readonly [entity: string]: Fn<
      readonly [IRType<bigint>, IRType<ReadonlyArray<string>>],
      ReadonlyArray<string>
    >;
  };
  /**
   * Request hardening (docs/native-divergences.md). Remote batches whole screens into one Read,
   * so the body limit defaults to 4 MiB rather than NativeRpc's 64 KiB.
   */
  readonly limits?: { readonly bodyBytes?: number; readonly batch?: number };
  /**
   * Serve `FoldkitRemoteLive` from a native port of `RemoteServer.liveHub` (LIVE-002), which
   * mutations signal with `R.LiveHub`; the reference passes its hub to `handlers` as `live`.
   * Without it, Live answers as `handlers` without `live`: an empty stream. On SQL, signals apply
   * after the mutation commits and are dropped on rollback (LIVE-003).
   */
  readonly live?: boolean;
  /**
   * Not upstream (LIVE-015, a recorded divergence): a fresh live subscription is first told each
   * selected row's current fields, re-read under its principal after it is registered, so a change
   * committed between a server render and the browser's subscription still arrives. Requires
   * `live`; off by default, where the hub matches `RemoteServer.liveHub`.
   */
  readonly liveSnapshot?: boolean;
  /**
   * Bounds on the live hub (#19; upstream's has none): events each subscriber may have queued
   * (beyond it they are dropped as a cursor gap the client resyncs from), subscriptions in all,
   * and subscriptions per authenticated principal. Defaults: 1024, 10000, 64.
   */
  readonly liveLimits?: {
    readonly queue?: number;
    readonly subscriptions?: number;
    readonly perPrincipal?: number;
  };
  /** The RPC serialization; Live streams incrementally only under NDJSON, as officially. */
  readonly serialization?: "json" | "ndjson";
  /**
   * Server-rendered pages (8A) whose first screen holds Remote data (M9-3 step 2). `remote` is the
   * page's plan, usually `planPage(...)` (#13): each planned request runs against this server's
   * engine under the page request's principal. The render's PageRequest may read `url`, `remote`
   * (`{ now, exchanges }`, `RemoteResume`'s encoding, which it carries in its Flags for the
   * browser's `replay`) and `views` (a Struct of each view's `R.Remote.Page` from its answer).
   */
  readonly pages?: NonNullable<CompileOptions["pages"]> & { readonly remote?: PagePlan };
}

const unsupported = (path: string, message: string) =>
  fail("REMOTE_UNSUPPORTED", "remote", path, message);
const READ = "FoldkitRemoteRead";
const QUERY = "FoldkitRemoteQuery";
const MUTATE = "FoldkitRemoteMutate";
const LIVE = "FoldkitRemoteLive";

/** A patch in wire shape, `{ entity, id, values }`, as `Remote.patch` builds it. */
export const RemotePatch = Struct({ entity: StringType, id: StringType, values: UnknownType });
/** A deleted entity's reference. */
export const RemoteRef = Struct({ entity: StringType, id: StringType });
/** `RemoteServerError`'s data: a mutation fails with its message (RM-001). */
export const RemoteServerError = Struct({ message: StringType });
const LiveEdge = Struct({ entity: StringType, id: StringType, key: StringType });
/** A connection change in wire shape (`ConnectionChange`), as `RemoteServer.prepend` builds it. */
export const RemoteConnectionChange = TaggedUnion({
  Insert: { connection: StringType, position: Literals(["prepend", "append"]), edge: LiveEdge },
  Remove: { connection: StringType, edge: LiveEdge },
});
const outcomeOf = <O>(output: IRType<O>) =>
  Struct({
    output,
    entities: optionalKey(ArrayIR(RemotePatch)),
    connections: optionalKey(ArrayIR(RemoteConnectionChange)),
    deleted: optionalKey(ArrayIR(RemoteRef)),
  });
/**
 * A mutation's `MutationOutcome`: its typed `output`, and optional entity patches, connection
 * changes (RM-005) and deletions.
 */
export type RemoteOutcome<O> = Value<ReturnType<typeof outcomeOf<O>>>;
/** The part of a `Mutation.make` descriptor a mutation source reads. */
export interface MutationLike {
  readonly name: string;
  readonly Input: Schema.Top;
  readonly Output: Schema.Top;
}
export interface NativeRemoteMutation {
  readonly name: string;
  readonly input: Schema.Top;
  /** `(principal?, input) => Unknown`, failing with the encoded `RemoteServerError`. */
  readonly fn: EffectFn<readonly IRType<unknown>[], unknown, unknown>;
  /** Whether the source reads the principal, so Mutate must authenticate. */
  readonly principal: boolean;
}
// The reference decodes inputs with `Schema.decodeUnknown` and encodes outputs with
// `Schema.encodeUnknown`; native code uses the JSON codecs. They agree on finite numbers and
// required or `optionalKey` fields, so schemas outside that subset are refused. An output number
// could be non-finite at run time, which upstream refuses and JSON cannot carry, so outputs hold
// none yet.
const portable = (ast: SchemaAST.AST, path: string, output = false): void => {
  if (SchemaAST.isNumber(ast)) {
    if (output) throw unsupported(path, "Mutation outputs hold no numbers in this profile");
    const admits = Schema.is(Schema.make<Schema.Top>(ast));
    if (admits(NaN) || admits(Infinity) || admits(-Infinity))
      throw unsupported(path, "Mutation numbers must be finite (Schema.Finite or Schema.Int)");
    return;
  }
  if (SchemaAST.isUndefined(ast))
    throw unsupported(path, "Mutation schemas must not hold undefined; use Schema.optionalKey");
  if (SchemaAST.isUnion(ast)) {
    ast.types.forEach((member, i) => portable(member, `${path}[${i}]`, output));
    return;
  }
  if (SchemaAST.isArrays(ast)) {
    ast.elements.forEach((element, i) => portable(element, `${path}[${i}]`, output));
    ast.rest.forEach((rest) => portable(rest, `${path}[]`, output));
    return;
  }
  if (SchemaAST.isObjects(ast)) {
    ast.propertySignatures.forEach((property) =>
      portable(property.type, `${path}.${String(property.name)}`, output),
    );
    ast.indexSignatures.forEach((index) => portable(index.type, `${path}{}`, output));
  }
};
/** The part of a `Query.define` descriptor a connection identity reads. */
export interface QueryLike {
  readonly name: string;
  readonly Input: Schema.Top;
}
/**
 * `Query.ref(input).identity`: the query's name, a NUL and the `stableStringify` of its encoded
 * input (RM-005). Inputs are encoded with the JSON codec, which equals upstream's
 * `Schema.encodeSync(Input)` on the portable subset.
 */
const connection = <Q extends QueryLike>(
  query: Q,
  input: Expr<WireValue<Q["Input"]>>,
): Expr<string> => {
  portable(query.Input.ast, `connection.${query.name}.Input`);
  const witness = NativeRpc.witness<Q["Input"]>(query.Input);
  if (!IRType.same(input.type, witness))
    throw unsupported(`connection.${query.name}`, "The input differs from the query's Input");
  return StringType.literal(`${query.name}\u0000`).pipe(
    StringType.concat(Expr.apply(StableStringify, encode(witness)(input))),
  );
};
const edgeOf = (ref: Expr<Value<typeof RemoteRef>>) => {
  const entity = Expr.get<string>(ref, "entity");
  const id = Expr.get<string>(ref, "id");
  return LiveEdge.make({
    entity,
    id,
    key: entity.pipe(StringType.concat(StringType.literal(":")), StringType.concat(id)),
  });
};
const insert =
  (position: "prepend" | "append") =>
  (
    connection: Expr<string>,
    ref: Expr<Value<typeof RemoteRef>>,
  ): Expr<Value<typeof RemoteConnectionChange>> =>
    RemoteConnectionChange.cases.Insert.make({
      connection,
      position: Expr.literal(Literals(["prepend", "append"]), position),
      edge: edgeOf(ref),
    });
/** `RemoteServer.prepend(connection, ref)`: `ref` now heads the connection. */
const prepend = insert("prepend");
/** `RemoteServer.append(connection, ref)`: `ref` now ends the connection. */
const append = insert("append");
/** `RemoteServer.remove(connection, ref)`: `ref` left the connection. */
const remove = (
  connection: Expr<string>,
  ref: Expr<Value<typeof RemoteRef>>,
): Expr<Value<typeof RemoteConnectionChange>> =>
  RemoteConnectionChange.cases.Remove.make({ connection, edge: edgeOf(ref) });
/** The outcome witness of a mutation, to build what its source returns. */
const outcome = <M extends MutationLike>(definition: M) =>
  outcomeOf(NativeRpc.witness<M["Output"]>(definition.Output, { position: "result" }));
const encode = <A>(witness: IRType<A>) => SchemaIR.encodeSync(SchemaIR.toCodecJson(witness));
/**
 * `RemoteServer.mutation(Mutation, run)`: `build` receives the decoded input and returns the
 * outcome, or fails with `RemoteServerError`. It may write the store with `R.RemoteStore`.
 */
const mutation = <M extends MutationLike>(
  definition: M,
  build: (context: {
    readonly input: Expr<WireValue<M["Input"]>>;
    /** The authenticated principal (RM-004c); reading it requires an authenticated Mutate. */
    readonly principal: Expr<bigint>;
  }) => Computation<RemoteOutcome<WireValue<M["Output"]>>, Value<typeof RemoteServerError>>,
): NativeRemoteMutation => {
  portable(definition.Input.ast, `mutations.${definition.name}.Input`);
  portable(definition.Output.ast, `mutations.${definition.name}.Output`, true);
  const input = NativeRpc.witness<M["Input"]>(definition.Input);
  const result = outcome(definition);
  let readsPrincipal = false;
  const body = (value: Expr<WireValue<M["Input"]>>, principal: Expr<bigint>) => {
    const built = build({
      input: value,
      get principal() {
        readsPrincipal = true;
        return principal;
      },
    });
    // A source that cannot succeed, or cannot fail, has nothing to encode on that channel.
    const succeeded = IRType.same(built.output, NeverType)
      ? built
      : EffectIR.map(built, encode(result));
    return IRType.same(succeeded.error, NeverType)
      ? succeeded
      : mapError(succeeded, encode(RemoteServerError));
  };
  const withPrincipal = EffectFn.make<
    readonly [IRType<bigint>, IRType<WireValue<M["Input"]>>],
    unknown,
    unknown
  >([U64Type, input], UnknownType, UnknownType, (principal, value) => body(value, principal));
  // A source that never reads the principal takes only its input, so public servers can run it.
  const fn = readsPrincipal
    ? withPrincipal
    : EffectFn.make<readonly [IRType<WireValue<M["Input"]>>], unknown, unknown>(
        [input],
        UnknownType,
        UnknownType,
        (value) => body(value, U64Type.literal(0n)),
      );
  return Object.freeze({
    name: definition.name,
    input: definition.Input,
    fn,
    principal: readsPrincipal,
  });
};
/**
 * `Remote.patch(Entity, id, values)`: `values` is a Struct of some of the entity's fields in their
 * wire shape, encoded as the wire carries them (RM-001 refined).
 */
const patch = <A>(
  entity: {
    readonly name: string;
    readonly fields?: object | undefined;
    readonly relations?: object | undefined;
  },
  id: Expr<string>,
  values: Expr<A>,
): Expr<Value<typeof RemotePatch>> => {
  const layout = structLayout(values.type);
  if (!layout || layout.tag !== undefined)
    throw unsupported(`patch.${entity.name}`, "Patch values are a plain Struct");
  for (const field of layout.fields)
    if (
      entity.fields &&
      !Object.hasOwn(entity.fields, field.name) &&
      !(entity.relations && Object.hasOwn(entity.relations, field.name))
    )
      throw unsupported(
        `patch.${entity.name}.${field.name}`,
        `${entity.name} declares no field ${field.name}`,
      );
  if (!IRType.same(id.type, StringType))
    throw unsupported(`patch.${entity.name}`, "Entity IDs are Strings");
  return RemotePatch.make({
    entity: Expr.literal(StringType, entity.name),
    id,
    values: encode(values.type)(values),
  });
};

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
const KIND = { string: "Text", number: "Number", boolean: "Boolean" } as const;
const rustParam = (param: SqlParam): string =>
  Match.value(param).pipe(
    Match.tagsExhaustive({
      Input: (input) =>
        `remote_sql::Param::Input(${Rs.stringLiteral(input.key).text}, remote_sql::Kind::${KIND[input.kind]})`,
      Literal: (literal) =>
        literal.value === null
          ? `remote_sql::Param::Null(remote_sql::Kind::${KIND[literal.kind]})`
          : typeof literal.value === "string"
            ? `remote_sql::Param::Text(${Rs.stringLiteral(literal.value).text})`
            : typeof literal.value === "boolean"
              ? `remote_sql::Param::Bool(${literal.value})`
              : `remote_sql::Param::Number(f64::from_bits(0x${Buffer.from(
                  new Float64Array([literal.value]).buffer,
                )
                  .reverse()
                  .toString("hex")}))`,
      Pattern: (pattern) =>
        Match.value(pattern.search).pipe(
          Match.tag(
            "Input",
            (input) => `remote_sql::Param::PatternInput(${Rs.stringLiteral(input.key).text})`,
          ),
          Match.tag("Literal", (literal) =>
            typeof literal.value === "string"
              ? `remote_sql::Param::PatternText(${Rs.stringLiteral(literal.value).text})`
              : "remote_sql::Param::Null(remote_sql::Kind::Text)",
          ),
          Match.orElse(() => {
            throw unsupported("sql", "A search pattern reads an input or a literal");
          }),
        ),
      Cursor: (cursor) => `remote_sql::Param::Cursor(${cursor.index})`,
      CursorId: () => "remote_sql::Param::CursorId",
      Limit: () => "remote_sql::Param::Limit",
    }),
  );
const rustStatement = (statement: SqlStatement): string =>
  `remote_sql::Statement { sql: ${Rs.stringLiteral(statement.sql).text}, params: &[${statement.params.map(rustParam).join(", ")}] }`;
/** The SQL backend's statics: entity storage, planned queries and the pool's URL variable. */
const sqlServer = (
  storages: ReadonlyArray<SqlStorage>,
  plans: ReadonlyArray<{
    readonly validator: string;
    readonly plan: ReturnType<typeof planQuery>;
    readonly index: number;
  }>,
  urlEnv: string,
): string => {
  const entities = storages.map(
    (storage) =>
      `remote_sql::Entity { name: ${Rs.stringLiteral(storage.entity).text}, table: ${Rs.stringLiteral(storage.table).text}, id: ${Rs.stringLiteral(storage.id).text}, columns: &[${storage.columns
        .map(
          (column) =>
            `remote_sql::Column { field: ${Rs.stringLiteral(column.field).text}, column: ${Rs.stringLiteral(column.column).text}, kind: remote_sql::Kind::${KIND[column.kind]} }`,
        )
        .join(", ")}], relations: &[${storage.relations
        .map(
          (one) =>
            `remote_sql::One { field: ${Rs.stringLiteral(one.field).text}, column: ${Rs.stringLiteral(one.column).text}, target: ${Rs.stringLiteral(one.target).text} }`,
        )
        .join(", ")}] }`,
  );
  const queries = plans.map(
    ({ plan, index }) =>
      `remote_sql::Query { name: ${Rs.stringLiteral(plan.query).text}, entity: ${Rs.stringLiteral(plan.entity).text}, valid: remote_query_valid_${index}, cursor_row: ${rustStatement(plan.cursorRow)}, forward: ${rustStatement(plan.forward)}, forward_after: ${rustStatement(plan.forwardAfter)}, backward: ${rustStatement(plan.backward)}, backward_before: ${rustStatement(plan.backwardBefore)} }`,
  );
  return `${plans.map((plan) => plan.validator).join("\n")}
static REMOTE_SQL: remote_sql::Sql = remote_sql::Sql { entities: &[${entities.join(", ")}], queries: &[${queries.join(", ")}], url_env: ${Rs.stringLiteral(urlEnv).text}, pool: std::sync::OnceLock::new() };
// The engine's memory backend names the evaluator's cell type; SQL runs no evaluator.
#[allow(dead_code)]
mod foldkit_eval {
pub use std::cmp::Ordering;
#[derive(Clone, Debug, PartialEq)]
pub enum Value { Null, Bool(bool), Number(f64), Text(Vec<u16>) }
}`;
};
/** NativeRpc's page options: the plan is NativeRemote's to run. */
const withoutReads = (
  pages: NonNullable<NativeRemoteOptions["pages"]>,
): NonNullable<CompileOptions["pages"]> => ({
  template: pages.template,
  render: pages.render,
  ...(pages.containerId === undefined ? {} : { containerId: pages.containerId }),
  ...(pages.origin === undefined ? {} : { origin: pages.origin }),
});
/** Whether a planned query asks for a bounded page. */
const hasWindow = (request: unknown): boolean => {
  const window =
    typeof request === "object" && request !== null && "window" in request
      ? request.window
      : undefined;
  return (
    typeof window === "object" &&
    window !== null &&
    (("first" in window && typeof window.first === "number") ||
      ("last" in window && typeof window.last === "number"))
  );
};
/** A positive live hub bound, as a Rust integer literal. */
const liveLimit = (value: number | undefined, fallback: number, path: string): string => {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw unsupported(`liveLimits.${path}`, "Live limits are positive safe integers");
  return String(limit);
};
/** Whether a selection asks for related entities, which a first-pass plan cannot follow. */
const hasRelations = (selection: unknown): boolean =>
  typeof selection === "object" &&
  selection !== null &&
  "relations" in selection &&
  typeof selection.relations === "object" &&
  selection.relations !== null &&
  Object.keys(selection.relations).length > 0;
/**
 * A query view's `Page` of its decoded items, as upstream's `pageSchema(select.schema)` reads it,
 * or a get view's settled `RemoteData`.
 */
type ViewPages<V extends PlannedViews> = {
  readonly [K in keyof V]: V[K] extends PlannedGetView
    ?
        | { readonly _tag: "Ready"; readonly value: V[K]["item"]["Type"] }
        | { readonly _tag: "NotFound" }
    : {
        readonly items: ReadonlyArray<V[K]["item"]["Type"]>;
        readonly hasNext: boolean;
        readonly hasPrevious: boolean;
      };
};
/**
 * The witness of a plan's views (#6): a Struct of each query view's `R.Remote.Page` and each get
 * view's `R.Remote.Data`, of the selection's own schema. A page's request reads `views` of
 * exactly this, so a field the schema transforms reaches the R view decoded, as it reaches
 * upstream's view.
 */
const pageViews = <V extends PlannedViews>(plan: PagePlan<V>): IRType<ViewPages<V>> =>
  NativeRpc.witness(
    Schema.Struct(
      Object.fromEntries(
        Object.entries(plan.views).map(([name, view]) => [
          name,
          Match.value(view).pipe(
            Match.tagsExhaustive({
              Query: ({ item }): Schema.Top =>
                Schema.Struct({
                  items: Schema.Array(item),
                  hasNext: Schema.Boolean,
                  hasPrevious: Schema.Boolean,
                }),
              Get: ({ item }): Schema.Top =>
                Schema.Union([
                  Schema.TaggedStruct("Ready", { value: item }),
                  Schema.TaggedStruct("NotFound", {}),
                ]),
            }),
          ),
        ]),
      ),
    ),
  ) as IRType<ViewPages<V>>;
/**
 * The page's data step (M9-3 step 2a): each planned request run against the engine as the RPC
 * handlers run it, recorded with its answer. On a server with bearer auth a page needs its
 * request's principal, so one without is refused (401) rather than read more openly than RPC.
 */
const pageReads = (
  { reads, views }: PagePlan,
  render: NonNullable<CompileOptions["pages"]>["render"],
  domain: RemoteDomain,
  source: string,
  authenticates: boolean,
): { readonly data: string; readonly helpers: { readonly [name: string]: Fn } } => {
  // A view whose input comes from the URL: its R input, encoded by the query's own Input codec,
  // fills its read's request `input` per page request (docs/research/ssr-data.md).
  const helpers: { [name: string]: Fn } = {};
  const fills: string[] = [];
  for (const [name, view] of Object.entries(views)) {
    if (view._tag === "Get") {
      if (view.id === undefined) continue;
      const at = `pages.views.${name}.id`;
      if (
        !(view.id instanceof Fn) ||
        view.id.input.length !== 1 ||
        !IRType.same(view.id.input[0]!, StringType) ||
        !IRType.same(view.id.output, StringType)
      )
        throw unsupported(at, "A URL id is a pure R function of the page URL (String) to String");
      const helperName = `page_id_${view.read}`;
      helpers[helperName] = view.id;
      fills.push(
        `${view.read} => { request["requests"][0]["id"] = serde_json::Value::String(reffect_generated::r_${helperName}(href.clone())); }`,
      );
      continue;
    }
    if (view.input === undefined) continue;
    const at = `pages.views.${name}.input`;
    const read = reads[view.read];
    const queryName =
      read !== undefined && typeof read.request === "object" && "query" in read.request
        ? read.request.query
        : undefined;
    const query =
      typeof queryName === "string" ? domain.registry.queries.get(queryName) : undefined;
    if (query === undefined) throw unsupported(at, "A URL input fills a query of the domain");
    const witness = NativeRpc.witness(query.Input);
    if (
      !(view.input instanceof Fn) ||
      view.input.input.length !== 1 ||
      !IRType.same(view.input.input[0]!, StringType) ||
      !IRType.same(view.input.output, witness)
    )
      throw unsupported(
        at,
        `A URL input is a pure R function of the page URL (String) returning ${queryName}'s Input`,
      );
    const encode = Fn.make([witness], UnknownType, (value) =>
      SchemaIR.encodeSync(SchemaIR.toCodecJson(witness))(value),
    );
    const helper = flow(view.input, encode);
    const helperName = `page_input_${view.read}`;
    helpers[helperName] = helper;
    fills.push(
      `${view.read} => { request["input"] = reffect_generated::r_${helperName}(href.clone()); }`,
    );
  }
  const planned = reads.map((read, i) => {
    const path = `pages.remote.reads[${i}]`;
    const request = read.request;
    if (typeof request !== "object" || request === null)
      throw unsupported(path, "A planned read carries its wire request");
    if (read._tag === "Query") {
      const query = "query" in request ? request.query : undefined;
      if (typeof query !== "string" || !domain.registry.queries.has(query))
        throw unsupported(path, "The query is one of the domain's");
      if ("select" in request && hasRelations(request.select))
        throw unsupported(path, "Page reads select no relations yet (M9-3)");
    } else {
      const requests = "requests" in request ? request.requests : undefined;
      if (!Array.isArray(requests)) throw unsupported(path, "A planned read is a ReadBatch");
      for (const requirement of requests) {
        const entity =
          typeof requirement === "object" && requirement !== null && "entity" in requirement
            ? requirement.entity
            : undefined;
        if (typeof entity !== "string" || !domain.registry.entities.has(entity))
          throw unsupported(path, "The read's entities are the domain's");
        if (hasRelations(requirement))
          throw unsupported(path, "Page reads select no relations yet (M9-3)");
      }
    }
    return `remote_engine::PageRead { tag: ${Rs.stringLiteral(read._tag).text}, request: serde_json::from_str(${Rs.stringLiteral(JSON.stringify(request)).text}).expect("planned while compiling") }`;
  });
  // The request reads the plan's views as pageViews derives them, or no views at all.
  const viewsType = pageRequest(render).views;
  for (const [name, view] of Object.entries(views)) {
    const read = reads[view.read];
    if (view._tag === "Get") {
      if (read?._tag !== "Read" || read.request.requests.length !== 1)
        throw unsupported(`pages.views.${name}`, "A get view reads one entity of the page's reads");
      if (!Schema.isSchema(view.item))
        throw unsupported(`pages.views.${name}`, "A view carries its selection schema (planPage)");
      continue;
    }
    if (read?._tag !== "Query")
      throw unsupported(`pages.views.${name}`, "A view reads one of the page's queries");
    // A view without a window would read the whole table on every page request (#5).
    if (!hasWindow(read.request))
      throw unsupported(
        `pages.views.${name}`,
        "A view's query needs a window (first or last), so a page reads a bounded page",
      );
    if (!Schema.isSchema(view.item))
      throw unsupported(`pages.views.${name}`, "A view carries its selection schema (planPage)");
  }
  if (Object.keys(views).length > 0 || viewsType !== undefined) {
    const expected = pageViews({ reads, views });
    if (viewsType === undefined || !IRType.same(viewsType, expected))
      throw unsupported(
        "pages.views",
        "The page request's views are NativeRemote.pageViews(plan): each view's Page of its selection",
      );
  }
  const viewEntries = Object.entries(views)
    .map(([name, view]) => `(${Rs.stringLiteral(name).text}, ${view.read})`)
    .join(", ");
  // The work is the engine's page_data (runtime/src/remote_engine.rs, #37); the planned requests
  // are parsed once per process (#9).
  const data = `async {
        static REMOTE_PAGE_READS: std::sync::OnceLock<Vec<remote_engine::PageRead>> = std::sync::OnceLock::new();
        let reads = REMOTE_PAGE_READS.get_or_init(|| vec![${planned.join(", ")}]);${
          fills.length === 0
            ? ""
            : `
        // Requests whose input comes from this page's URL, filled from it.
        let filled: Vec<remote_engine::PageRead> = reads.iter().enumerate().map(|(index, read)| {
            let mut request = read.request.clone();
            match index { ${fills.join(" ")} _ => {} }
            remote_engine::PageRead { tag: read.tag, request }
        }).collect();
        let reads = &filled[..];`
        }
        ${authenticates ? "if principal.is_none() { return Err(StatusCode::UNAUTHORIZED); }" : ""}
        let authorize = remote_authorize(principal);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0);
        remote_engine::page_data(${source}, &authorize, reads, &[${viewEntries}], now).await.map_err(|error| {
            eprintln!("{}", json!({ "schema": "reffect.ssr.page@1", "outcome": "read-failure", "error": error }));
            StatusCode::INTERNAL_SERVER_ERROR
        })
    }.await`;
  return { data, helpers };
};
/** The Rust expression of the hub service each session gets (LIVE-008). */
const REMOTE_LIVE = "std::sync::Arc::new(RemoteLive)";
const compile = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options: NativeRemoteOptions,
): Effect.Effect<RpcArtifact, CompileError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => {
        for (const tag of group.requests.keys())
          if (tag !== READ && tag !== QUERY && tag !== MUTATE && tag !== LIVE)
            throw unsupported(`rpc.${tag}`, "Only the Remote contract's procedures are served");
        // A Live stream never ends, so a JSON body would buffer it forever and never answer (LR-4).
        if (options.live && options.serialization !== "ndjson")
          throw unsupported("live", 'A live hub needs serialization: "ndjson"');
        if (options.liveSnapshot && !options.live)
          throw unsupported("liveSnapshot", "A snapshot needs the live hub (live: true)");
        if (options.liveLimits !== undefined) {
          if (!options.live)
            throw unsupported("liveLimits", "Live limits need the live hub (live: true)");
          liveLimit(options.liveLimits.queue, 1024, "queue");
          liveLimit(options.liveLimits.subscriptions, 10000, "subscriptions");
          liveLimit(options.liveLimits.perPrincipal, 64, "perPrincipal");
        }
        const authorize = Object.entries(options.authorize ?? {});
        if (authorize.length && !options.auth)
          throw unsupported("authorize", "authorize needs an authenticated principal (auth)");
        const StringArray = ArrayIR(StringType);
        for (const [entity, fn] of authorize) {
          if (!options.domain.registry.entities.has(entity))
            throw unsupported(`authorize.${entity}`, `The domain declares no entity ${entity}`);
          if (
            !(fn instanceof Fn) ||
            fn.input.length !== 2 ||
            !IRType.same(fn.input[0], U64Type) ||
            !IRType.same(fn.input[1], StringArray) ||
            !IRType.same(fn.output, StringArray)
          )
            throw unsupported(
              `authorize.${entity}`,
              "authorize is an R function (principal: U64, fields: Array<String>) => Array<String>",
            );
        }
        // Read, Query and a live hub call authorize with the principal, so all must authenticate.
        if (authorize.length)
          for (const tag of options.live ? [READ, QUERY, LIVE] : [READ, QUERY]) {
            const definition: unknown = group.requests.get(tag);
            if (!Rpc.isRpc(definition)) continue;
            const rpc: Rpc.AnyWithProps = definition;
            if (!rpc.middlewares.has(options.auth!.middleware))
              throw unsupported(
                `rpc.${tag}`,
                "With authorize, Read, Query and live Live must carry the auth middleware",
              );
          }
        const mutations = options.mutations ?? [];
        const mutateDefinition: unknown = group.requests.get(MUTATE);
        const mutateRpc: Rpc.AnyWithProps | undefined = Rpc.isRpc(mutateDefinition)
          ? mutateDefinition
          : undefined;
        const protectedMutate =
          options.auth !== undefined &&
          mutateRpc !== undefined &&
          mutateRpc.middlewares.has(options.auth.middleware);
        for (const source of mutations)
          if (source.principal && !protectedMutate)
            throw unsupported(
              `mutations.${source.name}`,
              "A source that reads the principal needs Mutate to carry the auth middleware",
            );
        const sourced = new Set<string>();
        for (const source of mutations) {
          if (sourced.has(source.name))
            throw unsupported(`mutations.${source.name}`, "Each mutation has one source");
          sourced.add(source.name);
        }
        const entities = Array.from(options.domain.registry.entities.keys());
        // Rows are keyed `entity:id`, as upstream keys them, and split at the first colon: an
        // entity name holding one would make keys ambiguous ("A:1" + "x" is "A" + "1:x") (#26).
        for (const entity of entities)
          if (entity.includes(":"))
            throw unsupported(`domain.${entity}`, "Entity names hold no colon");
        const queries = Array.from(options.domain.registry.queries.values());
        if ((options.rows === undefined) === (options.sql === undefined))
          throw unsupported("backend", "Give exactly one backend: rows (memory) or sql");
        const bodiless = queries.filter((query) => query.body === undefined);
        if (bodiless.length)
          throw unsupported(
            "queries",
            `${bodiless.map((query) => `"${query.name}"`).join(", ")} ${bodiless.length === 1 ? "has" : "have"} no body to run`,
          );
        if (options.sql !== undefined) {
          const sql = options.sql;
          if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(sql.databaseUrlEnv))
            throw unsupported("sql.databaseUrlEnv", "Name an uppercase environment variable");
          const storages = new Map<string, SqlStorage>();
          for (const [entity, binding] of Object.entries(sql.bindings)) {
            if (!options.domain.registry.entities.has(entity) || binding.name !== entity)
              throw unsupported(
                `sql.bindings.${entity}`,
                `The domain declares no entity ${entity}`,
              );
            const storage = storageOf(binding, sql.dialect);
            for (const field of [...storage.columns, ...storage.relations])
              if (field.column.length === 0)
                throw unsupported(`sql.bindings.${entity}`, "Empty column name");
            if (storage.columns.find((column) => column.field === "id")?.kind !== "string")
              throw unsupported(`sql.bindings.${entity}.id`, "Text ids only in this profile");
            storages.set(entity, storage);
          }
          const plans = queries.map((query, i) => {
            const entity = query.body!.entity.name;
            const storage = storages.get(entity);
            if (!storage) throw unsupported(`queries.${query.name}`, `No binding for ${entity}`);
            return {
              validator: inputValidator(query.name, query.Input, i),
              plan: planQuery(query.name, query.body!, storage, sql.dialect),
              index: i,
            };
          });
          return {
            backend: "sql" as const,
            dialect: sql.dialect,
            source: "&REMOTE_SQL",
            server: sqlServer(Array.from(storages.values()), plans, sql.databaseUrlEnv),
            store: {
              begin:
                "REMOTE_SQL.begin().await.map(|session| std::sync::Arc::new(session) as std::sync::Arc<dyn reffect_generated::RemoteStore>)",
              impl: `impl reffect_generated::RemoteStore for remote_sql::Session {
    fn get<'a>(&'a self, entity: &'a str, id: &'a str) -> reffect_generated::RowFuture<'a> { Box::pin(remote_sql::Session::get(self, entity, id)) }
    fn write<'a>(&'a self, entity: &'a str, id: &'a str, values: serde_json::Value) -> reffect_generated::StoreFuture<'a> { Box::pin(remote_sql::Session::write(self, entity, id, values)) }
    fn remove<'a>(&'a self, entity: &'a str, id: &'a str) -> reffect_generated::StoreFuture<'a> { Box::pin(remote_sql::Session::remove(self, entity, id)) }
    fn failure(&self) -> Option<String> { remote_sql::Session::failure(self) }
    fn finish(&self, commit: bool) -> reffect_generated::StoreFuture<'_> { Box::pin(remote_sql::Session::finish(self, commit)) }
    // Effects visible outside the transaction wait for its commit (LIVE-003, LIVE-008).
    fn after_commit(&self, action: reffect_generated::AfterCommit) -> reffect_generated::StoreFuture<'_> {
        remote_sql::Session::defer(self, action);
        Box::pin(std::future::ready(Ok(())))
    }
}`,
              live: options.live ? REMOTE_LIVE : undefined,
            },
            mutations,
            authorize,
          };
        }
        const rowTables = tables(options.rows!);
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
            definition: `remote_engine::QueryDef { name: ${Rs.stringLiteral(query.name).text}, entity: ${Rs.stringLiteral(entity).text}, valid: remote_query_valid_${i}, fields: ${list(analysis.fields)}, inputs: ${list(analysis.inputs)}, run: foldkit_eval::r_q${i}, order: foldkit_eval::r_q${i}_order, order_fields: ${list(twin.fields)}, order_inputs: ${list(twin.inputs)}, cells: std::sync::Mutex::new(None) }`,
          };
        });
        const names = entities.map((entity) => `${Rs.stringLiteral(entity).text}.to_string()`);
        const rows = JSON.stringify(Object.fromEntries(rowTables));
        const server = `static REMOTE_ROWS: &str = ${Rs.stringLiteral(rows).text};
static REMOTE_MEMORY: std::sync::OnceLock<remote_engine::Memory> = std::sync::OnceLock::new();
fn remote_memory() -> &'static remote_engine::Memory {
    REMOTE_MEMORY.get_or_init(|| remote_engine::Memory::new(vec![${names.join(", ")}], &serde_json::from_str(REMOTE_ROWS).expect("embedded rows are JSON"), &REMOTE_QUERIES))
}
${definitions.map((definition) => definition.validator).join("\n")}
static REMOTE_QUERIES: [remote_engine::QueryDef; ${definitions.length}] = [${definitions.map((definition) => definition.definition).join(", ")}];
#[allow(dead_code)]
mod foldkit_eval {
${embedded.rust || "pub use std::cmp::Ordering;\n#[derive(Clone, Debug, PartialEq)]\npub enum Value { Null, Bool(bool), Number(f64), Text(Vec<u16>) }"}
}`;
        return {
          backend: "memory" as const,
          source: "remote_memory()",
          server,
          // The memory backend is not transactional, as upstream's is not: writes apply at once.
          store: {
            begin:
              "Ok::<std::sync::Arc<dyn reffect_generated::RemoteStore>, String>(std::sync::Arc::new(MemorySession(remote_memory())))",
            impl: `struct MemorySession(&'static remote_engine::Memory);
impl reffect_generated::RemoteStore for MemorySession {
    // The row as stored, in its JS key order, as upstream's rows(entity) holds it.
    fn get<'a>(&'a self, entity: &'a str, id: &'a str) -> reffect_generated::RowFuture<'a> {
        let row = self.0.get(entity, id).map(|row| serde_json::Value::Object(row.iter().map(|(key, value)| (key.clone(), value.clone())).collect()));
        Box::pin(std::future::ready(Ok(row)))
    }
    fn write<'a>(&'a self, entity: &'a str, id: &'a str, values: serde_json::Value) -> reffect_generated::StoreFuture<'a> {
        if let serde_json::Value::Object(values) = values { self.0.write(entity, id, values.into_iter().collect()); }
        Box::pin(std::future::ready(Ok(())))
    }
    fn remove<'a>(&'a self, entity: &'a str, id: &'a str) -> reffect_generated::StoreFuture<'a> {
        self.0.remove(entity, id);
        Box::pin(std::future::ready(Ok(())))
    }
    fn finish(&self, _commit: bool) -> reffect_generated::StoreFuture<'_> { Box::pin(std::future::ready(Ok(()))) }
    fn failure(&self) -> Option<String> { None }
    // Not transactional: the default after_commit runs each action at once, as
    // upstream's memory mutations call the hub (LIVE-003).
}`,
            live: options.live ? REMOTE_LIVE : undefined,
          },
          mutations,
          authorize,
        };
      },
      catch: (cause) =>
        cause instanceof CompileError ? cause : unsupported("remote", String(cause)),
    });
    // Upstream order: unknown mutation, then input decoding, then the run (RM-001).
    const arms = prepared.mutations
      .map(
        (source, i) =>
          `        ${Rs.stringLiteral(source.name).text} => runtime_mutation_${i}(context, cancellation, input).await,\n`,
      )
      .join("");
    const mutate = `async fn remote_mutate(context: &RequestContext<'_>, cancellation: &tokio::sync::watch::Receiver<bool>, payload: &serde_json::Value) -> Served {
    let name = payload.get("mutation").and_then(serde_json::Value::as_str).unwrap_or_default();
    let input = payload.get("input").unwrap_or(&serde_json::Value::Null);
    let call = match name {
${arms}        _ => return Served::Failure(remote_engine::mutation_error(format!("Unknown mutation: {}", name))),
    };
    match call {
        RuntimeCall::Invalid(_) => Served::Failure(remote_engine::mutation_error("Invalid mutation input".to_string())),
        RuntimeCall::Success(outcome) => Served::Success(remote_engine::mutation_result(outcome)),
        RuntimeCall::Failure(error) => Served::Failure(remote_engine::mutation_error(error.get("message").and_then(serde_json::Value::as_str).unwrap_or_default().to_string())),
        RuntimeCall::Interrupted => Served::Interrupted,
        RuntimeCall::StoreFailed(message) => Served::Failure(remote_engine::mutation_error(message)),
    }
}`;
    // Each entity's authorize for the request's principal; others permit every requested field.
    const authorizer = `fn remote_authorize(principal: Option<u64>) -> impl Fn(&str, &[String]) -> Vec<String> + Sync {
    move |entity: &str, fields: &[String]| -> Vec<String> {
        let _ = principal;
        match entity {
${prepared.authorize
  .map(
    (
      [entity],
      i,
    ) => `            ${Rs.stringLiteral(entity).text} => reffect_generated::r_authorize_${i}(principal.expect("authorize runs only for authenticated procedures"), fields.to_vec()),
`,
  )
  .join("")}            _ => fields.to_vec(),
        }
    }
}
#[allow(dead_code)]
fn remote_authorize_for(principal: Option<u64>, entity: &str, fields: &[String]) -> Vec<String> { remote_authorize(principal)(entity, fields) }`;
    const procedures: Record<string, { readonly call: string; readonly stream?: boolean }> = {};
    if (group.requests.has(LIVE))
      procedures[LIVE] = {
        call: options.liveSnapshot
          ? "remote_live_subscribe(payload, context.principal).await"
          : options.live
            ? "remote_hub().subscribe(payload, context.principal)"
            : "remote_engine::no_live(payload)",
        stream: true,
      };
    if (group.requests.has(MUTATE))
      procedures[MUTATE] = { call: "remote_mutate(context, cancellation, payload).await" };
    if (group.requests.has(READ))
      procedures[READ] = {
        call: `remote_engine::read(${prepared.source}, &remote_authorize(context.principal), payload).await`,
      };
    if (group.requests.has(QUERY))
      procedures[QUERY] = {
        call: `remote_engine::query(${prepared.source}, &remote_authorize(context.principal), payload).await`,
      };
    const pageRead = yield* Effect.try({
      try: () =>
        options.pages?.remote === undefined
          ? undefined
          : pageReads(
              options.pages.remote,
              options.pages.render,
              options.domain,
              prepared.source,
              options.auth !== undefined,
            ),
      catch: (cause) =>
        cause instanceof CompileError ? cause : unsupported("pages.remote", String(cause)),
    });
    const pageData = pageRead?.data;
    return yield* compileServer(
      group,
      {},
      {
        ...(options.pages ? { pages: withoutReads(options.pages) } : {}),
        limits: { bodyBytes: 4 * 1024 * 1024, ...options.limits },
        ...(options.auth ? { auth: options.auth } : {}),
        ...(options.serialization ? { serialization: options.serialization } : {}),
      },
      {
        procedures,
        ported: [
          ...(group.requests.has(READ) ? [PortedRuntimes.RemoteRead] : []),
          ...(group.requests.has(MUTATE) ? [PortedRuntimes.RemoteMutate] : []),
          ...(prepared.backend === "sql"
            ? [PortedRuntimes.RemoteQuerySql]
            : group.requests.has(QUERY)
              ? [PortedRuntimes.RemoteQueryMemory]
              : []),
          ...(options.live && group.requests.has(LIVE) ? [PortedRuntimes.LiveHub] : []),
        ],
        // The engine awaits its source (SQLX-007), so the server is asynchronous.
        asynchronous: true,
        modules: [
          remoteEngineRuntime,
          ...(prepared.backend === "sql" ? [sqlRuntime(prepared.dialect)] : []),
          prepared.server,
          ...(options.live
            ? [
                `static REMOTE_HUB: std::sync::OnceLock<remote_engine::Hub> = std::sync::OnceLock::new();
fn remote_hub() -> &'static remote_engine::Hub {
    REMOTE_HUB.get_or_init(|| remote_engine::Hub::with_limits(remote_engine::LiveLimits { queue: ${liveLimit(options.liveLimits?.queue, 1024, "queue")}, subscriptions: ${liveLimit(options.liveLimits?.subscriptions, 10000, "subscriptions")}, per_principal: ${liveLimit(options.liveLimits?.perPrincipal, 64, "perPrincipal")} }))
}${
                  options.liveSnapshot
                    ? `
/// LIVE-015: subscribe, then tell a fresh stream the rows it selects as they are now.
async fn remote_live_subscribe(payload: &Value, principal: Option<u64>) -> Result<remote_engine::Subscription, Value> {
    let subscription = remote_hub().subscribe(payload, principal)?;
    remote_hub().snapshot(&subscription, ${prepared.source}, remote_authorize_for).await;
    Ok(subscription)
}`
                    : ""
                }
/// The hub as the sessions' LiveHub service (LIVE-008): signals become after-commit actions.
struct RemoteLive;
impl reffect_generated::LiveHub for RemoteLive {
    fn changed(&self, entity: &str, id: &str, fields: Vec<String>) -> reffect_generated::AfterCommit {
        let (entity, id) = (entity.to_string(), id.to_string());
        Box::new(move || Box::pin(async move { remote_hub().changed(${prepared.source}, remote_authorize_for, &entity, &id, &fields).await }))
    }
    fn deleted(&self, entity: &str, id: &str) -> reffect_generated::AfterCommit {
        let (entity, id) = (entity.to_string(), id.to_string());
        Box::new(move || Box::pin(async move { remote_hub().deleted(&entity, &id) }))
    }
}`,
              ]
            : []),
          authorizer,
          ...(group.requests.has(MUTATE) ? [mutate] : []),
        ],
        helpers: {
          ...Object.fromEntries(prepared.authorize.map(([, fn], i) => [`authorize_${i}`, fn])),
          ...pageRead?.helpers,
        },
        functions: Object.fromEntries(
          prepared.mutations.map((source, i) => [
            `mutation_${i}`,
            { fn: source.fn, input: source.input, principal: source.principal },
          ]),
        ),
        store: prepared.store,
        ...(pageData ? { pageData } : {}),
        ...(prepared.backend === "sql" ? { boot: "REMOTE_SQL.ready()" } : {}),
        dependencies: [
          'ryu-js = { version = "=1.0.3", default-features = false }\n',
          ...(prepared.backend !== "sql"
            ? []
            : prepared.dialect === "postgres"
              ? [
                  'sqlx = { version = "=0.9.0", default-features = false, features = ["runtime-tokio", "postgres"] }\n',
                ]
              : [
                  'sqlx = { version = "=0.9.0", default-features = false, features = ["runtime-tokio", "sqlite-bundled"] }\n',
                  'libsqlite3-sys = "=0.37.0"\n',
                ]),
        ],
        crates: [
          "ryu-js@1.0.3",
          ...(prepared.backend !== "sql"
            ? []
            : prepared.dialect === "postgres"
              ? ["sqlx@0.9.0"]
              : ["sqlx@0.9.0", "libsqlite3-sys@0.37.0"]),
        ],
      },
    );
  });

export const NativeRemote = Object.freeze({
  compile,
  mutation,
  outcome,
  patch,
  connection,
  prepend,
  append,
  remove,
  pageViews,
  ServerError: RemoteServerError,
  Patch: RemotePatch,
  Ref: RemoteRef,
});
