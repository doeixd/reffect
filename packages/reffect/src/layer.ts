import { Pipeable } from "effect";
import { Computation, EffectIR } from "./effect-ir.ts";
import { Expr, IRType, NeverType, fail } from "./kernel.ts";
import { Service, StaticContext } from "./context.ts";

type Memo = Map<StaticLayer<Service>, StaticContext<Service>>;
type Continue = (context: StaticContext<Service>) => Computation<unknown, unknown>;
type Build = (memo: Memo, continuation: Continue) => Computation<unknown, unknown>;

/** Resource-free scalar provider graph specialized into existing computation IR. */
export class StaticLayer<Provided extends Service = never> extends Pipeable.Class {
  declare private readonly provided: Provided;
  private constructor(
    private readonly build: Build,
    readonly pure: boolean,
    private readonly freshBoundary = false,
  ) {
    super();
    Object.freeze(this);
  }
  private expand(memo: Memo, continuation: Continue): Computation<unknown, unknown> {
    if (this.freshBoundary) return this.build(new Map(), continuation);
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
    return new StaticLayer((_memo, continuation) => continuation(context), true);
  }
  static effect<const Id extends string, A>(
    this: void,
    service: Service<Id, A>,
    acquisition: Computation<NoInfer<A>, never>,
  ): StaticLayer<Service<Id, A>> {
    if (
      !IRType.same(service.type, acquisition.output) ||
      !IRType.same(acquisition.error, NeverType)
    )
      throw fail(
        "INVALID_LAYER_ACQUISITION",
        "authoring",
        `Layer.${service.id}`,
        "Acquisition must match the service witness and have Never errors",
      );
    return new StaticLayer(
      (_memo, continuation) =>
        EffectIR.flatMap(acquisition, (value) =>
          continuation(StaticContext.empty().add(service, value)),
        ),
      false,
    );
  }
  /** Sequential builds share one memo map; the right context overrides the left. */
  static sequence<L extends Service, R extends Service>(
    this: void,
    left: StaticLayer<L>,
    right: StaticLayer<R>,
  ): StaticLayer<L | R> {
    return new StaticLayer(
      (memo, continuation) =>
        left.expand(memo, (a) => right.expand(memo, (b) => continuation(a.merge(b)))),
      left.pure && right.pure,
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
  static fresh<P extends Service>(this: void, layer: StaticLayer<P>): StaticLayer<P> {
    return new StaticLayer(
      (memo, continuation) => layer.expand(memo, continuation),
      layer.pure,
      true,
    );
  }
  static provide<P extends Service, A, E>(
    this: void,
    layer: StaticLayer<P>,
    build: (context: StaticContext<P>) => Computation<A, E>,
  ): Computation<A, E> {
    // Staging binds each acquisition once; those bindings are invocation-owned at runtime.
    return layer.expand(new Map(), (context) => build(context as StaticContext<P>)) as Computation<
      A,
      E
    >;
  }
}
export const LayerIR = Object.freeze({
  succeed: StaticLayer.succeed,
  effect: StaticLayer.effect,
  sequence: StaticLayer.sequence,
  merge: StaticLayer.merge,
  fresh: StaticLayer.fresh,
  provide: StaticLayer.provide,
});
