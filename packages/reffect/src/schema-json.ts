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
  UnknownType,
  fail,
  type AnyOperation,
} from "./kernel.ts";

type EncodeJson = Operation<readonly [IRType<unknown>], unknown>;
const byWitness = new Map<string, EncodeJson>();
const witnesses = new WeakMap<object, IRType<unknown>>();

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
  return operation;
};

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
