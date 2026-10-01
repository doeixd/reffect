import { Schema } from "effect";

const U64Json = Schema.BigIntFromString.check(
  Schema.isGreaterThanOrEqualToBigInt(0n),
  Schema.isLessThanOrEqualToBigInt(18446744073709551615n),
);
for (const check of U64Json.ast.checks ?? []) Object.freeze(check);
if (U64Json.ast.checks) Object.freeze(U64Json.ast.checks);
Object.freeze(U64Json.ast);
Object.freeze(U64Json);

/** Ordinary Effect schemas shared by clients and the supported native boundary profile. */
export const RpcCodecs = Object.freeze({ U64Json });
