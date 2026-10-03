import type { ProvenanceSnapshot } from "./provenance.ts";
import { Provenance } from "./provenance.ts";
import { SourceWriter, joinFragments, mapFragment, textFragment } from "./source-writer.ts";
import type { MappedFragment } from "./source-writer.ts";
import type { GeneratedRange } from "./source-artifact.ts";
import { Match, Predicate } from "effect";
import {
  BoolType,
  IRType,
  NeverType,
  NumberType,
  UnknownType,
  reachesUnknown,
  StringType,
  Traits,
  U64Type,
  UnitType,
  fail,
  arrayItem,
  structLayout,
  unionCases,
  undefinedOrItem,
  literalsOf,
} from "./kernel.ts";
import { refContent, refType } from "./ref-model.ts";
import { normalizeRuntimeServicesSelection } from "./runtime-service-model.ts";
import type {
  RuntimeServicesSelection,
  ResolvedRuntimeServicesSelection,
} from "./runtime-service-model.ts";
import { runtimeServicesPrelude } from "./runtime-services.ts";
import type { RuntimeServiceUsage } from "./runtime-services.ts";
import { ArrayType, rustFieldNames, rustLiteralVariants, rustVariantName } from "./records.ts";
import { streamExpressions, streamFinalizers } from "./stream-ir.ts";
import type { StreamIR } from "./stream-ir.ts";
import { Expr } from "./kernel.ts";
import type { OperationRef, Program, RecordQuery } from "./kernel.ts";
import { hostFunctionOf } from "./schema-json.ts";
import type { SchedulePlan } from "./schedule.ts";
import { FailureFrames, checkFailureFramePolicy } from "./frame-policy.ts";
import type { FailureFramePolicy } from "./frame-policy.ts";
import { asyncRuntime } from "./async-runtime.ts";
import { structuredRuntime } from "./structured-runtime.ts";
import { frameTrailRuntime, syncFrameStorageRuntime } from "./frame-runtime.ts";
import {
  EffectFn,
  maxLogicalFrames,
  maxScopeFinalizers,
  streamEmit,
  streamRunCollect,
} from "./effect-ir.ts";
import type { Computation, RemoteOp } from "./effect-ir.ts";
import type { Implementation } from "./compiler.ts";
import type { GeneratedFiles } from "./cargo.ts";
import { Rs, escapeJsonContent } from "./rust-emit.ts";
import type { RsExpr, RsStmt, RsType } from "./rust-emit.ts";
import { SourceArtifacts, checkArtifactPolicy } from "./artifact-policy.ts";
import type {
  ArtifactPolicy,
  FullSourceArtifacts,
  NoneSourceArtifacts,
} from "./artifact-policy.ts";

export type RustExpr = (
  | { readonly _tag: "Parameter"; readonly index: number }
  | { readonly _tag: "Bound"; readonly name: string }
  | { readonly _tag: "Local"; readonly index: number }
  | { readonly _tag: "Literal"; readonly value: bigint | boolean | string | number | void }
  | {
      readonly _tag: "Call";
      readonly method: Implementation["method"];
      readonly args: readonly RustExpr[];
      /** The host's encoder function for a "json" call (RM-006). */
      readonly encoder?: string;
    }
  | {
      readonly _tag: "Match";
      readonly condition: RustExpr;
      readonly onTrue: number;
      readonly onFalse: number;
      readonly onTrueUse?: string;
      readonly onFalseUse?: string;
    }
  | {
      readonly _tag: "Make";
      readonly type: IRType<unknown>;
      readonly tag: string | undefined;
      /** `None` is an absent optional key; `Some`/`SomeSome` wrap presence (OPT-003). */
      readonly fields: readonly {
        readonly value: RustExpr | undefined;
        readonly wrap: "Plain" | "None" | "Some" | "SomeSome";
      }[];
    }
  | {
      readonly _tag: "MatchUndefined";
      readonly scrutinee: RustExpr;
      readonly binder: string;
      readonly itemCopy: boolean;
      readonly onDefined: number;
      readonly onDefinedUse?: string;
      readonly onUndefined: number;
      readonly onUndefinedUse?: string;
    }
  | { readonly _tag: "Defined"; readonly value: RustExpr }
  | { readonly _tag: "Undefined" }
  /** An `optional` field read: presence and definedness collapse to `Option<T>`. */
  | { readonly _tag: "Flatten"; readonly base: RustExpr }
  /** A unit enum variant of a literal union (LIT-001). */
  | { readonly _tag: "Variant"; readonly text: string }
  /** A `Record` query over `Vec<(String, V)>` in JS order (RECJS-002). */
  | {
      readonly _tag: "RecordQuery";
      readonly query: RecordQuery;
      readonly source: RustExpr;
      readonly key: RustExpr | undefined;
    }
  | { readonly _tag: "ArrayMake"; readonly elements: readonly RustExpr[] }
  | { readonly _tag: "ArrayLength"; readonly value: RustExpr }
  /** One generated loop per structured iteration (ARR-004). */
  | {
      readonly _tag: "ArrayLoop";
      readonly op: "Map" | "Filter" | "Reduce";
      readonly source: RustExpr;
      readonly init: RustExpr | undefined;
      readonly helper: number;
      readonly use?: string;
      readonly item: string;
      readonly index: string;
      readonly accumulator: string | undefined;
      readonly itemCopy: boolean;
    }
  /** A field place; borrowed as an operand, cloned only in value positions. */
  | { readonly _tag: "Field"; readonly base: RustExpr; readonly field: string }
  | {
      readonly _tag: "MatchTags";
      readonly union: IRType<unknown>;
      readonly scrutinee: RustExpr;
      readonly cases: readonly {
        readonly tag: string;
        readonly path: string;
        readonly binder: string;
        readonly helper: number;
        readonly use?: string;
      }[];
    }
) & {
  readonly origin?: string;
  readonly occurrence?: string;
  /**
   * Non-Copy value (STR-002, REC-004): names are borrows, locals are owned, operands borrow
   * and value positions take an owned copy.
   */
  readonly owned?: true;
};
export const RustExpr = Object.freeze({
  parameter: (index: number): RustExpr => Object.freeze({ _tag: "Parameter", index }),
  bound: (name: string): RustExpr => Object.freeze({ _tag: "Bound", name }),
  local: (index: number): RustExpr => Object.freeze({ _tag: "Local", index }),
  literal: (value: bigint | boolean | string | number | void): RustExpr =>
    Object.freeze({ _tag: "Literal", value }),
  call: (method: Implementation["method"], left: RustExpr, right: RustExpr): RustExpr =>
    Object.freeze({ _tag: "Call", method, args: Object.freeze([left, right]) }),
});
export interface RustBinding {
  readonly index: number;
  readonly type: IRType<unknown>;
  readonly value: RustExpr;
}
interface RustBlock {
  readonly bindings: readonly RustBinding[];
  readonly body: RustExpr;
}
interface Parameter {
  readonly name: string;
  readonly type: IRType<unknown>;
}
/**
 * A stream pipeline ready for emission: value blocks render in the consumer's scope, and a
 * per-element operator is a block computing its Array operation over the chunk bound to `chunk`.
 */
type StreamPlan =
  | { readonly _tag: "FromArray"; readonly values: RustBlock; readonly item: IRType<unknown> }
  | { readonly _tag: "Range"; readonly min: RustBlock; readonly max: RustBlock }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Fail"; readonly error: RustBlock }
  | { readonly _tag: "FromSchedule"; readonly milliseconds: number }
  | {
      readonly _tag: "Transform";
      readonly filter: boolean;
      readonly source: StreamPlan;
      readonly chunk: string;
      readonly input: IRType<unknown>;
      readonly output: IRType<unknown>;
      readonly transform: RustBlock;
    }
  | { readonly _tag: "Take"; readonly source: StreamPlan; readonly count: number }
  | {
      readonly _tag: "Rechunk";
      readonly source: StreamPlan;
      readonly size: number;
      readonly item: IRType<unknown>;
    }
  | { readonly _tag: "Concat"; readonly first: StreamPlan; readonly second: StreamPlan }
  | { readonly _tag: "Chunks"; readonly source: StreamPlan; readonly item: IRType<unknown> };
/** Whether a planned pipeline sleeps, so its consumer is asynchronous. */
const planSuspends = (plan: StreamPlan): boolean =>
  Match.value(plan).pipe(
    Match.tags({
      FromSchedule: () => true,
      Transform: (m) => planSuspends(m.source),
      Take: (m) => planSuspends(m.source),
      Rechunk: (m) => planSuspends(m.source),
      Chunks: (m) => planSuspends(m.source),
      Concat: (m) => planSuspends(m.first) || planSuspends(m.second),
    }),
    Match.orElse(() => false),
  );
type HelperBody =
  | { readonly _tag: "ClockReadMillis" }
  | { readonly _tag: "RandomDraw" }
  | {
      readonly _tag: "TaskGroup";
      readonly mode: "All" | "Race";
      readonly children: readonly number[];
    }
  | {
      readonly _tag: "RefScope";
      readonly initial: RustBlock;
      readonly binder: string;
      readonly content: IRType<unknown>;
      readonly body: number;
    }
  | { readonly _tag: "RefGet"; readonly ref: string }
  | {
      readonly _tag: "RefModify";
      readonly ref: string;
      readonly binder: string;
      readonly content: IRType<unknown>;
      readonly result: RustBlock;
      readonly next: RustBlock;
    }
  | { readonly _tag: "Scope"; readonly body: number }
  | { readonly _tag: "AddFinalizer"; readonly finalizer: number }
  | {
      readonly _tag: "AcquireRelease";
      readonly acquire: number;
      readonly binder: string;
      readonly release: number;
    }
  | {
      readonly _tag: "RegisteredFile";
      readonly path: string;
      readonly file: string;
      readonly body: number;
      readonly afterClose: number;
    }
  | {
      readonly _tag: "Repeat";
      readonly body: number;
      readonly schedule: SchedulePlan;
      readonly times: number | undefined;
    }
  | {
      readonly _tag: "Retry";
      readonly body: number;
      readonly schedule: SchedulePlan;
      readonly times: number | undefined;
    }
  | {
      readonly _tag: "FileScope";
      readonly path: string;
      readonly file: string;
      readonly body: number;
      readonly afterClose: number;
    }
  | { readonly _tag: "FileSize"; readonly file: string }
  | {
      readonly _tag: "CatchAll";
      readonly source: number;
      readonly binder: string;
      readonly body: number;
    }
  | {
      readonly _tag: "AcquireUseRelease";
      readonly acquire: number;
      readonly binder: string;
      readonly use: number;
      readonly release: number;
    }
  | { readonly _tag: "Sleep"; readonly milliseconds: number }
  | {
      readonly _tag: "ForEach";
      readonly source: RustBlock;
      readonly item: string;
      readonly index: string;
      readonly itemCopy: boolean;
      readonly helper: number;
      readonly discard: boolean;
    }
  | {
      readonly _tag: "MatchTags";
      readonly union: IRType<unknown>;
      readonly scrutinee: RustBlock;
      readonly cases: readonly {
        readonly tag: string;
        readonly binder: string;
        readonly helper: number;
      }[];
    }
  | {
      readonly _tag: "Launch";
      readonly values: readonly RustBlock[];
      readonly types: readonly IRType<unknown>[];
    }
  | {
      readonly _tag: "RemoteStore";
      readonly op: RemoteOp;
      readonly entity: string;
      readonly id: RustBlock;
      readonly values: RustBlock | undefined;
    }
  | { readonly _tag: "Ensuring"; readonly body: number; readonly finalizer: number }
  /** `Stream.runCollect`, fused into one chunk loop (STREAM-004). */
  | {
      readonly _tag: "StreamCollect";
      readonly plan: StreamPlan;
      readonly item: IRType<unknown>;
      readonly error: IRType<unknown>;
      /** Hand each encoded chunk to the host's sink instead of collecting (STREAM-006). */
      readonly emit?: {
        readonly chunk: string;
        readonly input: IRType<unknown>;
        readonly transform: RustBlock;
      };
    }
  | { readonly _tag: "Pure"; readonly block: RustBlock }
  | { readonly _tag: "Succeed"; readonly block: RustBlock }
  | { readonly _tag: "Fail"; readonly block: RustBlock }
  | {
      readonly _tag: "Map";
      readonly source: number;
      readonly binder: string;
      readonly block: RustBlock;
    }
  | {
      readonly _tag: "FlatMap";
      readonly source: number;
      readonly binder: string;
      readonly body: number;
    }
  | {
      readonly _tag: "Match";
      readonly condition: RustBlock;
      readonly onTrue: number;
      readonly onFalse: number;
    }
  | {
      readonly _tag: "Log";
      readonly level: string;
      readonly message: string;
      readonly attributes: readonly {
        readonly key: string;
        readonly type: IRType<unknown>;
        readonly block: RustBlock;
      }[];
    }
  | {
      readonly _tag: "Annotate";
      readonly key: string;
      readonly type: IRType<unknown>;
      readonly value: RustBlock;
      readonly body: number;
    }
  | {
      readonly _tag: "Span";
      readonly label: string;
      readonly body: number;
    };
interface Helper {
  readonly files: readonly string[];
  readonly asynchronous?: boolean;
  readonly origin?: string;
  readonly path: string;
  readonly index: number;
  readonly input: readonly Parameter[];
  readonly output: IRType<unknown>;
  readonly error?: IRType<unknown>;
  readonly body: HelperBody;
}
interface RustFunction {
  readonly services: RuntimeServiceUsage;
  readonly asynchronous: boolean;
  readonly origin?: string;
  readonly path: string;
  readonly name: string;
  readonly input: readonly IRType<unknown>[];
  readonly output: IRType<unknown>;
  readonly helpers: readonly Helper[];
  readonly node:
    | { readonly _tag: "Pure"; readonly block: RustBlock }
    | { readonly _tag: "Effect"; readonly root: number; readonly error: IRType<unknown> };
}
export interface RustModule {
  readonly runtimeServices: ResolvedRuntimeServicesSelection;
  readonly failureFrames: FailureFramePolicy;
  readonly sourceArtifacts: FullSourceArtifacts;
  readonly provenance: ProvenanceSnapshot;
  readonly functions: readonly RustFunction[];
}
export interface UnmappedRustModule {
  readonly runtimeServices: ResolvedRuntimeServicesSelection;
  readonly failureFrames: FailureFramePolicy;
  readonly sourceArtifacts: NoneSourceArtifacts;
  readonly provenance?: never;
  readonly functions: readonly RustFunction[];
}
export type LoweredModule = RustModule | UnmappedRustModule;
interface Scope {
  readonly files: ReadonlyMap<symbol, string>;
  readonly fileInputs: readonly string[];
  readonly bindings: ReadonlyMap<symbol, readonly Parameter[]>;
  readonly input: readonly Parameter[];
}

