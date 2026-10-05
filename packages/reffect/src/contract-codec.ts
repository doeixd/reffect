/**
 * Contract codecs (#14): how an Effect contract schema is represented natively, and the R
 * witness of its values. Pure schema analysis, shared by NativeRpc's server and by authoring
 * (`R.Html` Message fields) without the compiler, so it is browser-safe.
 */
import { Cause, Exit, Match, Option, Schema, SchemaAST, SchemaIssue } from "effect";
import { namingDigest } from "./naming.ts";
import {
  BoolType,
  fail,
  IRType,
  NeverType,
  NumberType,
  StringType,
  U64Type,
  UnitType,
  UnknownType,
} from "./kernel.ts";
import {
  ArrayType,
  Literals,
  optional as optionalField,
  optionalKey as optionalKeyField,
  RecordType,
  Struct,
  TaggedUnion,
} from "./records.ts";
import { RpcCodecs, u64RangeOf } from "./rpc-codecs.ts";

export const U64Json = RpcCodecs.U64Json;
export const StringJson = RpcCodecs.StringJson;

export type Scalar = "u64" | "bool" | "unit" | "never" | "string";
/** A struct field codec; optional fields decode by presence (OPT-003, OPT-004). */
export interface FieldCodec {
  readonly name: string;
  readonly codec: Codec;
  readonly optional?: {
    readonly kind: "optional" | "optionalKey";
    /** JSON kinds the item accepts, and the verified `... | null` text for the others. */
    readonly kinds: readonly JsonKind[];
    readonly mismatch: string;
  };
}
export type JsonKind = "boolean" | "number" | "string" | "array" | "object";
/** A struct or tagged union recognized structurally from the contract (REC-005). */
export interface Composite {
  /** Generated function stem, derived from the full codec structure (NUM-003). */
  readonly name: string;
  readonly type: IRType<unknown>;
  /** Fields per struct, or per union case keyed by tag; codecs in schema order. */
  readonly fields: readonly FieldCodec[];
  readonly cases: readonly {
    readonly tag: string;
    readonly fields: readonly FieldCodec[];
  }[];
  /** Official `defaultFormatter` text for a value that is not this shape at all. */
  readonly expected: string;
  /** Element codec of a `Schema.Array` (ARR-005). */
  readonly item?: Codec;
  /** Verified length checks on a decoded array, in declaration order (LEN-001). */
  readonly lengths?: readonly { readonly rust: string; readonly expected: string }[];
  /** Value codec of a string-keyed `Schema.Record` (RECJS-001). */
  readonly record?: Codec;
  /** `Schema.Unknown` carried as normalized JSON data (UNK-002). */
  readonly json?: true;
  /** A union of string literals, in declaration order (LIT-002). */
  readonly literals?: readonly string[];
  /** A JS number: plain JSON numbers when finite-only, plus verified checks (NUM-002). */
  readonly number?: {
    readonly finiteOnly: boolean;
    readonly checks: readonly { readonly rust: string; readonly expected: string }[];
  };
}
export type Codec = Scalar | Composite;
export type Registry = Map<string, Composite>;
export const codecKey = (codec: Codec): string => (typeof codec === "string" ? codec : codec.name);
// Stable, collision-resistant naming digest (#30).
export const digest = namingDigest;
export const isScalar = (codec: Codec): codec is Scalar => typeof codec === "string";
const witness = {
  u64: U64Type,
  bool: BoolType,
  unit: UnitType,
  never: NeverType,
  string: StringType,
};
export const witnessOf = (codec: Codec): IRType<unknown> =>
  isScalar(codec) ? witness[codec] : codec.type;

/** The R value of a contract schema: TaggedError classes reach R as their data (TE-002). */
export type WireValue<S> = S extends { readonly members: infer M extends ReadonlyArray<unknown> }
  ? WireValue<M[number]>
  : S extends { readonly fields: infer F extends Schema.Struct.Fields }
    ? Schema.Struct<F>["Type"]
    : S extends Schema.Top
      ? S["Type"]
      : never;

export const wellFormed = (value: string) =>
  !Array.from(value).some(
    (char) => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff,
  );
export const unsupported = (path: string, message: string) =>
  fail("RPC_UNSUPPORTED", "rpc", path, message);
