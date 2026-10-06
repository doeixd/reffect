/**
 * `Schema.encodeSync(Schema.toCodecJson(S))` for R witnesses (RM-006): typed values become the
 * `Unknown` JSON the wire carries; `Schema.decodeUnknownOption(Schema.toCodecJson(S))` (RS-007)
 * reads such JSON back as an Option. The reference runs the official codec. Natively, a NativeRpc
 * host supplies each encoder from its codecs verified against that same codec, so a target
 * without the `JsonEncoders` capability refuses the operation instead of guessing an encoding.
 */
import { namingDigest } from "./naming.ts";
import { Cause, Exit, Option, Schema } from "effect";
import { OptionIR } from "./option.ts";
import type { OptionValue } from "./option.ts";
import { ArrayType, UndefinedOr } from "./records.ts";
import {
  Capabilities,
  Expr,
  IRType,
  NeverType,
  Operation,
  SemanticRef,
  StringType,
  UnknownType,
  fail,
  type AnyOperation,
} from "./kernel.ts";

type EncodeJson = Operation<readonly [IRType<unknown>], unknown>;
// Keyed by the witness itself, not its id string (#39): an id reused by an unrelated program no
// longer fails at authoring, and a forgotten witness takes its operation with it. Within one
// program, two operations with one id are still refused by derive (IDENTITY_COLLISION).
const byWitness = new WeakMap<IRType<unknown>, EncodeJson>();
const witnesses = new WeakMap<object, IRType<unknown>>();
// Operations a host implements as `crate::reffect_json::<name>(&args...)`.
const hostFunctions = new WeakMap<object, string>();

const encodeOperation = (witness: IRType<unknown>): EncodeJson => {
  const known = byWitness.get(witness);
  if (known) return known;
  if (IRType.same(witness, NeverType))
    throw fail("TYPE_MISMATCH", "authoring", "Schema.toCodecJson", "Never has no values");
  const encode = Schema.encodeSync(Schema.toCodecJson(witness.schema));
  const operation: EncodeJson = Operation.make(
    SemanticRef.operation(`reffect/schema.encode-json@1/${witness.id}`),
    [witness] as const,
    UnknownType,
    (value) => encode(value),
  ).pipe(Operation.withCapabilities([Capabilities.Json, Capabilities.JsonEncoders]));
  byWitness.set(witness, operation);
  witnesses.set(operation, witness);
  hostFunctions.set(operation, jsonEncoderName(witness));
  return operation;
};

type DecodeJson = Operation<readonly [IRType<unknown>], unknown>;
const decodersByWitness = new WeakMap<IRType<unknown>, DecodeJson>();
const decodedWitnesses = new WeakMap<object, IRType<unknown>>();
/**
 * The decode half: `Unknown` to `UndefinedOr<W>`, undefined when the JSON is not a `W`. Natively
 * that is Rust `Option<W>`, from the same verified decoder the server uses for requests.
 */
const decodeOperation = (witness: IRType<unknown>): DecodeJson => {
  const known = decodersByWitness.get(witness);
  if (known) return known;
  if (IRType.same(witness, NeverType))
    throw fail("TYPE_MISMATCH", "authoring", "Schema.toCodecJson", "Never has no values");
  const decode = Schema.decodeUnknownOption(Schema.toCodecJson(witness.schema));
  const operation: DecodeJson = Operation.make(
    SemanticRef.operation(`reffect/schema.decode-json-option@1/${witness.id}`),
    [UnknownType] as const,
    UndefinedOr(witness),
    (value) => Option.getOrUndefined(decode(value)),
  ).pipe(Operation.withCapabilities([Capabilities.Json, Capabilities.JsonEncoders]));
  decodersByWitness.set(witness, operation);
  decodedWitnesses.set(operation, witness);
  hostFunctions.set(operation, jsonDecoderName(witness));
  return operation;
};

type TypeSideOperation = Operation<readonly [IRType<unknown>], unknown>;
/** What a type-side operation reads: one `Unknown` value, or a statement's rows as an Array. */
export type TypeSideInput = "value" | "rows";
interface TypeSide {
  readonly witness: IRType<unknown>;
  readonly issue: boolean;
  readonly input: TypeSideInput;
}
const typeSideOperations = new WeakMap<IRType<unknown>, Map<string, TypeSideOperation>>();
const typeSides = new WeakMap<object, TypeSide>();
const failureMessage = (exit: Exit.Exit<unknown, Schema.SchemaError>): string =>
  Exit.isSuccess(exit)
    ? ""
    : Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => "",
        onSome: (error) => error.message,
      });
