/**
 * SQL in R (docs/research/sql-service.md): `R.sql` stands for the tagged template of
 * `yield* SqlClient.SqlClient`, and `R.SqlSchema` mirrors `effect/sql`'s `SqlSchema`. A statement
 * is one `SqlExecute` node yielding its outcome as data; everything else is ordinary R built on
 * it, so the reference and native code share the decoding and the failure paths (SQL-002).
 */
import { Computation, EffectIR, sqlExecute, sqlParameter } from "./effect-ir.ts";
import {
  BoolType,
  Expr,
  IRType,
  NumberType,
  StringType,
  UnknownType,
  fail,
  literalsOf,
  nullOrItem,
  structLayout,
} from "./kernel.ts";
import { OptionIR } from "./option.ts";
import type { OptionValue } from "./option.ts";
import { ArrayIR, TaggedUnion, optionalKey } from "./records.ts";
import { ResultIR } from "./result.ts";
import { SchemaIR, typeDecodeOperation, typeIssueOperation } from "./schema-json.ts";
import type { TypeSideInput } from "./schema-json.ts";
import { ArrayCombinators } from "./collection-combinators.ts";

const reasonFields = { message: optionalKey(StringType), operation: optionalKey(StringType) };
/** `SqlError["reason"]` as data (SQL-003): the eleven reason tags and their fields. */
export const SqlErrorReason = TaggedUnion({
  ConnectionError: reasonFields,
  AuthenticationError: reasonFields,
  AuthorizationError: reasonFields,
  SqlSyntaxError: reasonFields,
  UniqueViolation: { ...reasonFields, constraint: StringType },
  ConstraintError: reasonFields,
  DeadlockError: reasonFields,
  SerializationError: reasonFields,
  LockTimeoutError: reasonFields,
  StatementTimeoutError: reasonFields,
  UnknownError: reasonFields,
});
/**
 * What a SQL computation fails with (SQL-003): `SqlError`, `SchemaError` or
 * `NoSuchElementError`, as plain data. Effect types each function more narrowly; R shares one
 * witness until it can widen error unions.
 */
export const SqlSchemaError = TaggedUnion({
  SqlError: { reason: SqlErrorReason },
  SchemaError: { message: StringType },
  NoSuchElementError: {},
});
export type SqlSchemaError = typeof SqlSchemaError extends IRType<infer A> ? A : never;

const Rows = ArrayIR(UnknownType);
const Outcome = ResultIR(Rows, SqlSchemaError);
const decodeOutcome = SchemaIR.decodeUnknownOption(SchemaIR.toCodecJson(Outcome));
// Both runtimes always answer a well-formed outcome; this stands in for an impossible one.
const malformed = () =>
  Outcome.cases.Failure.make({
    failure: SqlSchemaError.cases.SqlError.make({
      reason: SqlErrorReason.cases.UnknownError.make({
        message: Expr.literal(StringType, "Failed to execute statement"),
        operation: Expr.literal(StringType, "execute"),
      }),
    }),
  });

/**
 * `sql\`...\`` from `yield* SqlClient.SqlClient`: the rows a statement returns. Interpolations
 * are bound as parameters, never spliced into the text (SQL-001).
 */
export const sql = (
  strings: TemplateStringsArray,
  ...params: ReadonlyArray<Expr<unknown>>
): Computation<ReadonlyArray<unknown>, SqlSchemaError> => {
  params.forEach((param, index) => {
    if (!(param instanceof Expr) || !sqlParameter(param.type))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        `sql.params.${index}`,
        "SQL parameters are String, Number, u64, Boolean or NullOr of these",
      );
  });
  return EffectIR.flatMap(sqlExecute([...strings], params), (raw) =>
    ResultIR.match(OptionIR.getOrElse(decodeOutcome(raw), malformed), {
      onSuccess: (rows) => EffectIR.succeed(rows),
      onFailure: (error) => EffectIR.fail(error),
    }),
  );
};

// Witnesses whose type and encoded sides agree, so a request passes through unencoded and a
// row decodes on the type side as Effect decodes it (SQL-001, SQL-006).
const plain = (type: IRType<unknown>): boolean => {
  const item = nullOrItem(type) ?? type;
  if ([StringType, NumberType, BoolType].some((scalar) => IRType.same(item, scalar))) return true;
  if (literalsOf(item)) return true;
  const layout = structLayout(item);
  return (
    layout !== undefined &&
    layout.tag === undefined &&
    layout.fields.every((field) => field.optional === undefined && plain(field.type))
  );
};
const checkedWitness = (type: IRType<unknown>, at: string): void => {
  if (!plain(type))
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      at,
      "SqlSchema reads Strings, Numbers, Booleans, Literals, NullOr of these and Structs of them",
    );
};
const checkedRequest = <Req>(request: Expr<Req>, witness: IRType<Req>, at: string): Expr<Req> => {
  if (!IRType.same(request.type, witness))
    throw fail("TYPE_MISMATCH", "authoring", at, "The request's witness differs from Request");
  return request;
};

