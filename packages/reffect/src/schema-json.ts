/**
 * `Schema.encodeSync(Schema.toCodecJson(S))` for R witnesses (RM-006): typed values become the
 * `Unknown` JSON the wire carries. The reference runs the official codec. Natively, a NativeRpc
 * host supplies each encoder from its codecs verified against that same codec, so a target
 * without the `JsonEncoders` capability refuses the operation instead of guessing an encoding.
 */
import { Schema } from "effect";
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
const byWitness = new Map<string, EncodeJson>();
const witnesses = new WeakMap<object, IRType<unknown>>();
// Operations a host implements as `crate::reffect_json::<name>(&args...)`.
const hostFunctions = new WeakMap<object, string>();

const encodeOperation = (witness: IRType<unknown>): EncodeJson => {
  const known = byWitness.get(witness.id);
  if (known) {
    if (!IRType.same(known.input[0], witness))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        "Schema.toCodecJson",
        `Witness ID ${witness.id} is reused with a different schema`,
      );
    return known;
  }
  if (IRType.same(witness, NeverType))
    throw fail("TYPE_MISMATCH", "authoring", "Schema.toCodecJson", "Never has no values");
  const encode = Schema.encodeSync(Schema.toCodecJson(witness.schema));
  const operation: EncodeJson = Operation.make(
    SemanticRef.operation(`reffect/schema.encode-json@1/${witness.id}`),
    [witness] as const,
    UnknownType,
    (value) => encode(value),
  ).pipe(Operation.withCapabilities([Capabilities.Json, Capabilities.JsonEncoders]));
  byWitness.set(witness.id, operation);
  witnesses.set(operation, witness);
  hostFunctions.set(operation, jsonEncoderName(witness));
  return operation;
};

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

// FNV-1a: encoder names only need to be stable and distinct per witness ID.
const digest = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};
/** The Rust function a host defines in `crate::reffect_json` for this witness. */
export const jsonEncoderName = (witness: IRType<unknown>): string =>
  `json_${digest(witness.id)}_${witness.id.length}`;

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
});