const typeSideOperation = (side: TypeSide): TypeSideOperation => {
  const key = `${side.issue}/${side.input}`;
  const byKey = typeSideOperations.get(side.witness) ?? new Map<string, TypeSideOperation>();
  typeSideOperations.set(side.witness, byKey);
  const known = byKey.get(key);
  if (known) return known;
  const schema = side.witness.schema as Schema.Codec<unknown>;
  const option = Schema.decodeUnknownOption(schema);
  const exit = Schema.decodeUnknownExit(schema);
  const kind = side.issue ? "issue" : "option";
  const operation: TypeSideOperation = Operation.make(
    SemanticRef.operation(`reffect/schema.decode-type-${kind}@1/${side.input}/${side.witness.id}`),
    [side.input === "rows" ? ArrayType.of(UnknownType) : UnknownType] as const,
    side.issue ? StringType : UndefinedOr(side.witness),
    (value) => (side.issue ? failureMessage(exit(value)) : Option.getOrUndefined(option(value))),
  ).pipe(Operation.withCapabilities([Capabilities.Json, Capabilities.JsonEncoders]));
  byKey.set(key, operation);
  typeSides.set(operation, side);
  hostFunctions.set(
    operation,
    `json_type_${kind}_${side.input}_${digest(side.witness.id)}_${side.witness.id.length}`,
  );
  return operation;
};
/**
 * `Schema.decodeUnknownOption(W)` on the type side, as `SqlSchema` decodes rows (SQL-006): a
 * Number field accepts numbers only, unlike the JSON codec's non-finite strings.
 */
export const typeDecodeOperation = (
  witness: IRType<unknown>,
  input: TypeSideInput = "value",
): TypeSideOperation => typeSideOperation({ witness, issue: false, input });
/** The `SchemaError` message the type-side decode gives, or "" when the value decodes. */
export const typeIssueOperation = (
  witness: IRType<unknown>,
  input: TypeSideInput = "value",
): TypeSideOperation => typeSideOperation({ witness, issue: true, input });
/** What a type-side decode or issue operation reads and answers. */
export const typeSideOf = (operation: AnyOperation): TypeSide | undefined =>
  typeSides.get(operation);

/** The host function implementing an operation, for operations a NativeRpc host supplies. */
export const hostFunctionOf = (operation: AnyOperation): string | undefined =>
  hostFunctions.get(operation);

/**
 * `foldkit-remote`'s `stableStringify` (0.10.0): object keys sorted by UTF-16 code units,
 * `undefined` values dropped, primitives as `JSON.stringify` writes them. Connection identities
 * are built from it (RM-005).
 */
export const stableStringify = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};
export const StableStringify = Operation.make(
  SemanticRef.operation("reffect/json.stable-stringify@1"),
  [UnknownType] as const,
  StringType,
  stableStringify,
).pipe(Operation.withCapabilities([Capabilities.Json, Capabilities.JsonEncoders]));
hostFunctions.set(StableStringify, "stable_stringify");

/** The witness an encode operation encodes, or undefined for any other operation. */
export const jsonEncodedWitness = (operation: AnyOperation): IRType<unknown> | undefined =>
  witnesses.get(operation);
/** The witness a decode operation decodes, or undefined for any other operation. */
export const jsonDecodedWitness = (operation: AnyOperation): IRType<unknown> | undefined =>
  decodedWitnesses.get(operation);

// Stable, collision-resistant naming digest (#30).
const digest = namingDigest;
/** The Rust function a host defines in `crate::reffect_json` for this witness. */
export const jsonEncoderName = (witness: IRType<unknown>): string =>
  `json_${digest(witness.id)}_${witness.id.length}`;
/** The Rust decoder a host defines in `crate::reffect_json` for this witness. */
export const jsonDecoderName = (witness: IRType<unknown>): string =>
  `json_decode_${digest(witness.id)}_${witness.id.length}`;

/** A witness's canonical JSON codec, `Schema.toCodecJson`. */
export interface JsonCodec<A> {
  readonly witness: IRType<A>;
}
export const SchemaIR = Object.freeze({
  toCodecJson: <A>(witness: IRType<A>): JsonCodec<A> => Object.freeze({ witness }),
  /** `Schema.encodeSync(codec)(value)`; admitted witnesses always encode. */
  encodeSync:
    <A>(codec: JsonCodec<A>) =>
    (value: Expr<A>): Expr<unknown> => {
      if (!IRType.same(value.type, codec.witness))
        throw fail(
          "TYPE_MISMATCH",
          "authoring",
          "Schema.encodeSync",
          "The value's witness differs from the codec's",
        );
      return Expr.apply(encodeOperation(codec.witness), value);
    },
  /**
   * `Schema.decodeUnknownOption(codec)(value)`: `Some` of the decoded value, or `None` when the
   * JSON is not one; the parse issue itself is not represented yet.
   */
  decodeUnknownOption:
    <A>(codec: JsonCodec<A>) =>
    (value: Expr<unknown>): Expr<OptionValue<A>> => {
      if (!IRType.same(value.type, UnknownType))
        throw fail(
          "TYPE_MISMATCH",
          "authoring",
          "Schema.decodeUnknownOption",
          "Decodes an Unknown value",
        );
      return OptionIR.fromUndefinedOr(
        Expr.apply(decodeOperation(codec.witness), value) as Expr<A | undefined>,
      );
    },
});