// The pinned server formats decode issues with the default formatter (the internal
// `defaultFormatter` is `makeFormatterDefault()`); a null input
// yields the top-level "Expected ..." text, to which the native decoder appends paths.
export const formatIssue = SchemaIssue.makeFormatterDefault();
export const expectedOf = (type: IRType<unknown>): string =>
  Exit.match(Schema.decodeUnknownExit(type.schema as Schema.Codec<unknown>)(null), {
    onSuccess: () => {
      throw unsupported(type.id, "A composite schema unexpectedly accepted null");
    },
    onFailure: (cause) =>
      Option.match(Cause.findErrorOption(cause), {
        onNone: () => {
          throw unsupported(type.id, "Composite decoding failed without a Schema issue");
        },
        onSome: (error) => formatIssue(error.issue),
      }),
  });
// Effect's union candidates for `optional(T)`: the JSON kinds T accepts, and T's own text for
// a value of any other kind, to which the official decoder appends `| null` (OPT-004).
export const kindsOf = (
  codec: Codec,
  path: string,
): { readonly kinds: readonly JsonKind[]; readonly expected: string } => {
  if (isScalar(codec))
    return Match.value(codec).pipe(
      Match.when("bool", () => ({ kinds: ["boolean"] as const, expected: "Expected boolean" })),
      Match.when("string", () => ({ kinds: ["string"] as const, expected: "Expected string" })),
      Match.when("u64", () => ({ kinds: ["string"] as const, expected: "Expected string" })),
      Match.when("never", () => ({ kinds: [] as const, expected: "Expected never" })),
      Match.when("unit", () => {
        throw unsupported(path, "Optional Undefined fields are not supported");
      }),
      Match.exhaustive,
    );
  if (codec.number)
    return codec.number.finiteOnly
      ? { kinds: ["number"], expected: "Expected number" }
      : {
          kinds: ["number", "string"],
          expected: 'Expected number | "Infinity" | "-Infinity" | "NaN"',
        };
  if (codec.item) return { kinds: ["array"], expected: codec.expected };
  if (codec.record) return { kinds: ["object"], expected: codec.expected };
  if (codec.literals) return { kinds: ["string"], expected: codec.expected };
  if (codec.json)
    throw unsupported(path, "optional(Unknown) is not supported: null matches Unknown first");
  if (codec.cases.length === 0 && codec.fields.length === 0)
    throw unsupported(path, "optional(Struct({})) accepts any value in Effect and is refused");
  return { kinds: ["object"], expected: codec.expected };
};
export const kindProbes: readonly (readonly [JsonKind, unknown])[] = [
  ["boolean", true],
  ["number", 0],
  ["string", "reffect"],
  ["array", []],
  ["object", {}],
];
// Runs Effect's own decoder on one probe per rejected JSON kind; the text must match exactly.
export const verifyOptional = (
  property: SchemaAST.AST,
  path: string,
  kinds: readonly JsonKind[],
  mismatch: string,
) => {
  const struct = Schema.toCodecJson(
    Schema.make<Schema.Codec<unknown>>(
      new SchemaAST.Objects([new SchemaAST.PropertySignature("f", property)], []),
    ),
  );
  const decoded = (value: unknown) => Schema.decodeUnknownExit(struct)({ f: value });
  if (!Exit.isSuccess(decoded(null)))
    throw unsupported(path, "Effect refused null for an optional field");
  for (const [kind, probe] of kindProbes) {
    if (kinds.includes(kind)) continue;
    const text = Exit.match(decoded(probe), {
      onSuccess: () => undefined,
      onFailure: (cause) =>
        Option.match(Cause.findErrorOption(cause), {
          onNone: () => undefined,
          onSome: (error) => formatIssue(error.issue),
        }),
    });
    if (text !== `${mismatch}\n  at ["f"]`)
      throw unsupported(path, `Optional field text for ${kind} disagrees with Effect`);
  }
};
export const optionalOf = (
  property: SchemaAST.AST,
  path: string,
): { readonly kind: "optional" | "optionalKey"; readonly item: SchemaAST.AST } | undefined => {
  const context = property.context;
  // Required keys may carry a context too (`Schema.tag` has a constructor default).
  if (!context?.isOptional) return undefined;
  if (context.isMutable || context.constructorDefault || context.annotations)
    throw unsupported(path, "Only plain optional and optionalKey fields are supported");
  // `optional(T)` keeps T's own AST as the first union member.
  if (
    SchemaAST.isUnion(property) &&
    property.types.length === 2 &&
    SchemaAST.isUndefined(property.types[1]) &&
    !property.checks &&
    !property.annotations &&
    !property.encoding &&
    !property.types[1].annotations &&
    !property.types[1].checks
  )
    return { kind: "optional", item: property.types[0] };
  return { kind: "optionalKey", item: withoutContext(property) };
};
// `optionalKey(T)` copies T's AST with a key context. Canonical codecs are recognized by their
// shared checks; other shapes are inspected through a context-free view.
export const withoutContext = (ast: SchemaAST.AST): SchemaAST.AST => {
  for (const canonical of [U64Json.ast, StringJson.ast])
    if (ast._tag === canonical._tag && ast.checks === canonical.checks) return canonical;
  return Object.freeze(
    Object.assign(Object.create(Object.getPrototypeOf(ast) as object) as SchemaAST.AST, ast, {
      context: undefined,
    }),
  );
};
// A plain union of string literals, or one string literal (LIT-002); others stay refused.
export const stringLiterals = (ast: SchemaAST.AST): readonly [string, ...string[]] | undefined => {
  const plain = (node: SchemaAST.AST) =>
    SchemaAST.isLiteral(node) &&
    typeof node.literal === "string" &&
    !node.checks &&
    !node.encoding &&
    !node.context &&
    !node.annotations;
  if (plain(ast) && SchemaAST.isLiteral(ast) && typeof ast.literal === "string")
    return [ast.literal];
  if (
    !SchemaAST.isUnion(ast) ||
    ast.checks ||
    ast.encoding ||
    ast.context ||
    ast.annotations ||
    !ast.types.every(plain)
  )
    return undefined;
  const values = ast.types.flatMap((node) =>
    SchemaAST.isLiteral(node) && typeof node.literal === "string" ? [node.literal] : [],
  );
  const [first, ...rest] = values;
  return first === undefined || new Set(values).size !== values.length
    ? undefined
    : [first, ...rest];
};
// Schema.TaggedError: a Declaration encoded through exactly its tagged struct (TE-001).
export const taggedClass = (
  ast: SchemaAST.Declaration,
  path: string,
  decodeOnly: boolean,
): SchemaAST.AST => {
  if (decodeOnly)
    throw unsupported(path, "TaggedError classes are supported in success and error schemas only");
  const struct = ast.typeParameters[0];
  if (
    ast.checks ||
    ast.context ||
    ast.encodingChecks ||
    ast.typeParameters.length !== 1 ||
    ast.encoding?.length !== 1 ||
    ast.encoding[0].to !== struct ||
    typeof ast.annotations?.identifier !== "string"
  )
    throw unsupported(path, "Only Schema.TaggedError classes are supported");
  return struct;
};
// A struct-form sample per admitted codec, for round-trip verification.
export const sampleOf = (codec: Codec, path: string): unknown => {
  if (isScalar(codec))
    return Match.value(codec).pipe(
      Match.when("bool", () => true),
      Match.when("string", () => "reffect"),
      Match.when("u64", () => "7"),
      Match.orElse(() => {
        throw unsupported(path, "Class fields must have a sample value for verification");
      }),
    );
  if (codec.number) return 1.5;
  if (codec.literals) return codec.literals[0];
  if (codec.json) return null;
  if (codec.item) return [];
  if (codec.record) return {};
  if (codec.cases.length)
    return { _tag: codec.cases[0].tag, ...sampleFields(codec.cases[0].fields, path) };
  return sampleFields(codec.fields, path);
};
export const sampleFields = (fields: readonly FieldCodec[], path: string) =>
  Object.fromEntries(
    fields
      .filter((field) => field.optional === undefined)
      .map((field) => [field.name, sampleOf(field.codec, `${path}.${field.name}`)]),
  );