export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
): RustModule;
export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
  policy: FullSourceArtifacts,
  failureFrames?: FailureFramePolicy,
  runtimeServices?: RuntimeServicesSelection,
): RustModule;
export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
  policy: NoneSourceArtifacts,
  failureFrames?: FailureFramePolicy,
  runtimeServices?: RuntimeServicesSelection,
): UnmappedRustModule;
export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
  policy: ArtifactPolicy,
  failureFrames?: FailureFramePolicy,
  runtimeServices?: RuntimeServicesSelection,
): LoweredModule;
export function lowerFunctions(
  program: Program,
  selected: ReadonlyMap<OperationRef, Implementation>,
  policy: ArtifactPolicy = SourceArtifacts.Full,
  failureFrames: FailureFramePolicy = FailureFrames.Bounded,
  servicesSelection: RuntimeServicesSelection = {},
): LoweredModule {
  const runtimeServices = normalizeRuntimeServicesSelection(servicesSelection);
  checkArtifactPolicy(policy);
  checkFailureFramePolicy(failureFrames);
  const provenance = SourceArtifacts.isNone(policy) ? undefined : new Provenance(program);
  const functions = Object.freeze(
    Object.entries(program.functions).map(([name, f]): RustFunction => {
      const path = `functions.${name}`;
      let next = 0;
      const helpers = new Map<number, Helper>();
      const pureMemo = new Map<Expr<unknown>["node"], Map<Scope, number>>();
      const effectMemo = new Map<
        Computation<unknown, unknown>["node"],
        Map<Scope, Map<IRType<unknown>, number>>
      >();
      const input = Object.freeze(f.input.map((type, i) => Object.freeze({ name: `p${i}`, type })));
      const rootScope: Scope = {
        bindings: new Map([[f.binder, input]]),
        input,
        files: new Map(),
        fileInputs: [],
      };
      const nestedScope = (
        scope: Scope,
        binder: symbol,
        type: IRType<unknown>,
        id: number,
      ): Scope => {
        const parameter = Object.freeze({ name: `b${id}`, type });
        const bindings = new Map(scope.bindings);
        bindings.set(binder, [parameter]);
        return {
          bindings,
          input: Object.freeze(scope.input.concat([parameter])),
          files: scope.files,
          fileInputs: scope.fileInputs,
        };
      };
      let caseBinders = 0;
      const caseScope = (scope: Scope, binder: symbol, type: IRType<unknown>): Scope => {
        const parameter = Object.freeze({ name: `m${caseBinders++}`, type });
        const bindings = new Map(scope.bindings);
        bindings.set(binder, [parameter]);
        return {
          bindings,
          input: Object.freeze(scope.input.concat([parameter])),
          files: scope.files,
          fileInputs: scope.fileInputs,
        };
      };
      // Only external parameters used by cleanup need to survive until scope close.
      const delayedScope = (scope: Scope, finalizer: Computation<unknown, unknown>): Scope => {
        const captures = new Set<Parameter>();
        const expressions = new Set<Expr<unknown>["node"]>();
        const computations = new Set<Computation<unknown, unknown>["node"]>();
        const expression = (value: Expr<unknown>): void => {
          if (expressions.has(value.node)) return;
          expressions.add(value.node);
          Match.value(value.node).pipe(
            Match.tagsExhaustive({
              Parameter: (n) => {
                const parameter = scope.bindings.get(n.binder)?.[n.index];
                if (parameter) captures.add(parameter);
              },
              Literal: () => {},
              Apply: (n) => n.args.forEach(expression),
              Match: (n) => {
                expression(n.condition);
                expression(n.onTrue);
                expression(n.onFalse);
              },
              Make: (n) => n.fields.forEach((field) => field && expression(field)),
              Get: (n) => expression(n.value),
              MatchUndefined: (n) => {
                expression(n.value);
                expression(n.onDefined);
                expression(n.onUndefined);
              },
              Defined: (n) => expression(n.value),
              Undefined: () => {},
              RecordQuery: (n) => {
                expression(n.value);
                if (n.key) expression(n.key);
              },
              ArrayMake: (n) => n.elements.forEach(expression),
              ArrayLength: (n) => expression(n.value),
              ArrayLoop: (n) => {
                expression(n.source);
                expression(n.body);
                Match.value(n.op).pipe(
                  Match.tag("Reduce", (reduce) => expression(reduce.init)),
                  Match.orElse(() => undefined),
                );
              },
              MatchTags: (n) => {
                expression(n.value);
                n.cases.forEach((c) => expression(c.body));
              },
            }),
          );
        };
        const computation = (value: Computation<unknown, unknown>): void => {
          if (computations.has(value.node)) return;
          computations.add(value.node);
          Match.value(value.node).pipe(
            Match.tagsExhaustive({
              TaskGroup: (n) => n.children.forEach(computation),
              Scope: (n) => computation(n.body),
              AddFinalizer: (n) => computation(n.finalizer),
              AcquireRelease: (n) => {
                computation(n.acquire);
                computation(n.release);
              },
              RegisteredFile: (n) => {
                computation(n.body);
                computation(n.afterClose);
              },
              FileScope: (n) => {
                computation(n.body);
                computation(n.afterClose);
              },
              ClockReadMillis: () => {},
              RandomDraw: () => {},
              RefMake: (n) => expression(n.initial),
              RefScope: (n) => {
                expression(n.initial);
                computation(n.body);
              },
              RefGet: () => {},
              RefModify: (n) => {
                expression(n.result);
                expression(n.next);
              },
              FileSize: () => {},
              AcquireUseRelease: (n) => {
                computation(n.acquire);
                computation(n.use);
                computation(n.release);
              },
              Ensuring: (n) => {
                computation(n.body);
                computation(n.finalizer);
              },
              CatchAll: (n) => {
                computation(n.source);
                computation(n.body);
              },
              FlatMap: (n) => {
                computation(n.source);
                computation(n.body);
              },
              Map: (n) => {
                computation(n.source);
                expression(n.body);
              },
              Match: (n) => {
                expression(n.condition);
                computation(n.onTrue);
                computation(n.onFalse);
              },
              MatchTags: (n) => {
                expression(n.value);
                n.cases.forEach((c) => computation(c.body));
              },
              ForEach: (n) => {
                expression(n.source);
                computation(n.body);
              },
              Annotate: (n) => {
                expression(n.value);
                computation(n.body);
              },
              Span: (n) => computation(n.body),
              Repeat: (n) => computation(n.body),
              Retry: (n) => computation(n.body),
              Succeed: (n) => expression(n.value),
              StreamRunCollect: (n) => {
                streamExpressions(n.stream).forEach(({ expr }) => expression(expr));
                streamFinalizers(n.stream).forEach(({ finalizer }) => computation(finalizer));
              },
              StreamEmit: (n) => {
                streamExpressions(n.stream).forEach(({ expr }) => expression(expr));
                streamFinalizers(n.stream).forEach(({ finalizer }) => computation(finalizer));
                expression(n.encoded);
              },
              Fail: (n) => expression(n.error),
              Log: (n) => n.attributes.forEach(([, value]) => expression(value)),
              Sleep: () => {},
              Launch: (n) => n.values.forEach(expression),
              RemoteStore: (n) => {
                expression(n.id);
                if (n.values) expression(n.values);
              },
            }),
          );
        };
        computation(finalizer);
        return {
          bindings: scope.bindings,
          input: Object.freeze(scope.input.filter((parameter) => captures.has(parameter))),
          files: new Map(),
          fileInputs: [],
        };
      };
      const pureHelper = (e: Expr<unknown>, scope: Scope, path: string): number => {
        const cached = pureMemo.get(e.node)?.get(scope);
        if (cached !== undefined) return cached;
        const index = next++;
        const scopes = pureMemo.get(e.node) ?? new Map<Scope, number>();
        scopes.set(scope, index);
        pureMemo.set(e.node, scopes);
        const body: HelperBody = Object.freeze({ _tag: "Pure", block: block(e, scope, path) });
        helpers.set(
          index,
          Object.freeze({
            index,
            files: [],
            input: scope.input,
            output: e.type,
            body,
            origin: provenance?.origin(e),
            path,
          }),
        );
        return index;
      };
      const block = (root: Expr<unknown>, scope: Scope, path: string): RustBlock => {
        const bindings: RustBinding[] = [];
        const memo = new Map<Expr<unknown>["node"], RustExpr>();
        const expression = (e: Expr<unknown>, path: string): RustExpr => {
          const source = provenance
            ? { origin: provenance.origin(e), occurrence: provenance.use(path) }
            : undefined;
          const cached = memo.get(e.node);
          if (cached) return provenance ? Object.freeze({ ...cached, ...source }) : cached;
          const value = Match.value(e.node).pipe(
            Match.tagsExhaustive({
              Parameter: (n) => {
                const parameter = scope.bindings.get(n.binder)![n.index];
                return RustExpr.bound(parameter.name);
              },
              Literal: (n): RustExpr => {
                const literal = RustExpr.literal(
                  n.value as bigint | boolean | string | number | void,
                );
                const literals = literalsOf(e.type);
                if (literals)
                  return Object.freeze({
                    _tag: "Variant",
                    text: `${e.type.native.type}::${rustLiteralVariants(literals)[literals.indexOf(n.value as string)]}`,
                  });
                if (!undefinedOrItem(e.type)) return literal;
                return n.value === undefined
                  ? Object.freeze({ _tag: "Undefined" })
                  : Object.freeze({ _tag: "Defined", value: literal });
              },
              Apply: (n): RustExpr => {
                const method = selected.get(n.operation.ref)!.method;
                const host = hostFunctionOf(n.operation);
                return Object.freeze({
                  _tag: "Call",
                  method,
                  args: Object.freeze(
                    n.args.map((arg, i) => expression(arg, `${path}.args[${i}]`)),
                  ),
                  ...(method === "json" && host ? { encoder: host } : {}),
                });
              },
              Match: (n): RustExpr =>
                Object.freeze({
                  _tag: "Match",
                  condition: expression(n.condition, `${path}.condition`),
                  onTrue: pureHelper(n.onTrue, scope, `${path}.onTrue`),
                  onTrueUse: provenance?.use(`${path}.onTrue`),
                  onFalse: pureHelper(n.onFalse, scope, `${path}.onFalse`),
                  onFalseUse: provenance?.use(`${path}.onFalse`),
                }),
              Make: (n): RustExpr => {
                const layout = structLayout(e.type, n.tag)!;
                return Object.freeze({
                  _tag: "Make",
                  type: e.type,
                  tag: n.tag,
                  fields: Object.freeze(
                    n.fields.map((field, i) => {
                      const declared = layout.fields[i];
                      const value = field && expression(field, `${path}.fields[${i}]`);
                      const wrap =
                        declared.optional === undefined
                          ? "Plain"
                          : field === undefined
                            ? "None"
                            : declared.optional === "optional" &&
                                !IRType.same(field.type, declared.type)
                              ? "SomeSome"
                              : "Some";
                      return Object.freeze({ value, wrap });
                    }),
                  ),
                });
              },
              Get: (n): RustExpr => {
                const layout = structLayout(n.value.type)!;
                const index = layout.fields.findIndex((f) => f.name === n.field);
                const place: RustExpr = Object.freeze({
                  _tag: "Field",
                  base: expression(n.value, `${path}.value`),
                  field: rustFieldNames(layout)[index],
                });
                return layout.fields[index].optional === "optional"
                  ? Object.freeze({ _tag: "Flatten", base: place })
                  : place;
              },
              MatchUndefined: (n): RustExpr => {
                const item = undefinedOrItem(n.value.type)!;
                const nested = caseScope(scope, n.binder, item);
                return Object.freeze({
                  _tag: "MatchUndefined",
                  scrutinee: expression(n.value, `${path}.value`),
                  binder: nested.input[nested.input.length - 1].name,
                  itemCopy: item.traits.includes(Traits.Copyable),
                  onDefined: pureHelper(n.onDefined, nested, `${path}.onDefined`),
                  onDefinedUse: provenance?.use(`${path}.onDefined`),
                  onUndefined: pureHelper(n.onUndefined, scope, `${path}.onUndefined`),
                  onUndefinedUse: provenance?.use(`${path}.onUndefined`),
                });
              },
              Defined: (n): RustExpr =>
                Object.freeze({ _tag: "Defined", value: expression(n.value, `${path}.value`) }),
              Undefined: (): RustExpr => Object.freeze({ _tag: "Undefined" }),
              RecordQuery: (n): RustExpr =>
                Object.freeze({
                  _tag: "RecordQuery",
                  query: n.query,
                  source: expression(n.value, `${path}.value`),
                  key: n.key && expression(n.key, `${path}.key`),
                }),
              ArrayMake: (n): RustExpr =>
                Object.freeze({
                  _tag: "ArrayMake",
                  elements: Object.freeze(
                    n.elements.map((element, i) => expression(element, `${path}.elements[${i}]`)),
                  ),
                }),
              ArrayLength: (n): RustExpr =>
                Object.freeze({ _tag: "ArrayLength", value: expression(n.value, `${path}.value`) }),
              ArrayLoop: (n): RustExpr => {
                const item = arrayItem(n.source.type)!;
                const withItem = caseScope(scope, n.item, item);
                const withIndex = caseScope(withItem, n.index, U64Type);
                const reduce = Match.value(n.op).pipe(
                  Match.tag("Reduce", (op) => op),
                  Match.orElse(() => undefined),
                );
                const loopScope = reduce
                  ? caseScope(withIndex, reduce.accumulator, e.type)
                  : withIndex;
                const names = loopScope.input.slice(scope.input.length).map((p) => p.name);
                return Object.freeze({
                  _tag: "ArrayLoop",
                  op: n.op._tag,
                  source: expression(n.source, `${path}.source`),
                  init: reduce ? expression(reduce.init, `${path}.init`) : undefined,
                  helper: pureHelper(n.body, loopScope, `${path}.body`),
                  use: provenance?.use(`${path}.body`),
                  item: names[0],
                  index: names[1],
                  accumulator: names[2],
                  itemCopy: item.traits.includes(Traits.Copyable),
                });
              },
              MatchTags: (n): RustExpr => {
                const cases = unionCases(n.value.type) ?? [];
                return Object.freeze({
                  _tag: "MatchTags",
                  union: n.value.type,
                  scrutinee: expression(n.value, `${path}.value`),
                  cases: Object.freeze(
                    n.cases.map((c, i) => {
                      const caseType = cases.find((t) => structLayout(t)?.tag === c.tag)!;
                      const nested = caseScope(scope, c.binder, caseType);
                      return Object.freeze({
                        tag: c.tag,
                        path: `${path}.cases[${i}]`,
                        binder: nested.input[nested.input.length - 1].name,
                        helper: pureHelper(c.body, nested, `${path}.cases[${i}]`),
                        use: provenance?.use(`${path}.cases[${i}]`),
                      });
                    }),
                  ),
                });
              },
            }),
          );
          const local = Match.value(value).pipe(
            Match.tags({
              Call: () => true,
              Match: () => true,
              Make: () => true,
              MatchTags: () => true,
              ArrayMake: () => true,
              ArrayLoop: () => true,
              MatchUndefined: () => true,
              Defined: () => true,
              Undefined: () => true,
              Flatten: () => true,
              RecordQuery: () => true,
            }),
            Match.orElse(() => false),
          );
          const plain = local ? RustExpr.local(bindings.length) : value;
          const reference = e.type.traits.includes(Traits.Copyable)
            ? plain
            : Object.freeze({ ...plain, owned: true as const });
          const result = provenance ? Object.freeze({ ...reference, ...source }) : reference;
          if (local)
            bindings.push(
              Object.freeze({
                index: bindings.length,
                type: e.type,
                value: provenance ? Object.freeze({ ...value, ...source }) : value,
              }),
            );
          memo.set(e.node, result);
          return result;
        };
        const body = expression(root, path);
        return Object.freeze({ bindings: Object.freeze(bindings), body });
      };
      const effectHelper = (
        c: Computation<unknown, unknown>,
        scope: Scope,
        error: IRType<unknown>,
        path: string,
      ): number => {
        const cached = effectMemo.get(c.node)?.get(scope)?.get(error);
        if (cached !== undefined) return cached;
        const index = next++;
        const scopes = effectMemo.get(c.node) ?? new Map<Scope, Map<IRType<unknown>, number>>();
        const channels = scopes.get(scope) ?? new Map<IRType<unknown>, number>();
        channels.set(error, index);
        scopes.set(scope, channels);
        effectMemo.set(c.node, scopes);
        const rootFinalizer = (stream: StreamIR<unknown, unknown>) =>
          Match.value(stream.node).pipe(
            Match.tag("Ensuring", (m) => ({ source: m.source, finalizer: m.finalizer })),
            Match.orElse(() => undefined),
          );
        // Stream pipelines plan once per consumer (STREAM-004).
        // A per-element operator runs as its Array operation over a bound chunk.
        const transform = (
          filter: boolean,
          m: {
            readonly source: StreamIR<unknown, unknown>;
            readonly item: symbol;
            readonly body: Expr<unknown>;
          },
          output: IRType<unknown>,
          at: string,
        ): StreamPlan => {
          const input = ArrayType.of(m.source.item);
          const chunk = Symbol("reffect/stream/chunk");
          const chunkScope = caseScope(scope, chunk, input);
          const loop = Expr.arrayLoop(
            filter ? { _tag: "Filter" } : { _tag: "Map" },
            filter ? input : ArrayType.of(output),
            Expr.parameter(input, chunk, 0),
            m.item,
            Symbol("reffect/stream/index"),
            m.body,
          );
          return {
            _tag: "Transform",
            filter,
            source: planStream(m.source, `${at}.source`),
            chunk: chunkScope.input[chunkScope.input.length - 1].name,
            input,
            output: filter ? input : ArrayType.of(output),
            transform: block(loop, chunkScope, `${at}.body`),
          };
        };
        const planStream = (stream: StreamIR<unknown, unknown>, at: string): StreamPlan =>
          Match.value(stream.node).pipe(
            Match.tagsExhaustive({
              FromArray: (m): StreamPlan => ({
                _tag: "FromArray",
                values: block(m.values, scope, `${at}.values`),
                item: stream.item,
              }),
              Range: (m): StreamPlan => ({
                _tag: "Range",
                min: block(m.min, scope, `${at}.min`),
                max: block(m.max, scope, `${at}.max`),
              }),
              Empty: (): StreamPlan => ({ _tag: "Empty" }),
              FromSchedule: (m): StreamPlan => ({
                _tag: "FromSchedule",
                milliseconds: m.milliseconds,
              }),
              Ensuring: (): StreamPlan => {
                throw fail(
                  "UNSUPPORTED_STREAM",
                  "lower",
                  at,
                  "Stream.ensuring is native as the outermost operator of a consumed stream",
                );
              },
              Fail: (m): StreamPlan => ({
                _tag: "Fail",
                error: block(m.error, scope, `${at}.error`),
              }),
              Map: (m) => transform(false, m, stream.item, at),
              Filter: (m) => transform(true, m, stream.item, at),
              Take: (m): StreamPlan => ({
                _tag: "Take",
                source: planStream(m.source, `${at}.source`),
                count: m.count,
              }),
              Rechunk: (m): StreamPlan => ({
                _tag: "Rechunk",
                source: planStream(m.source, `${at}.source`),
                size: m.size,
                item: stream.item,
              }),
              Concat: (m): StreamPlan => ({
                _tag: "Concat",
                first: planStream(m.first, `${at}.first`),
                second: planStream(m.second, `${at}.second`),
              }),
              Chunks: (m): StreamPlan => ({
                _tag: "Chunks",
                source: planStream(m.source, `${at}.source`),
                item: m.source.item,
              }),
            }),
          );
        const body: HelperBody = Match.value(c.node).pipe(
          Match.tagsExhaustive({
            TaskGroup: (n): HelperBody => ({
              _tag: "TaskGroup",
              mode: n.mode,
              children: n.children.map((child, i) =>
                effectHelper(
                  child,
                  delayedScope(scope, child),
                  NeverType,
                  `${path}.children[${i}]`,
                ),
              ),
            }),
            Scope: (n): HelperBody => ({
              _tag: "Scope",
              body: effectHelper(n.body, scope, error, `${path}.body`),
            }),
            AddFinalizer: (n): HelperBody => ({
              _tag: "AddFinalizer",
              finalizer: effectHelper(
                n.finalizer,
                delayedScope(scope, n.finalizer),
                NeverType,
                `${path}.finalizer`,
              ),
            }),
            AcquireRelease: (n): HelperBody => ({
              _tag: "AcquireRelease",
              acquire: effectHelper(n.acquire, scope, error, `${path}.acquire`),
              binder: `b${index}`,
              release: effectHelper(
                n.release,
                delayedScope(nestedScope(scope, n.binder, n.acquire.output, index), n.release),
                NeverType,
                `${path}.release`,
              ),
            }),
            RegisteredFile: (n): HelperBody => {
              const file = Rs.ident(`file${index}`).text;
              const files = new Map(scope.files);
              files.set(n.binder, file);
              return {
                _tag: "RegisteredFile",
                path: n.path,
                file,
                body: effectHelper(
                  n.body,
                  { ...scope, files, fileInputs: scope.fileInputs.concat(file) },
                  error,
                  `${path}.body`,
                ),
                afterClose: effectHelper(
                  n.afterClose,
                  delayedScope(scope, n.afterClose),
                  NeverType,
                  `${path}.afterClose`,
                ),
              };
            },
            CatchAll: (n): HelperBody => ({
              _tag: "CatchAll",
              source: effectHelper(n.source, scope, n.source.error, `${path}.source`),
              binder: `b${index}`,
              body: effectHelper(
                n.body,
                nestedScope(scope, n.binder, n.source.error, index),
                error,
                `${path}.body`,
              ),
            }),
            FileScope: (n): HelperBody => {
              const file = Rs.ident(`file${index}`).text;
              const files = new Map(scope.files);
              files.set(n.binder, file);
              const nested: Scope = {
                bindings: scope.bindings,
                input: scope.input,
                files,
                fileInputs: scope.fileInputs.concat(file),
              };
              return {
                _tag: "FileScope",
                path: n.path,
                file,
                body: effectHelper(n.body, nested, error, `${path}.body`),
                afterClose: effectHelper(n.afterClose, scope, error, `${path}.afterClose`),
              };
            },
            ClockReadMillis: (): HelperBody => ({ _tag: "ClockReadMillis" }),
            RandomDraw: (): HelperBody => ({ _tag: "RandomDraw" }),
            RefMake: (): HelperBody => {
              throw fail(
                "RESOURCE_ESCAPE",
                "lower",
                path,
                "Ref.make must be bound by Effect.flatMap",
              );
            },
            RefScope: (n): HelperBody => ({
              _tag: "RefScope",
              initial: block(n.initial, scope, `${path}.initial`),
              binder: `b${index}`,
              content: n.initial.type,
              body: effectHelper(
                n.body,
                nestedScope(scope, n.binder, refType(n.initial.type), index),
                error,
                `${path}.body`,
              ),
            }),
            RefGet: (n): HelperBody => ({
              _tag: "RefGet",
              ref: scope.bindings.get(n.binder)![0].name,
            }),
            RefModify: (n): HelperBody => {
              const nested = nestedScope(scope, n.binder, n.content, index);
              return {
                _tag: "RefModify",
                ref: scope.bindings.get(n.ref)![0].name,
                binder: `b${index}`,
                content: n.content,
                result: block(n.result, nested, `${path}.result`),
                next: block(n.next, nested, `${path}.next`),
              };
            },
            FileSize: (n): HelperBody => ({ _tag: "FileSize", file: scope.files.get(n.binder)! }),
            AcquireUseRelease: (n): HelperBody => ({
              _tag: "AcquireUseRelease",
              acquire: effectHelper(n.acquire, scope, error, `${path}.acquire`),
              binder: `b${index}`,
              use: effectHelper(
                n.use,
                nestedScope(scope, n.binder, n.acquire.output, index),
                error,
                `${path}.use`,
              ),
              release: effectHelper(
                n.release,
                nestedScope(scope, n.binder, n.acquire.output, index),
                error,
                `${path}.release`,
              ),
            }),
            Sleep: (n): HelperBody => ({ _tag: "Sleep", milliseconds: n.milliseconds }),
            Launch: (n): HelperBody => ({
              _tag: "Launch",
              values: Object.freeze(
                n.values.map((value, i) => block(value, scope, `${path}.values.${i}`)),
              ),
              types: Object.freeze(n.values.map((value) => value.type)),
            }),
            RemoteStore: (n): HelperBody => ({
              _tag: "RemoteStore",
              op: n.op,
              entity: n.entity,
              id: block(n.id, scope, `${path}.id`),
              values: n.values && block(n.values, scope, `${path}.values`),
            }),
            Repeat: (n): HelperBody => ({
              _tag: "Repeat",
              body: effectHelper(n.body, scope, error, `${path}.body`),
              schedule: n.schedule,
              times: n.times,
            }),
            Retry: (n): HelperBody => ({
              _tag: "Retry",
              body: effectHelper(n.body, scope, error, `${path}.body`),
              schedule: n.schedule,
              times: n.times,
            }),
            Ensuring: (n): HelperBody => ({
              _tag: "Ensuring",
              body: effectHelper(n.body, scope, error, `${path}.body`),
              finalizer: effectHelper(n.finalizer, scope, error, `${path}.finalizer`),
            }),
            Succeed: (n): HelperBody => ({
              _tag: "Succeed",
              block: block(n.value, scope, `${path}.value`),
            }),
            Fail: (n): HelperBody => ({
              _tag: "Fail",
              block: block(n.error, scope, `${path}.error`),
            }),
            StreamRunCollect: (n): HelperBody => {
              // A root Stream.ensuring is Effect.ensuring around consuming its source.
              const ensured = rootFinalizer(n.stream);
              if (ensured)
                return {
                  _tag: "Ensuring",
                  body: effectHelper(
                    streamRunCollect(ensured.source, c.output),
                    scope,
                    error,
                    `${path}.stream.source`,
                  ),
                  finalizer: effectHelper(
                    ensured.finalizer,
                    scope,
                    error,
                    `${path}.stream.finalizer`,
                  ),
                };
              return {
                _tag: "StreamCollect",
                plan: planStream(n.stream, `${path}.stream`),
                item: n.stream.item,
                error: n.stream.error,
              };
            },
            // Each chunk is encoded element by element, then handed to the host (STREAM-006).
            StreamEmit: (n): HelperBody => {
              const ensured = rootFinalizer(n.stream);
              if (ensured)
                return {
                  _tag: "Ensuring",
                  body: effectHelper(
                    streamEmit(ensured.source, n.item, n.encoded, c.error),
                    scope,
                    error,
                    `${path}.stream.source`,
                  ),
                  finalizer: effectHelper(
                    ensured.finalizer,
                    scope,
                    error,
                    `${path}.stream.finalizer`,
                  ),
                };
              const input = ArrayType.of(n.stream.item);
              const chunk = Symbol("reffect/stream/chunk");
              const chunkScope = caseScope(scope, chunk, input);
              const encode = Expr.arrayLoop(
                { _tag: "Map" },
                ArrayType.of(UnknownType),
                Expr.parameter(input, chunk, 0),
                n.item,
                Symbol("reffect/stream/index"),
                n.encoded,
              );
              return {
                _tag: "StreamCollect",
                plan: planStream(n.stream, `${path}.stream`),
                item: n.stream.item,
                error: n.stream.error,
                emit: {
                  chunk: chunkScope.input[chunkScope.input.length - 1].name,
                  input,
                  transform: block(encode, chunkScope, `${path}.encoded`),
                },
              };
            },
            Map: (n): HelperBody => ({
              _tag: "Map",
              source: effectHelper(n.source, scope, error, `${path}.source`),
              binder: `b${index}`,
              block: block(
                n.body,
                nestedScope(scope, n.binder, n.source.output, index),
                `${path}.body`,
              ),
            }),
            FlatMap: (n): HelperBody => ({
              _tag: "FlatMap",
              source: effectHelper(n.source, scope, error, `${path}.source`),
              binder: `b${index}`,
              body: effectHelper(
                n.body,
                nestedScope(scope, n.binder, n.source.output, index),
                error,
                `${path}.body`,
              ),
            }),
            Match: (n): HelperBody => ({
              _tag: "Match",
              condition: block(n.condition, scope, `${path}.condition`),
              onTrue: effectHelper(n.onTrue, scope, error, `${path}.onTrue`),
              onFalse: effectHelper(n.onFalse, scope, error, `${path}.onFalse`),
            }),
            ForEach: (n): HelperBody => {
              const item = arrayItem(n.source.type)!;
              const withItem = caseScope(scope, n.item, item);
              const loopScope = caseScope(withItem, n.index, U64Type);
              const [itemName, indexName] = loopScope.input
                .slice(scope.input.length)
                .map((p) => p.name);
              return {
                _tag: "ForEach",
                source: block(n.source, scope, `${path}.source`),
                item: itemName,
                index: indexName,
                itemCopy: item.traits.includes(Traits.Copyable),
                helper: effectHelper(n.body, loopScope, error, `${path}.body`),
                discard: n.discard,
              };
            },
            MatchTags: (n): HelperBody => {
              const caseTypes = unionCases(n.value.type) ?? [];
              return {
                _tag: "MatchTags",
                union: n.value.type,
                scrutinee: block(n.value, scope, `${path}.value`),
                cases: n.cases.map((c, i) => {
                  const caseType = caseTypes.find((t) => structLayout(t)?.tag === c.tag)!;
                  const nested = caseScope(scope, c.binder, caseType);
                  return Object.freeze({
                    tag: c.tag,
                    binder: nested.input[nested.input.length - 1].name,
                    helper: effectHelper(c.body, nested, error, `${path}.cases[${i}]`),
                  });
                }),
              };
            },
            Log: (n): HelperBody => ({
              _tag: "Log",
              level: n.level,
              message: n.message,
              attributes: Object.freeze(
                n.attributes.map(([key, value]) =>
                  Object.freeze({
                    key,
                    type: value.type,
                    block: block(value, scope, `${path}.attributes.${key}`),
                  }),
                ),
              ),
            }),
            Annotate: (n): HelperBody => ({
              _tag: "Annotate",
              key: n.key,
              type: n.value.type,
              value: block(n.value, scope, `${path}.value`),
              body: effectHelper(n.body, scope, error, `${path}.body`),
            }),
            Span: (n): HelperBody => ({
              _tag: "Span",
              label: n.label,
              body: effectHelper(n.body, scope, error, `${path}.body`),
            }),
          }),
        );
        helpers.set(
          index,
          Object.freeze({
            index,
            files: scope.fileInputs,
            asynchronous: Match.value(body).pipe(
              Match.tagsExhaustive({
                StreamCollect: (n) => n.emit !== undefined || planSuspends(n.plan),
                TaskGroup: () => true,
                Scope: () => true,
                AddFinalizer: () => true,
                AcquireRelease: () => true,
                RegisteredFile: () => true,
                Pure: () => false,
                Succeed: () => false,
                Fail: () => false,
                Log: () => false,
                Sleep: () => true,
                Launch: () => true,
                RemoteStore: () => true,
                Repeat: () => true,
                Retry: () => true,
                FileScope: () => true,
                ClockReadMillis: () => false,
                RandomDraw: () => false,
                RefScope: (n) => helpers.get(n.body)?.asynchronous ?? false,
                RefGet: () => false,
                RefModify: () => false,
                FileSize: () => false,
                Ensuring: () => true,
                AcquireUseRelease: () => true,
                Map: (n) => helpers.get(n.source)?.asynchronous ?? false,
                CatchAll: (n) =>
                  !!(helpers.get(n.source)?.asynchronous || helpers.get(n.body)?.asynchronous),
                FlatMap: (n) =>
                  !!(helpers.get(n.source)?.asynchronous || helpers.get(n.body)?.asynchronous),
                Match: (n) =>
                  !!(helpers.get(n.onTrue)?.asynchronous || helpers.get(n.onFalse)?.asynchronous),
                MatchTags: (n) => n.cases.some((c) => helpers.get(c.helper)?.asynchronous),
                ForEach: (n) => helpers.get(n.helper)?.asynchronous ?? false,
                Annotate: (n) => helpers.get(n.body)?.asynchronous ?? false,
                Span: (n) => helpers.get(n.body)?.asynchronous ?? false,
              }),
            ),
            origin: provenance?.origin(c),
            path,
            input: scope.input,
            output: c.output,
            error,
            body: Object.freeze(body),
          }),
        );
        return index;
      };
      const node: RustFunction["node"] =
        f instanceof EffectFn
          ? Object.freeze({
              _tag: "Effect",
              root: effectHelper(f.body, rootScope, f.error, `${path}.body`),
              error: f.error,
            })
          : Object.freeze({ _tag: "Pure", block: block(f.body, rootScope, `${path}.body`) });
      const clock =
        runtimeServices.clock === "InjectedMillis" &&
        Array.from(helpers.values()).some((h) => h.body._tag === "ClockReadMillis");
      const random = Array.from(helpers.values()).some((h) => h.body._tag === "RandomDraw");
      if (random && runtimeServices.random !== "ScriptedRandom")
        throw fail(
          "MISSING_RUNTIME_SERVICE",
          "lower",
          path,
          "Random requires explicit ScriptedRandom implementation selection",
        );
      return Object.freeze({
        services: Object.freeze({ clock, random }),
        name,
        asynchronous: Match.value(node).pipe(
          Match.tagsExhaustive({
            Pure: () => false,
            Effect: (n) => helpers.get(n.root)?.asynchronous ?? false,
          }),
        ),
        path,
        origin: provenance?.origin(f),
        input: f.input,
        output: f.output,
        helpers: Object.freeze(Array.from(helpers.values()).sort((a, b) => a.index - b.index)),
        node,
      });
    }),
  );
  return provenance
    ? Object.freeze({
        failureFrames,
        runtimeServices,
        sourceArtifacts: SourceArtifacts.Full,
        provenance: provenance.snapshot(),
        functions,
      })
    : Object.freeze({
        failureFrames,
        runtimeServices,
        sourceArtifacts: SourceArtifacts.None,
        functions,
      });
}

