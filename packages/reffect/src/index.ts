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
  StringType,
  NumberType,
  AddNumber,
  EqNumber,
  LtNumber,
  EqString,
  IncludesString,
  UnknownType,
  reachesUnknown,
  ReplaceAllString,
  isWellFormed,
  AddU64,
  SubU64,
  MulU64,
  apply,
} from "./kernel.ts";
export { R } from "./authoring.ts";
export { OptionIR } from "./option.ts";
export type { OptionValue, OptionType } from "./option.ts";
export { ResultIR, effectResult } from "./result.ts";
export type { ResultValue } from "./result.ts";
export { DurationIR } from "./duration.ts";
export type { Duration, DurationInput } from "./duration.ts";
export { EffectCombinators } from "./effect-combinators.ts";
export { RefIR } from "./ref.ts";
export {
  ArrayCombinators,
  BooleanCombinators,
  PredicateCombinators,
  RecordCombinators,
} from "./collection-combinators.ts";
export type { SymbolicPredicate } from "./collection-combinators.ts";
export {
  Struct,
  TaggedUnion,
  StructType,
  TaggedUnionType,
  ArrayType,
  ArrayIR,
  UndefinedOr,
  UndefinedOrType,
  RecordIR,
  RecordType,
  Literals,
  LiteralsType,
  optional,
  optionalKey,
} from "./records.ts";
export type {
  Fields,
  StructValue,
  CaseValue,
  UnionValue,
  CaseType,
  OptionalField,
} from "./records.ts";
export { flow } from "./flow.ts";
export type { FlowResult } from "./flow.ts";
export { Schedule } from "./schedule.ts";
export type { SchedulePlan } from "./schedule.ts";
export { ScopedSequence } from "./scoped-sequence.ts";
export { analyzeScopes, maxScopeFinalizers } from "./scope-analysis.ts";
export type { ScopeAnalysis } from "./scope-analysis.ts";
export { Reference } from "./reference.ts";
export {
  Computation,
  EffectFn,
  SyncEffects,
  AsyncEffects,
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
  Value,
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
export type { RpcBinding, RpcArtifact, WireValue } from "./native-rpc.ts";
export { NativeRemote } from "./native-remote.ts";
export type {
  MemoryRows,
  MutationLike,
  NativeRemoteMutation,
  NativeRemoteOptions,
  RemoteOutcome,
} from "./native-remote.ts";
export { RemoteStoreHost } from "./remote-store-host.ts";
export type { RemoteStoreApi } from "./remote-store-host.ts";
export { RpcCodecs } from "./rpc-codecs.ts";

export { RpcBearer } from "./rpc-auth.ts";

export { FailureFrames, FailureFramePolicy } from "./frame-policy.ts";

export { Service, StaticContext, ContextIR } from "./context.ts";
export type { ServiceValue } from "./context.ts";
export { StaticLayer, LayerIR } from "./layer.ts";
export { ScopedFile, FileIR } from "./file-resource.ts";
export { ReferenceFiles } from "./reference-files.ts";
export { FileLease } from "./file-model.ts";