// The class must decode its struct form to an instance and encode it back unchanged.
export const verifyClass = (
  ast: SchemaAST.Declaration,
  tag: string,
  fields: readonly FieldCodec[],
  path: string,
) => {
  const sample = { _tag: tag, ...sampleFields(fields, path) };
  const codec = Schema.toCodecJson(Schema.make<Schema.Codec<unknown>>(ast));
  const decoded = Schema.decodeUnknownExit(codec)(sample);
  const roundTrip = Exit.isSuccess(decoded)
    ? Schema.encodeUnknownExit(codec)(decoded.value)
    : decoded;
  if (!Exit.isSuccess(roundTrip) || JSON.stringify(roundTrip.value) !== JSON.stringify(sample))
    throw unsupported(path, "TaggedError class does not round-trip through its struct form");
};
export const fieldsOf = (
  ast: SchemaAST.Objects,
  path: string,
  registry: Registry,
  tagged: boolean,
  decodeOnly: boolean,
): { readonly tag: string | undefined; readonly fields: Composite["fields"] } => {
  if (
    ast.encoding ||
    ast.checks ||
    ast.context ||
    ast.indexSignatures.length ||
    ast.encodingChecks ||
    Object.keys(ast.annotations ?? {}).some((key) => key !== "identifier" || tagged)
  )
    throw unsupported(
      path,
      "Only plain required Struct shapes (with an optional identifier) are supported",
    );
  let tag: string | undefined;
  const fields: FieldCodec[] = [];
  for (const property of ast.propertySignatures) {
    if (typeof property.name !== "string" || !wellFormed(property.name))
      throw unsupported(path, "Struct field names must be well-formed strings");
    const at = `${path}.${property.name}`;
    const optional = optionalOf(property.type, at);
    if (optional) {
      if (property.name === "_tag") throw unsupported(at, "`_tag` cannot be optional");
      const item = codec(optional.item, at, false, registry, decodeOnly);
      const { kinds, expected } = kindsOf(item, at);
      const mismatch = optional.kind === "optional" ? `${expected} | null` : expected;
      if (optional.kind === "optional") verifyOptional(property.type, at, kinds, mismatch);
      fields.push({
        name: property.name,
        codec: item,
        optional: { kind: optional.kind, kinds, mismatch },
      });
      continue;
    }
    if (property.name === "_tag") {
      const literal = property.type;
      if (!tagged || !SchemaAST.isLiteral(literal) || typeof literal.literal !== "string")
        throw unsupported(`${path}._tag`, "`_tag` is admitted only as a string union discriminant");
      tag = literal.literal;
      continue;
    }
    fields.push({
      name: property.name,
      codec: codec(property.type, `${path}.${property.name}`, false, registry, decodeOnly),
    });
  }
  if (tagged && tag === undefined)
    throw unsupported(path, "Union members must be Structs with a string `_tag` literal");
  return { tag, fields };
};
export const witnessFields = (fields: Composite["fields"]) =>
  Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.optional === undefined
        ? witnessOf(field.codec)
        : field.optional.kind === "optional"
          ? optionalField(witnessOf(field.codec))
          : optionalKeyField(witnessOf(field.codec)),
    ]),
  );
