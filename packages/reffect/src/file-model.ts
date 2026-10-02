import { Effect, Schema } from "effect";
import { IRType, SemanticRef, Targets } from "./kernel.ts";

export const FileRequirement = SemanticRef.requirement("reffect/service/readonly-files@1");

/** Reference-only lease. Native code owns a plain File and borrows it in helpers. */
export class FileLease {
  constructor(
    readonly size: Effect.Effect<bigint, boolean>,
    readonly close: Effect.Effect<void>,
  ) {}
}

export const FileHandleType = IRType.make(
  SemanticRef.type("reffect/scoped-readonly-file@1"),
  Schema.declare((value): value is FileLease => value instanceof FileLease),
  Object.freeze({ target: Targets.RustStd, type: "std::fs::File" }),
);

export const validFilePath = (path: string): boolean =>
  typeof path === "string" &&
  path.length > 0 &&
  path.length <= 4096 &&
  !path.includes("\0") &&
  Array.from(path).every((character) => {
    const code = character.codePointAt(0)!;
    return code < 0xd800 || code > 0xdfff;
  });
