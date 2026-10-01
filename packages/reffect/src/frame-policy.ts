import { Pipeable } from "effect";
import { SemanticRef, fail } from "./kernel.ts";

declare const framePolicyBrand: unique symbol;

/** Logical failure capture is independent of source artifacts and authored logging. */
export class FailureFramePolicy extends Pipeable.Class {
  declare readonly [framePolicyBrand]: true;
  private constructor(
    readonly _tag: "Bounded" | "None",
    readonly ref: SemanticRef<"policy">,
  ) {
    super();
    Object.freeze(this);
  }
  static readonly Bounded = new FailureFramePolicy(
    "Bounded",
    SemanticRef.policy("reffect/failure-frames/bounded@1"),
  );
  static readonly None = new FailureFramePolicy(
    "None",
    SemanticRef.policy("reffect/failure-frames/none@1"),
  );
}
Object.freeze(FailureFramePolicy);
export const FailureFrames = Object.freeze({
  Bounded: FailureFramePolicy.Bounded,
  None: FailureFramePolicy.None,
  isNone: (policy: FailureFramePolicy): boolean => policy === FailureFramePolicy.None,
});
export const checkFailureFramePolicy = (policy: FailureFramePolicy): void => {
  if (policy !== FailureFrames.Bounded && policy !== FailureFrames.None)
    throw fail(
      "UNSUPPORTED_FRAME_POLICY",
      "check",
      "failureFrames",
      "Use a registered failure frame policy",
    );
};
