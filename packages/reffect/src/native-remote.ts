import { Effect, Match, Schema, SchemaAST } from "effect";
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
import type { RpcArtifact, WireValue } from "./native-rpc.ts";
import { ArrayIR, Literals, Struct, TaggedUnion, optionalKey } from "./records.ts";
import { SchemaIR, StableStringify } from "./schema-json.ts";
import { planQuery, storageOf } from "./sql-plan.ts";
import type { BindingLike, SqlDialect, SqlParam, SqlStatement, SqlStorage } from "./sql-plan.ts";
import { sqlRuntime } from "./sql-runtime.ts";
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
}

const unsupported = (path: string, message: string) =>
  fail("REMOTE_UNSUPPORTED", "remote", path, message);
const READ = "FoldkitRemoteRead";
const QUERY = "FoldkitRemoteQuery";
const MUTATE = "FoldkitRemoteMutate";

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
const compile = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options: NativeRemoteOptions,
): Effect.Effect<RpcArtifact, CompileError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => {
        for (const tag of group.requests.keys())
          if (tag !== READ && tag !== QUERY && tag !== MUTATE)
            throw unsupported(
              `rpc.${tag}`,
              tag === "FoldkitRemoteLive"
                ? "Streaming Live is deferred to milestones 6–7 (NR-006)"
                : "Only Read, Query and Mutate are served natively so far",
            );
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
        // Read and Query call authorize with the principal, so both must authenticate.
        if (authorize.length)
          for (const tag of [READ, QUERY]) {
            const definition: unknown = group.requests.get(tag);
            if (!Rpc.isRpc(definition)) continue;
            const rpc: Rpc.AnyWithProps = definition;
            if (!rpc.middlewares.has(options.auth!.middleware))
              throw unsupported(
                `rpc.${tag}`,
                "With authorize, Read and Query must carry the auth middleware",
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
    fn finish(&self, commit: bool) -> reffect_generated::StoreFuture<'_> { Box::pin(remote_sql::Session::finish(self, commit)) }
    fn failure(&self) -> Option<String> { remote_sql::Session::failure(self) }
}`,
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
}`,
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
}`;
    const procedures: Record<string, { readonly call: string }> = {};
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
    return yield* compileServer(
      group,
      {},
      {
        limits: { bodyBytes: 4 * 1024 * 1024, ...options.limits },
        ...(options.auth ? { auth: options.auth } : {}),
      },
      {
        procedures,
        // The engine awaits its source (SQLX-007), so the server is asynchronous.
        asynchronous: true,
        modules: [
          remoteEngineRuntime,
          ...(prepared.backend === "sql" ? [sqlRuntime(prepared.dialect)] : []),
          prepared.server,
          authorizer,
          ...(group.requests.has(MUTATE) ? [mutate] : []),
        ],
        helpers: Object.fromEntries(prepared.authorize.map(([, fn], i) => [`authorize_${i}`, fn])),
        functions: Object.fromEntries(
          prepared.mutations.map((source, i) => [
            `mutation_${i}`,
            { fn: source.fn, input: source.input, principal: source.principal },
          ]),
        ),
        store: prepared.store,
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
  ServerError: RemoteServerError,
  Patch: RemotePatch,
  Ref: RemoteRef,
});
