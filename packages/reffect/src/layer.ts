import { Pipeable } from "effect";
import { Computation, EffectIR, joinType } from "./effect-ir.ts";
import { Expr, IRType, NeverType, fail } from "./kernel.ts";
import { Service, StaticContext } from "./context.ts";
import { analyzeScopes } from "./scope-analysis.ts";

type AnyLayer = StaticLayer<Service, unknown>;
type Continue = (context: StaticContext<Service>) => Computation<unknown, unknown>;
type Build = (memo: Memo, continuation: Continue) => Computation<unknown, unknown>;

/** Mirrors Effect's MemoMap: lookups consult the parent chain, new entries stay local. */
class Memo {
  private readonly entries = new Map<AnyLayer, StaticContext<Service>>();
  constructor(private readonly parent?: Memo) {}
  get(layer: AnyLayer): StaticContext<Service> | undefined {
    return this.entries.get(layer) ?? this.parent?.get(layer);
  }
  set(layer: AnyLayer, context: StaticContext<Service>): void {
    this.entries.set(layer, context);
  }
}

// Memo maps of provides whose bodies are being staged, mirroring CurrentMemoMap in the fiber
// context: a provide staged inside another provide's body inherits the outer memo.
const staging: Memo[] = [];

/** Scalar provider graph specialized into existing computation IR. */
export class StaticLayer<Provided extends Service = never, E = never> extends Pipeable.Class {
  declare private readonly provided: Provided;
  private constructor(
    private readonly build: Build,
    readonly pure: boolean,
    readonly error: IRType<E>,
    /** Some acquisition retains a registration that the provide-owned scope must close. */
    readonly resource: boolean,
    private readonly freshBoundary = false,
  ) {
    super();
    Object.freeze(this);
  }
  private expand(memo: Memo, continuation: Continue): Computation<unknown, unknown> {
    if (this.freshBoundary) return this.build(new Memo(), continuation);
    const cached = memo.get(this);
    if (cached) return continuation(cached);
    return this.build(memo, (context) => {
      memo.set(this, context);
      return continuation(context);
    });
  }
  static succeed<const Id extends string, A>(
    this: void,
    service: Service<Id, A>,
    value: Expr<NoInfer<A>>,
  ): StaticLayer<Service<Id, A>> {
    const context = StaticContext.empty().add(service, value);
    return new StaticLayer((_memo, continuation) => continuation(context), true, NeverType, false);
  }
  /**
   * Acquisition runs in the layer's scope: registrations it retains are released when the
   * consuming provide exits, in reverse order with the provide's other registrations.
   */
  static effect<const Id extends string, A, E = never>(
    this: void,
    service: Service<Id, A>,
    acquisition: Computation<NoInfer<A>, E>,
  ): StaticLayer<Service<Id, A>, E> {
    if (!IRType.same(service.type, acquisition.output))
      throw fail(
        "INVALID_LAYER_ACQUISITION",
        "authoring",
        `Layer.${service.id}`,
        "Acquisition must match the service witness",
      );
    return new StaticLayer(
      (_memo, continuation) =>
        EffectIR.flatMap(acquisition, (value) =>
          continuation(StaticContext.empty().add(service, value)),
        ),
      false,
      acquisition.error,
      analyzeScopes(acquisition).retained > 0,
    );
  }
  /** Sequential builds share one memo map; the right context overrides the left. */
  static sequence<L extends Service, R extends Service, EL, ER>(
    this: void,
    left: StaticLayer<L, EL>,
    right: StaticLayer<R, ER>,
  ): StaticLayer<L | R, EL | ER> {
    return new StaticLayer(
      (memo, continuation) =>
        left.expand(memo, (a) => right.expand(memo, (b) => continuation(a.merge(b)))),
      left.pure && right.pure,
      joinLayerErrors(left.error, right.error, "Layer.sequence") as IRType<EL | ER>,
      left.resource || right.resource,
    );
  }
  /** Concurrent merge is erasable only when both providers have no acquisition effects. */
  static merge<L extends Service, R extends Service>(
    this: void,
    left: StaticLayer<L>,
    right: StaticLayer<R>,
  ): StaticLayer<L | R> {
    if (!left.pure || !right.pure)
      throw fail(
        "UNSUPPORTED_LAYER_CONCURRENCY",
        "authoring",
        "Layer.merge",
        "Effectful concurrent merge is unsupported; use explicit sequential composition",
      );
    return StaticLayer.sequence(left, right);
  }
  /** Every occurrence gets an independent memo boundary, even for a reused wrapper. */
  static fresh<P extends Service, E>(this: void, layer: StaticLayer<P, E>): StaticLayer<P, E> {
    return new StaticLayer(
      (memo, continuation) => layer.expand(memo, continuation),
      layer.pure,
      layer.error,
      layer.resource,
      true,
    );
  }
  /**
   * Mirrors Effect.provide: a resource-bearing graph is built in a provide-owned scope that
   * closes after `build`'s computation. A provide staged inside another provide's body reuses
   * the outer memoized providers unless `local` is set.
   */
  static provide<P extends Service, EL, A, E>(
    this: void,
    layer: StaticLayer<P, EL>,
    build: (context: StaticContext<P>) => Computation<A, E>,
    options?: { readonly local?: boolean | undefined },
  ): Computation<A, EL | E> {
    const enclosing = options?.local ? undefined : staging.at(-1);
    const memo = new Memo(enclosing);
    // Staging binds each acquisition once; those bindings are invocation-owned at runtime.
    const expanded = layer.expand(memo, (context) => {
      staging.push(memo);
      try {
        const body = build(context as StaticContext<P>);
        joinLayerErrors(layer.error, body.error, "Layer.provide");
        return body;
      } finally {
        staging.pop();
      }
    }) as Computation<A, EL | E>;
    return layer.resource ? EffectIR.scoped(expanded) : expanded;
  }
}
const joinLayerErrors = (
  left: IRType<unknown>,
  right: IRType<unknown>,
  site: string,
): IRType<unknown> => {
  try {
    return joinType(left, right);
  } catch {
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      site,
      "Layer acquisition and body errors require the same witness or Never",
    );
  }
};
export const LayerIR = Object.freeze({
  succeed: StaticLayer.succeed,
  effect: StaticLayer.effect,
  sequence: StaticLayer.sequence,
  merge: StaticLayer.merge,
  fresh: StaticLayer.fresh,
  provide: StaticLayer.provide,
});