export const composite = (
  ast: SchemaAST.AST,
  path: string,
  registry: Registry,
  decodeOnly: boolean,
): Composite => {
  if (SchemaAST.isObjects(ast) && ast.indexSignatures.length) {
    const [signature] = ast.indexSignatures;
    if (
      ast.indexSignatures.length !== 1 ||
      ast.propertySignatures.length ||
      ast.encoding ||
      ast.checks ||
      ast.context ||
      ast.annotations ||
      ast.encodingChecks
    )
      throw unsupported(path, "Only plain Schema.Record(Schema.String, V) records are supported");
    const key = signature.parameter;
    const plainString =
      SchemaAST.isString(key) && !key.checks && !key.encoding && !key.annotations && !key.context;
    if (!plainString && key !== StringJson.ast)
      throw unsupported(`${path}.key`, "Record keys must be Schema.String or NativeRpc.StringJson");
    if (signature.type.context)
      throw unsupported(`${path}.value`, "Record values cannot be optional");
    const value = codec(signature.type, `${path}.value`, false, registry, decodeOnly);
    if (value === "never" || value === "unit")
      throw unsupported(`${path}.value`, "Record values cannot be Never or Undefined");
    const type = RecordType.of(StringType, witnessOf(value));
    return register(registry, "Record", {
      type,
      fields: [],
      cases: [],
      record: value,
      expected: expectedOf(type),
    });
  }
  if (SchemaAST.isObjects(ast)) {
    const { fields } = fieldsOf(ast, path, registry, false, decodeOnly);
    const plain = Struct(witnessFields(fields));
    const identifier = ast.annotations?.identifier;
    const type = typeof identifier === "string" ? plain.annotate({ identifier }) : plain;
    return register(registry, type.native.type, {
      type,
      fields,
      cases: [],
      expected: expectedOf(type),
    });
  }
  if (SchemaAST.isArrays(ast)) {
    if (
      ast.elements.length ||
      ast.rest.length !== 1 ||
      ast.encoding ||
      ast.context ||
      ast.annotations ||
      ast.encodingChecks
    )
      throw unsupported(path, "Only plain Schema.Array(item) is supported; tuples are not");
    const lengths = (ast.checks ?? []).map((group, i) =>
      lengthCheck(ast, group, `${path}.checks[${i}]`),
    );
    if (lengths.length && !decodeOnly)
      throw unsupported(path, "Length-checked arrays are supported for decoding payloads only");
    const item = codec(ast.rest[0], `${path}[]`, false, registry, decodeOnly);
    if (item === "never") throw unsupported(path, "Array items cannot be Never");
    const type = ArrayType.of(witnessOf(item));
    return register(registry, "Array", {
      type,
      fields: [],
      cases: [],
      item,
      expected: expectedOf(type),
      ...(lengths.length ? { lengths } : {}),
    });
  }
  const literals = stringLiterals(ast);
  if (literals) {
    const type = Literals(literals);
    return register(registry, type.native.type, {
      type,
      fields: [],
      cases: [],
      literals,
      expected: expectedOf(type),
    });
  }
  if (SchemaAST.isUnion(ast) || SchemaAST.isDeclaration(ast)) {
    if (SchemaAST.isUnion(ast) && (ast.checks || ast.encoding || ast.context || ast.annotations))
      throw unsupported(path, "Annotated or checked unions are not supported");
    // A single TaggedError class is a one-case union (TE-001).
    const members = SchemaAST.isUnion(ast) ? ast.types : [ast];
    const cases = members.map((member, i) => {
      const at = `${path}.members[${i}]`;
      const struct = SchemaAST.isDeclaration(member) ? taggedClass(member, at, decodeOnly) : member;
      if (!SchemaAST.isObjects(struct))
        throw unsupported(at, "Only tagged Struct or TaggedError union members are supported");
      const { tag, fields } = fieldsOf(struct, at, registry, true, decodeOnly);
      if (SchemaAST.isDeclaration(member)) verifyClass(member, tag!, fields, at);
      return { tag: tag!, fields };
    });
    if (new Set(cases.map((c) => c.tag)).size !== cases.length)
      throw unsupported(path, "Union discriminants must be distinct");
    const type = TaggedUnion(
      Object.fromEntries(cases.map((c) => [c.tag, witnessFields(c.fields)])),
    );
    return register(registry, type.native.type, {
      type,
      fields: [],
      cases,
      expected: expectedOf(type),
    });
  }
  throw unsupported(path, "Unsupported schema");
};
export const register = (
  registry: Registry,
  base: string,
  shape: Omit<Composite, "name">,
): Composite => {
  const signature = JSON.stringify([
    base,
    shape.type.id,
    shape.fields.map((f) => [f.name, codecKey(f.codec), f.optional?.kind ?? null]),
    shape.cases.map((c) => [
      c.tag,
      c.fields.map((f) => [f.name, codecKey(f.codec), f.optional?.kind ?? null]),
    ]),
    shape.item === undefined ? null : codecKey(shape.item),
    shape.record === undefined ? null : codecKey(shape.record),
    shape.number ?? null,
    shape.lengths ?? null,
    shape.json ?? null,
    shape.literals ?? null,
  ]);
  const name = `${base}_${digest(signature)}`;
  const existing = registry.get(name);
  if (existing) return existing;
  const composite = Object.freeze({ ...shape, name });
  registry.set(name, composite);
  return composite;
};
// Effect's number checks, recognized by representation id and verified by running them.
export const numberChecks: Record<
  string,
  (
    payload: Record<string, unknown>,
  ) => { readonly test: (x: number) => boolean; readonly rust: (x: string) => string } | undefined
