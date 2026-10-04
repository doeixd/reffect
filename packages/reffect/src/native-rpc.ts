import { Cause, Effect, Exit, Match, Option, Schema, SchemaAST, SchemaIssue } from "effect";
import type { Stream as EffectStream } from "effect";
import type { StreamFn } from "./stream-ir.ts";
import { Rpc, RpcSchema, type RpcGroup } from "effect/rpc";
import { Compile, Rust, Target, type Plan } from "./compiler.ts";
import { PortedRuntimes, verifyUpstream } from "./ported-runtime.ts";
import { PageSchema, pageRuntime, splitTemplate } from "./ssr-page.ts";
import type { TemplatePart } from "./ssr-page.ts";
import type { PortedRuntime, UpstreamCheck } from "./ported-runtime.ts";
import {
  StableStringify,
  jsonDecodedWitness,
  jsonDecoderName,
  jsonEncodedWitness,
  jsonEncoderName,
} from "./schema-json.ts";
import { FailureFrames } from "./frame-policy.ts";
import type { FailureFramePolicy } from "./frame-policy.ts";
import { SourceArtifacts } from "./artifact-policy.ts";
import type { GeneratedFiles } from "./cargo.ts";
import { AsyncEffects, EffectFn, SyncEffects, isAsyncComputation, launch } from "./effect-ir.ts";
import { Service } from "./context.ts";
import { StaticLayer } from "./layer.ts";
import {
  CompileError,
  BoolType,
  literalsOf,
  type StructLayout,
  Capabilities,
  Expr,
  Fn,
  IRType,
  NeverType,
  Program,
  StringType,
  U64Type,
  UnitType,
  fail,
} from "./kernel.ts";
import type { AnyFn } from "./kernel.ts";
import { Rs } from "./rust-emit.ts";
import {
  ArrayType,
  RecordType,
  Struct,
  TaggedUnion,
  optional as optionalField,
  optionalKey as optionalKeyField,
  Literals,
  rustFieldNames,
  rustLiteralVariants,
  rustVariantName,
} from "./records.ts";
import {
  NumberType,
  UnknownType,
  arrayItem,
  recordValue,
  structLayout,
  undefinedOrItem,
  unionCases,
} from "./kernel.ts";
import type { RsExpr } from "./rust-emit.ts";
import { RpcCodecs, u64RangeOf } from "./rpc-codecs.ts";
import { RpcBearer } from "./rpc-auth.ts";
import { rpcAuthRuntime } from "./rpc-auth-runtime.ts";
import { decodeArgs, rpcRuntime } from "./rpc-runtime.ts";
import { analyzeTaskGroups } from "./structured-concurrency.ts";

const U64Json = RpcCodecs.U64Json;
const StringJson = RpcCodecs.StringJson;