const rsSegments = (...names: string[]) => names.map((name) => Rs.ident(name));
const identExpr = (name: string) => Rs.identExpr(Rs.ident(name));
const stdCellPath = rsSegments("std", "cell");
const refCellPath = [...stdCellPath, Rs.ident("RefCell")];
const refCellOf = (inner: RsType) => Rs.genericType(Rs.pathType(refCellPath), [inner]);
const newCall = (path: ReturnType<typeof rsSegments>, args: readonly RsExpr[]) =>
  Rs.pathCall(path, Rs.ident("new"), args);

/** The bounded array lives behind a failure-only handle, keeping helper Results compact. */
const framePrelude = (synchronous: boolean) =>
  Rs.itemsText(
    [
      Rs.constItem(Rs.ident("MAX_LOGICAL_FRAMES"), Rs.usizeType(), Rs.litInt(maxLogicalFrames)),
      Rs.verbatimItem(frameTrailRuntime),
      ...(synchronous ? [Rs.verbatimItem(syncFrameStorageRuntime)] : []),
    ],
    "\n",
  );
/** JSON string literal; lone surrogates become \u escapes, keeping Rust sources valid UTF-8. */
const jsonString = (text: string): RsExpr => Rs.verbatimExpr(`"${escapeJsonContent(text)}"`);
const rustString = (text: string): RsExpr => Rs.stringLiteral(text);
const attrVariant = (type: IRType<unknown>): ReturnType<typeof Rs.ident> => {
  if (IRType.same(type, BoolType)) return Rs.ident("Bool");
  if (IRType.same(type, U64Type)) return Rs.ident("U64");
  throw fail(
    "UNSUPPORTED_REPRESENTATION",
    "lower",
    "log-attribute",
    "Log attributes require Boolean or u64 witnesses",
  );
};
/** Logging scopes and records; success paths never emit. No dependencies. */
const logPrelude = Rs.itemsText(
  [
    Rs.withAttributes(
      [Rs.deriveAttribute(Rs.ident("Clone"), Rs.ident("Copy"))],
      Rs.enumItem(Rs.ident("LogAttr"), [
        { name: Rs.ident("Bool"), fields: [Rs.boolType()] },
        { name: Rs.ident("U64"), fields: [Rs.u64Type()] },
      ]),
    ),
    Rs.constItem(Rs.ident("MIN_LOG_LEVEL"), Rs.u8Type(), Rs.litInt(2)),
    Rs.fnItem(
      Rs.ident("log_attr_json"),
      [
        { name: Rs.ident("value"), type: Rs.namedType("LogAttr") },
        { name: Rs.ident("out"), type: Rs.mutRefType(Rs.stringType()) },
      ],
      Rs.unitType(),
      Rs.block(
        [],
        Rs.matchBlock(
          identExpr("value"),
          [
            {
              pat: Rs.variantPat(rsSegments("LogAttr", "Bool"), [Rs.identPat(Rs.ident("b"))]),
              body: Rs.dotCall(identExpr("out"), Rs.ident("push_str"), [
                Rs.if_(
                  identExpr("b"),
                  Rs.inlineBlock(Rs.stringLiteral("true")),
                  Rs.inlineBlock(Rs.stringLiteral("false")),
                ),
              ]),
            },
            {
              pat: Rs.variantPat(rsSegments("LogAttr", "U64"), [Rs.identPat(Rs.ident("n"))]),
              body: Rs.inlineStmtBlock(
                Rs.stmt(Rs.dotCall(identExpr("out"), Rs.ident("push"), [Rs.litChar('"')])),
                Rs.stmt(
                  Rs.dotCall(identExpr("out"), Rs.ident("push_str"), [
                    Rs.prefix("&", Rs.dotCall(identExpr("n"), Rs.ident("to_string"), [])),
                  ]),
                ),
                Rs.stmt(Rs.dotCall(identExpr("out"), Rs.ident("push"), [Rs.litChar('"')])),
              ),
            },
          ],
          { indent: 4 },
        ),
      ),
    ),
    Rs.threadLocalItem([
      {
        name: Rs.ident("LOG_ANNOS"),
        type: refCellOf(Rs.vecType(Rs.tupleType([Rs.strRefType(), Rs.namedType("LogAttr")]))),
        value: newCall(refCellPath, [newCall(rsSegments("Vec"), [])]),
      },
      {
        name: Rs.ident("LOG_SPANS"),
        type: refCellOf(
          Rs.vecType(
            Rs.tupleType([Rs.strRefType(), Rs.pathType(rsSegments("std", "time", "Instant"))]),
          ),
        ),
        value: newCall(refCellPath, [newCall(rsSegments("Vec"), [])]),
      },
    ]),
    Rs.verbatimItem(String.raw`
thread_local! { static LOG_CONTEXT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }
struct LogContextGuard(Option<String>);
impl Drop for LogContextGuard {
    fn drop(&mut self) { LOG_CONTEXT.with(|scope| *scope.borrow_mut() = self.0.take()); }
}
/// Lexical synchronous context only; returning a future does not install context during its polls.
pub fn with_log_context<T>(context: String, f: impl FnOnce() -> T) -> T {
    let _guard = LogContextGuard(LOG_CONTEXT.with(|scope| scope.replace(Some(context))));
    f()
}`),
  ],
  "\n",
);
const logLevelOrdinal: Readonly<Record<string, number>> = Object.freeze({
  Trace: 0,
  Debug: 1,
  Info: 2,
  Warn: 3,
  Error: 4,
  Fatal: 5,
});
const frameLiteral = (
  functionName: string,
  path: string,
  kind: string,
  origin: string | undefined,
): RsExpr => {
  const json =
    '{"function":"' +
    escapeJsonContent(functionName) +
    '","path":"' +
    escapeJsonContent(path) +
    '","kind":"' +
    escapeJsonContent(kind) +
    '"' +
    (origin === undefined ? "" : ',"origin":"' + escapeJsonContent(origin) + '"') +
    "}";
  return Rs.stringLiteral(json);
};