> = {
  "effect/schema/isInt": () => ({
    test: (x) => Number.isSafeInteger(x),
    rust: (x) => `(${x}.is_finite() && ${x}.trunc() == ${x} && ${x}.abs() <= 9007199254740991.0)`,
  }),
  "effect/schema/isFinite": () => ({
    test: (x) => Number.isFinite(x),
    rust: (x) => `${x}.is_finite()`,
  }),
  // Range checks compare with Order.Number, which orders NaN below every number: NaN passes
  // the upper bounds and fails the lower ones. NaN bounds are refused.
  "effect/schema/isGreaterThanOrEqualTo": ({ minimum: m }) =>
    typeof m === "number" && !Number.isNaN(m)
      ? { test: (x) => x >= m, rust: (x) => `${x} >= ${f64(m)}` }
      : undefined,
  "effect/schema/isGreaterThan": ({ exclusiveMinimum: m }) =>
    typeof m === "number" && !Number.isNaN(m)
      ? { test: (x) => x > m, rust: (x) => `${x} > ${f64(m)}` }
      : undefined,
  "effect/schema/isLessThanOrEqualTo": ({ maximum: m }) =>
    typeof m === "number" && !Number.isNaN(m)
      ? {
          test: (x) => Number.isNaN(x) || x <= m,
          rust: (x) => `(${x}.is_nan() || ${x} <= ${f64(m)})`,
        }
      : undefined,
  "effect/schema/isLessThan": ({ exclusiveMaximum: m }) =>
    typeof m === "number" && !Number.isNaN(m)
      ? {
          test: (x) => Number.isNaN(x) || x < m,
          rust: (x) => `(${x}.is_nan() || ${x} < ${f64(m)})`,
        }
      : undefined,
};
// Effect's length checks (LEN-001), recognized by representation id and verified by running them.
export const lengthChecks: Record<
  string,
  (
    payload: Record<string, unknown>,
  ) => { readonly test: (n: number) => boolean; readonly rust: string } | undefined