type Scalar = "u64" | "bool" | "unit" | "never" | "string";
/** A struct field codec; optional fields decode by presence (OPT-003, OPT-004). */
interface FieldCodec {
  readonly name: string;
  readonly codec: Codec;
  readonly optional?: {
    readonly kind: "optional" | "optionalKey";
    /** JSON kinds the item accepts, and the verified `... | null` text for the others. */
    readonly kinds: readonly JsonKind[];
    readonly mismatch: string;
  };
}
type JsonKind = "boolean" | "number" | "string" | "array" | "object";
/** A struct or tagged union recognized structurally from the contract (REC-005). */
interface Composite {
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
type Codec = Scalar | Composite;
type Registry = Map<string, Composite>;
const codecKey = (codec: Codec): string => (typeof codec === "string" ? codec : codec.name);
// FNV-1a over the codec signature; names only need to be stable and distinct per build.
const digest = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
const isScalar = (codec: Codec): codec is Scalar => typeof codec === "string";
const witness = {
  u64: U64Type,
  bool: BoolType,
  unit: UnitType,
  never: NeverType,
  string: StringType,
};
const witnessOf = (codec: Codec): IRType<unknown> =>
  isScalar(codec) ? witness[codec] : codec.type;
export interface RpcBinding<F extends AnyFn = AnyFn> {
  readonly fn: F;
  readonly fields: readonly string[];
  readonly principal: boolean;
  /** Server-lifetime services passed, in order, before the payload arguments. */
  readonly services: readonly Service[];
}
type NativeValue<A> = [A] extends [never] ? never : [A] extends [undefined] ? void : A;
/** The R value of a contract schema: TaggedError classes reach R as their data (TE-002). */
export type WireValue<S> = S extends { readonly members: infer M extends ReadonlyArray<unknown> }
  ? WireValue<M[number]>
  : S extends { readonly fields: infer F extends Schema.Struct.Fields }
    ? Schema.Struct<F>["Type"]
    : S extends Schema.Top
      ? S["Type"]
      : never;
type HandlerError<P extends Rpc.Any> = P extends {
  readonly errorSchema: infer E extends Schema.Top;
}
  ? WireValue<E>
  : never;
type HasMiddleware<P extends Rpc.Any> = [Rpc.Middleware<P>] extends [never] ? false : true;
type Bindings<Rpcs extends Rpc.Any> = {
  readonly [Tag in Rpcs["_tag"]]: RpcBinding<
    // A `stream: true` procedure binds an R.Stream.fn of its elements and failures (STREAM-006).
    Rpc.Success<Rpc.ExtractTag<Rpcs, Tag>> extends EffectStream.Stream<infer A, infer E, infer _R>
      ? StreamFn<readonly IRType<unknown>[], NativeValue<A>, NativeValue<E>>
      :
          | ([HandlerError<Rpc.ExtractTag<Rpcs, Tag>>] extends [never]
              ? Fn<readonly IRType<unknown>[], NativeValue<Rpc.Success<Rpc.ExtractTag<Rpcs, Tag>>>>
              : never)
          | EffectFn<
              readonly IRType<unknown>[],
              NativeValue<Rpc.Success<Rpc.ExtractTag<Rpcs, Tag>>>,
              NativeValue<HandlerError<Rpc.ExtractTag<Rpcs, Tag>>>
            >
  > & {
    readonly principal: HasMiddleware<Rpc.ExtractTag<Rpcs, Tag>>;
    readonly fields: Rpc.Payload<Rpc.ExtractTag<Rpcs, Tag>> extends Readonly<
      Record<string, unknown>
    >
      ? readonly Extract<keyof Rpc.Payload<Rpc.ExtractTag<Rpcs, Tag>>, string>[]
      : readonly [];
  };
};
export interface RpcArtifact extends GeneratedFiles {
  readonly failureFrames: FailureFramePolicy;
  readonly explanation: Plan;
  readonly stages: readonly string[];
  readonly sourceArtifacts: typeof SourceArtifacts.None;
  readonly runtime: {
    readonly id: "rust/axum-unary-json@1";
    readonly crates: readonly string[];
    readonly handlerProfile: "synchronous-scalars" | "suspended-scalars";
    /** The ported protocol engines this server runs, with their upstream pins (LIVE-010). */
    readonly ported: readonly PortedRuntime[];
    /** Whether those pins were checked against the installed packages. */
    readonly upstream: UpstreamCheck;
    /** Server-lifetime service IDs in launch-tuple order; empty without a layer. */
    readonly services: readonly string[];
    readonly auth:
      | {
          readonly middleware: string;
          readonly principalService: string;
          readonly credentialsEnv: string;
        }
      | undefined;
  };
}
const unsupported = (path: string, message: string) =>
  fail("RPC_UNSUPPORTED", "rpc", path, message);
// The pinned server formats decode issues with the default formatter (the internal
// `defaultFormatter` is `makeFormatterDefault()`); a null input
// yields the top-level "Expected ..." text, to which the native decoder appends paths.
const formatIssue = SchemaIssue.makeFormatterDefault();
const expectedOf = (type: IRType<unknown>): string =>
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
const kindsOf = (
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
const kindProbes: readonly (readonly [JsonKind, unknown])[] = [
  ["boolean", true],
  ["number", 0],
  ["string", "reffect"],
  ["array", []],
  ["object", {}],
];
// Runs Effect's own decoder on one probe per rejected JSON kind; the text must match exactly.
const verifyOptional = (
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
const optionalOf = (
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
const withoutContext = (ast: SchemaAST.AST): SchemaAST.AST => {
  for (const canonical of [U64Json.ast, StringJson.ast])
    if (ast._tag === canonical._tag && ast.checks === canonical.checks) return canonical;
  return Object.freeze(
    Object.assign(Object.create(Object.getPrototypeOf(ast) as object) as SchemaAST.AST, ast, {
      context: undefined,
    }),
  );
};
// A plain union of string literals, or one string literal (LIT-002); others stay refused.
const stringLiterals = (ast: SchemaAST.AST): readonly [string, ...string[]] | undefined => {
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
const taggedClass = (
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
const sampleOf = (codec: Codec, path: string): unknown => {
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
const sampleFields = (fields: readonly FieldCodec[], path: string) =>
  Object.fromEntries(
    fields
      .filter((field) => field.optional === undefined)
      .map((field) => [field.name, sampleOf(field.codec, `${path}.${field.name}`)]),
  );
// The class must decode its struct form to an instance and encode it back unchanged.
const verifyClass = (
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
const fieldsOf = (
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
const witnessFields = (fields: Composite["fields"]) =>
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
const composite = (
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
const register = (registry: Registry, base: string, shape: Omit<Composite, "name">): Composite => {
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
const numberChecks: Record<
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
const lengthChecks: Record<
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
const isLength = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const lengthCheck = (ast: SchemaAST.Arrays, group: SchemaAST.Check<unknown>, path: string) => {
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
const f64 = (value: number): string => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return `f64::from_bits(0x${view.getBigUint64(0).toString(16).padStart(16, "0")})`;
};
const numberCodec = (
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
const codec = (
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
const local = (name: string) => Rs.identExpr(Rs.ident(name));
const callLocal = (name: string, ...args: readonly RsExpr[]) => Rs.call(local(name), args);
const encode = (kind: Codec, value: RsExpr): RsExpr => {
  if (!isScalar(kind)) return callLocal(`encode_${kind.name}`, Rs.refExpr(value));
  if (kind === "never") return Rs.unreachableMatch(value);
  if (kind === "unit")
    return Rs.block(
      [Rs.letDiscard(Rs.unitType(), value)],
      Rs.pathExpr(Rs.path([Rs.ident("Value"), Rs.ident("Null")])),
    );
  if (kind === "string") return Rs.pathCall([Rs.ident("Value")], Rs.ident("String"), [value]);
  return Rs.pathCall([Rs.ident("Value")], Rs.ident(kind === "u64" ? "String" : "Bool"), [
    kind === "u64" ? Rs.dotCall(value, Rs.ident("to_string"), []) : value,
  ]);
};
const wellFormed = (value: string) =>
  !Array.from(value).some(
    (char) => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff,
  );
const bind = <F extends AnyFn, const Fields extends readonly string[] = readonly []>(
  fn: F,
  fields?: Fields,
): RpcBinding<F> & { readonly fields: Fields; readonly principal: false } =>
  Object.freeze({
    fn,
    fields: Object.freeze(Array.from(fields ?? [])) as unknown as Fields,
    principal: false,
    services: Object.freeze([]),
  });
/** Bind a protected handler with its canonical u64 principal before the payload arguments. */
const bindPrincipal = <F extends AnyFn, const Fields extends readonly string[] = readonly []>(
  fn: F & (F["input"] extends readonly [IRType<bigint>, ...IRType<unknown>[]] ? unknown : never),
  fields?: Fields,
): RpcBinding<F> & { readonly fields: Fields; readonly principal: true } =>
  Object.freeze({
    fn,
    fields: Object.freeze(Array.from(fields ?? [])) as unknown as Fields,
    principal: true,
    services: Object.freeze([]),
  });
/**
 * Bind a public handler whose leading arguments are services built once by the server `layer`,
 * like handlers closing over services in `RpcGroup.toLayer`.
 */
const bindServices = <
  F extends AnyFn,
  const Services extends readonly Service[],
  const Fields extends readonly string[] = readonly [],
>(
  services: Services,
  fn: F,
  fields?: Fields,
): RpcBinding<F> & { readonly fields: Fields; readonly principal: false } =>
  Object.freeze({
    fn,
    fields: Object.freeze(Array.from(fields ?? [])) as unknown as Fields,
    principal: false,
    services: Object.freeze(Array.from(services)),
  });

/**
 * Procedures served by a dedicated semantic runtime (NR-012) instead of an R handler. The
 * payload is still validated by the generated decoder, with the official messages, before the
 * runtime `call` runs; it receives `payload: &Value` and returns the encoded success or failure.
 */
export interface RpcRuntime {
  /**
   * Each `call` is Rust evaluating to `Result<Value, Value>` or `Served`. In it, `payload`,
   * `context` and (in async servers) `cancellation` are in scope.
   */
  readonly procedures: {
    readonly [tag: string]: {
      readonly call: string;
      /**
       * A streaming procedure (LIVE-004): `call` yields `Result<Subscription, Value>`, whose
       * `events` are forwarded as chunks, each one wait plus whatever is queued (`takeAll`), until
       * they end; its `guard` drops when the client disconnects or the request is cancelled.
       */
      readonly stream?: boolean;
    };
  };
  /** The runtime awaits in its calls, so the server must be asynchronous. */
  readonly asynchronous?: boolean;
  /**
   * R functions the runtime calls as `runtime_<name>(context, cancellation, input).await`,
   * yielding a `RuntimeCall`. Each takes one input decoded by its schema's generated decoder and
   * produces `Unknown` (or fails with `Unknown`). Their presence makes the server asynchronous.
   */
  readonly functions?: {
    readonly [name: string]: {
      readonly fn: EffectFn<readonly IRType<unknown>[], unknown, unknown>;
      readonly input: Schema.Top;
      /** The function takes the authenticated `u64` principal before its input. */
      readonly principal?: boolean;
    };
  };
  /**
   * The server's Remote store (RS-003, SQLX-006): `begin` is an async Rust expression opening one
   * session, `Result<Arc<dyn RemoteStore>, String>`, and `impl` implements the generated trait.
   * Each async runtime function runs in its own session, committed when it succeeds and rolled
   * back otherwise. Used only when the store is reachable.
   */
  readonly store?: {
    readonly begin: string;
    readonly impl: string;
    /**
     * The live hub signals reach (LIVE-001, LIVE-008): a Rust expression of type
     * `Arc<dyn reffect_generated::LiveHub>`, set on every session's execution context.
     */
    readonly live?: string;
  };
  /**
   * What a page reads before it renders (M9-3 step 2): an async Rust expression over
   * `principal: Option<u64>`, of type `Result<(Value, Value), StatusCode>`: the data the page
   * carries (an Unknown input after the URL) and the JSON of its views (a third, typed input).
   */
  readonly pageData?: string;
  /** The ported engines these procedures run, listed in the artifact and version-checked. */
  readonly ported?: readonly PortedRuntime[];
  /** Pure R functions compiled into the program, callable as `reffect_generated::r_<name>`. */
  readonly helpers?: { readonly [name: string]: Fn<readonly IRType<unknown>[], unknown> };
  readonly modules: readonly string[];
  /** Cargo dependency lines and the crate IDs they add to the explanation. */
  readonly dependencies: readonly string[];
  readonly crates: readonly string[];
}
export type CompileOptions = {
  readonly path?: string;
  readonly auth?: RpcBearer;
  readonly failureFrames?: FailureFramePolicy;
  /** Built once at startup and released after in-flight requests on graceful shutdown. */
  readonly layer?: StaticLayer<Service, unknown>;
  /**
   * Request hardening the official server does not apply (see docs/native-divergences.md).
   * Defaults: 64 KiB bodies and 64-request batches.
   */
  readonly limits?: {
    readonly bodyBytes?: number;
    readonly batch?: number;
    /** Time to receive a request's headers, then its body, before the server gives up (#16). */
    readonly headerTimeoutMs?: number;
    readonly bodyTimeoutMs?: number;
    /** Connections served at once; beyond it, accepting waits (#16). */
    readonly connections?: number;
  };
  /**
   * The wire serialization, chosen as `RpcSerialization.layerJson`/`layerNdjson` is (STREAM-001):
   * one JSON value per body, or one message per line. Defaults to JSON.
   */
  readonly serialization?: "json" | "ndjson";
  /**
   * Server-rendered pages beside the RPC path (SSR-007), as foldkit's `handleRequest` serves them:
   * `render` is a pure R function returning `R.Result(R.Html.Rendered, R.Html.RenderError)`, and
   * `template` holds one `<div id="root"></div>` (or `containerId`) and one `<title>`.
   */
  readonly pages?: {
    readonly template: string;
    /**
     * No input, or the request URL: its target resolved against `origin` as WHATWG resolves it.
     * A host that reads data for pages (NativeRemote) also passes that data as an Unknown.
     */
    readonly render:
      | Fn<readonly [], unknown>
      | Fn<readonly [IRType<string>], unknown>
      | Fn<readonly [IRType<string>, IRType<unknown>], unknown>
      | Fn<readonly [IRType<string>, IRType<unknown>, IRType<unknown>], unknown>;
    readonly containerId?: string;
    /** The origin page URLs are resolved against; never the untrusted Host header. */
    readonly origin?: string;
  };
};
const limitOf = (value: number | undefined, fallback: number, path: string): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw unsupported(`limits.${path}`, "Limits are positive safe integers");
  return value;
};
// The server crate supplies `Schema.toCodecJson` encoders from its verified codecs (RM-006).
const serverTarget = (target: Target): Target =>
  target.pipe(Target.withCapabilities([...target.capabilities, Capabilities.JsonEncoders]));
/**
 * The contract schema whose JSON codec a witness's `Schema.toCodecJson` agrees with. Builtin
 * witnesses carry private identity filters NativeRpc refuses, so codecs are found from the
 * witness's structure; the wire test compares the result with the official encoding.
 */
const contractSchemaOf = (type: IRType<unknown>, path: string): Schema.Top => {
  const scalar = (
    [
      [NumberType, Schema.Number],
      [StringType, Schema.String],
      [BoolType, Schema.Boolean],
      [U64Type, U64Json],
      [UnknownType, Schema.Unknown],
    ] as const
  ).find(([witness]) => IRType.same(type, witness));
  if (scalar) return scalar[1];
  const item = arrayItem(type);
  if (item) return Schema.Array(contractSchemaOf(item, `${path}[]`));
  const value = recordValue(type);
  if (value) return Schema.Record(Schema.String, contractSchemaOf(value, `${path}{}`));
  const literals = literalsOf(type);
  if (literals) return Schema.Literals(literals);
  const fieldsOf = (layout: StructLayout): Schema.Struct.Fields =>
    Object.fromEntries(
      layout.fields.map((field) => {
        const at = `${path}.${field.name}`;
        const defined = field.optional === undefined ? undefined : undefinedOrItem(field.type);
        if (defined === undefined) return [field.name, contractSchemaOf(field.type, at)];
        const schema = contractSchemaOf(defined, at);
        return [
          field.name,
          field.optional === "optional" ? Schema.optional(schema) : Schema.optionalKey(schema),
        ];
      }),
    );
  const struct = structLayout(type);
  if (struct) return Schema.Struct(fieldsOf(struct));
  const cases = unionCases(type);
  if (cases)
    return Schema.Union(
      cases.map((member) => {
        const layout = structLayout(member);
        if (!layout?.tag) throw unsupported(path, "Union cases must be tagged structs");
        return Schema.TaggedStruct(layout.tag, fieldsOf(layout));
      }),
    );
  throw unsupported(path, "No JSON codec for this witness");
};
// `foldkit-remote`'s stableStringify; ryu-js writes doubles as JS's Number#toString does.
const stableStringifyRust = String.raw`
/// stableStringify over JSON (RM-005): keys sorted by UTF-16 code units, JS number text.
pub fn stable_stringify(value: &Value) -> String {
    let mut out = String::new();
    stable_into(value, &mut out);
    out
}
fn stable_into(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            let x = number.as_f64().unwrap_or(f64::NAN);
            if !x.is_finite() { out.push_str("null") }
            else if x == 0.0 { out.push('0') }
            else { out.push_str(ryu_js::Buffer::new().format_finite(x)) }
        }
        Value::String(text) => out.push_str(&serde_json::to_string(text).expect("strings serialize")),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 { out.push(','); }
                stable_into(item, out);
            }
            out.push(']');
        }
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 { out.push(','); }
                out.push_str(&serde_json::to_string(key).expect("strings serialize"));
                out.push(':');
                stable_into(&object[key.as_str()], out);
            }
            out.push('}');
        }
    }
}
`;
/** The library's `reffect_json` module: the host functions the program reaches. */
const jsonModule = (plan: Plan): { readonly text: string; readonly stable: boolean } => {
  const witnesses = plan.analysis.operations.flatMap((operation) => {
    const witness = jsonEncodedWitness(operation);
    return witness ? [witness] : [];
  });
  const decoded = plan.analysis.operations.flatMap((operation) => {
    const witness = jsonDecodedWitness(operation);
    return witness ? [witness] : [];
  });
  const stable = plan.analysis.operations.some(
    (operation) => operation.ref === StableStringify.ref,
  );
  if (witnesses.length === 0 && decoded.length === 0 && !stable) return { text: "", stable };
  const registry: Registry = new Map();
  const codecOf = (type: IRType<unknown>, decode: boolean) => {
    const path = `Schema.toCodecJson(${type.id})`;
    const kind = codec(contractSchemaOf(type, path).ast, path, decode, registry, false);
    if (kind === "never" || !IRType.same(witnessOf(kind), type))
      throw unsupported(path, "No verified JSON codec maps back onto this witness");
    return kind;
  };
  const encoders = witnesses.map((type) => ({
    name: jsonEncoderName(type),
    type,
    codec: codecOf(type, false),
  }));
  const decoders = decoded.map((type) => ({
    name: jsonDecoderName(type),
    type,
    codec: codecOf(type, true),
  }));
  return {
    text: `
#[allow(non_snake_case, dead_code)]
pub mod reffect_json {
${compositeCodecs(Array.from(registry.values()), encoders, decoders)}${stable ? stableStringifyRust : ""}}
`,
    stable,
  };
};
const compile = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  bindings: Bindings<Rpcs>,
  options: CompileOptions = {},
): Effect.Effect<RpcArtifact, import("./kernel.ts").CompileError> =>
  compileServer(group, bindings, options, undefined);
/** NativeRpc composition with runtime-served procedures; the public API keeps bindings typed. */
export const compileServer = (
  group: { readonly requests: ReadonlyMap<string, unknown> },
  bindings: { readonly [tag: string]: RpcBinding },
  options: CompileOptions,
  runtime: RpcRuntime | undefined,
): Effect.Effect<RpcArtifact, import("./kernel.ts").CompileError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => {
        const path = options.path ?? "/rpc";
        const limits = {
          body: limitOf(options.limits?.bodyBytes, 65536, "bodyBytes"),
          batch: limitOf(options.limits?.batch, 64, "batch"),
          headerTimeoutMs: limitOf(options.limits?.headerTimeoutMs, 30000, "headerTimeoutMs"),
          bodyTimeoutMs: limitOf(options.limits?.bodyTimeoutMs, 30000, "bodyTimeoutMs"),
          connections: limitOf(options.limits?.connections, 1024, "connections"),
        };
        if (!/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path))
          throw unsupported(
            "path",
            "Path must be a literal absolute route without a trailing slash",
          );
        const entries = Array.from(group.requests.values());
        if (entries.length === 0) throw unsupported("group", "RPC group must contain a procedure");
        const served = Object.keys(runtime?.procedures ?? {});
        if (
          Reflect.ownKeys(bindings).length + served.length !== entries.length ||
          served.some((tag) => Object.hasOwn(bindings, tag) || !group.requests.has(tag))
        )
          throw unsupported("bindings", "Bindings must match the RPC group exactly");
        const auth = options.auth;
        if (auth && !(auth instanceof RpcBearer))
          throw unsupported("auth", "Expected a checked bearer adapter");
        if (
          auth &&
          (auth.middleware.error.ast !== auth.denialAst ||
            !SchemaAST.isLiteral(auth.denialAst) ||
            auth.denialAst.literal !== auth.denied ||
            auth.denialAst.checks ||
            auth.denialAst.encoding ||
            auth.denialAst.context ||
            auth.denialAst.annotations)
        )
          throw unsupported("auth", "Middleware denial schema changed after adapter creation");
        let protectedCount = 0;
        let ranges = false;
        const registry: Registry = new Map();
        const functions: Record<string, AnyFn> = {};
        const layer = options.layer;
        if (layer !== undefined && !(layer instanceof StaticLayer))
          throw unsupported("layer", "Expected an R.Layer provider graph");
        // Launch tuple positions, deduplicated by service ID in first-binding order.
        const serverServices: Service[] = [];
        // Runtime-served payload witnesses, kept reachable so their native types are emitted.
        const runtimePayloads: IRType<unknown>[] = [];
        for (const [name, fn] of Object.entries(runtime?.helpers ?? {})) {
          if (!/^[a-z][a-z0-9_]*$/.test(name) || Object.hasOwn(functions, name))
            throw unsupported(
              `runtime.${name}`,
              "Helper names are distinct lowercase Rust identifiers",
            );
          if (!(fn instanceof Fn))
            throw unsupported(`runtime.${name}`, "Helpers are pure R functions");
          functions[name] = fn;
        }
        const runtimeFunctions = Object.entries(runtime?.functions ?? {}).map(
          ([name, { fn, input, principal }]) => {
            const at = `runtime.${name}`;
            if (!/^[a-z][a-z0-9_]*$/.test(name))
              throw unsupported(at, "Runtime function names are lowercase Rust identifiers");
            const arity = principal ? 2 : 1;
            if (
              !(fn instanceof EffectFn) ||
              fn.input.length !== arity ||
              (principal && !IRType.same(fn.input[0], U64Type))
            )
              throw unsupported(
                at,
                "Runtime functions are R effect functions of one input, after a U64 principal if any",
              );
            if (principal && !auth)
              throw unsupported(at, "A runtime function with a principal needs an auth adapter");
            if (
              !IRType.same(fn.output, UnknownType) ||
              !(IRType.same(fn.error, UnknownType) || IRType.same(fn.error, NeverType))
            )
              throw unsupported(at, "Runtime functions produce and fail with Unknown");
            const kind = codec(input.ast, `${at}.input`, true, registry, true);
            if (kind === "never" || !IRType.same(witnessOf(kind), fn.input[arity - 1]))
              throw unsupported(at, "The input witness disagrees with its schema");
            functions[`runtime_${name}`] = fn;
            return {
              name,
              kind,
              principal: principal === true,
              asynchronous: isAsyncComputation(fn.body),
              fails: !IRType.same(fn.error, NeverType),
            };
          },
        );
        const servicePosition = (service: Service, procedure: string): number => {
          if (!(service instanceof Service))
            throw unsupported(procedure, "Expected an R.Context service");
          const index = serverServices.findIndex((known) => known.id === service.id);
          if (index >= 0) {
            if (!IRType.same(serverServices[index].type, service.type))
              throw unsupported(procedure, "Service ID reused with a different witness");
            return index;
          }
          if (!layer) throw unsupported(procedure, "Server services require a NativeRpc layer");
          if (![U64Type, BoolType, UnitType].some((type) => IRType.same(service.type, type)))
            throw unsupported(procedure, "Server services must be Boolean, u64 or Unit scalars");
          serverServices.push(service);
          return serverServices.length - 1;
        };
        // The bearer check, after payload validation: a denial answers with the adapter's literal.
        const authenticate = (bearer: RpcBearer) => [
          Rs.exprStmt(
            Rs.letElse(
              Rs.variantPat([Rs.ident("Some")], [Rs.identPat(Rs.ident("principal"))]),
              callLocal("authenticate", local("headers"), local("message"), local("state")),
              Rs.block([
                Rs.stmt(
                  Rs.return_(
                    Rs.ok(
                      callLocal(
                        "failure",
                        Rs.pathCall([Rs.ident("Value")], Rs.ident("String"), [
                          Rs.dotCall(Rs.stringLiteral(bearer.denied), Rs.ident("to_string"), []),
                        ]),
                      ),
                    ),
                  ),
                ),
              ]),
            ),
          ),
          Rs.assign(Rs.field(local("context"), Rs.ident("principal")), Rs.some(local("principal"))),
        ];
        const arms = entries.map((definition, index) => {
          if (!Rpc.isRpc(definition)) throw unsupported("group", "Expected a stock RPC definition");
          const rpc: Rpc.AnyWithProps = definition;
          const procedure = `rpc.${rpc._tag}`;
          if (!wellFormed(rpc._tag)) throw unsupported(procedure, "RPC tags must be valid Unicode");
          const served = runtime?.procedures[rpc._tag];
          if (served && Object.hasOwn(runtime!.procedures, rpc._tag)) {
            const protectedServed = rpc.middlewares.size !== 0;
            if (
              protectedServed &&
              (!auth || rpc.middlewares.size !== 1 || !rpc.middlewares.has(auth.middleware))
            )
              throw unsupported(
                procedure,
                "Exactly one middleware with a matching bearer adapter is supported",
              );
            if (protectedServed) protectedCount++;
            const servedStream = RpcSchema.isStreamSchema(rpc.successSchema)
              ? { success: rpc.successSchema.success, error: rpc.successSchema.error }
              : undefined;
            if ((servedStream !== undefined) !== (served.stream === true))
              throw unsupported(
                procedure,
                "A runtime-served procedure streams exactly when its contract does",
              );
            if (servedStream && !runtime!.asynchronous)
              throw unsupported(procedure, "Runtime-served streams need an asynchronous server");
            if (rpc.defectSchema.ast !== Schema.Defect().ast)
              throw unsupported(procedure, "Custom defect codecs are unsupported");
            // The contract must be admitted even though the runtime encodes its own results, so
            // results are checked against a scratch registry and emit no codecs.
            codec(
              (servedStream?.success ?? rpc.successSchema).ast,
              `${procedure}.success`,
              false,
              new Map(),
              false,
            );
            codec(
              (servedStream?.error ?? rpc.errorSchema).ast,
              `${procedure}.error`,
              false,
              new Map(),
              false,
            );
            const kind = codec(rpc.payloadSchema.ast, `${procedure}.payload`, true, registry, true);
            runtimePayloads.push(witnessOf(kind));
            const validate = isScalar(kind)
              ? callLocal(`${kind}_arg`, local("payload"), Rs.none())
              : callLocal(`decode_${kind.name}`, local("payload"), Rs.none());
            return {
              pat: Rs.stringPat(rpc._tag),
              body: Rs.block(
                [
                  Rs.stmt(Rs.try_(validate)),
                  ...(protectedServed && auth ? authenticate(auth) : []),
                ],
                Rs.ok(
                  Rs.verbatimExpr(
                    servedStream
                      ? // The forwarder stops on disconnect or cancellation; dropping the subscription unsubscribes.
                        `match ${served.call} { Err(error) => failure(error), Ok(mut subscription) => { let ended = forward_chunks(context.out, context.id, cancellation, &mut subscription.events).await; drop(subscription); if ended { success(Value::Null) } else { interrupted() } } }`
                      : `match Served::from(${served.call}) { Served::Success(value) => success(value), Served::Failure(error) => failure(error), Served::Interrupted => ${runtimeFunctions.length ? "interrupted()" : 'unreachable!("only runtime functions are interrupted")'} }`,
                  ),
                ),
              ),
            };
          }
          const descriptor = Object.getOwnPropertyDescriptor(bindings, rpc._tag);
          const binding: RpcBinding | undefined = descriptor?.value;
          if (!binding || (!(binding.fn instanceof Fn) && !(binding.fn instanceof EffectFn)))
            throw unsupported(procedure, "Missing own-data handler binding");
          const protectedRpc = rpc.middlewares.size !== 0;
          if (
            protectedRpc &&
            (!auth || rpc.middlewares.size !== 1 || !rpc.middlewares.has(auth.middleware))
          )
            throw unsupported(
              procedure,
              "Exactly one middleware with a matching bearer adapter is supported",
            );
          if (binding.principal !== protectedRpc)
            throw unsupported(
              procedure,
              "Protected procedures require bindPrincipal; public procedures require bind",
            );
          if (protectedRpc) protectedCount++;
          const services = binding.services ?? [];
          if (protectedRpc && services.length)
            throw unsupported(
              procedure,
              "Protected procedures cannot also bind server services yet",
            );
          const positions = services.map((service) => servicePosition(service, procedure));
          // A streaming procedure's elements and failures come from its stream schema (STREAM-006).
          const streamed = RpcSchema.isStreamSchema(rpc.successSchema)
            ? { success: rpc.successSchema.success, error: rpc.successSchema.error }
            : undefined;
          if (rpc.defectSchema.ast !== Schema.Defect().ast)
            throw unsupported(procedure, "Custom defect codecs are unsupported");
          const success = codec(
            (streamed?.success ?? rpc.successSchema).ast,
            `${procedure}.success`,
            false,
            registry,
            false,
          );
          const error = codec(
            (streamed?.error ?? rpc.errorSchema).ast,
            `${procedure}.error`,
            false,
            registry,
            false,
          );
          const fn = binding.fn;
          const streamItem =
            fn instanceof EffectFn
              ? Match.value(fn.body.node).pipe(
                  Match.tag("StreamEmit", (n) => n.stream.item),
                  Match.orElse(() => undefined),
                )
              : undefined;
          if (streamed !== undefined && streamItem === undefined)
            throw unsupported(procedure, "A streaming procedure binds an R.Stream.fn");
          if (streamed === undefined && streamItem !== undefined)
            throw unsupported(procedure, "An R.Stream.fn answers a stream: true procedure");
          if (
            !IRType.same(streamItem ?? fn.output, witnessOf(success)) ||
            !IRType.same(fn instanceof EffectFn ? fn.error : NeverType, witnessOf(error))
          )
            throw unsupported(
              procedure,
              "Handler success/error witnesses disagree with RPC schemas",
            );
          const payload = rpc.payloadSchema.ast;
          const offset = (protectedRpc ? 1 : 0) + services.length;
          // A handler taking exactly the payload's composite type receives it whole; otherwise a
          // Struct payload is projected into handler arguments by field name.
          const whole =
            binding.fields.length === 0 &&
            fn.input.length === offset + 1 &&
            (SchemaAST.isObjects(payload) || SchemaAST.isUnion(payload)) &&
            fn.input[offset].layout !== undefined;
          let inputs: readonly {
            readonly name: string;
            readonly codec: Codec;
            readonly range?: ReturnType<typeof u64RangeOf>;
          }[];
          if (SchemaAST.isObjects(payload) && !whole) {
            if (
              payload.encoding ||
              payload.checks ||
              payload.context ||
              payload.annotations ||
              payload.indexSignatures.length ||
              payload.encodingChecks
            )
              throw unsupported(
                `${procedure}.payload`,
                "Only plain flat required Struct payloads are supported",
              );
            const fields = payload.propertySignatures;
            if (
              fields.some((field) => typeof field.name !== "string" || !wellFormed(field.name)) ||
              binding.fields.length !== fields.length ||
              new Set(binding.fields).size !== fields.length
            )
              throw unsupported(
                `${procedure}.payload`,
                "Supply every payload field exactly once in handler argument order",
              );
            inputs = binding.fields.map((name) => {
              const field = fields.find((field) => field.name === name);
              if (!field) throw unsupported(procedure, `Unknown payload field ${name}`);
              if (field.type.context?.isOptional)
                throw unsupported(
                  `${procedure}.payload.${name}`,
                  "Optional payload fields require binding the whole Struct",
                );
              return {
                name,
                codec: codec(field.type, `${procedure}.payload.${name}`, true, registry, true),
                range: u64RangeOf(field.type),
              };
            });
          } else {
            const kind = codec(payload, `${procedure}.payload`, true, registry, true);
            if (binding.fields.length)
              throw unsupported(procedure, "Scalar payload bindings have no named fields");
            inputs =
              kind === "unit" && fn.input.length === (protectedRpc ? 1 : 0) + services.length
                ? []
                : [{ name: "", codec: kind, range: u64RangeOf(payload) }];
          }
          if (inputs.some((input) => input.range !== undefined)) ranges = true;
          if (
            (protectedRpc && !IRType.same(fn.input[0], U64Type)) ||
            services.some((service, i) => !IRType.same(fn.input[i], service.type)) ||
            fn.input.length !== inputs.length + offset ||
            inputs.some(
              (input, i) =>
                input.codec === "never" ||
                !IRType.same(fn.input[i + offset], witnessOf(input.codec)),
            )
          )
            throw unsupported(procedure, "Handler argument witnesses disagree with payload fields");
          const name = `handler_${index}`;
          functions[name] = fn;
          const isRecord = SchemaAST.isObjects(payload) && !whole;
          const args = inputs.map((input) =>
            Rs.try_(
              isScalar(input.codec)
                ? callLocal(
                    input.range ? "u64_range_arg" : `${input.codec}_arg`,
                    isRecord
                      ? Rs.try_(callLocal("field", local("payload"), Rs.stringLiteral(input.name)))
                      : local("payload"),
                    isRecord ? Rs.some(Rs.stringLiteral(input.name)) : Rs.none(),
                    ...(input.range
                      ? [Rs.litU64(input.range.minimum), Rs.litU64(input.range.maximum)]
                      : []),
                  )
                : callLocal(
                    `decode_${input.codec.name}`,
                    isRecord
                      ? Rs.try_(callLocal("field", local("payload"), Rs.stringLiteral(input.name)))
                      : local("payload"),
                    isRecord
                      ? Rs.some(
                          Rs.verbatimExpr(
                            `&Path { parent: None, name: ${Rs.stringLiteral(input.name).text}, index: false }`,
                          ),
                        )
                      : Rs.none(),
                  ),
            ),
          );
          const statements = isRecord
            ? [
                Rs.stmt(
                  Rs.if_(
                    payload.propertySignatures.length === 0
                      ? Rs.dotCall(local("payload"), Rs.ident("is_null"), [])
                      : Rs.prefix("!", Rs.dotCall(local("payload"), Rs.ident("is_object"), [])),
                    Rs.inlineStmtBlock(
                      Rs.stmt(
                        Rs.return_(
                          Rs.err(
                            Rs.dotCall(
                              Rs.stringLiteral(
                                payload.propertySignatures.length === 0
                                  ? "Expected object | array"
                                  : "Expected object",
                              ),
                              Rs.ident("to_string"),
                              [],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ]
            : inputs.length === 0
              ? [Rs.stmt(Rs.try_(callLocal("unit_arg", local("payload"), Rs.none())))]
              : [];
          const inputIndices = new Map(inputs.map((input, index) => [input.name, index]));
          const validationOrder = isRecord
            ? payload.propertySignatures.map((field) => {
                const index = inputIndices.get(String(field.name));
                if (index === undefined)
                  throw unsupported(procedure, "Missing handler argument for payload field");
                return index;
              })
            : inputs.map((_input, index) => index);
          validationOrder.forEach((index) =>
            statements.push(Rs.let_(Rs.ident(`arg_${index}`), undefined, args[index])),
          );
          if (protectedRpc && auth) statements.push(...authenticate(auth));
          const asynchronous = fn instanceof EffectFn && isAsyncComputation(fn.body);
          positions.forEach((position, i) =>
            statements.push(
              Rs.verbatimStmt(
                `let service_${i} = SERVICES.get().expect("services are published before serving").${position};`,
              ),
            ),
          );
          const arguments_ = (protectedRpc ? [local("principal")] : [])
            .concat(positions.map((_position, i) => local(`service_${i}`)))
            .concat(inputs.map((_input, i) => local(`arg_${i}`)));
          if (asynchronous)
            statements.push(
              Rs.verbatimStmt(
                "let mut execution = execution_context(cancellation.clone(), context);",
              ),
            );
          const compiledCall = Rs.pathCall(
            [Rs.ident("reffect_generated")],
            Rs.ident(`r_${name}`),
            (asynchronous ? [Rs.mutRefExpr(local("execution"))] : []).concat(arguments_),
          );
          const call = asynchronous
            ? Rs.await(compiledCall)
            : callLocal(
                "in_context",
                local("context"),
                Rs.closureTyped([], undefined, compiledCall),
              );
          if (streamItem !== undefined) {
            const failed =
              error === "never"
                ? "match error {}"
                : callLocal("failure", encode(error, local("error"))).text;
            statements.push(
              Rs.verbatimStmt(
                [
                  "let (sink, mut chunks) = tokio::sync::mpsc::channel::<Vec<Value>>(1);",
                  "execution.set_stream_sink(sink);",
                  "let (out, id, watch) = (context.out, context.id, cancellation.clone());",
                  // Each future owns its end: when the client goes away the forwarder stops, its
                  // receiver drops, and the producer's next send interrupts it (STREAM-003).
                  `let run = async move { let result = ${compiledCall.text}.await; drop(execution); result };`,
                  "let forward = async move { forward_chunks(out, id, &watch, &mut chunks).await; };",
                  "let (result, ()) = tokio::join!(run, forward);",
                ].join(" "),
              ),
            );
            return {
              pat: Rs.stringPat(rpc._tag),
              body: Rs.block(
                statements,
                Rs.ok(
                  Rs.verbatimExpr(
                    `match result { Ok(()) => success(Value::Null), Err(reffect_generated::AsyncError::Fail(error)) => ${failed}, Err(reffect_generated::AsyncError::Interrupted) => interrupted() }`,
                  ),
                ),
              ),
            };
          }
          const result =
            fn instanceof EffectFn
              ? Rs.match_(call, [
                  {
                    pat: Rs.variantPat([Rs.ident("Ok")], [Rs.identPat(Rs.ident("value"))]),
                    body: callLocal("success", encode(success, local("value"))),
                  },
                  {
                    pat: asynchronous
                      ? Rs.pat("Err(reffect_generated::AsyncError::Fail(error))")
                      : Rs.variantPat([Rs.ident("Err")], [Rs.identPat(Rs.ident("error"))]),
                    body:
                      error === "never"
                        ? Rs.unreachableMatch(local("error"))
                        : callLocal("failure", encode(error, local("error"))),
                  },
                  ...(asynchronous
                    ? [
                        {
                          pat: Rs.pat("Err(reffect_generated::AsyncError::Interrupted)"),
                          body: callLocal("interrupted"),
                        },
                      ]
                    : []),
                ])
              : callLocal("success", encode(success, call));
          return { pat: Rs.stringPat(rpc._tag), body: Rs.block(statements, Rs.ok(result)) };
        });
        if (auth && protectedCount === 0) throw unsupported("auth", "Bearer adapter is unused");
        let pages:
          | {
              readonly kind: Codec;
              readonly parts: ReadonlyArray<TemplatePart>;
              readonly takesUrl: boolean;
              readonly takesData: boolean;
              readonly views: Codec | undefined;
              readonly origin: string;
            }
          | undefined;
        if (options.pages) {
          const { render, template, containerId, origin = "http://localhost" } = options.pages;
          const takesData = runtime?.pageData !== undefined;
          if (
            !(render instanceof Fn) ||
            (takesData
              ? (render.input.length !== 2 && render.input.length !== 3) ||
                !IRType.same(render.input[0]!, StringType) ||
                !IRType.same(render.input[1]!, UnknownType)
              : render.input.length > 1 ||
                (render.input.length === 1 && !IRType.same(render.input[0]!, StringType)))
          )
            throw unsupported(
              "pages.render",
              takesData
                ? "The page is a pure R function of the request URL (String), its data (Unknown) and optionally its views"
                : "The page is a pure R function of nothing or of the request URL (String)",
            );
          let base: URL;
          try {
            base = new URL(origin);
          } catch {
            throw unsupported("pages.origin", "The origin is an absolute URL");
          }
          if (base.origin === "null" || base.href !== `${base.origin}/`)
            throw unsupported("pages.origin", "The origin is a scheme, host and port only");
          const kind = codec(PageSchema.ast, "pages.render", false, registry, false);
          if (!IRType.same(render.output, witnessOf(kind)))
            throw unsupported(
              "pages.render",
              "The page returns R.Result(R.Html.Rendered, R.Html.RenderError)",
            );
          if (Object.hasOwn(functions, "ssr_page"))
            throw unsupported("pages.render", "ssr_page is reserved for the page");
          functions.ssr_page = render;
          pages = {
            kind,
            parts: splitTemplate(template, containerId),
            takesUrl: render.input.length >= 1,
            takesData,
            views:
              render.input.length === 3
                ? codec(
                    contractSchemaOf(render.input[2]!, "pages.render.views").ast,
                    "pages.render.views",
                    true,
                    registry,
                    true,
                  )
                : undefined,
            origin: base.href,
          };
        }
        if (layer)
          functions.launch = EffectFn.make([], NeverType, layer.error, () =>
            StaticLayer.provide(layer, (context) =>
              launch(serverServices.map((service) => context.get(service))),
            ),
          );
        return {
          path,
          limits,
          auth,
          ranges,
          composites: Array.from(registry.values()),
          // Validated runtime payloads decode into native types, which only reachable witnesses get.
          program: Program.make(
            runtimePayloads.length
              ? {
                  ...functions,
                  runtime_payloads: Fn.make(runtimePayloads, BoolType, () =>
                    Expr.literal(BoolType, true),
                  ),
                }
              : functions,
          ),
          arms,
          pages,
          layered: layer !== undefined,
          services: serverServices.map((service) => service.id),
          runtimeFunctions,
          asynchronous:
            runtime?.asynchronous === true ||
            runtimeFunctions.length > 0 ||
            Object.values(functions).some(
              (fn) => fn instanceof EffectFn && isAsyncComputation(fn.body),
            ),
          hasSynchronousEffects: Object.values(functions).some(
            (fn) => fn instanceof EffectFn && !isAsyncComputation(fn.body),
          ),
        };
      },
      catch: (cause) =>
        cause instanceof CompileError ? cause : unsupported("group", String(cause)),
    });
    if (
      Object.values(prepared.program.functions).some(
        (fn) => fn instanceof EffectFn && analyzeTaskGroups(fn.body).requiresRichErrors,
      )
    )
      return yield* unsupported(
        "handlers",
        "Cancellation-retained failures and fallible task groups require a verified compound RPC Cause wire adapter",
      );
    const core = yield* Compile.run(
      Compile.make(prepared.program).pipe(
        Compile.withTarget(serverTarget(prepared.asynchronous ? Rust.tokio : Rust.std)),
        Compile.withSourceArtifacts(SourceArtifacts.None),
        Compile.withFailureFrames(options.failureFrames ?? FailureFrames.Bounded),
      ),
    );
    // The HTTP manifest composes Tokio and serde_json (which Unknown codecs configure with
    // preserve_order, UNK-003). Refuse other core crates until composition supports them.
    if (
      core.explanation.crates.some(
        (crate) =>
          crate !== "tokio@1.53.1" && crate !== "serde_json@1.0.151" && crate !== "ryu-js@1.0.3",
      )
    )
      return yield* unsupported(
        "crates",
        "HTTP manifest composition does not support selected core crates",
      );
    const clear =
      prepared.hasSynchronousEffects && !FailureFrames.isNone(core.failureFrames)
        ? [
            Rs.letDiscard(
              Rs.unitType(),
              Rs.pathCall([Rs.ident("reffect_generated")], Rs.ident("clear_last_frames"), []),
            ),
          ]
        : [];
    const dispatch = (prepared.asynchronous ? Rs.asyncFnItem : Rs.fnItem)(
      Rs.ident("dispatch"),
      [
        { name: Rs.ident("tag"), type: Rs.refType(Rs.strType()) },
        { name: Rs.ident("payload"), type: Rs.refType(Rs.namedType("Value")) },
        { name: Rs.ident("headers"), type: Rs.refType(Rs.namedType("HeaderMap")) },
        { name: Rs.ident("message"), type: Rs.refType(Rs.namedType("Value")) },
        { name: Rs.ident("state"), type: Rs.refType(Rs.namedType("RuntimeState")) },
        {
          name: Rs.ident("context"),
          type: Rs.mutRefType(
            prepared.asynchronous
              ? Rs.verbatimType("RequestContext<'_>")
              : Rs.namedType("RequestContext"),
          ),
        },
        ...(prepared.asynchronous
          ? [
              {
                name: Rs.ident("cancellation"),
                type: Rs.refType(
                  Rs.genericType(
                    Rs.pathType([
                      Rs.ident("tokio"),
                      Rs.ident("sync"),
                      Rs.ident("watch"),
                      Rs.ident("Receiver"),
                    ]),
                    [Rs.boolType()],
                  ),
                ),
              },
            ]
          : []),
      ],
      Rs.resultType(Rs.namedType("Value"), Rs.stringType()),
      Rs.block(
        [],
        Rs.match_(
          local("tag"),
          prepared.arms.concat([
            {
              pat: Rs.wildcardPat(),
              body: Rs.err(
                Rs.macroCall(Rs.ident("format"), [
                  Rs.stringLiteral("Unknown request tag: {}"),
                  local("tag"),
                ]),
              ),
            },
          ]),
        ),
      ),
    );
    const encoders = yield* Effect.try({
      try: () => jsonModule(core.explanation),
      catch: (cause) =>
        cause instanceof CompileError ? cause : unsupported("Schema.toCodecJson", String(cause)),
    });
    const ryuJs = encoders.stable || core.explanation.crates.includes("ryu-js@1.0.3");
    const hasLogs = core.explanation.analysis.effects.includes(SyncEffects.Log);
    // Live signals travel through the store session, so they need it too (LIVE-001).
    const usesLive = core.explanation.analysis.effects.includes(AsyncEffects.LiveHub);
    const usesStore =
      usesLive || core.explanation.analysis.effects.includes(AsyncEffects.RemoteStore);
    if (usesStore && !runtime?.store)
      return yield* unsupported(
        "RemoteStore",
        "RemoteStore operations need a NativeRemote host store",
      );
    if (usesLive && !runtime?.store?.live)
      return yield* unsupported(
        "LiveHub",
        "LiveHub signals need a NativeRemote live hub (live: true)",
      );
    const contextRuntime = hasLogs
      ? String.raw`
fn in_context<T>(context: &RequestContext, f: impl FnOnce() -> T) -> T {
    let metadata = json!({"id":context.id, "tag":context.tag, "principal":context.principal.map(|p| p.to_string())});
    reffect_generated::with_log_context(metadata.to_string(), f)
}`
      : "fn in_context<T>(_context: &RequestContext, f: impl FnOnce() -> T) -> T { f() }";
    // Only compiled async functions take an execution context; a server can be asynchronous for
    // its runtime alone (synchronous mutation sources), with no AsyncContext generated.
    const hasAsyncFunctions = Object.values(prepared.program.functions).some(
      (fn) => fn instanceof EffectFn && isAsyncComputation(fn.body),
    );
    const executionRuntime = prepared.asynchronous
      ? `${
          hasAsyncFunctions
            ? `
fn execution_context(cancellation: tokio::sync::watch::Receiver<bool>, context: &RequestContext) -> reffect_generated::AsyncContext {
    let mut execution = reffect_generated::AsyncContext::new(cancellation);
    ${hasLogs ? 'execution.set_request(json!({"id":context.id, "tag":context.tag, "principal":context.principal.map(|p| p.to_string())}).to_string());' : "let _ = context;"}
    execution
}`
            : ""
        }
fn interrupted() -> Value { json!({"_tag":"Failure", "cause":[{"_tag":"Interrupt"}]}) }
`
      : "";
    const decodeCall = (kind: Codec): string =>
      isScalar(kind) ? `${kind}_arg(input, None)` : `decode_${kind.name}(input, None)`;
    const servedRuntime = runtime
      ? `
/// A runtime-served answer: success, typed failure, or interruption of a runtime function.
enum Served { Success(Value), Failure(Value), ${prepared.runtimeFunctions.length ? "Interrupted" : "#[allow(dead_code)] Interrupted"} }
impl From<Result<Value, Value>> for Served {
    fn from(result: Result<Value, Value>) -> Self { match result { Ok(value) => Served::Success(value), Err(error) => Served::Failure(error) } }
}
${
  prepared.runtimeFunctions.length
    ? `/// A runtime function's outcome; \`Invalid\` means its input failed the generated decoder.
#[allow(dead_code)]
enum RuntimeCall { Invalid(String), Success(Value), Failure(Value), Interrupted, StoreFailed(String) }
`
    : ""
}${prepared.runtimeFunctions
          .map((f) => {
            const call = `reffect_generated::r_runtime_${f.name}`;
            const failure = f.fails ? "RuntimeCall::Failure(error)" : "match error {}";
            // Hosts call functions that take a principal only from protected procedures.
            const args = f.principal
              ? 'context.principal.expect("authenticated before runtime functions run"), arg'
              : "arg";
            return `async fn runtime_${f.name}(context: &RequestContext<'_>, cancellation: &tokio::sync::watch::Receiver<bool>, input: &Value) -> RuntimeCall {
    let arg = match ${decodeCall(f.kind)} { Ok(arg) => arg, Err(message) => return RuntimeCall::Invalid(message) };
${
  f.asynchronous && usesStore
    ? `    let mut execution = execution_context(cancellation.clone(), context);
    // One store session per run: committed on success, rolled back on failure or interruption.
    let store = match ${runtime!.store!.begin} { Ok(store) => store, Err(message) => return RuntimeCall::StoreFailed(message) };
    execution.set_remote_store(store.clone());${
      runtime!.store!.live
        ? `
    execution.set_live_hub(${runtime!.store!.live});`
        : ""
    }
    let outcome = ${call}(&mut execution, ${args}).await;
    drop(execution);
    match outcome {
        Ok(value) => match store.finish(true).await { Ok(()) => RuntimeCall::Success(value), Err(message) => RuntimeCall::StoreFailed(message) },
        Err(reffect_generated::AsyncError::Fail(error)) => { let _ = store.finish(false).await; ${failure} }
        Err(reffect_generated::AsyncError::Interrupted) => {
            let _ = store.finish(false).await;
            match store.failure() { Some(message) => RuntimeCall::StoreFailed(message), None => RuntimeCall::Interrupted }
        }
    }`
    : f.asynchronous
      ? `    let mut execution = execution_context(cancellation.clone(), context);
    match ${call}(&mut execution, ${args}).await {
        Ok(value) => RuntimeCall::Success(value),
        Err(reffect_generated::AsyncError::Fail(error)) => ${failure},
        Err(reffect_generated::AsyncError::Interrupted) => RuntimeCall::Interrupted,
    }`
      : `    let _ = cancellation;
    match in_context(context, || ${call}(${args})) { Ok(value) => RuntimeCall::Success(value), Err(error) => ${failure} }`
}
}
`;
          })
          .join("")}`
      : "";
    const authRuntime = prepared.auth
      ? rpcAuthRuntime
      : "#[derive(Clone)] struct RuntimeState; fn load_state() -> Result<RuntimeState, &'static str> { Ok(RuntimeState) }\n#[allow(dead_code)]\nfn page_principal(_: &HeaderMap, _: &RuntimeState) -> Option<u64> { None }";
    const main = Rs.itemsText(
      [
        Rs.constItem(Rs.ident("RPC_PATH"), Rs.strRefType(), Rs.stringLiteral(prepared.path)),
        Rs.constItem(Rs.ident("MAX_BODY"), Rs.usizeType(), Rs.litInt(prepared.limits.body)),
        Rs.constItem(Rs.ident("MAX_BATCH"), Rs.usizeType(), Rs.litInt(prepared.limits.batch)),
        Rs.constItem(
          Rs.ident("HEADER_TIMEOUT_MS"),
          Rs.u64Type(),
          Rs.litInt(prepared.limits.headerTimeoutMs),
        ),
        Rs.constItem(
          Rs.ident("BODY_TIMEOUT_MS"),
          Rs.u64Type(),
          Rs.litInt(prepared.limits.bodyTimeoutMs),
        ),
        Rs.constItem(
          Rs.ident("MAX_CONNECTIONS"),
          Rs.usizeType(),
          Rs.litInt(prepared.limits.connections),
        ),
        ...(prepared.auth
          ? [
              Rs.constItem(
                Rs.ident("CREDENTIALS_ENV"),
                Rs.strRefType(),
                Rs.stringLiteral(prepared.auth.credentialsEnv),
              ),
            ]
          : []),
        ...(clear.length
          ? [Rs.fnItem(Rs.ident("clear_frames"), [], Rs.unitType(), Rs.block(clear))]
          : []),
        dispatch,
        ...(prepared.composites.length
          ? [Rs.verbatimItem(compositeCodecs(prepared.composites))]
          : []),
        Rs.verbatimItem(contextRuntime),
        ...(executionRuntime ? [Rs.verbatimItem(executionRuntime)] : []),
        ...(servedRuntime ? [Rs.verbatimItem(servedRuntime)] : []),
        ...(prepared.pages
          ? [
              Rs.verbatimItem(
                pageRuntime(
                  prepared.pages.parts,
                  prepared.pages.origin,
                  encode(
                    prepared.pages.kind,
                    Rs.pathCall(
                      [Rs.ident("reffect_generated")],
                      Rs.ident("r_ssr_page"),
                      prepared.pages.takesData
                        ? [
                            Rs.verbatimExpr("href.clone()"),
                            Rs.verbatimExpr("resume"),
                            ...(prepared.pages.views ? [Rs.verbatimExpr("views")] : []),
                          ]
                        : prepared.pages.takesUrl
                          ? [Rs.verbatimExpr("href.clone()")]
                          : [],
                    ),
                  ).text,
                  prepared.pages.takesData ? runtime!.pageData : undefined,
                  prepared.pages.views === undefined
                    ? undefined
                    : isScalar(prepared.pages.views)
                      ? `${prepared.pages.views}_arg(&views, None)`
                      : `decode_${prepared.pages.views.name}(&views, None)`,
                ),
              ),
            ]
          : []),
        ...(usesStore ? [Rs.verbatimItem(runtime!.store!.impl)] : []),
        Rs.verbatimItem(authRuntime),
        ...(runtime?.modules ?? []).map((module) => Rs.verbatimItem(module)),
        Rs.verbatimItem(
          rpcRuntime(
            clear.length ? Rs.stmt(callLocal("clear_frames")) : undefined,
            prepared.asynchronous,
            prepared.layered,
            options.serialization === "ndjson",
            prepared.pages !== undefined,
          ),
        ),
      ],
      "\n",
    ).text;
    const ported = Object.freeze([
      PortedRuntimes.RpcHttp,
      ...(runtime?.ported ?? []),
      ...(core.explanation.selections.some((s) => s.selected.method === "html")
        ? [PortedRuntimes.SsrSerialize]
        : []),
      ...(prepared.pages ? [PortedRuntimes.SsrHost] : []),
    ]);
    const upstream = yield* verifyUpstream(ported);
    return Object.freeze({
      sourceArtifacts: SourceArtifacts.None,
      failureFrames: core.failureFrames,
      explanation: core.explanation,
      stages: Object.freeze(core.stages.concat("rpc-http")),
      files: Object.freeze({
        "Cargo.toml":
          core.files["Cargo.toml"].split("\n[dependencies]")[0] +
          '\n[dependencies]\naxum = { version = "=0.8.9", default-features = false, features = ["http1", "tokio", "json"] }\n' +
          // Every server runs the multi-thread accept loop with timers; a layered one also
          // listens for the shutdown signal.
          `tokio = { version = "=1.53.1", features = ${JSON.stringify(["macros", "rt", "rt-multi-thread", "net", "time", "sync", ...(prepared.layered ? ["signal"] : [])])} }\n` +
          'serde_json = { version = "=1.0.151", features = ["float_roundtrip", "preserve_order"] }\n' +
          // The accept loop (#16): hyper's own connection builder, with a timer.
          'hyper = { version = "=1.11.1", features = ["server", "http1"] }\nhyper-util = { version = "=0.1.21", features = ["tokio", "server-graceful"] }\ntower = { version = "=0.5.3", default-features = false, features = ["util"] }\n' +
          (prepared.asynchronous
            ? 'http-body = "=1.0.1"\nfutures-util = { version = "=0.3.34", default-features = false, features = ["std"] }\n'
            : "") +
          (prepared.auth ? 'subtle = { version = "=2.6.1", default-features = false }\n' : "") +
          (prepared.pages ? 'url = "=2.5.8"\n' : "") +
          (runtime?.dependencies ?? []).join("") +
          (ryuJs && !runtime?.crates.includes("ryu-js@1.0.3")
            ? 'ryu-js = { version = "=1.0.3", default-features = false }\n'
            : ""),
        "src/lib.rs": core.files["src/lib.rs"] + encoders.text,
        "src/main.rs": main,
      }),
      runtime: Object.freeze({
        id: "rust/axum-unary-json@1",
        crates: Object.freeze(
          [
            "axum@0.8.9",
            "hyper@1.11.1",
            "hyper-util@0.1.21",
            "tower@0.5.3",
            "tokio@1.53.1",
            "serde_json@1.0.151",
          ].concat(
            prepared.auth ? ["subtle@2.6.1"] : [],
            prepared.pages ? ["url@2.5.8"] : [],
            prepared.asynchronous ? ["http-body@1.0.1"] : [],
            runtime?.crates ?? [],
            ryuJs && !runtime?.crates.includes("ryu-js@1.0.3") ? ["ryu-js@1.0.3"] : [],
          ),
        ),
        handlerProfile: prepared.asynchronous ? "suspended-scalars" : "synchronous-scalars",
        ported,
        upstream,
        services: Object.freeze(prepared.services),
        auth: prepared.auth
          ? Object.freeze({
              middleware: prepared.auth.middleware.key,
              principalService: prepared.auth.principal.key,
              credentialsEnv: prepared.auth.credentialsEnv,
            })
          : undefined,
      }),
    });
  });

/** Generate a native unary JSON/HTTP server for the checked sync/async scalar profiles. */
/**
 * The R witness a contract schema maps onto, so handlers can read contract values without
 * restating them. `result` admits classes and refuses decode-only checks, as success and
 * error schemas do. Structurally equal R witnesses are the same interned witness.
 */
const contractWitness = <S extends Schema.Top>(
  schema: S,
  options?: { readonly position?: "payload" | "result" },
): IRType<WireValue<S>> =>
  witnessOf(
    codec(schema.ast, "witness", false, new Map(), (options?.position ?? "payload") === "payload"),
  ) as IRType<WireValue<S>>;

export const NativeRpc = Object.freeze({
  U64Json,
  StringJson,
  bind,
  bindPrincipal,
  bindServices,
  bearer: RpcBearer.make,
  compile,
  witness: contractWitness,
});

// JSON.stringify-compatible doubles: non-finite as strings, -0 as 0, safe integers unfractioned.
const jsNumber = `fn js_number(x: f64) -> Value {
    if x.is_nan() { return Value::String("NaN".to_string()); }
    if x.is_infinite() { return Value::String(if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string()); }
    if x == 0.0 { return Value::from(0u64); }
    if x.fract() == 0.0 && x.abs() < 9007199254740992.0 { return Value::from(x as i64); }
    Value::from(x)
}
`;
/** A host encoder for one `Schema.toCodecJson` witness (RM-006). */
interface JsonEncoder {
  readonly name: string;
  readonly type: IRType<unknown>;
  readonly codec: Codec;
}
/**
 * Generated serde_json decoders/encoders for contract composites, with official messages. Given
 * `encoders`, only the encode side is generated, as the library's `reffect_json` module.
 */
const compositeCodecs = (
  composites: readonly Composite[],
  encoders?: readonly JsonEncoder[],
  decoders: readonly JsonEncoder[] = [],
): string => {
  const rustType = (type: IRType<unknown>): string => {
    const item = arrayItem(type);
    if (item) return `Vec<${rustType(item)}>`;
    const value = recordValue(type);
    if (value) return `Vec<(String, ${rustType(value)})>`;
    if (IRType.same(type, UnknownType)) return "Value";
    const defined = undefinedOrItem(type);
    if (defined) return `Option<${rustType(defined)}>`;
    if (type.layout) return `reffect_generated::${type.native.type}`;
    if (IRType.same(type, NumberType)) return "f64";
    return IRType.same(type, U64Type)
      ? "u64"
      : IRType.same(type, BoolType)
        ? "bool"
        : IRType.same(type, StringType)
          ? "String"
          : "()";
  };
  const borrowedType = (type: IRType<unknown>): string => {
    const item = arrayItem(type);
    if (item) return `[${rustType(item)}]`;
    const value = recordValue(type);
    return value ? `[(String, ${rustType(value)})]` : rustType(type);
  };
  const decodeField = (codec: Codec, value: string, path: string): string =>
    isScalar(codec)
      ? `${codec === "never" ? "never" : codec}_in(${value}, ${path})`
      : `decode_${codec.name}(${value}, ${path})`;
  const encodeField = (codec: Codec, value: string): string =>
    isScalar(codec)
      ? codec === "u64"
        ? `Value::String(${value}.to_string())`
        : codec === "bool"
          ? `Value::Bool(${value})`
          : codec === "string"
            ? `Value::String(${value}.clone())`
            : "Value::Null"
      : `encode_${codec.name}(&${value})`;
  const structBody = (
    type: IRType<unknown>,
    tag: string | undefined,
    fields: Composite["fields"],
  ): { readonly decode: string; readonly encode: string } => {
    const layout = structLayout(type, tag)!;
    const caseType =
      tag === undefined ? type : unionCases(type)!.find((c) => structLayout(c)?.tag === tag)!;
    const names = rustFieldNames(layout);
    const kindTest: Record<JsonKind, string> = {
      boolean: "value.is_boolean()",
      number: "value.is_number()",
      string: "value.is_string()",
      array: "value.is_array()",
      object: "value.is_object()",
    };
    const decode = fields
      .map((field, i) => {
        const key = Rs.stringLiteral(field.name).text;
        const child = `    let child_${i} = Path { parent: path, name: ${key}, index: false };\n`;
        const item = `${decodeField(field.codec, "value", `Some(&child_${i})`)}?`;
        const optional = field.optional;
        if (optional === undefined)
          return (
            child +
            `    let f${i} = match object.get(${key}) { Some(value) => ${item}, None => return Err(at("Missing key", Some(&child_${i}))) };\n`
          );
        if (optional.kind === "optionalKey")
          return (
            child +
            `    let f${i} = match object.get(${key}) { Some(value) => Some(${item}), None => None };\n`
          );
        const accepted = optional.kinds.map((kind) => kindTest[kind]).join(" || ") || "false";
        return (
          child +
          `    let f${i} = match object.get(${key}) {\n        None => None,\n        Some(Value::Null) => Some(None),\n        Some(value) if !(${accepted}) => return Err(at(${Rs.stringLiteral(optional.mismatch).text}, Some(&child_${i}))),\n        Some(value) => Some(Some(${item})),\n    };\n`
        );
      })
      .join("");
    const build = `${rustType(caseType)} { ${fields.map((_, i) => `${names[i]}: f${i}, `).join("")}}`;
    const encode =
      (tag === undefined
        ? ""
        : `    map.insert("_tag".to_string(), Value::String(${Rs.stringLiteral(tag).text}.to_string()));\n`) +
      fields
        .map((field, i) => {
          const key = `${Rs.stringLiteral(field.name).text}.to_string()`;
          const optional = field.optional;
          if (optional === undefined)
            return `    map.insert(${key}, ${encodeField(field.codec, `value.${names[i]}`)});\n`;
          // Absent keys are omitted; a present `undefined` encodes as null (OPT-003).
          if (optional.kind === "optionalKey")
            return `    if let Some(item) = &value.${names[i]} { map.insert(${key}, ${encodeField(field.codec, "(*item)")}); }\n`;
          return `    match &value.${names[i]} { None => {}, Some(None) => { map.insert(${key}, Value::Null); } Some(Some(item)) => { map.insert(${key}, ${encodeField(field.codec, "(*item)")}); } }\n`;
        })
        .join("");
    return { decode: decode + `    Ok(${build})\n`, encode };
  };
  const items = composites.map((shape) => {
    const name = shape.name;
    const expected = Rs.stringLiteral(shape.expected).text;
    if (shape.number !== undefined) {
      const { finiteOnly, checks } = shape.number;
      const fallback = finiteOnly
        ? ""
        : `        Value::String(text) => match text.as_str() { "NaN" => f64::NAN, "Infinity" => f64::INFINITY, "-Infinity" => f64::NEG_INFINITY, _ => return Err(at(${Rs.stringLiteral('Expected "Infinity" | "-Infinity" | "NaN"').text}, path)) },\n`;
      const mismatch = Rs.stringLiteral(
        finiteOnly ? "Expected number" : 'Expected number | "Infinity" | "-Infinity" | "NaN"',
      ).text;
      return {
        decode:
          `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<f64, String> {\n    let x = match value {\n        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),\n${fallback}        _ => return Err(at(${mismatch}, path)),\n    };\n` +
          checks
            .map(
              (check) =>
                `    if !(${check.rust}) { return Err(at(${Rs.stringLiteral(check.expected).text}, path)); }\n`,
            )
            .join("") +
          `    Ok(x)\n}\n`,
        encode: `fn encode_${name}(value: &f64) -> Value { js_number(*value) }\n`,
      };
    }
    if (shape.literals) {
      const variants = rustLiteralVariants(shape.literals);
      const type = rustType(shape.type);
      return {
        decode: `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<${type}, String> {\n    match value.as_str() {\n${shape.literals
          .map(
            (literal, i) =>
              `        Some(${Rs.stringLiteral(literal).text}) => Ok(${type}::${variants[i]}),\n`,
          )
          .join("")}        _ => Err(at(${expected}, path)),\n    }\n}\n`,
        encode: `fn encode_${name}(value: &${type}) -> Value {\n    Value::String(match value {\n${shape.literals
          .map(
            (literal, i) =>
              `        ${type}::${variants[i]} => ${Rs.stringLiteral(literal).text},\n`,
          )
          .join("")}    }.to_string())\n}\n`,
      };
    }
    if (shape.json)
      return {
        decode: `fn decode_${name}(value: &Value, _path: Option<&Path>) -> Result<Value, String> { Ok(js_json(value)) }\n`,
        encode: `fn encode_${name}(value: &Value) -> Value { value.clone() }\n`,
      };
    if (shape.record !== undefined)
      return {
        decode:
          `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<${rustType(shape.type)}, String> {\n` +
          `    let Some(object) = value.as_object() else { return Err(at(${expected}, path)) };\n` +
          `    let mut out = Vec::with_capacity(object.len());\n` +
          `    for (key, item) in js_entries(object) {\n        let child = Path { parent: path, name: key, index: false };\n        out.push((key.clone(), ${decodeField(shape.record, "item", "Some(&child)")}?));\n    }\n    Ok(out)\n}\n`,
        encode: `fn encode_${name}(value: &[(String, ${rustType(recordValue(shape.type)!)})]) -> Value {\n    let mut map = serde_json::Map::new();\n    for (key, item) in value.iter() { map.insert(key.clone(), ${encodeField(shape.record, "(*item)")}); }\n    Value::Object(map)\n}\n`,
      };
    if (shape.item !== undefined)
      return {
        decode:
          `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<${rustType(shape.type)}, String> {\n` +
          `    let Some(items) = value.as_array() else { return Err(at(${expected}, path)) };\n` +
          `    let mut out = Vec::with_capacity(items.len());\n` +
          `    for (i, item) in items.iter().enumerate() {\n        let index = i.to_string();\n        let child = Path { parent: path, name: &index, index: true };\n        out.push(${decodeField(shape.item, "item", "Some(&child)")}?);\n    }\n` +
          // Elements decode first; length checks then run in declaration order, first failure wins.
          (shape.lengths?.length
            ? `    let n = out.len();\n` +
              shape.lengths
                .map(
                  (check) =>
                    `    if !(${check.rust}) { return Err(at(${Rs.stringLiteral(check.expected).text}, path)); }\n`,
                )
                .join("")
            : "") +
          `    Ok(out)\n}\n`,
        encode: `fn encode_${name}(value: &[${rustType(arrayItem(shape.type)!)}]) -> Value {\n    Value::Array(value.iter().map(|item| ${encodeField(shape.item, "(*item)")}).collect())\n}\n`,
      };
    if (shape.cases.length === 0) {
      const body = structBody(shape.type, undefined, shape.fields);
      // An empty Struct also accepts arrays, as the pinned decoder does.
      const object =
        shape.fields.length === 0
          ? `if !(value.is_object() || value.is_array()) { return Err(at(${expected}, path)) }\n    let empty = serde_json::Map::new();\n    let object = value.as_object().unwrap_or(&empty);\n`
          : `let Some(object) = value.as_object() else { return Err(at(${expected}, path)) };\n`;
      return {
        decode: `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<${rustType(shape.type)}, String> {\n    ${object}${body.decode}}\n`,
        encode: `fn encode_${name}(value: &${rustType(shape.type)}) -> Value {\n    let mut map = serde_json::Map::new();\n${body.encode}    Value::Object(map)\n}\n`,
      };
    }
    const variants = shape.cases.map((c, i) => {
      const body = structBody(shape.type, c.tag, c.fields);
      const variant = `${rustType(shape.type)}::${rustVariantName(c.tag, i)}`;
      return {
        decode: `        Some(${Rs.stringLiteral(c.tag).text}) => {\n${body.decode.replace(/^ {4}Ok\((.*)\)\n$/m, `    Ok(${variant}($1))\n`)}        }\n`,
        encode: `        ${variant}(value) => {\n            let mut map = serde_json::Map::new();\n${body.encode}            Value::Object(map)\n        }\n`,
      };
    });
    return {
      decode: `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<${rustType(shape.type)}, String> {\n    let empty = serde_json::Map::new();\n    let object = value.as_object().unwrap_or(&empty);\n    match value.as_object().and_then(|o| o.get("_tag")).and_then(Value::as_str) {\n${variants.map((v) => v.decode).join("")}        _ => Err(at(${expected}, path)),\n    }\n}\n`,
      encode: `fn encode_${name}(value: &${rustType(shape.type)}) -> Value {\n    match value {\n${variants.map((v) => v.encode).join("")}    }\n}\n`,
    };
  });
  // Paths, scalar readers and JS-shaped helpers the decoders call.
  const decodePrelude = `struct Path<'a> { parent: Option<&'a Path<'a>>, name: &'a str, index: bool }
fn at(message: &str, path: Option<&Path>) -> String {
    let mut names = Vec::new();
    let mut current = path;
    while let Some(segment) = current { names.push(segment); current = segment.parent; }
    if names.is_empty() { return message.to_string(); }
    names.reverse();
    // Array indexes print unquoted, keys as JSON strings, as the pinned formatter does.
    let segments: String = names.iter().map(|segment| if segment.index { format!("[{}]", segment.name) } else { format!("[{}]", serde_json::to_string(segment.name).unwrap()) }).collect();
    format!("{}\\n  at {}", message, segments)
}
/// JSON.stringify-compatible doubles: non-finite as strings, -0 as 0, safe integers unfractioned.
${jsNumber}
fn u64_in(value: &Value, path: Option<&Path>) -> Result<u64, String> { u64_arg(value, None).map_err(|message| at(&message, path)) }
fn bool_in(value: &Value, path: Option<&Path>) -> Result<bool, String> { bool_arg(value, None).map_err(|message| at(&message, path)) }
fn string_in(value: &Value, path: Option<&Path>) -> Result<String, String> { string_arg(value, None).map_err(|message| at(&message, path)) }
fn unit_in(value: &Value, path: Option<&Path>) -> Result<(), String> { unit_arg(value, None).map_err(|message| at(&message, path)) }
fn never_in(_value: &Value, path: Option<&Path>) -> Result<std::convert::Infallible, String> { Err(at("Expected never", path)) }
${
  composites.some((shape) => shape.json)
    ? `/// The value as JSON.parse sees it (UNK-002): doubles in JS form, objects in JS key order.
fn js_json(value: &Value) -> Value {
    match value {
        Value::Number(number) => js_number(number.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => Value::Array(items.iter().map(js_json).collect()),
        Value::Object(object) => {
            let mut map = serde_json::Map::new();
            for (key, item) in js_entries(object) { map.insert(key.clone(), js_json(item)); }
            Value::Object(map)
        }
        other => other.clone(),
    }
}
`
    : ""
}${
    composites.some((shape) => shape.record !== undefined || shape.json)
      ? `/// JS own-property order (RECJS-003): array-index keys ascending, then insertion order.
fn js_entries(object: &serde_json::Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed = Vec::new();
    let mut named = Vec::new();
    for (key, value) in object.iter() {
        match array_index(key) { Some(index) => indexed.push((index, key, value)), None => named.push((key, value)) }
    }
    indexed.sort_by_key(|entry| entry.0);
    indexed.into_iter().map(|(_, key, value)| (key, value)).chain(named).collect()
}
fn array_index(key: &str) -> Option<u32> {
    if key == "0" { return Some(0); }
    if key.is_empty() || key.starts_with('0') || !key.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}
`
      : ""
  }
`;
  const encoderFns = (list: readonly JsonEncoder[]): string =>
    list
      .map((encoder) =>
        // Read-only inputs arrive borrowed (`&str`, slices); owned values coerce to them.
        IRType.same(encoder.type, StringType)
          ? `pub fn ${encoder.name}(value: &str) -> Value { Value::String(value.to_string()) }
`
          : `pub fn ${encoder.name}(value: &${borrowedType(encoder.type)}) -> Value { ${encodeField(encoder.codec, "(*value)")} }
`,
      )
      .join("");
  if (encoders && decoders.length > 0)
    // The library decodes stored JSON (RS-007) with the server's verified decoders and helpers.
    return `use crate as reffect_generated;
use serde_json::Value;
${decodeArgs()}${decodePrelude}${items.map((item) => item.decode + item.encode).join("")}${encoderFns(encoders)}${decoders
      .map(
        (decoder) =>
          `pub fn ${decoder.name}(value: &Value) -> Option<${rustType(decoder.type)}> { ${decodeField(decoder.codec, "value", "None")}.ok() }
`,
      )
      .join("")}`;
  if (encoders)
    return `use crate as reffect_generated;
use serde_json::Value;
${
  composites.some((shape) => shape.number !== undefined) ? jsNumber : ""
}${items.map((item) => item.encode).join("")}${encoderFns(encoders)}`;
  return `${decodePrelude}${items.map((item) => item.decode + item.encode).join("")}`;
};
