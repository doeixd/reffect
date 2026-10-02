import { Computation, EffectIR, joinType } from "./effect-ir.ts";
import { BoolType, IRType, U64Type, fail } from "./kernel.ts";
import { FileHandleType, validFilePath } from "./file-model.ts";

/** A build-time borrowed resource reference; it cannot be returned as a runtime value. */
export class ScopedFile {
  readonly type = FileHandleType;
  readonly size: Computation<bigint, boolean>;
  constructor(readonly binder: symbol) {
    this.size = Computation.make(U64Type, BoolType, { _tag: "FileSize", binder });
    Object.freeze(this);
  }
}

const scoped = <A, E>(
  path: string,
  use: (file: ScopedFile) => Computation<A, E>,
  afterClose: Computation<void, never> = EffectIR.void,
): Computation<A, E | boolean> => {
  if (!validFilePath(path))
    throw fail(
      "INVALID_FILE_PATH",
      "authoring",
      "file",
      "File paths require Unicode scalar content without NUL, bounded to 1–4096 UTF-16 code units",
    );
  const binder = Symbol("reffect/scoped-file");
  const body = use(new ScopedFile(binder));
  return Computation.make(body.output, joinType(BoolType, body.error) as IRType<E | boolean>, {
    _tag: "FileScope",
    path,
    binder,
    body,
    afterClose,
  });
};

/** Acquire a read-only file in the surrounding scope; its borrowed use cannot escape. */
const acquireReadOnly = <A, E>(
  path: string,
  use: (file: ScopedFile) => Computation<A, E>,
  afterClose: Computation<void, never> = EffectIR.void,
): Computation<A, E | boolean> => {
  if (!validFilePath(path))
    throw fail(
      "INVALID_FILE_PATH",
      "authoring",
      "file",
      "File paths require Unicode scalar content without NUL, bounded to 1–4096 UTF-16 code units",
    );
  const binder = Symbol("reffect/registered-file");
  const body = use(new ScopedFile(binder));
  return Computation.make(body.output, joinType(BoolType, body.error) as IRType<E | boolean>, {
    _tag: "RegisteredFile",
    path,
    binder,
    body,
    afterClose,
  });
};

export const FileIR = Object.freeze({ scoped, acquireReadOnly });
