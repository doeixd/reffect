import { Pipeable } from "effect";
import { Expr, IRType, SemanticRef, fail } from "./kernel.ts";

/** A build-owned service key; native service values remain ordinary scalars. */
export class Service<Id extends string = string, A = unknown> extends Pipeable.Class {
  private constructor(
    readonly ref: SemanticRef<"requirement", Id>,
    readonly type: IRType<A>,
  ) {
    super();
    Object.freeze(this);
  }
  get id(): Id {
    return this.ref.id;
  }
  static make<const Id extends string, A>(this: void, id: Id, type: IRType<A>): Service<Id, A> {
    if (id.length === 0)
      throw fail(
        "INVALID_SERVICE_ID",
        "authoring",
        "Context.service",
        "Service ID must be nonempty",
      );
    return new Service(SemanticRef.requirement(id), type);
  }
}
export type ServiceValue<S> = S extends Service<string, infer A> ? A : never;
type Entry = Readonly<{ service: Service; value: Expr<unknown> }>;

/** Immutable lexical service environment, erased before native lowering. */
export class StaticContext<Provided extends Service = never> extends Pipeable.Class {
  private constructor(private readonly entries: ReadonlyMap<string, Entry>) {
    super();
    Object.freeze(this);
  }
  static empty(this: void): StaticContext<never> {
    return new StaticContext(new Map());
  }
  add<const Id extends string, A>(
    service: Service<Id, A>,
    value: Expr<NoInfer<A>>,
  ): StaticContext<Provided | Service<Id, A>> {
    if (!IRType.same(service.type, value.type))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        `Context.${service.id}`,
        "Service value witness differs from its key",
      );
    const previous = this.entries.get(service.id);
    if (previous && !IRType.same(previous.service.type, service.type))
      throw fail(
        "SERVICE_ID_COLLISION",
        "authoring",
        `Context.${service.id}`,
        "Service ID reused with a different witness",
      );
    const entries = new Map(this.entries);
    entries.set(service.id, Object.freeze({ service, value }));
    return new StaticContext(entries);
  }
  get<S extends Provided>(service: S): Expr<ServiceValue<S>> {
    const entry = this.entries.get(service.id);
    if (!entry)
      throw fail(
        "MISSING_SERVICE",
        "authoring",
        `Context.${service.id}`,
        "Service is absent from this lexical context",
      );
    if (!IRType.same(entry.service.type, service.type))
      throw fail(
        "SERVICE_ID_COLLISION",
        "authoring",
        `Context.${service.id}`,
        "Service ID reused with a different witness",
      );
    // The witness check above establishes the heterogeneous-map boundary.
    return entry.value as Expr<ServiceValue<S>>;
  }
  merge<P extends Service>(that: StaticContext<P>): StaticContext<Provided | P> {
    const entries = new Map(this.entries);
    for (const [id, entry] of that.entries) {
      const previous = entries.get(id);
      if (previous && !IRType.same(previous.service.type, entry.service.type))
        throw fail(
          "SERVICE_ID_COLLISION",
          "authoring",
          `Context.${id}`,
          "Service ID reused with a different witness",
        );
      entries.set(id, entry);
    }
    return new StaticContext(entries);
  }
}
export const ContextIR = Object.freeze({ service: Service.make, empty: StaticContext.empty });
