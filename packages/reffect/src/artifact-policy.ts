import { Pipeable } from "effect";
import { SemanticRef, fail } from "./kernel.ts";

/** Artifact collection is independent of authoring capture and native instrumentation. */
export class SourceArtifactPolicy<Tag extends "Full" | "None"> extends Pipeable.Class {
  private constructor(
    readonly _tag: Tag,
    readonly ref: SemanticRef<"policy">,
  ) {
    super();
    Object.freeze(this);
  }
  static readonly Full = new SourceArtifactPolicy(
    "Full",
    SemanticRef.policy("reffect/source-artifacts/full@1"),
  );
  static readonly None = new SourceArtifactPolicy(
    "None",
    SemanticRef.policy("reffect/source-artifacts/none@1"),
  );
}
Object.freeze(SourceArtifactPolicy);
export const SourceArtifacts = Object.freeze({
  Full: SourceArtifactPolicy.Full,
  None: SourceArtifactPolicy.None,
  isNone: (policy: ArtifactPolicy): policy is NoneSourceArtifacts =>
    policy === SourceArtifactPolicy.None,
});
export type FullSourceArtifacts = typeof SourceArtifactPolicy.Full;
export type NoneSourceArtifacts = typeof SourceArtifactPolicy.None;
export type ArtifactPolicy = FullSourceArtifacts | NoneSourceArtifacts;

export const checkArtifactPolicy = (policy: ArtifactPolicy): void => {
  if (policy !== SourceArtifacts.Full && policy !== SourceArtifacts.None)
    throw fail(
      "UNSUPPORTED_SOURCE_POLICY",
      "check",
      "sourceArtifacts",
      "Use a registered source artifact policy",
    );
};