export const emitFunctions = (
  module: LoweredModule,
): { readonly files: GeneratedFiles["files"]; readonly ranges: readonly GeneratedRange[] } => {
  const uses = module.provenance
    ? new Map(module.provenance.occurrences.map((use) => [use.path, use.id]))
    : undefined;
  const useAt = (path: string) => uses?.get(path);
  const writer = new SourceWriter("src/lib.rs", !SourceArtifacts.isNone(module.sourceArtifacts));
  // Set when a reachable witness renders as serde_json::Value (UNK-003).
  let usesJson = false;
  const rsTypeOf = (type: IRType<unknown>): RsType => {
    const content = refContent(type);
    if (content) return rsTypeOf(content);
    if (IRType.same(type, U64Type)) return Rs.namedType("u64");
    if (IRType.same(type, BoolType)) return Rs.namedType("bool");
    if (IRType.same(type, UnitType)) return Rs.unitType();
    if (IRType.same(type, StringType)) return Rs.stringType();
    if (IRType.same(type, NumberType)) return Rs.namedType("f64");
    if (IRType.same(type, UnknownType)) {
      usesJson = true;
      return Rs.pathType([Rs.ident("serde_json"), Rs.ident("Value")]);
    }
    if (type.layout)
      return Match.value(type.layout).pipe(
        Match.tag("Array", (array) => Rs.genericType(Rs.namedType("Vec"), [rsTypeOf(array.item)])),
        Match.tag("UndefinedOr", (option) =>
          Rs.genericType(Rs.namedType("Option"), [rsTypeOf(option.item)]),
        ),
        Match.tag("Record", (record) =>
          Rs.genericType(Rs.namedType("Vec"), [
            Rs.tupleType([Rs.stringType(), rsTypeOf(record.value)]),
          ]),
        ),
        Match.orElse(() => Rs.namedType(type.native.type)),
      );
    if (IRType.same(type, NeverType))
      return Rs.pathType([Rs.ident("std"), Rs.ident("convert"), Rs.ident("Infallible")]);
    throw fail(
      "UNSUPPORTED_REPRESENTATION",
      "lower",
      "type",
      "Only canonical witnesses have native types",
    );
  };
  const typeName = (type: IRType<unknown>) => rsTypeOf(type).text;
  const copyable = (type: IRType<unknown>) => type.traits.includes(Traits.Copyable);
  const casesOf = (union: IRType<unknown>) => unionCases(union) ?? [];
  const caseOf = (union: IRType<unknown>, tag: string) =>
    casesOf(union).find((c) => structLayout(c)?.tag === tag)!;
  const variantOf = (union: IRType<unknown>, tag: string) =>
    rustVariantName(
      tag,
      casesOf(union).findIndex((c) => structLayout(c)?.tag === tag),
    );
  // Helpers borrow non-Copy values from their caller; scalars stay by value (REC-004).
  // Read-only helpers take slices for arrays (architecture §15) and `&str` for strings.
  const helperParameterType = (type: IRType<unknown>): string => {
    const content = refContent(type);
    if (content) return Rs.mutRefType(rsTypeOf(content)).text;
    if (copyable(type)) return typeName(type);
    if (IRType.same(type, StringType)) return "&str";
    const item = arrayItem(type);
    return item ? `&[${typeName(item)}]` : `&${typeName(type)}`;
  };
  // `&name` coerces from an owned value or an existing borrow alike.
  const helperArgument = (p: { readonly name: string; readonly type: IRType<unknown> }) =>
    refContent(p.type)
      ? Rs.mutRefExpr(Rs.prefix("*", Rs.identExpr(Rs.ident(p.name)))).text
      : copyable(p.type)
        ? Rs.ident(p.name).text
        : `&${Rs.ident(p.name).text}`;
  const write = (text: string | { readonly text: string }) =>
    writer.write(typeof text === "string" ? text : text.text);
  const hasEffect = module.functions.some((f) => f.node._tag === "Effect");
  const captureFrames = !FailureFrames.isNone(module.failureFrames);
  if (hasEffect && captureFrames)
    write(framePrelude(module.functions.some((f) => f.node._tag === "Effect" && !f.asynchronous)));
  const hasLogScopes = module.functions.some((f) =>
    f.helpers.some(
      (h) => h.body._tag === "Log" || h.body._tag === "Annotate" || h.body._tag === "Span",
    ),
  );
  if (hasLogScopes) write(logPrelude);
  const hasAsync = module.functions.some((f) => f.asynchronous);
  const serviceUsage = (asynchronous: boolean): RuntimeServiceUsage => ({
    clock: module.functions.some((f) => f.asynchronous === asynchronous && f.services.clock),
    random: module.functions.some((f) => f.asynchronous === asynchronous && f.services.random),
  });
  const syncServices = serviceUsage(false);
  const asyncServices = serviceUsage(true);
  const hasSyncServices = syncServices.clock || syncServices.random;
  const hasClockReads = module.functions.some((f) =>
    f.helpers.some((h) => h.body._tag === "ClockReadMillis"),
  );
  if (hasClockReads || syncServices.random || asyncServices.random)
    write(
      runtimeServicesPrelude(
        hasClockReads,
        syncServices.clock || asyncServices.clock,
        syncServices.random || asyncServices.random,
        syncServices,
      ),
    );
  const registrations = module.functions.flatMap((f, functionIndex) =>
    f.helpers.flatMap((helper) => {
      const cleanup = Match.value(helper.body).pipe(
        Match.tags({
          AddFinalizer: (n) => n.finalizer,
          AcquireRelease: (n) => n.release,
          RegisteredFile: (n) => n.afterClose,
        }),
        Match.orElse(() => undefined),
      );
      return cleanup === undefined
        ? []
        : [
            {
              f,
              helper,
              cleanup: f.helpers[cleanup],
              variant: Rs.ident(`F${functionIndex}H${helper.index}`),
              file: helper.body._tag === "RegisteredFile",
            },
          ];
    }),
  );
  const registrationByHelper = new Map(
    registrations.map((registration) => [registration.helper, registration]),
  );
  // Repetition reuses frames; only simultaneously nested lexical Scope nodes add depth.
  const scopeDepth = Math.max(
    0,
    ...module.functions.map((f) => {
      const memo = new Map<number, number>();
      const depth = (index: number): number => {
        const cached = memo.get(index);
        if (cached !== undefined) return cached;
        const child = (...children: number[]) => Math.max(0, ...children.map(depth));
        const result = Match.value(f.helpers[index].body).pipe(
          Match.tagsExhaustive({
            StreamCollect: () => 0,
            TaskGroup: (n) => child(...n.children),
            Scope: (n) => 1 + depth(n.body),
            AddFinalizer: () => 0,
            AcquireRelease: (n) => depth(n.acquire),
            RegisteredFile: (n) => depth(n.body),
            FileScope: (n) => child(n.body, n.afterClose),
            ClockReadMillis: () => 0,
            RandomDraw: () => 0,
            RefScope: (n) => depth(n.body),
            RefGet: () => 0,
            RefModify: () => 0,
            FileSize: () => 0,
            AcquireUseRelease: (n) => child(n.acquire, n.use, n.release),
            Ensuring: (n) => child(n.body, n.finalizer),
            CatchAll: (n) => child(n.source, n.body),
            FlatMap: (n) => child(n.source, n.body),
            Map: (n) => depth(n.source),
            Match: (n) => child(n.onTrue, n.onFalse),
            MatchTags: (n) => child(...n.cases.map((c) => c.helper)),
            ForEach: (n) => depth(n.helper),
            Annotate: (n) => depth(n.body),
            Span: (n) => depth(n.body),
            Repeat: (n) => depth(n.body),
            Retry: (n) => depth(n.body),
            Pure: () => 0,
            Succeed: () => 0,
            Fail: () => 0,
            Log: () => 0,
            Sleep: () => 0,
            Launch: () => 0,
            RemoteStore: () => 0,
          }),
        );
        memo.set(index, result);
        return result;
      };
      return f.node._tag === "Effect" ? depth(f.node.root) : 0;
    }),
  );
  if (scopeDepth) {
    write(
      Rs.enumItem(
        Rs.ident("ScopeFinalizer"),
        registrations.length
          ? registrations.map((r) => ({
              name: r.variant,
              fields: r.cleanup.input
                .map((p) => rsTypeOf(p.type))
                .concat(
                  r.file
                    ? [
                        Rs.genericType(Rs.namedType("Option"), [
                          Rs.pathType(rsSegments("std", "fs", "File")),
                        ]),
                      ]
                    : [],
                ),
            }))
          : [{ name: Rs.ident("Unreachable"), fields: [rsTypeOf(NeverType)] }],
      ),
    );
    write("\n");
  }
  // One server-lifetime hold per module; its values cross to the host as one owned tuple.
  const launches = module.functions.flatMap((f) =>
    f.helpers.flatMap((helper) =>
      Match.value(helper.body).pipe(
        Match.tag("Launch", (n) => [n.types]),
        Match.orElse(() => []),
      ),
    ),
  );
  const launchTypes = launches[0];
  if (
    launches.some(
      (types) =>
        types.length !== launchTypes!.length ||
        types.some((type, i) => !IRType.same(type, launchTypes![i])),
    )
  )
    throw fail("LAUNCH_SIGNATURE", "lower", "launch", "Launch holds must publish one tuple shape");
  const launchTuple = launchTypes
    ? `(${launchTypes.map((type) => `${rsTypeOf(type).text}, `).join("")})`
    : undefined;
  const usesStore = module.functions.some((f) =>
    f.helpers.some((helper) =>
      Match.value(helper.body).pipe(
        Match.tag("RemoteStore", () => true),
        Match.orElse(() => false),
      ),
    ),
  );
  const usesStreams = module.functions.some((f) =>
    f.helpers.some((helper) =>
      Match.value(helper.body).pipe(
        Match.tag("StreamCollect", (n) => n.emit !== undefined),
        Match.orElse(() => false),
      ),
    ),
  );
  const taskArities = module.functions.flatMap((f) =>
    f.helpers.flatMap((helper) =>
      Match.value(helper.body).pipe(
        Match.tag("TaskGroup", (n) => [n.children.length]),
        Match.orElse(() => []),
      ),
    ),
  );
  if (hasAsync)
    write(
      asyncRuntime(
        hasLogScopes,
        captureFrames,
        scopeDepth,
        maxScopeFinalizers,
        launchTuple,
        usesStore,
        asyncServices,
        taskArities.length > 0,
        usesStreams,
      ),
    );
  if (taskArities.length) write(structuredRuntime(taskArities));
  writeCompositeTypes(module, write, typeName);
  for (const f of module.functions) {
    const contextual = f.asynchronous || f.services.clock || f.services.random;
    const contextType = f.asynchronous ? "AsyncContext" : "SyncContext";
    const record = (helper: Helper): string => {
      const registration = registrationByHelper.get(helper)!;
      return Rs.pathCall(
        rsSegments("ScopeFinalizer"),
        registration.variant,
        registration.cleanup.input
          .map((p) => identExpr(p.name))
          .concat(registration.file ? [identExpr("None")] : []),
      ).text;
    };
    const callText = (index: number): string => {
      const helper = f.helpers[index];
      const call = Rs.call(
        Rs.identExpr(Rs.ident(`h_${f.name}_${helper.index}`)),
        (contextual && helper.error ? [identExpr("ctx")] : []).concat(
          helper.input.map((p) => Rs.verbatimExpr(helperArgument(p))),
          helper.files.map((name) => Rs.refExpr(identExpr(name))),
        ),
      );
      return helper.asynchronous ? Rs.await(call).text : call.text;
    };
    const callFrag = (index: number, occurrence?: string): MappedFragment =>
      mapFragment(f.helpers[index].origin, occurrence, textFragment(callText(index)));
    const adaptFrag = (index: number, output: IRType<unknown>, occurrence?: string) => {
      if (IRType.same(f.helpers[index].output, NeverType) && !IRType.same(output, NeverType))
        return joinFragments([
          "match ",
          callFrag(index, occurrence),
          " { Ok(value) => match value {}, Err(error) => Err(error) }",
        ]);
      return callFrag(index, occurrence);
    };
    // Non-Copy values (STR-002, REC-004): names are borrows and computed locals are owned.
    // Operands borrow; value positions take an owned copy; literals render as `&'static str`.
    const operand = (e: RustExpr): MappedFragment =>
      !e.owned
        ? render(e)
        : Match.value(e).pipe(
            Match.tags({
              Local: (n) => joinFragments(["&", render(n, undefined, true)]),
              Field: (n) => joinFragments(["&", render(n, undefined, true)]),
            }),
            Match.orElse((n) => render(n, undefined, true)),
          );
    const render = (e: RustExpr, role?: GeneratedRange["role"], plain = false): MappedFragment =>
      e.owned && !plain
        ? Match.value(e).pipe(
            Match.tag("Literal", (n) =>
              joinFragments(["String::from(", render(n, role, true), ")"]),
            ),
            Match.tags({
              Parameter: (n) => joinFragments([render(n, role, true), ".to_owned()"]),
              Bound: (n) => joinFragments([render(n, role, true), ".to_owned()"]),
              Local: (n) => joinFragments([render(n, role, true), ".clone()"]),
              Field: (n) => joinFragments(["(", render(n, role, true), ").clone()"]),
            }),
            Match.orElse((n) => render(n, role, true)),
          )
        : mapFragment(
            e.origin,
            e.occurrence,
            Match.value(e).pipe(
              Match.tagsExhaustive({
                Parameter: (n) => textFragment(Rs.ident(`p${n.index}`).text),
                Bound: (n) => textFragment(Rs.ident(n.name).text),
                Local: (n) => textFragment(Rs.ident(`v${n.index}`).text),
                ArrayMake: (n) =>
                  n.elements.length === 0
                    ? textFragment("Vec::new()")
                    : joinFragments([
                        "vec![",
                        ...n.elements.flatMap((element, i) =>
                          i ? [", ", render(element)] : [render(element)],
                        ),
                        "]",
                      ]),
                ArrayLength: (n) => joinFragments(["((", operand(n.value), ").len() as u64)"]),
                ArrayLoop: (n) => {
                  const item = Rs.ident(n.item).text;
                  const index = Rs.ident(n.index).text;
                  const header = ["{ let source = ", operand(n.source), "; "];
                  const loop = `for (${index}, ${item}) in source.iter().enumerate() { let ${index}: u64 = ${index} as u64; ${n.itemCopy ? `let ${item} = *${item}; ` : ""}`;
                  const call = callFrag(n.helper, n.use);
                  const owned = n.itemCopy ? item : `${item}.clone()`;
                  return Match.value(n.op).pipe(
                    Match.when("Map", () =>
                      joinFragments([
                        ...header,
                        "let mut out = Vec::with_capacity(source.len()); ",
                        loop,
                        "out.push(",
                        call,
                        "); } out }",
                      ]),
                    ),
                    Match.when("Filter", () =>
                      joinFragments([
                        ...header,
                        "let mut out = Vec::new(); ",
                        loop,
                        "if ",
                        call,
                        ` { out.push(${owned}); } } out }`,
                      ]),
                    ),
                    Match.when("Reduce", () => {
                      const acc = Rs.ident(n.accumulator!).text;
                      return joinFragments([
                        ...header,
                        `let mut ${acc} = `,
                        render(n.init!),
                        "; ",
                        loop,
                        `${acc} = `,
                        call,
                        `; } ${acc} }`,
                      ]);
                    }),
                    Match.exhaustive,
                  );
                },
                // Places auto-deref through borrowed names.
                Field: (n) => joinFragments([render(n.base, undefined, true), `.${n.field}`]),
                Make: (n) => {
                  const layout = structLayout(n.type, n.tag)!;
                  const names = rustFieldNames(layout);
                  const caseType = n.tag === undefined ? n.type : caseOf(n.type, n.tag);
                  const body = joinFragments([
                    `${typeName(caseType)} { `,
                    ...n.fields.flatMap((field, i) => [
                      `${names[i]}: `,
                      Match.value(field.wrap).pipe(
                        Match.when("Plain", () => render(field.value!)),
                        Match.when("None", () => textFragment("None")),
                        Match.when("Some", () =>
                          joinFragments(["Some(", render(field.value!), ")"]),
                        ),
                        Match.when("SomeSome", () =>
                          joinFragments(["Some(Some(", render(field.value!), "))"]),
                        ),
                        Match.exhaustive,
                      ),
                      ", ",
                    ]),
                    "}",
                  ]);
                  return n.tag === undefined
                    ? body
                    : joinFragments([
                        `${typeName(n.type)}::${variantOf(n.type, n.tag)}(`,
                        body,
                        ")",
                      ]);
                },
                MatchTags: (n) =>
                  joinFragments([
                    "match ",
                    operand(n.scrutinee),
                    " { ",
                    ...n.cases.flatMap((c) => [
                      `${typeName(n.union)}::${variantOf(n.union, c.tag)}(${Rs.ident(c.binder).text}) => `,
                      callFrag(c.helper, c.use),
                      ", ",
                    ]),
                    "}",
                  ]),
                MatchUndefined: (n) => {
                  const binder = Rs.ident(n.binder).text;
                  return joinFragments([
                    "match ",
                    operand(n.scrutinee),
                    ` { Some(${binder}) => { ${n.itemCopy ? `let ${binder} = *${binder}; ` : ""}`,
                    callFrag(n.onDefined, n.onDefinedUse),
                    " } None => ",
                    callFrag(n.onUndefined, n.onUndefinedUse),
                    ", }",
                  ]);
                },
                Defined: (n) => joinFragments(["Some(", render(n.value), ")"]),
                Undefined: () => textFragment("None"),
                Variant: (n) => textFragment(n.text),
                RecordQuery: (n) =>
                  Match.value(n.query).pipe(
                    Match.when("Keys", () =>
                      joinFragments([
                        "(",
                        operand(n.source),
                        ").iter().map(|(key, _)| key.clone()).collect::<Vec<String>>()",
                      ]),
                    ),
                    Match.when("Values", () =>
                      joinFragments([
                        "(",
                        operand(n.source),
                        ").iter().map(|(_, value)| value.clone()).collect::<Vec<_>>()",
                      ]),
                    ),
                    Match.when("Size", () =>
                      joinFragments(["((", operand(n.source), ").len() as f64)"]),
                    ),
                    Match.when("Has", () =>
                      joinFragments([
                        "{ let needle: &str = ",
                        operand(n.key!),
                        "; (",
                        operand(n.source),
                        ").iter().any(|(key, _)| key.as_str() == needle) }",
                      ]),
                    ),
                    Match.exhaustive,
                  ),
                Flatten: (n) =>
                  joinFragments([render(n.base, undefined, true), ".clone().flatten()"]),
                Literal: (n) => {
                  if (Predicate.isUndefined(n.value)) return textFragment(Rs.litUnit().text);
                  if (Predicate.isBigInt(n.value)) return textFragment(Rs.litU64(n.value).text);
                  if (Predicate.isBoolean(n.value)) return textFragment(Rs.litBool(n.value).text);
                  if (Predicate.isString(n.value))
                    return textFragment(Rs.stringLiteral(n.value).text);
                  // Bit patterns keep NaN, infinities and -0 exact.
                  if (Predicate.isNumber(n.value))
                    return textFragment(`f64::from_bits(0x${f64Bits(n.value)})`);
                  throw fail(
                    "UNSUPPORTED_REPRESENTATION",
                    "lower",
                    "literal",
                    "Literals require Boolean, u64 or Unit witnesses",
                  );
                },
                Call: (n) => {
                  if (n.method === "not") return joinFragments(["!(", operand(n.args[0]), ")"]);
                  if (n.method === "concat")
                    return joinFragments([
                      'format!("{}{}", ',
                      operand(n.args[0]),
                      ", ",
                      operand(n.args[1]),
                      ")",
                    ]);
                  if (n.method === "json")
                    return joinFragments([
                      `crate::reffect_json::${Rs.ident(n.encoder!).text}(&(`,
                      operand(n.args[0]),
                      "))",
                    ]);
                  if (n.method === "add")
                    return joinFragments([
                      "(",
                      operand(n.args[0]),
                      ") + (",
                      operand(n.args[1]),
                      ")",
                    ]);
                  if (n.method === "eq" || n.method === "lt")
                    return joinFragments([
                      "(",
                      operand(n.args[0]),
                      n.method === "eq" ? ") == (" : ") < (",
                      operand(n.args[1]),
                      ")",
                    ]);
                  return joinFragments([
                    "(",
                    operand(n.args[0]),
                    `).${Rs.ident(n.method).text}(`,
                    ...n.args
                      .slice(1)
                      .flatMap((arg, i) => (i ? [", ", operand(arg)] : [operand(arg)])),
                    ")",
                  ]);
                },
                Match: (n) =>
                  joinFragments([
                    "if ",
                    render(n.condition),
                    " { ",
                    callFrag(n.onTrue, n.onTrueUse),
                    " } else { ",
                    callFrag(n.onFalse, n.onFalseUse),
                    " }",
                  ]),
              }),
            ),
            role,
          );
    const refPlaceholder = Rs.identExpr(Rs.ident("__reffect_ref_expression"));
    // Typed binding syntax surrounds the original mapped expression, preserving its byte ranges.
    const refBindingFragment = (statement: RsStmt, expression: MappedFragment): MappedFragment => {
      const [before, after] = statement.text.split(refPlaceholder.text);
      return joinFragments([before, expression, after]);
    };
    const renderBlock = (block: RustBlock): MappedFragment => {
      const parts: Array<string | MappedFragment> = ["{\n"];
      for (const binding of block.bindings) {
        parts.push(`    let ${Rs.ident(`v${binding.index}`).text}: `);
        parts.push(
          mapFragment(
            binding.value.origin,
            binding.value.occurrence,
            textFragment(typeName(binding.type)),
            "definition",
          ),
        );
        parts.push(" = ");
        parts.push(render(binding.value, "definition"));
        parts.push(";\n");
      }
      parts.push("    ");
      // A block's final expression runs after every operand borrow, so an owned local moves (§17).
      parts.push(
        render(
          block.body,
          undefined,
          Match.value(block.body).pipe(
            Match.tag("Local", () => true),
            Match.orElse(() => false),
          ),
        ),
      );
      parts.push("\n}");
      return joinFragments(parts);
    };
    const errorType = (error: IRType<unknown>) =>
      f.asynchronous
        ? Rs.genericType(Rs.namedType("AsyncError"), [rsTypeOf(error)])
        : rsTypeOf(error);
    const resultType = (output: IRType<unknown>, error?: IRType<unknown>) =>
      error ? Rs.resultType(rsTypeOf(output), errorType(error)).text : rsTypeOf(output).text;
    // Internal helpers carry bounded frames with the error. Public functions stash
    // them in the synchronous thread owner or the explicit async context.
    const tracedType = (output: IRType<unknown>, error: IRType<unknown>) =>
      captureFrames
        ? Rs.resultType(
            rsTypeOf(output),
            Rs.tupleType([
              errorType(error),
              Rs.genericType(Rs.namedType("Box"), [Rs.namedType("FrameTrail")]),
            ]),
          ).text
        : resultType(output, error);
    const frameOf = (helper: Helper, kind: string): RsExpr =>
      frameLiteral(f.name, helper.path, kind, helper.origin);
    const entryFrameKind = (body: HelperBody): string =>
      Match.value(body).pipe(
        Match.tags({
          TaskGroup: (n) => (n.mode === "All" ? "all" : "race"),
          FlatMap: () => "flatMap",
          CatchAll: () => "catchAll",
          AcquireUseRelease: () => "acquireUseRelease",
          FileScope: () => "fileScope",
          ClockReadMillis: () => "clockReadMillis",
          RandomDraw: () => "randomDraw",
          RefScope: () => "refScope",
          RefGet: () => "refGet",
          RefModify: () => "refModify",
          FileSize: () => "fileSize",
          AddFinalizer: () => "addFinalizer",
          AcquireRelease: () => "acquireRelease",
          RegisteredFile: () => "registeredFile",
        }),
        Match.orElse((node) => node._tag.toLowerCase()),
      );
    const failureArm = (helper: Helper, kind: string, cleanup = ""): string =>
      captureFrames
        ? `Err((error, mut frames)) => { ${cleanup}frames.push(${frameOf(helper, kind).text}); Err((error, frames)) }`
        : `Err(error) => { ${cleanup}Err(error) }`;
    const scheduleContinue = (plan: SchedulePlan, times: number | undefined): string => {
      const parts: string[] = [];
      if (plan._tag === "Recurs") parts.push(`completed < ${Rs.litU64(BigInt(plan.times)).text}`);
      if (times !== undefined) parts.push(`completed < ${Rs.litU64(BigInt(times)).text}`);
      return parts.length ? parts.join(" && ") : "true";
    };
    const scheduleDelay = (plan: SchedulePlan): string =>
      Match.value(plan).pipe(
        Match.tagsExhaustive({
          Recurs: () => "0u64",
          Forever: () => "0u64",
          Spaced: (p) => Rs.litU64(BigInt(p.milliseconds)).text,
          Exponential: (p) =>
            `{ let exp = completed.min(63) as i32; let d = ${p.milliseconds}f64 * (${p.factor}f64).powi(exp); if d >= u64::MAX as f64 { u64::MAX } else { d as u64 } }`,
        }),
      );
    for (const helper of f.helpers) {
      const use = (edge: string) => useAt(`${helper.path}.${edge}`);
      const signature =
        helper.body._tag === "Pure"
          ? resultType(helper.output, helper.error)
          : helper.error
            ? tracedType(helper.output, helper.error)
            : resultType(helper.output, helper.error);
      const helperBody: MappedFragment = Match.value(helper.body).pipe(
        Match.tagsExhaustive({
          TaskGroup: (n) => {
            const race = Rs.litBool(n.mode === "Race");
            const parts: (string | MappedFragment)[] = ["{ "];
            n.children.forEach((_, i) => {
              const channel = Rs.pathCall(
                rsSegments("tokio", "sync", "watch"),
                Rs.ident("channel"),
                [Rs.litBool(false)],
              );
              parts.push(
                `let (cancel${i}, receiver${i}) = ${channel.text}; let mut child${i} = ${Rs.dotCall(identExpr("ctx"), Rs.ident("child_context"), [identExpr(`receiver${i}`), race]).text}; `,
              );
            });
            parts.push(
              "let parent_cancellation = ctx.cancellation.clone(); let parent_interruptible = ctx.interruptible; ",
            );
            n.children.forEach((index, i) => {
              const child = f.helpers[index];
              const call = Rs.call(
                Rs.identExpr(Rs.ident(`h_${f.name}_${child.index}`)),
                [Rs.mutRefExpr(identExpr(`child${i}`))].concat(
                  child.input.map((parameter) => Rs.verbatimExpr(helperArgument(parameter))),
                ),
              );
              parts.push(
                `let future${i} = async { match `,
                mapFragment(
                  child.origin,
                  use(`children[${i}]`),
                  textFragment(child.asynchronous ? Rs.await(call).text : call.text),
                ),
                captureFrames
                  ? " { Ok(()) => true, Err((AsyncError::Fail(never), _frames)) => match never {}, Err((AsyncError::Interrupted, _frames)) => false } }; "
                  : " { Ok(()) => true, Err(AsyncError::Fail(never)) => match never {}, Err(AsyncError::Interrupted) => false } }; ",
              );
            });
            const joined = Rs.await(
              Rs.call(
                identExpr(`task_group${n.children.length}`),
                n.children
                  .flatMap((_, i) => [identExpr(`future${i}`), identExpr(`cancel${i}`)])
                  .concat([
                    identExpr("parent_cancellation"),
                    identExpr("parent_interruptible"),
                    race,
                  ]),
              ),
            );
            parts.push(
              `if ${joined.text} && !ctx.is_cancelled() { Ok(()) } else { `,
              captureFrames
                ? `Err((AsyncError::Interrupted, FrameTrail::new(${frameOf(helper, n.mode === "All" ? "all" : "race").text})))`
                : "Err(AsyncError::Interrupted)",
              " } }",
            );
            return joinFragments(parts);
          },
          Scope: (n) =>
            joinFragments([
              "{ ctx.enter_scope(); let result = ",
              adaptFrag(n.body, helper.output, use("body")),
              "; let saved_interruptible = ctx.interruptible; ctx.interruptible = false; close_scope(ctx).await; ctx.interruptible = saved_interruptible; match result { Ok(value) => { if ctx.is_cancelled() { ",
              captureFrames
                ? `Err((AsyncError::Interrupted, FrameTrail::new(${frameOf(helper, "scope").text})))`
                : "Err(AsyncError::Interrupted)",
              ` } else { Ok(value) } }, ${failureArm(helper, "scope")} } }`,
            ]),
          AddFinalizer: () => textFragment(`{ ctx.register_finalizer(${record(helper)}); Ok(()) }`),
          AcquireRelease: (n) =>
            joinFragments([
              "{ let saved_interruptible = ctx.interruptible; ctx.interruptible = false; let acquired = ",
              callFrag(n.acquire, use("acquire")),
              `; match acquired { Ok(${Rs.ident(n.binder).text}) => { ctx.register_finalizer(${record(helper)}); ctx.interruptible = saved_interruptible; Ok(${Rs.ident(n.binder).text}) }, `,
              failureArm(helper, "acquireRelease", "ctx.interruptible = saved_interruptible; "),
              " } }",
            ]),
          RegisteredFile: (n) => {
            // Reserve order before borrowed use, then transfer the still-local File before unwinding.
            const registration = registrationByHelper.get(helper)!;
            const open = Rs.await(
              Rs.pathCall(rsSegments("tokio", "task"), Rs.ident("spawn_blocking"), [
                Rs.closure0(
                  Rs.pathCall(rsSegments("std", "fs", "File"), Rs.ident("open"), [
                    rustString(n.path),
                  ]),
                ),
              ]),
            );
            const failure = captureFrames
              ? `Err((AsyncError::Fail(false), FrameTrail::new(${frameOf(helper, "registeredFile").text})))`
              : "Err(AsyncError::Fail(false))";
            return joinFragments([
              "{ let saved_interruptible = ctx.interruptible; ctx.interruptible = false; let acquired = ",
              Rs.dotCall(open, Rs.ident("expect"), [rustString("File acquisition task failed")])
                .text,
              `; match acquired { Ok(${Rs.ident(n.file).text}) => { let (scope_index, record_index) = ctx.register_finalizer(${record(helper)}); ctx.interruptible = saved_interruptible; let result = `,
              adaptFrag(n.body, helper.output, use("body")),
              `; match &mut ctx.scopes[scope_index].as_mut().expect("Reserved scope remains open").entries[record_index].as_mut().expect("Reserved file slot remains occupied").finalizer { ScopeFinalizer::${registration.variant.text}(${registration.cleanup.input
                .map(() => "_")
                .concat("owned_file")
                .join(
                  ", ",
                )}) => { *owned_file = Some(${Rs.ident(n.file).text}); }, _ => unreachable!("Reserved file variant is unchanged") } match result { Ok(value) => Ok(value), ${failureArm(helper, "registeredFile")} } }, Err(_) => { ctx.interruptible = saved_interruptible; ${failure} } } }`,
            ]);
          },
          FileScope: (n) => {
            const open = Rs.dotCall(
              Rs.await(
                Rs.pathCall(rsSegments("tokio", "task"), Rs.ident("spawn_blocking"), [
                  Rs.closure0(
                    Rs.pathCall(rsSegments("std", "fs", "File"), Rs.ident("open"), [
                      rustString(n.path),
                    ]),
                  ),
                ]),
              ),
              Rs.ident("expect"),
              [rustString("File acquisition task failed")],
            );
            const ioFailure = captureFrames
              ? Rs.err(
                  Rs.tuple(
                    Rs.pathCall(rsSegments("AsyncError"), Rs.ident("Fail"), [Rs.litBool(false)]),
                    Rs.pathCall(rsSegments("FrameTrail"), Rs.ident("new"), [
                      frameOf(helper, "fileScope"),
                    ]),
                  ),
                )
              : Rs.err(
                  Rs.pathCall(rsSegments("AsyncError"), Rs.ident("Fail"), [Rs.litBool(false)]),
                );
            return joinFragments([
              "{ ",
              Rs.let_(
                Rs.ident("saved_interruptible"),
                undefined,
                Rs.exprTemplate`${identExpr("ctx")}.interruptible`,
              ).text,
              " ctx.interruptible = false; ",
              Rs.let_(Rs.ident("acquired"), undefined, open).text,
              " ctx.interruptible = saved_interruptible; match acquired { Ok(",
              n.file,
              ") => { let result = ",
              adaptFrag(n.body, helper.output, use("body")),
              "; ctx.interruptible = false; ",
              Rs.stmt(Rs.call(identExpr("drop"), [identExpr(n.file)])).text,
              " let cleanup = ",
              callFrag(n.afterClose, use("afterClose")),
              '; ctx.interruptible = saved_interruptible; if cleanup.is_err() { panic!("Non-failing after-close effect returned an error"); } match result { Ok(value) => { if ctx.is_cancelled() { ',
              captureFrames
                ? `Err((AsyncError::Interrupted, FrameTrail::new(${frameOf(helper, "fileScope").text})))`
                : "Err(AsyncError::Interrupted)",
              ` } else { Ok(value) } }, ${failureArm(helper, "fileScope")} } }, Err(_) => `,
              ioFailure.text,
              " } }",
            ]);
          },
          ClockReadMillis: () =>
            textFragment(
              Rs.block(
                [],
                Rs.ok(
                  module.runtimeServices.clock === "InjectedMillis"
                    ? Rs.dotCall(identExpr("ctx"), Rs.ident("clock_millis"), [])
                    : Rs.call(identExpr("live_clock_millis"), []),
                ),
              ).text,
            ),
          RandomDraw: () =>
            textFragment(
              Rs.block([], Rs.ok(Rs.dotCall(identExpr("ctx"), Rs.ident("random_next"), []))).text,
            ),
          RefScope: (n) => {
            const initializer = refBindingFragment(
              Rs.letMut(Rs.ident("ref_slot"), rsTypeOf(n.content), refPlaceholder),
              renderBlock(n.initial),
            );
            const borrow = Rs.let_(
              Rs.ident(n.binder),
              undefined,
              Rs.mutRefExpr(Rs.identExpr(Rs.ident("ref_slot"))),
            );
            return joinFragments([
              "{ ",
              initializer,
              " ",
              borrow.text,
              " match ",
              adaptFrag(n.body, helper.output, use("body")),
              ` { Ok(value) => Ok(value), ${failureArm(helper, "refScope")} } }`,
            ]);
          },
          RefGet: (n) =>
            textFragment(Rs.block([], Rs.ok(Rs.prefix("*", Rs.identExpr(Rs.ident(n.ref))))).text),
          RefModify: (n) => {
            const snapshot = Rs.let_(
              Rs.ident(n.binder),
              rsTypeOf(n.content),
              Rs.prefix("*", Rs.identExpr(Rs.ident(n.ref))),
            );
            const result = refBindingFragment(
              Rs.let_(Rs.ident("ref_result"), undefined, refPlaceholder),
              renderBlock(n.result),
            );
            const next = refBindingFragment(
              Rs.let_(Rs.ident("ref_next"), rsTypeOf(n.content), refPlaceholder),
              renderBlock(n.next),
            );
            const commit = Rs.assign(
              Rs.prefix("*", Rs.identExpr(Rs.ident(n.ref))),
              Rs.identExpr(Rs.ident("ref_next")),
            );
            const success = Rs.call(Rs.identExpr(Rs.ident("Ok")), [
              Rs.identExpr(Rs.ident("ref_result")),
            ]);
            return joinFragments([
              "{ ",
              snapshot.text,
              " ",
              result,
              " ",
              next,
              " ",
              commit.text,
              " ",
              success.text,
              " }",
            ]);
          },
          FileSize: (n) => {
            const metadata = Rs.dotCall(identExpr(n.file), Rs.ident("metadata"), []);
            const error = Rs.pathCall(rsSegments("AsyncError"), Rs.ident("Fail"), [
              Rs.litBool(false),
            ]);
            return textFragment(
              Rs.inlineBlock(
                Rs.match_(metadata, [
                  {
                    pat: Rs.pat("Ok(metadata)"),
                    body: Rs.ok(Rs.dotCall(identExpr("metadata"), Rs.ident("len"), [])),
                  },
                  {
                    pat: Rs.pat("Err(_)"),
                    body: Rs.err(
                      captureFrames
                        ? Rs.tuple(
                            error,
                            Rs.pathCall(rsSegments("FrameTrail"), Rs.ident("new"), [
                              frameOf(helper, "fileSize"),
                            ]),
                          )
                        : error,
                    ),
                  },
                ]),
              ).text,
            );
          },
          Sleep: (n) =>
            joinFragments([
              `{ match ctx.sleep(${Rs.litU64(BigInt(n.milliseconds)).text}).await { Ok(()) => Ok(()), `,
              captureFrames
                ? `Err(error) => Err((error, FrameTrail::new(${frameOf(helper, "sleep").text})))`
                : "Err(error) => Err(error)",
              " } }",
            ]),
          Launch: (n) =>
            joinFragments([
              "{ let error = ctx.launch((",
              ...n.values.flatMap((value) => [renderBlock(value), ", "]),
              ")).await; ",
              captureFrames
                ? `Err((error, FrameTrail::new(${frameOf(helper, "launch").text})))`
                : "Err(error)",
              " }",
            ]),
          // A store operation awaits its session; a failure aborts through the interruption path.
          RemoteStore: (n) =>
            n.op === "Changed" || n.op === "Deleted"
              ? joinFragments([
                  "{ match ctx.remote_live(",
                  ...(n.values
                    ? [
                        "Some((",
                        renderBlock(n.values),
                        ").iter().map(|field| field.to_string()).collect::<Vec<String>>())",
                      ]
                    : ["None"]),
                  `, ${Rs.stringLiteral(n.entity).text}, &(`,
                  renderBlock(n.id),
                  ")).await { Ok(()) => Ok(()), ",
                  captureFrames
                    ? `Err(error) => Err((error, FrameTrail::new(${frameOf(helper, "live hub").text})))`
                    : "Err(error) => Err(error)",
                  " } }",
                ])
              : n.op === "Get"
                ? joinFragments([
                    `{ match ctx.remote_store_get(${Rs.stringLiteral(n.entity).text}, &(`,
                    renderBlock(n.id),
                    ")).await { Ok(row) => Ok(row), ",
                    captureFrames
                      ? `Err(error) => Err((error, FrameTrail::new(${frameOf(helper, "remote store").text})))`
                      : "Err(error) => Err(error)",
                    " } }",
                  ])
                : joinFragments([
                    "{ match ctx.remote_store(",
                    ...(n.values ? ["Some(", renderBlock(n.values), ")"] : ["None"]),
                    `, ${Rs.stringLiteral(n.entity).text}, &(`,
                    renderBlock(n.id),
                    ")).await { Ok(()) => Ok(()), ",
                    captureFrames
                      ? `Err(error) => Err((error, FrameTrail::new(${frameOf(helper, "remote store").text})))`
                      : "Err(error) => Err(error)",
                    " } }",
                  ]),
          Repeat: (n) =>
            joinFragments([
              "{ let mut completed: u64 = 0u64; loop { match ",
              callFrag(n.body, use("body")),
              " { Ok(()) => {}, ",
              captureFrames
                ? `Err((error, mut frames)) => { frames.push(${frameOf(helper, "repeat").text}); return Err((error, frames)); }`
                : "Err(error) => return Err(error),",
              " } if !(",
              scheduleContinue(n.schedule, n.times),
              `) { break Ok(()); } let delay: u64 = ${scheduleDelay(n.schedule)}; if delay > 0 { match ctx.sleep(delay).await { Ok(()) => {}, `,
              captureFrames
                ? `Err(error) => return Err((error, FrameTrail::new(${frameOf(helper, "repeat").text}))),`
                : "Err(error) => return Err(error),",
              " } } completed += 1; } }",
            ]),
          Retry: (n) =>
            joinFragments([
              "{ let mut completed: u64 = 0u64; loop { match ",
              callFrag(n.body, use("body")),
              " { Ok(value) => break Ok(value), ",
              captureFrames
                ? `Err((AsyncError::Interrupted, _frames)) => return Err((AsyncError::Interrupted, FrameTrail::new(${frameOf(helper, "retry").text}))), Err((AsyncError::Fail(error), mut frames)) => { `
                : "Err(AsyncError::Interrupted) => return Err(AsyncError::Interrupted), Err(AsyncError::Fail(error)) => { ",
              `if !(${scheduleContinue(n.schedule, n.times)}) { `,
              captureFrames
                ? `frames.push(${frameOf(helper, "retry").text}); break Err((AsyncError::Fail(error), frames)); }`
                : "break Err(AsyncError::Fail(error)); }",
              ` let delay: u64 = ${scheduleDelay(n.schedule)}; if delay > 0 { match ctx.sleep(delay).await { Ok(()) => {}, `,
              captureFrames
                ? `Err(error) => return Err((error, FrameTrail::new(${frameOf(helper, "retry").text}))),`
                : "Err(error) => return Err(error),",
              " } } completed += 1; } } } }",
            ]),
          CatchAll: (n) => {
            const source = f.helpers[n.source];
            const binder = Rs.ident(n.binder).text;
            const sourceSuccess = IRType.same(source.output, NeverType)
              ? "Ok(value) => match value {}, "
              : "Ok(value) => Ok(value), ";
            const domainPattern = f.asynchronous
              ? captureFrames
                ? `Err((AsyncError::Fail(${binder}), _handled_frames))`
                : `Err(AsyncError::Fail(${binder}))`
              : captureFrames
                ? `Err((${binder}, _handled_frames))`
                : `Err(${binder})`;
            const interrupted = f.asynchronous
              ? captureFrames
                ? `, Err((AsyncError::Interrupted, mut frames)) => { frames.push(${frameOf(helper, "catchAll").text}); Err((AsyncError::Interrupted, frames)) }`
                : ", Err(AsyncError::Interrupted) => Err(AsyncError::Interrupted)"
              : "";
            return joinFragments([
              "{ match ",
              callFrag(n.source, use("source")),
              ` { ${sourceSuccess}${domainPattern} => { ${captureFrames ? "drop(_handled_frames); " : ""}match `,
              adaptFrag(n.body, helper.output, use("body")),
              ` { Ok(value) => Ok(value), ${failureArm(helper, "catchAll")} } }${interrupted} } }`,
            ]);
          },
          AcquireUseRelease: (n) =>
            joinFragments([
              "{ let saved_interruptible = ctx.interruptible; ctx.interruptible = false; let acquired = ",
              callFrag(n.acquire, use("acquire")),
              "; ctx.interruptible = saved_interruptible; match acquired { Ok(",
              Rs.ident(n.binder).text,
              ") => { let result = ",
              adaptFrag(n.use, helper.output, use("use")),
              "; ctx.interruptible = false; let cleanup = ",
              callFrag(n.release, use("release")),
              '; ctx.interruptible = saved_interruptible; if cleanup.is_err() { panic!("Non-failing masked release returned an error"); } match result { Ok(value) => { if ctx.is_cancelled() { ',
              captureFrames
                ? `Err((AsyncError::Interrupted, FrameTrail::new(${frameOf(helper, "acquireUseRelease").text})))`
                : "Err(AsyncError::Interrupted)",
              ` } else { Ok(value) } }, ${failureArm(helper, "acquireUseRelease")} } }, ${failureArm(helper, "acquireUseRelease")} } }`,
            ]),
          Ensuring: (n) =>
            joinFragments([
              "{ let result = ",
              adaptFrag(n.body, helper.output, use("body")),
              "; let saved_interruptible = ctx.interruptible; ctx.interruptible = false; let cleanup = ",
              callFrag(n.finalizer, use("finalizer")),
              '; ctx.interruptible = saved_interruptible; if cleanup.is_err() { panic!("Non-failing masked finalizer returned an error"); } match result { Ok(value) => { if ctx.is_cancelled() { ',
              captureFrames
                ? `Err((AsyncError::Interrupted, FrameTrail::new(${frameOf(helper, "ensuring").text})))`
                : "Err(AsyncError::Interrupted)",
              ` } else { Ok(value) } }, ${failureArm(helper, "ensuring")} } }`,
            ]),
          Pure: (n) => renderBlock(n.block),
          Succeed: (n) =>
            joinFragments([
              "{ ",
              mapFragment(helper.origin, undefined, textFragment("Ok")),
              "(",
              renderBlock(n.block),
              ") }",
            ]),
          StreamCollect: (n) => {
            // Push-fused chunk loop: each stage hands its non-empty chunks to the next (STREAM-004).
            let fresh = 0;
            const name = (prefix: string) => `${prefix}_${fresh++}`;
            const root = name("'stream");
            const vec = (type: IRType<unknown>) => `Vec<${typeName(type)}>`;
            const emit = (
              plan: StreamPlan,
              next: (chunk: string) => MappedFragment,
            ): MappedFragment =>
              Match.value(plan).pipe(
                Match.tagsExhaustive({
                  FromArray: (m) => {
                    const chunk = name("chunk");
                    return joinFragments([
                      `{ let ${chunk}: ${vec(m.item)} = (`,
                      renderBlock(m.values),
                      `).to_vec(); if !${chunk}.is_empty() { `,
                      next(chunk),
                      " } }",
                    ]);
                  },
                  // Arr.range: chunks of 4096; the last has max(1, floor(remaining)) elements.
                  Range: (m) => {
                    const [min, max, start, remaining, count, chunk] = [
                      "min",
                      "max",
                      "start",
                      "remaining",
                      "count",
                      "chunk",
                    ].map(name);
                    return joinFragments([
                      `{ let ${min}: f64 = `,
                      renderBlock(m.min),
                      `; let ${max}: f64 = `,
                      renderBlock(m.max),
                      `; if !(${min} > ${max}) { let mut ${start} = ${min}; loop { let ${remaining} = ${max} - ${start} + 1.0; if ${remaining} > 4096.0 { let ${chunk}: Vec<f64> = (0..4096usize).map(|i| ${start} + i as f64).collect(); ${start} += 4096.0; `,
                      next(chunk),
                      ` } else { let ${count}: usize = if ${remaining} >= 2.0 { ${remaining}.floor() as usize } else { 1 }; let ${chunk}: Vec<f64> = (0..${count}).map(|i| ${start} + i as f64).collect(); `,
                      next(chunk),
                      " break; } } } }",
                    ]);
                  },
                  Empty: () => textFragment(""),
                  // Stream.fromSchedule(Schedule.spaced(d)): each count after an interruptible sleep.
                  FromSchedule: (m) => {
                    const [count, chunk] = ["count", "chunk"].map(name);
                    return joinFragments([
                      `{ let mut ${count}: f64 = 0.0; loop { if let Err(error) = ctx.sleep(${m.milliseconds}).await { stopped = Some(error); break ${root}; } let ${chunk}: Vec<f64> = vec![${count}]; ${count} += 1.0; `,
                      next(chunk),
                      " } }",
                    ]);
                  },
                  Fail: (m) =>
                    joinFragments([
                      "{ failure = Some(",
                      renderBlock(m.error),
                      `); break ${root}; }`,
                    ]),
                  Transform: (m) => {
                    const out = name("chunk");
                    return emit(m.source, (chunk) =>
                      joinFragments([
                        // The element callback also reads its chunk, so the loop borrows it.
                        `{ let ${m.chunk}: &${vec(arrayItem(m.input)!)} = &${chunk}; let ${out}: ${vec(arrayItem(m.output)!)} = `,
                        renderBlock(m.transform),
                        "; ",
                        m.filter ? `if !${out}.is_empty() { ` : "",
                        next(out),
                        m.filter ? " } }" : " }",
                      ]),
                    );
                  },
                  // Stream.take: Infinity takes everything; 0 never starts the source.
                  Take: (m) => {
                    if (m.count === 0) return textFragment("");
                    if (m.count === Infinity) return emit(m.source, next);
                    const [remaining, label, taken] = ["remaining", "'take", "taken"].map(name);
                    return joinFragments([
                      `{ let mut ${remaining}: usize = ${m.count}; ${label}: { `,
                      emit(m.source, (chunk) =>
                        joinFragments([
                          `{ let mut ${taken} = ${chunk}; if ${taken}.len() > ${remaining} { ${taken}.truncate(${remaining}); } ${remaining} -= ${taken}.len(); `,
                          next(taken),
                          ` if ${remaining} == 0 { break ${label}; } }`,
                        ]),
                      ),
                      " } }",
                    ]);
                  },
                  // Stream.rechunk: an exact chunk passes through; the remainder flushes only at
                  // the end, so a failure drops it as Effect does.
                  Rechunk: (m) => {
                    const [buffer, incoming, element, full] = [
                      "buffer",
                      "incoming",
                      "element",
                      "full",
                    ].map(name);
                    return joinFragments([
                      `{ let mut ${buffer}: ${vec(m.item)} = Vec::new(); `,
                      emit(m.source, (chunk) =>
                        joinFragments([
                          `{ let ${incoming} = ${chunk}; if ${buffer}.is_empty() && ${incoming}.len() == ${m.size} { `,
                          next(incoming),
                          ` } else if ${buffer}.len() + ${incoming}.len() < ${m.size} { ${buffer}.extend(${incoming}); } else { for ${element} in ${incoming} { ${buffer}.push(${element}); if ${buffer}.len() == ${m.size} { let ${full} = std::mem::take(&mut ${buffer}); `,
                          next(full),
                          " } } } }",
                        ]),
                      ),
                      ` if !${buffer}.is_empty() { let ${full} = std::mem::take(&mut ${buffer}); `,
                      next(full),
                      " } }",
                    ]);
                  },
                  Concat: (m) => joinFragments([emit(m.first, next), emit(m.second, next)]),
                  Chunks: (m) =>
                    emit(m.source, (chunk) => {
                      const wrapped = name("chunk");
                      return joinFragments([
                        `{ let ${wrapped}: Vec<${vec(m.item)}> = vec![${chunk}]; `,
                        next(wrapped),
                        " }",
                      ]);
                    }),
                }),
              );
            const fails = (plan: StreamPlan): boolean =>
              Match.value(plan).pipe(
                Match.tagsExhaustive({
                  FromArray: () => false,
                  Range: () => false,
                  Empty: () => false,
                  FromSchedule: () => false,
                  Fail: () => true,
                  Transform: (m) => fails(m.source),
                  Take: (m) => fails(m.source),
                  Rechunk: (m) => fails(m.source),
                  Concat: (m) => fails(m.first) || fails(m.second),
                  Chunks: (m) => fails(m.source),
                }),
              );
            const failing = fails(n.plan);
            const out = name("out");
            const sink = n.emit;
            const consume = (chunk: string): MappedFragment =>
              sink
                ? joinFragments([
                    `{ let ${sink.chunk}: &${vec(arrayItem(sink.input)!)} = &${chunk}; let encoded: Vec<serde_json::Value> = `,
                    renderBlock(sink.transform),
                    `; if let Err(error) = ctx.stream_chunk(encoded).await { stopped = Some(error); break ${root}; } }`,
                  ])
                : textFragment(`${out}.extend(${chunk});`);
            const wrap = (error: string) =>
              joinFragments([
                mapFragment(helper.origin, undefined, textFragment("Err")),
                captureFrames ? "((" : "(",
                error,
                captureFrames
                  ? `, ${Rs.pathCall(rsSegments("FrameTrail"), Rs.ident("new"), [frameOf(helper, "fail")]).text}))`
                  : ")",
              ]);
            if (sink)
              return joinFragments([
                "{ let mut stopped = None; ",
                failing ? `let mut failure: Option<${typeName(n.error)}> = None; ` : "",
                `#[allow(unused_labels)] ${root}: { `,
                emit(n.plan, consume),
                " } if let Some(error) = stopped { ",
                wrap("error"),
                " } ",
                failing
                  ? joinFragments([
                      "else if let Some(error) = failure { ",
                      wrap("AsyncError::Fail(error)"),
                      " } ",
                    ])
                  : "",
                "else { Ok(()) } }",
              ]);
            const suspends = planSuspends(n.plan);
            return joinFragments([
              `{ let mut ${out}: ${vec(n.item)} = Vec::new(); `,
              suspends ? "let mut stopped = None; " : "",
              failing ? `let mut failure: Option<${typeName(n.error)}> = None; ` : "",
              `#[allow(unused_labels)] ${root}: { `,
              emit(n.plan, consume),
              " } ",
              suspends
                ? joinFragments(["if let Some(error) = stopped { ", wrap("error"), " } else "])
                : "",
              failing
                ? joinFragments([
                    "if let Some(error) = failure { ",
                    mapFragment(helper.origin, undefined, textFragment("Err")),
                    captureFrames ? "((" : "(",
                    f.asynchronous ? "AsyncError::Fail(error)" : "error",
                    captureFrames
                      ? `, ${Rs.pathCall(rsSegments("FrameTrail"), Rs.ident("new"), [frameOf(helper, "fail")]).text}))`
                      : ")",
                    " } else { ",
                  ])
                : "",
              `Ok(${out})`,
              failing ? " } }" : " }",
            ]);
          },
          Fail: (n) =>
            joinFragments([
              "{ ",
              mapFragment(helper.origin, undefined, textFragment("Err")),
              captureFrames ? "((" : "(",
              ...(f.asynchronous
                ? ["AsyncError::Fail(", renderBlock(n.block), ")"]
                : [renderBlock(n.block)]),
              captureFrames
                ? `, ${Rs.pathCall(rsSegments("FrameTrail"), Rs.ident("new"), [frameOf(helper, "fail")]).text})) }`
                : ") }",
            ]),
          Map: (n) =>
            joinFragments([
              "{ match ",
              callFrag(n.source, use("source")),
              ` { Ok(${copyable(f.helpers[n.source].output) ? "" : "ref "}${Rs.ident(n.binder).text}) => Ok(`,
              renderBlock(n.block),
              `), ${failureArm(helper, "map")} } }`,
            ]),
          FlatMap: (n) =>
            joinFragments([
              "{ match ",
              callFrag(n.source, use("source")),
              ` { Ok(${Rs.ident(n.binder).text}) => match `,
              adaptFrag(n.body, helper.output, use("body")),
              ` { Ok(value) => Ok(value), ${failureArm(helper, "flatMap")} }`,
              `, ${failureArm(helper, "flatMap")} } }`,
            ]),
          Match: (n) =>
            joinFragments([
              "{ if ",
              renderBlock(n.condition),
              " { match ",
              adaptFrag(n.onTrue, helper.output, use("onTrue")),
              ` { Ok(value) => Ok(value), ${failureArm(helper, "match")} }`,
              " } else { match ",
              adaptFrag(n.onFalse, helper.output, use("onFalse")),
              ` { Ok(value) => Ok(value), ${failureArm(helper, "match")} } } }`,
            ]),
          ForEach: (n) => {
            const item = Rs.ident(n.item).text;
            const index = Rs.ident(n.index).text;
            return joinFragments([
              "{ let source = ",
              n.source.bindings.length === 0
                ? operand(n.source.body)
                : joinFragments(["&", renderBlock(n.source)]),
              n.discard ? "; " : "; let mut out = Vec::with_capacity(source.len()); ",
              `for (${index}, ${item}) in source.iter().enumerate() { let ${index}: u64 = ${index} as u64; ${n.itemCopy ? `let ${item} = *${item}; ` : ""}let step = match `,
              adaptFrag(n.helper, f.helpers[n.helper].output, use("body")),
              ` { Ok(value) => Ok(value), ${failureArm(helper, "forEach")} }; match step { Ok(value) => `,
              n.discard ? "{ let _ = value; }" : "out.push(value)",
              ", Err(error) => return Err(error) } } ",
              n.discard ? "Ok(()) }" : "Ok(out) }",
            ]);
          },
          MatchTags: (n) =>
            joinFragments([
              "{ match ",
              // A plain name or field is borrowed directly; anything else is a borrowed temporary.
              n.scrutinee.bindings.length === 0
                ? operand(n.scrutinee.body)
                : joinFragments(["&", renderBlock(n.scrutinee)]),
              " { ",
              ...n.cases.flatMap((c, i) => [
                `${typeName(n.union)}::${variantOf(n.union, c.tag)}(${Rs.ident(c.binder).text}) => match `,
                adaptFrag(c.helper, helper.output, use(`cases[${i}]`)),
                ` { Ok(value) => Ok(value), ${failureArm(helper, "match")} }, `,
              ]),
              "} }",
            ]),
          Log: (n) => {
            const ordinal = logLevelOrdinal[n.level] ?? 99;
            const head =
              '{"schema":"reffect.log@1","level":"' +
              n.level +
              '","message":' +
              jsonString(n.message).text;
            const parts: Array<string | MappedFragment> = [
              `{ if ${Rs.litU8(ordinal).text} >= MIN_LOG_LEVEL { { let mut log_record = String::from(${rustString(head).text});`,
              ` log_record.push_str(",\\"annotations\\":{");`,
              ` { let mut log_attr_first = true;`,
            ];
            for (const attr of n.attributes) {
              parts.push(` { let log_attr_value = LogAttr::${attrVariant(attr.type).text}(`);
              parts.push(renderBlock(attr.block));
              parts.push(
                `); if !log_attr_first { log_record.push(','); } log_attr_first = false; log_record.push_str(${rustString(`"${attr.key}":`).text}); log_attr_json(log_attr_value, &mut log_record); }`,
              );
            }
            const shadowed =
              n.attributes.length === 0
                ? ``
                : ` if ${n.attributes.map((attr) => `*name == ${rustString(attr.key).text}`).join(" || ")} { continue; }`;
            parts.push(
              ` ${f.asynchronous ? "{ for (name, value) in ctx.annos.iter()" : "LOG_ANNOS.with(|scope| { for (name, value) in scope.borrow().iter()"} {${shadowed} if !log_attr_first { log_record.push(','); } log_attr_first = false; log_record.push_str("\\""); log_record.push_str(name); log_record.push_str("\\":"); log_attr_json(*value, &mut log_record); } }${f.asynchronous ? "" : ");"}`,
              ` } log_record.push('}');`,
              ` ${f.asynchronous ? "{ " : "LOG_SPANS.with(|scope| { "}log_record.push_str(",\\"spans\\":["); for (index, entry) in ${f.asynchronous ? "ctx.spans.iter()" : "scope.borrow().iter()"}.rev().enumerate() { if index > 0 { log_record.push(','); } log_record.push_str("{\\"label\\":\\""); log_record.push_str(entry.0); log_record.push_str("\\",\\"elapsed_ms\\":"); log_record.push_str(&entry.1.elapsed().as_millis().to_string()); log_record.push('}'); } log_record.push(']'); }${f.asynchronous ? "" : ");"}`,
              ` ${f.asynchronous ? "{ if let Some(context) = ctx.request.as_ref()" : "LOG_CONTEXT.with(|scope| { if let Some(context) = scope.borrow().as_ref()"} { log_record.push_str(",\\"request\\":"); log_record.push_str(context); } }${f.asynchronous ? "" : ");"}`,
              ` log_record.push('}'); eprintln!("{}", log_record); } } Ok(()) }`,
            );
            return joinFragments(parts);
          },
          Annotate: (n) => {
            const key = rustString(n.key).text;
            if (f.asynchronous)
              return joinFragments([
                `{ let saved_log_annos = ctx.annos.clone(); let value = LogAttr::${attrVariant(n.type).text}(`,
                renderBlock(n.value),
                `); if let Some(slot) = ctx.annos.iter_mut().find(|(name, _)| *name == ${key}) { *slot = (${key}, value); } else { ctx.annos.push((${key}, value)); } let result = `,
                adaptFrag(n.body, helper.output, use("body")),
                `; ctx.annos = saved_log_annos; match result { Ok(value) => Ok(value), ${failureArm(helper, "annotate")} } }`,
              ]);
            return joinFragments([
              `{ let saved_log_annos = LOG_ANNOS.with(|scope| scope.borrow().clone());`,
              ` LOG_ANNOS.with(|scope| { let value = LogAttr::${attrVariant(n.type).text}(`,
              renderBlock(n.value),
              `); let mut scope = scope.borrow_mut(); if let Some(slot) = scope.iter_mut().find(|(name, _)| *name == `,
              key,
              `) { *slot = (`,
              key,
              `, value); } else { scope.push((`,
              key,
              `, value)); } });`,
              ` match `,
              adaptFrag(n.body, helper.output, use("body")),
              ` { Ok(value) => { LOG_ANNOS.with(|scope| *scope.borrow_mut() = saved_log_annos); Ok(value) } ${failureArm(helper, "annotate", "LOG_ANNOS.with(|scope| *scope.borrow_mut() = saved_log_annos); ")} } }`,
            ]);
          },
          Span: (n) =>
            f.asynchronous
              ? joinFragments([
                  `{ ctx.spans.push((${rustString(n.label).text}, std::time::Instant::now())); let result = `,
                  adaptFrag(n.body, helper.output, use("body")),
                  `; ctx.spans.pop(); match result { Ok(value) => Ok(value), ${failureArm(helper, "span")} } }`,
                ])
              : joinFragments([
                  `{ LOG_SPANS.with(|scope| scope.borrow_mut().push((`,
                  rustString(n.label).text,
                  `, std::time::Instant::now())));`,
                  ` match `,
                  adaptFrag(n.body, helper.output, use("body")),
                  ` { Ok(value) => { LOG_SPANS.with(|scope| { scope.borrow_mut().pop(); }); Ok(value) } ${failureArm(helper, "span", "LOG_SPANS.with(|scope| { scope.borrow_mut().pop(); }); ")} } }`,
                ]),
        }),
      );
      // Inlining shared control flow can recreate exponential trees; preserve existing optimization boundary.
      writer.writeFragment(
        joinFragments([
          `#[inline(never)]\n${helper.asynchronous ? "async " : ""}fn `,
          mapFragment(
            helper.origin,
            useAt(helper.path),
            textFragment(Rs.ident(`h_${f.name}_${helper.index}`).text),
            "definition",
          ),
          `(${(contextual && helper.error ? [`ctx: &mut ${contextType}`] : [])
            .concat(
              helper.input.map((p) => `${Rs.ident(p.name).text}: ${helperParameterType(p.type)}`),
              helper.files.map(
                (name) =>
                  `${Rs.ident(name).text}: ${Rs.refType(Rs.pathType(rsSegments("std", "fs", "File"))).text}`,
              ),
            )
            .join(", ")}) -> `,
          mapFragment(helper.origin, useAt(helper.path), textFragment(signature), "definition"),
          " ",
          ...(f.asynchronous && helper.error
            ? [
                `{ if ctx.is_cancelled() { return ${captureFrames ? `Err((AsyncError::Interrupted, FrameTrail::new(${frameOf(helper, entryFrameKind(helper.body)).text})))` : "Err(AsyncError::Interrupted)"}; } `,
                helperBody,
                " }",
              ]
            : [helperBody]),
          "\n\n",
        ]),
      );
    }
    const entryCancellation = f.asynchronous
      ? `if ctx.is_cancelled() { ${captureFrames ? `ctx.frames = Some(FrameTrail::new(${frameLiteral(f.name, f.path, "function", f.origin).text}));` : ""} return Err(AsyncError::Interrupted); } `
      : "";
    writer.writeFragment(
      joinFragments([
        `\npub ${f.asynchronous ? "async " : ""}fn `,
        mapFragment(
          f.origin,
          useAt(f.path),
          textFragment(Rs.ident(`r_${f.name}`).text),
          "definition",
        ),
        `(${(contextual ? [`ctx: &mut ${contextType}`] : []).concat(f.input.map((type, i) => `p${i}: ${rsTypeOf(type).text}`)).join(", ")}) -> `,
        mapFragment(
          f.origin,
          useAt(f.path),
          textFragment(
            Match.value(f.node).pipe(
              Match.tagsExhaustive({
                Pure: () => typeName(f.output),
                Effect: (n) => resultType(f.output, n.error),
              }),
            ),
          ),
          "definition",
        ),
        " ",
        Match.value(f.node).pipe(
          Match.tagsExhaustive({
            Pure: (n) =>
              f.input.some((type) => !copyable(type))
                ? joinFragments([
                    "{ ",
                    ...f.input.flatMap((type, i) =>
                      copyable(type) ? [] : [`let p${i}: ${helperParameterType(type)} = &p${i}; `],
                    ),
                    renderBlock(n.block),
                    " }",
                  ])
                : renderBlock(n.block),
            // Public functions separate typed/interrupted outcomes from observer-owned frames.
            Effect: (n) =>
              captureFrames
                ? joinFragments([
                    f.asynchronous ? `{ ctx.frames = None; ${entryCancellation}match ` : "{ match ",
                    adaptFrag(n.root, f.output, useAt(`${f.path}.body`)),
                    ` { Ok(value) => Ok(value), Err((error, mut frames)) => { frames.push(${frameLiteral(f.name, f.path, "function", f.origin).text}); ${f.asynchronous ? "ctx.frames = Some(frames)" : "store_frames(frames)"}; Err(error) } } }`,
                  ])
                : joinFragments([
                    `{ ${entryCancellation}`,
                    adaptFrag(n.root, f.output, useAt(`${f.path}.body`)),
                    " }",
                  ]),
          }),
        ),
        "\n\n",
      ]),
    );
  }
  if (scopeDepth) {
    write(
      "async fn close_scope(ctx: &mut AsyncContext) {\n    while let Some(entry) = ctx.pop_finalizer() {\n",
    );
    if (hasLogScopes)
      write(
        "        let saved_annos = std::mem::replace(&mut ctx.annos, entry.annos);\n        let saved_spans = std::mem::replace(&mut ctx.spans, entry.spans);\n",
      );
    write("        match entry.finalizer {\n");
    for (const registration of registrations) {
      const { f, cleanup, variant, file } = registration;
      const captures = cleanup.input.map((p) => Rs.ident(p.name).text);
      write(
        `            ScopeFinalizer::${variant.text}(${captures.concat(file ? ["owned_file"] : []).join(", ")}) => {\n`,
      );
      if (file)
        write(
          '                drop(owned_file.expect("Reserved file ownership was transferred before scope close"));\n',
        );
      const call = Rs.call(
        Rs.identExpr(Rs.ident(`h_${f.name}_${cleanup.index}`)),
        [identExpr("ctx")].concat(cleanup.input.map((p) => identExpr(p.name))),
      );
      writer.writeFragment(
        joinFragments([
          "                match ",
          mapFragment(
            cleanup.origin,
            useAt(cleanup.path),
            textFragment(cleanup.asynchronous ? Rs.await(call).text : call.text),
          ),
          captureFrames
            ? ' { Ok(()) => {}, Err((AsyncError::Fail(never), _frames)) => match never {}, Err((AsyncError::Interrupted, _frames)) => panic!("Masked non-failing scope finalizer was interrupted") }\n'
            : ' { Ok(()) => {}, Err(AsyncError::Fail(never)) => match never {}, Err(AsyncError::Interrupted) => panic!("Masked non-failing scope finalizer was interrupted") }\n',
        ]),
      );
      write("            },\n");
    }
    if (!registrations.length)
      write("            ScopeFinalizer::Unreachable(never) => match never {},\n");
    write("        }\n");
    if (hasLogScopes) write("        ctx.annos = saved_annos;\n        ctx.spans = saved_spans;\n");
    write("    }\n    ctx.leave_scope();\n}\n\n");
  }
  const print = (type: IRType<unknown>, value: RsExpr, channel?: "ok" | "err"): RsExpr => {
    if (IRType.same(type, NeverType)) return Rs.unreachableMatch(value);
    if (IRType.same(type, UnitType))
      return Rs.inlineStmtBlock(
        Rs.letDiscard(Rs.unitType(), value),
        Rs.println(`${channel ? `${channel}:` : ""}unit`),
      );
    if (IRType.same(type, NumberType))
      return Rs.printlnExpr(
        `${channel ? `${channel}:` : ""}f64:`,
        Rs.verbatimExpr(`format!("{:016x}", (${value.text}).to_bits())`),
      );
    if (IRType.same(type, StringType))
      return Rs.printlnExpr(
        `${channel ? `${channel}:` : ""}str:`,
        Rs.call(identExpr("hex"), [Rs.refExpr(value)]),
      );
    const prefix = channel
      ? `${channel}:${IRType.same(type, U64Type) ? "u64" : "bool"}:`
      : IRType.same(type, BoolType)
        ? "bool:"
        : "";
    return Rs.printlnExpr(prefix, value);
  };
  const parseArg = (type: IRType<unknown>, index: number): RsExpr =>
    IRType.same(type, NumberType)
      ? Rs.verbatimExpr(
          `f64::from_bits(u64::from_str_radix(args[${index}].strip_prefix("f64:").ok_or("invalid f64")?, 16).map_err(|_| "invalid f64")?)`,
        )
      : IRType.same(type, StringType)
        ? Rs.try_(Rs.call(identExpr("unhex"), [Rs.refExpr(Rs.index(identExpr("args"), index))]))
        : IRType.same(type, UnitType)
          ? Rs.inlineBlock(
              Rs.if_(
                Rs.cmp(Rs.index(identExpr("args"), index), "!=", Rs.stringLiteral("unit")),
                Rs.inlineStmtBlock(Rs.stmt(Rs.return_(Rs.err(Rs.stringLiteral("invalid unit"))))),
              ),
              Rs.litUnit(),
            )
          : Rs.try_(
              Rs.dotChain(Rs.index(identExpr("args"), index), [
                { method: Rs.ident("parse"), args: [], turboTypes: [rsTypeOf(type)] },
                {
                  method: Rs.ident("map_err"),
                  args: [
                    Rs.closure(Rs.pat("_"), Rs.stringLiteral(`invalid ${rsTypeOf(type).text}`)),
                  ],
                },
              ]),
            );
  const callExpr = (f: LoweredModule["functions"][number]): RsExpr => {
    const call = Rs.pathCall(
      rsSegments("reffect_generated"),
      Rs.ident(`r_${f.name}`),
      (f.asynchronous
        ? [Rs.mutRefExpr(identExpr("ctx"))]
        : f.services.clock || f.services.random
          ? [Rs.mutRefExpr(identExpr("services_ctx"))]
          : []
      ).concat(f.input.map((type, i) => parseArg(type, i + 1))),
    );
    return f.asynchronous ? Rs.await(call) : call;
  };
  const framesBlock = (asynchronous: boolean) =>
    Rs.inlineStmtBlock(
      Rs.letPat(
        Rs.tuplePat(Rs.identPat(Rs.ident("frames")), Rs.identPat(Rs.ident("omitted"))),
        undefined,
        asynchronous
          ? Rs.dotCall(identExpr("ctx"), Rs.ident("take_frames"), [])
          : Rs.pathCall(rsSegments("reffect_generated"), Rs.ident("take_last_frames"), []),
      ),
      Rs.letMut(Rs.ident("body"), undefined, Rs.stringFrom(Rs.stringLiteral("["))),
      Rs.blockStmt(
        Rs.forLoop(
          Rs.pat("(i, frame)"),
          Rs.dotChain(identExpr("frames"), [
            { method: Rs.ident("iter"), args: [] },
            { method: Rs.ident("enumerate"), args: [] },
          ]),
          Rs.inlineStmtBlock(
            Rs.blockStmt(
              Rs.if_(
                Rs.cmp(identExpr("i"), ">", Rs.litInt(0)),
                Rs.inlineStmtBlock(
                  Rs.stmt(Rs.dotCall(identExpr("body"), Rs.ident("push"), [Rs.litChar(",")])),
                ),
              ),
            ),
            Rs.stmt(Rs.dotCall(identExpr("body"), Rs.ident("push_str"), [identExpr("frame")])),
          ),
        ),
      ),
      Rs.stmt(Rs.dotCall(identExpr("body"), Rs.ident("push"), [Rs.litChar("]")])),
      Rs.eprintln(
        '{"schema":"reffect.frames@1","frames":',
        identExpr("body"),
        ',"omitted":',
        identExpr("omitted"),
        "}",
      ),
    );
  const runnable = (f: LoweredModule["functions"][number]) =>
    [
      f.output,
      ...Match.value(f.node).pipe(
        Match.tagsExhaustive({ Pure: () => [], Effect: (n) => [n.error] }),
      ),
      ...f.input,
    ].every((type) => type.layout === undefined && !reachesUnknown(type));
  const arms = module.functions.filter(runnable).map((f) => ({
    pat: Rs.stringPat(f.name),
    guard: Rs.cmp(
      Rs.dotCall(identExpr("args"), Rs.ident("len"), []),
      "==",
      Rs.litInt(f.input.length + 1),
    ),
    body: Match.value(f.node).pipe(
      Match.tagsExhaustive({
        Pure: () =>
          Rs.inlineStmtBlock(
            Rs.let_(Rs.ident("value"), undefined, callExpr(f)),
            Rs.stmt(print(f.output, identExpr("value"))),
          ),
        Effect: (n) =>
          Rs.match_(callExpr(f), [
            { pat: Rs.pat("Ok(value)"), body: print(f.output, identExpr("value"), "ok") },
            ...(f.asynchronous
              ? [
                  {
                    pat: Rs.pat("Err(reffect_generated::AsyncError::Interrupted)"),
                    body: Rs.inlineStmtBlock(
                      Rs.println("interrupt"),
                      ...(captureFrames ? [Rs.blockStmt(framesBlock(true))] : []),
                    ),
                  },
                ]
              : []),
            {
              pat: Rs.pat(
                f.asynchronous ? "Err(reffect_generated::AsyncError::Fail(error))" : "Err(error)",
              ),
              body: Rs.inlineStmtBlock(
                Rs.stmt(print(n.error, identExpr("error"), "err")),
                ...(captureFrames ? [Rs.blockStmt(framesBlock(f.asynchronous))] : []),
              ),
            },
          ]),
      }),
    ),
  }));
  const mainBody = Rs.block(
    [
      ...(hasSyncServices
        ? [
            Rs.letMut(
              Rs.ident("services_ctx"),
              undefined,
              Rs.pathCall(rsSegments("reffect_generated", "SyncContext"), Rs.ident("new"), []),
            ),
          ]
        : []),
      ...(hasAsync
        ? [
            Rs.verbatimStmt(
              "let (_cancel_sender, cancellation) = tokio::sync::watch::channel(false); let mut ctx = reffect_generated::AsyncContext::new(cancellation);",
            ),
          ]
        : []),
      Rs.let_(
        Rs.ident("args"),
        Rs.vecType(Rs.stringType()),
        Rs.dotChain(Rs.pathCall(rsSegments("std", "env"), Rs.ident("args"), []), [
          { method: Rs.ident("skip"), args: [Rs.litInt(1)] },
          { method: Rs.ident("collect"), args: [] },
        ]),
      ),
      Rs.blockStmt(
        Rs.matchBlock(
          Rs.try_(
            Rs.dotChain(identExpr("args"), [
              { method: Rs.ident("first"), args: [] },
              {
                method: Rs.ident("map"),
                args: [Rs.pathExpr(Rs.path(rsSegments("String", "as_str")))],
              },
              { method: Rs.ident("ok_or"), args: [Rs.stringLiteral("missing function")] },
            ]),
          ),
          [
            ...arms,
            {
              pat: Rs.wildcardPat(),
              body: Rs.return_(Rs.err(Rs.stringLiteral("unknown function or incorrect arity"))),
            },
          ],
          { indent: 4, trailingComma: true },
        ),
      ),
    ],
    Rs.ok(Rs.litUnit()),
  );
  const usesStrings = module.functions.some((f) =>
    [
      f.output,
      ...Match.value(f.node).pipe(
        Match.tagsExhaustive({ Pure: () => [], Effect: (n) => [n.error] }),
      ),
      ...f.input,
    ].some((type) => IRType.same(type, StringType)),
  );
  const files = Object.freeze({
    "Cargo.toml":
      '[package]\nname = "reffect_generated"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n' +
      (hasAsync || usesJson ? "\n[dependencies]\n" : "") +
      (hasAsync
        ? 'tokio = { version = "=1.53.1", features = ["macros", "rt", "time", "sync"] }\n'
        : "") +
      (usesJson
        ? 'serde_json = { version = "=1.0.151", features = ["float_roundtrip", "preserve_order"] }\n'
        : ""),
    "src/lib.rs": writer.text,
    "src/main.rs": `${usesStrings ? stringBoundary : ""}${
      (hasAsync
        ? Rs.withAttributes(
            [Rs.tokioMainAttribute()],
            Rs.asyncFnItem(
              Rs.ident("main"),
              [],
              Rs.resultType(Rs.unitType(), Rs.strRefType()),
              mainBody,
            ),
          )
        : Rs.fnItem(Rs.ident("main"), [], Rs.resultType(Rs.unitType(), Rs.strRefType()), mainBody)
      ).text
    }\n`,
  });
  return Object.freeze({ files, ranges: writer.ranges });
};

