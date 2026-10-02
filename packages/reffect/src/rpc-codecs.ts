import { Schema, type SchemaAST } from "effect";
import { isWellFormed, wellFormedMessage } from "./unicode.ts";

const U64Json = Schema.BigIntFromString.check(
  Schema.isGreaterThanOrEqualToBigInt(0n),
  Schema.isLessThanOrEqualToBigInt(18446744073709551615n),
);
for (const check of U64Json.ast.checks ?? []) Object.freeze(check);
if (U64Json.ast.checks) Object.freeze(U64Json.ast.checks);
Object.freeze(U64Json.ast);
// Effect memoizes these accessors onto the schema on first use. Resolve them before freezing.
void U64Json.make;
void U64Json.makeEffect;
void U64Json.makeOption;
Object.freeze(U64Json);

interface U64Range {
  readonly minimum: bigint;
  readonly maximum: bigint;
}
const ranges = new WeakMap<SchemaAST.AST, U64Range>();
/** Compiler boundary lookup; registration is private and native values stay plain u64. */
export const u64RangeOf = (ast: SchemaAST.AST): U64Range | undefined => ranges.get(ast);

/** Inclusive payload constraint using the canonical decimal-string u64 wire codec. */
const u64Range = (bounds: U64Range) => {
  const { minimum, maximum } = bounds;
  if (typeof minimum !== "bigint" || typeof maximum !== "bigint")
    throw new TypeError("u64Range bounds must be bigint values");
  if (minimum < 0n || maximum > 18446744073709551615n || minimum > maximum)
    throw new RangeError("u64Range requires 0 <= minimum <= maximum <= u64::MAX");
  const schema = U64Json.check(
    Schema.isGreaterThanOrEqualToBigInt(minimum),
    Schema.isLessThanOrEqualToBigInt(maximum),
  );
  for (const check of schema.ast.checks ?? []) Object.freeze(check);
  if (schema.ast.checks) Object.freeze(schema.ast.checks);
  Object.freeze(schema.ast);
  void schema.make;
  void schema.makeEffect;
  void schema.makeOption;
  Object.freeze(schema);
  ranges.set(schema.ast, Object.freeze({ minimum, maximum }));
  return schema;
};

/**
 * Well-formed string codec. Plain `Schema.String` accepts lone surrogates, which a native
 * UTF-8 `String` cannot hold; this check makes the stock server refuse them as well.
 */
const StringJson = Schema.String.check(
  Schema.makeFilter((value: string) => isWellFormed(value) || wellFormedMessage),
);
for (const check of StringJson.ast.checks ?? []) Object.freeze(check);
if (StringJson.ast.checks) Object.freeze(StringJson.ast.checks);
Object.freeze(StringJson.ast);
void StringJson.make;
void StringJson.makeEffect;
void StringJson.makeOption;
Object.freeze(StringJson);

/** Ordinary Effect schemas shared by clients and the supported native boundary profile. */
export const RpcCodecs = Object.freeze({ U64Json, u64Range, StringJson });