/**
 * Decodes on the type side, failing with Effect's `SchemaError` message: one row, or with
 * `input: "rows"` a statement's rows against `Array(Result)`.
 */
const decoded = <A>(
  value: Expr<unknown>,
  witness: IRType<A>,
  input: TypeSideInput = "value",
): Computation<A, SqlSchemaError> =>
  OptionIR(witness).match(
    OptionIR.fromUndefinedOr(
      Expr.apply(typeDecodeOperation(witness, input), value) as Expr<A | undefined>,
    ),
    {
      None: () =>
        EffectIR.fail(
          SqlSchemaError.cases.SchemaError.make({
            message: Expr.apply(typeIssueOperation(witness, input), value) as Expr<string>,
          }),
        ),
      Some: (found) => EffectIR.succeed(Expr.get<A>(found, "value")),
    },
  ) as Computation<A, SqlSchemaError>;
const firstRow = (rows: Expr<ReadonlyArray<unknown>>): Expr<OptionValue<unknown>> =>
  ArrayCombinators.findFirst(rows, () => Expr.literal(BoolType, true));

interface Options<Req, Res> {
  readonly Request: IRType<Req>;
  readonly Result: IRType<Res>;
  readonly execute: (request: Expr<Req>) => Computation<ReadonlyArray<unknown>, SqlSchemaError>;
}

/** `SqlSchema.findAll`: every row, decoded with `Schema.Array(Result)`. */
const findAll =
  <Req, Res>(options: Options<Req, Res>) =>
  (request: Expr<Req>): Computation<ReadonlyArray<Res>, SqlSchemaError> => {
    checkedWitness(options.Request, "SqlSchema.findAll.Request");
    checkedWitness(options.Result, "SqlSchema.findAll.Result");
    const rows = ArrayIR(options.Result);
    return EffectIR.flatMap(
      options.execute(checkedRequest(request, options.Request, "SqlSchema.findAll")),
      (found) => decoded(found, rows, "rows"),
    );
  };
/** `SqlSchema.findOne`: the first row, decoded, or `NoSuchElementError` when there is none. */
const findOne =
  <Req, Res>(options: Options<Req, Res>) =>
  (request: Expr<Req>): Computation<Res, SqlSchemaError> => {
    checkedWitness(options.Request, "SqlSchema.findOne.Request");
    checkedWitness(options.Result, "SqlSchema.findOne.Result");
    return EffectIR.flatMap(
      options.execute(checkedRequest(request, options.Request, "SqlSchema.findOne")),
      (rows) =>
        OptionIR(UnknownType).match(firstRow(rows), {
          None: () => EffectIR.fail(SqlSchemaError.cases.NoSuchElementError.make({})),
          Some: (row) => decoded(Expr.get<unknown>(row, "value"), options.Result),
        }) as Computation<Res, SqlSchemaError>,
    );
  };
/** `SqlSchema.findOneOption`: the first row, decoded, as an Option. */
const findOneOption =
  <Req, Res>(options: Options<Req, Res>) =>
  (request: Expr<Req>): Computation<OptionValue<Res>, SqlSchemaError> => {
    checkedWitness(options.Request, "SqlSchema.findOneOption.Request");
    checkedWitness(options.Result, "SqlSchema.findOneOption.Result");
    return EffectIR.flatMap(
      options.execute(checkedRequest(request, options.Request, "SqlSchema.findOneOption")),
      (rows) =>
        OptionIR(UnknownType).match(firstRow(rows), {
          None: () => EffectIR.succeed(OptionIR.none(options.Result)),
          Some: (row) =>
            EffectIR.map(decoded(Expr.get<unknown>(row, "value"), options.Result), (value) =>
              OptionIR.some(value),
            ),
        }) as Computation<OptionValue<Res>, SqlSchemaError>,
    );
  };
/** `SqlSchema.void`: runs the statement and discards its rows. */
const voidSchema =
  <Req>(options: {
    readonly Request: IRType<Req>;
    readonly execute: (request: Expr<Req>) => Computation<ReadonlyArray<unknown>, SqlSchemaError>;
  }) =>
  (request: Expr<Req>): Computation<void, SqlSchemaError> => {
    checkedWitness(options.Request, "SqlSchema.void.Request");
    return EffectIR.asVoid(
      options.execute(checkedRequest(request, options.Request, "SqlSchema.void")),
    );
  };

export const SqlSchemaIR = Object.freeze({
  findAll,
  findOne,
  findOneOption,
  void: voidSchema,
  Error: SqlSchemaError,
  ErrorReason: SqlErrorReason,
});