/** Runner boundary for strings: lowercase hex of UTF-8 bytes, so NUL and any text cross argv. */
const stringBoundary = `fn hex(value: &str) -> String {
    value.bytes().map(|b| format!("{:02x}", b)).collect()
}
fn unhex(value: &str) -> Result<String, &'static str> {
    let digits = value.strip_prefix("str:").ok_or("invalid String")?;
    if digits.len() % 2 != 0 { return Err("invalid String"); }
    let bytes = (0..digits.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&digits[i..i + 2], 16).map_err(|_| "invalid String"))
        .collect::<Result<Vec<u8>, _>>()?;
    String::from_utf8(bytes).map_err(|_| "invalid String")
}
`;

/** Struct and enum definitions for every reachable composite witness, dependencies first. */
const writeCompositeTypes = (
  module: LoweredModule,
  write: (text: string) => void,
  typeName: (type: IRType<unknown>) => string,
): void => {
  const ordered: IRType<unknown>[] = [];
  const seen = new Set<IRType<unknown>>();
  const names = new Map<string, IRType<unknown>>();
  const visit = (type: IRType<unknown>): void => {
    const layout = type.layout;
    if (!layout || seen.has(type)) return;
    seen.add(type);
    Match.value(layout).pipe(
      Match.tagsExhaustive({
        Struct: (struct) => struct.fields.forEach((field) => visit(field.type)),
        Union: (union) => union.cases.forEach(visit),
        Array: (array) => visit(array.item),
        UndefinedOr: (option) => visit(option.item),
        Record: (record) => visit(record.value),
        Literals: () => undefined,
      }),
    );
    const previous = names.get(type.native.type);
    if (previous && !IRType.same(previous, type))
      throw fail(
        "NATIVE_NAME_COLLISION",
        "lower",
        type.native.type,
        "Distinct composite witnesses share a native type name",
      );
    names.set(type.native.type, type);
    ordered.push(type);
  };
  for (const f of module.functions) {
    [f.output, ...f.input].forEach(visit);
    for (const helper of f.helpers) {
      visit(helper.output);
      helper.input.forEach((p) => visit(p.type));
      if (helper.error) visit(helper.error);
      const blocks: readonly RustBlock[] = Match.value(helper.body).pipe(
        Match.tags({
          Pure: (body) => [body.block],
          Succeed: (body) => [body.block],
          Fail: (body) => [body.block],
          Map: (body) => [body.block],
          Match: (body) => [body.condition],
          MatchTags: (body) => [body.scrutinee],
          ForEach: (body) => [body.source],
          Log: (body) => body.attributes.map((attribute) => attribute.block),
          Annotate: (body) => [body.value],
          Launch: (body) => body.values,
          RemoteStore: (body) => (body.values ? [body.id, body.values] : [body.id]),
        }),
        Match.orElse(() => []),
      );
      blocks.forEach((block) => block.bindings.forEach((binding) => visit(binding.type)));
    }
    Match.value(f.node).pipe(
      Match.tagsExhaustive({ Pure: () => undefined, Effect: (n) => visit(n.error) }),
    );
  }
  for (const type of ordered)
    Match.value(type.layout!).pipe(
      Match.tagsExhaustive({
        Struct: (struct) => {
          const fields = rustFieldNames(struct);
          write(
            `#[derive(Clone, Debug, PartialEq)]\n#[allow(non_snake_case)]\npub struct ${type.native.type} {${struct.fields
              .map(
                (field, i) =>
                  ` pub ${fields[i]}: ${field.optional === "optional" ? `Option<${typeName(field.type)}>` : typeName(field.type)},`,
              )
              .join("")} }\n\n`,
          );
        },
        Union: (union) =>
          write(
            `#[derive(Clone, Debug, PartialEq)]\n#[allow(non_camel_case_types)]\npub enum ${type.native.type} {${union.cases
              .map((c, i) => ` ${rustVariantName(structLayout(c)!.tag!, i)}(${c.native.type}),`)
              .join("")} }\n\n`,
          ),
        Array: () => undefined,
        UndefinedOr: () => undefined,
        Record: () => undefined,
        Literals: (union) =>
          write(
            `#[derive(Clone, Copy, Debug, PartialEq)]\n#[allow(non_camel_case_types)]\npub enum ${type.native.type} {${rustLiteralVariants(
              union.literals,
            )
              .map((name) => ` ${name},`)
              .join("")} }\n\n`,
          ),
      }),
    );
};

/** Lowercase hex of a double's IEEE 754 bits, preserving NaN, infinities and -0. */
const f64Bits = (value: number): string => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
};