> = {
  "effect/schema/isMaxLength": ({ maxLength: m }) =>
    isLength(m) ? { test: (n) => n <= m, rust: `n <= ${m}` } : undefined,
  "effect/schema/isMinLength": ({ minLength: m }) =>
    isLength(m) ? { test: (n) => n >= m, rust: `n >= ${m}` } : undefined,
  "effect/schema/isBetweenLength": ({ minimum: a, maximum: b }) =>
    isLength(a) && isLength(b)
      ? { test: (n) => n >= a && n <= b, rust: `n >= ${a} && n <= ${b}` }
      : undefined,
};
export const isLength = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const lengthCheck = (
  ast: SchemaAST.Arrays,
  group: SchemaAST.Check<unknown>,
  path: string,
) => {
  const check = Match.value(group).pipe(
    Match.tag("Filter", (filter) => filter),
    Match.orElse(() => undefined),
  );
  if (!check) throw unsupported(path, "Check groups are not supported");
  const representation = check.annotations?.representation as
    | { readonly id?: unknown; readonly payload?: unknown }
    | undefined;
  const id = typeof representation?.id === "string" ? representation.id : "";
  const payload = (representation?.payload ?? {}) as Record<string, unknown>;
  const expected = check.annotations?.expected;
  const recognized = Object.hasOwn(lengthChecks, id) ? lengthChecks[id](payload) : undefined;
  if (!recognized || typeof expected !== "string")
    throw unsupported(path, "Unsupported array check");
  const bounds = Object.values(payload).filter(isLength);
  const probes = new Set([0, 1, 2, ...bounds.flatMap((b) => [b - 1, b, b + 1])]);
  for (const length of probes)
    if (
      length >= 0 &&
      (check.run(
        Array.from({ length }, () => null),
        ast,
        {},
      ) ===
        undefined) !==
        recognized.test(length)
    )
      throw unsupported(path, `Check ${id} disagrees with its native predicate`);
  return { rust: recognized.rust, expected: `Expected ${expected}` };
};
export const f64 = (value: number): string => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return `f64::from_bits(0x${view.getBigUint64(0).toString(16).padStart(16, "0")})`;
};
export const numberCodec = (
  ast: SchemaAST.AST,
  path: string,
  decodeOnly: boolean,
  registry: Registry,
): Composite => {
  if (ast.encoding || ast.context || ast.annotations)
    throw unsupported(path, "Annotated or transformed numbers are not supported");
  const checks = (ast.checks ?? []).map((group, i) => {
    const check = Match.value(group).pipe(
      Match.tag("Filter", (filter) => filter),
      Match.orElse(() => undefined),
    );
    if (!check) throw unsupported(`${path}.checks[${i}]`, "Check groups are not supported");
    const representation = check.annotations?.representation as
      | { readonly id?: unknown; readonly payload?: unknown }
      | undefined;
    const id = typeof representation?.id === "string" ? representation.id : "";
    const expected = check.annotations?.expected;
    const recognized = Object.hasOwn(numberChecks, id)
      ? numberChecks[id]((representation?.payload ?? {}) as Record<string, unknown>)
      : undefined;
    if (!recognized || typeof expected !== "string")
      throw unsupported(`${path}.checks[${i}]`, "Unsupported number check");
    const probes = [NaN, Infinity, -Infinity, 0, -0, 1, -1, 1.5, 2 ** 53, 2 ** 53 - 1, 5e-324];
    const payloadValues = Object.values((representation?.payload ?? {}) as Record<string, unknown>);
    for (const bound of payloadValues)
      if (typeof bound === "number") probes.push(bound, bound + 1, bound - 1, bound + 0.5);
    for (const probe of probes)
      if ((check.run(probe, ast, {}) === undefined) !== recognized.test(probe))
        throw unsupported(
          `${path}.checks[${i}]`,
          `Check ${id} disagrees with its native predicate`,
        );
    return { rust: recognized.rust("x"), expected: `Expected ${expected}` };
  });
  if (checks.length && !decodeOnly)
    throw unsupported(path, "Checked numbers are supported for decoding payloads only");
  const ids = (ast.checks ?? []).map(
    (check) => (check.annotations?.representation as { readonly id?: unknown } | undefined)?.id,
  );
  return register(registry, "Number", {
    type: NumberType,
    fields: [],
    cases: [],
    expected: "",
    number: {
      // SchemaAST.Number.toCodecJson drops the non-finite strings when finiteness is checked.
      finiteOnly: ids.includes("effect/schema/isInt") || ids.includes("effect/schema/isFinite"),
      checks,
    },
  });
};
// `payload` admits top-level u64 ranges; `decodeOnly` admits checked numbers anywhere beneath.
export const codec = (
  ast: SchemaAST.AST,
  path: string,
  payload: boolean,
  registry: Registry,
  decodeOnly: boolean,
): Codec => {
  if (u64RangeOf(ast)) {
    if (!payload) throw unsupported(path, "u64Range schemas are supported for payloads only");
    return "u64";
  }
  if (ast === U64Json.ast) return "u64";
  if (ast === StringJson.ast) return "string";
  if (SchemaAST.isNumber(ast)) return numberCodec(ast, path, decodeOnly, registry);
  if (SchemaAST.isUnknown(ast)) {
    if (ast.checks || ast.encoding || ast.context || ast.annotations)
      throw unsupported(path, "Only plain Schema.Unknown is supported");
    return register(registry, "Unknown", {
      type: UnknownType,
      fields: [],
      cases: [],
      expected: "",
      json: true,
    });
  }
  if (
    SchemaAST.isObjects(ast) ||
    SchemaAST.isUnion(ast) ||
    SchemaAST.isArrays(ast) ||
    SchemaAST.isDeclaration(ast) ||
    SchemaAST.isLiteral(ast)
  )
    return composite(ast, path, registry, decodeOnly);
  if (ast.checks || ast.encoding || ast.context || ast.annotations)
    throw unsupported(
      path,
      "Checked, annotated, optional or transformed schemas require a supported codec",
    );
  if (SchemaAST.isBoolean(ast)) return "bool";
  if (SchemaAST.isUndefined(ast)) return "unit";
  if (SchemaAST.isNever(ast)) return "never";
  // Encoding is exact (TE-003). Decoding accepts the recorded STR-008 divergence: lone-surrogate
  // escapes, which the official server accepts, refuse the whole body natively (STR-007).
  if (SchemaAST.isString(ast)) return "string";
  throw unsupported(
    path,
    "Only Boolean, Undefined, Never, NativeRpc.U64Json, NativeRpc.StringJson, Structs and tagged unions are supported",
  );
};

export const contractWitness = <S extends Schema.Top>(
  schema: S,
  options?: { readonly position?: "payload" | "result" },
): IRType<WireValue<S>> =>
  witnessOf(
    codec(schema.ast, "witness", false, new Map(), (options?.position ?? "payload") === "payload"),
  ) as IRType<WireValue<S>>;
