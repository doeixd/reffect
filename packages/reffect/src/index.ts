export {
  Operation,
  Law,
  Evidence,
  EvidencePolicy,
  IRType,
  Expr,
  Fn,
  Program,
  SemanticRef,
  Capabilities,
  Targets,
  Native,
  Traits,
  CompileError,
  Diagnostic,
  U64Type,
  BoolType,
  UnitType,
  NeverType,
  AddU64,
  SubU64,
  MulU64,
  apply,
} from "./kernel.ts";
export { R } from "./authoring.ts";
export { Reference } from "./reference.ts";
export {
  Computation,
  EffectFn,
  SyncEffects,
  maxLogicalFrames,
  LogIR,
  logLevels,
} from "./effect-ir.ts";
export type { LogicalFrame, FramedExit, LogLevel, LogAttribute } from "./effect-ir.ts";
export type {
  OperationRef,
  Capability,
  EffectRef,
  Requirement,
  NativeRepresentation,
  Trait,
  Assurance,
  Inputs,
  Symbols,
  AnyOperation,
} from "./kernel.ts";
export { Compile, Compiler, CompileSpec, Rust, Target, Plan, RustExpr } from "./compiler.ts";
export type {
  Implementation,
  Analysis,
  Ownership,
  RustBinding,
  RustModule,
  Artifact,
  MappedArtifact,
  UnmappedArtifact,
  ArtifactFor,
} from "./compiler.ts";
export { SourceArtifacts, SourceArtifactPolicy } from "./artifact-policy.ts";
export type {
  ArtifactPolicy,
  FullSourceArtifacts,
  NoneSourceArtifacts,
} from "./artifact-policy.ts";
export type { UnmappedRustModule, LoweredModule } from "./lower.ts";
export { Cargo, CargoApi, CargoError } from "./cargo.ts";
export type { ProcessResult } from "./cargo.ts";
export type { GeneratedFiles } from "./cargo.ts";
export { Foldkit } from "./foldkit.ts";
export type { FoldkitArtifact, QueryAnalysis } from "./foldkit.ts";

export { NativeRunner } from "./native-runner.ts";
export type { NativeFrame, FramedNativeExit } from "./native-runner.ts";

export { Source, SourceFile, SourceSite, SourceLocation } from "./source.ts";
export type { SourceMetadata } from "./source.ts";

export {
  SourceMaps,
  SourceMap,
  SourceManifest,
  SourceMapError,
  GeneratedRange,
} from "./source-artifact.ts";
export type { SourceResolution } from "./source-artifact.ts";

export { NativeDiagnostic } from "./cargo-diagnostics.ts";

export type { OriginRecord, OccurrenceRecord, ProvenanceSnapshot } from "./provenance.ts";

export { NativeRpc } from "./native-rpc.ts";
export type { RpcBinding, RpcArtifact } from "./native-rpc.ts";
export { RpcCodecs } from "./rpc-codecs.ts";

export { RpcBearer } from "./rpc-auth.ts";
