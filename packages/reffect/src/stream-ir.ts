/**
 * Finite Effect `Stream` pipelines as data (STREAM-005): sources, pure per-element operators and
 * chunk operators, each mirroring the Effect v4 constructor it names. A pipeline is consumed by a
 * Computation node (`runCollect`); the reference rebuilds it with official `Stream`, and native
 * lowering fuses it into one chunk loop that keeps Effect's chunk boundaries (STREAM-004).
 */
import { Match, Stream } from "effect";
import { pipeArguments } from "effect/Pipeable";
import type { Pipeable } from "effect/Pipeable";
import type { Expr, IRType } from "./kernel.ts";
import type { EffectFn } from "./effect-ir.ts";

export type StreamNode =
  /** `Stream.make(...values)` and `Stream.fromIterable(array)`: one chunk, none when empty. */
  | { readonly _tag: "FromArray"; readonly values: Expr<unknown> }
  /** `Stream.range(min, max)`: inclusive, in chunks of 4096. */
  | { readonly _tag: "Range"; readonly min: Expr<number>; readonly max: Expr<number> }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Fail"; readonly error: Expr<unknown> }
  /** Per element, as `Stream.map`; `body` reads the element through `item`. */
  | {
      readonly _tag: "Map";
      readonly source: StreamIR<unknown, unknown>;
      readonly item: symbol;
      readonly body: Expr<unknown>;
    }
  /** Per element, as `Stream.filter`; chunks left empty are dropped. */
  | {
      readonly _tag: "Filter";
      readonly source: StreamIR<unknown, unknown>;
      readonly item: symbol;
      readonly body: Expr<boolean>;
    }
  /** `Stream.take(n)`, `n` normalized as Effect does (`Infinity` takes everything). */
  | { readonly _tag: "Take"; readonly source: StreamIR<unknown, unknown>; readonly count: number }
  /** `Stream.rechunk(size)`, `size` normalized as Effect does. */
  | { readonly _tag: "Rechunk"; readonly source: StreamIR<unknown, unknown>; readonly size: number }
  | {
      readonly _tag: "Concat";
      readonly first: StreamIR<unknown, unknown>;
      readonly second: StreamIR<unknown, unknown>;
    }
  /** `Stream.chunks`: each chunk becomes one element. */
  | { readonly _tag: "Chunks"; readonly source: StreamIR<unknown, unknown> };

declare const StreamElement: unique symbol;
/**
 * A streaming procedure (STREAM-006): an effect function whose body hands its chunks to the
 * host, typed by the elements it streams.
 */
export type StreamFn<
  I extends readonly IRType<unknown>[] = readonly IRType<unknown>[],
  A = unknown,
  E = unknown,
> = EffectFn<I, void, E> & { readonly [StreamElement]?: A };

/** A `Stream<A, E>` description: the element and error witnesses, and the pipeline. */
export class StreamIR<A, E> implements Pipeable {
  declare readonly _A: A;
  declare readonly _E: E;
  declare readonly pipe: Pipeable["pipe"];
  constructor(
    readonly item: IRType<A>,
    readonly error: IRType<E>,
    readonly node: StreamNode,
  ) {
    Object.freeze(this);
  }
}
Object.defineProperty(StreamIR.prototype, "pipe", {
  value(this: StreamIR<unknown, unknown>) {
    // oxlint-disable-next-line prefer-rest-params -- Effect's pipe protocol reads `arguments`.
    return pipeArguments(this, arguments);
  },
});

/** The streams a node reads from, in order. */
export const streamSources = (node: StreamNode): ReadonlyArray<StreamIR<unknown, unknown>> =>
  Match.value(node).pipe(
    Match.tags({
      Map: (n) => [n.source],
      Filter: (n) => [n.source],
      Take: (n) => [n.source],
      Rechunk: (n) => [n.source],
      Chunks: (n) => [n.source],
      Concat: (n) => [n.first, n.second],
    }),
    Match.orElse(() => []),
  );

interface StreamExpression {
  readonly expr: Expr<unknown>;
  /** The element a `Map`/`Filter` body reads, if any. */
  readonly binder?: { readonly symbol: symbol; readonly type: IRType<unknown> };
  readonly path: string;
}
/** Every expression in a pipeline with the binder it sees, sources first. */
export const streamExpressions = (
  stream: StreamIR<unknown, unknown>,
): ReadonlyArray<StreamExpression> => {
  const out: StreamExpression[] = [];
  const visit = (s: StreamIR<unknown, unknown>, path: string): void => {
    const element = (n: { readonly source: StreamIR<unknown, unknown>; readonly item: symbol }) =>
      ({ symbol: n.item, type: n.source.item }) as const;
    Match.value(s.node).pipe(
      Match.tagsExhaustive({
        FromArray: (n) => out.push({ expr: n.values, path: `${path}.values` }),
        Range: (n) => {
          out.push({ expr: n.min, path: `${path}.min` });
          out.push({ expr: n.max, path: `${path}.max` });
        },
        Empty: () => undefined,
        Fail: (n) => out.push({ expr: n.error, path: `${path}.error` }),
        Map: (n) => {
          visit(n.source, `${path}.source`);
          out.push({ expr: n.body, binder: element(n), path: `${path}.body` });
        },
        Filter: (n) => {
          visit(n.source, `${path}.source`);
          out.push({ expr: n.body, binder: element(n), path: `${path}.body` });
        },
        Take: (n) => visit(n.source, `${path}.source`),
        Rechunk: (n) => visit(n.source, `${path}.source`),
        Chunks: (n) => visit(n.source, `${path}.source`),
        Concat: (n) => {
          visit(n.first, `${path}.first`);
          visit(n.second, `${path}.second`);
        },
      }),
    );
  };
  visit(stream, "stream");
  return out;
};

/** The pipeline with each expression replaced; the same object when nothing changed. */
export const mapStreamExpressions = <A, E>(
  stream: StreamIR<A, E>,
  f: (expr: Expr<unknown>) => Expr<unknown>,
): StreamIR<A, E> => {
  const go = (s: StreamIR<unknown, unknown>): StreamIR<unknown, unknown> => {
    const rebuild = (node: StreamNode, changed: boolean) =>
      changed ? new StreamIR(s.item, s.error, Object.freeze(node)) : s;
    return Match.value(s.node).pipe(
      Match.tagsExhaustive({
        FromArray: (n) => {
          const values = f(n.values);
          return rebuild({ ...n, values }, values !== n.values);
        },
        Range: (n) => {
          const min = f(n.min) as Expr<number>;
          const max = f(n.max) as Expr<number>;
          return rebuild({ ...n, min, max }, min !== n.min || max !== n.max);
        },
        Empty: () => s,
        Fail: (n) => {
          const error = f(n.error);
          return rebuild({ ...n, error }, error !== n.error);
        },
        Map: (n) => {
          const source = go(n.source);
          const body = f(n.body);
          return rebuild({ ...n, source, body }, source !== n.source || body !== n.body);
        },
        Filter: (n) => {
          const source = go(n.source);
          const body = f(n.body) as Expr<boolean>;
          return rebuild({ ...n, source, body }, source !== n.source || body !== n.body);
        },
        Take: (n) => {
          const source = go(n.source);
          return rebuild({ ...n, source }, source !== n.source);
        },
        Rechunk: (n) => {
          const source = go(n.source);
          return rebuild({ ...n, source }, source !== n.source);
        },
        Chunks: (n) => {
          const source = go(n.source);
          return rebuild({ ...n, source }, source !== n.source);
        },
        Concat: (n) => {
          const first = go(n.first);
          const second = go(n.second);
          return rebuild({ ...n, first, second }, first !== n.first || second !== n.second);
        },
      }),
    );
  };
  return go(stream) as StreamIR<A, E>;
};

/**
 * The official `Stream` a pipeline describes, for the reference. `evaluate` reads an expression
 * under bindings; `bind` extends them with one element.
 */
export const toEffectStream = <B>(
  stream: StreamIR<unknown, unknown>,
  bindings: B,
  evaluate: (expr: Expr<unknown>, bindings: B) => unknown,
  bind: (bindings: B, binder: symbol, value: unknown) => B,
): Stream.Stream<unknown, unknown> => {
  const go = (s: StreamIR<unknown, unknown>): Stream.Stream<unknown, unknown> =>
    Match.value(s.node).pipe(
      Match.tagsExhaustive({
        FromArray: (n) =>
          Stream.suspend(() =>
            Stream.fromIterable(evaluate(n.values, bindings) as ReadonlyArray<unknown>),
          ),
        Range: (n) =>
          Stream.suspend(() =>
            Stream.range(evaluate(n.min, bindings) as number, evaluate(n.max, bindings) as number),
          ),
        Empty: () => Stream.empty,
        Fail: (n) => Stream.suspend(() => Stream.fail(evaluate(n.error, bindings))),
        Map: (n) =>
          Stream.map(go(n.source), (value) => evaluate(n.body, bind(bindings, n.item, value))),
        Filter: (n) =>
          Stream.filter(
            go(n.source),
            (value) => evaluate(n.body, bind(bindings, n.item, value)) === true,
          ),
        Take: (n) => Stream.take(go(n.source), n.count),
        Rechunk: (n) => Stream.rechunk(go(n.source), n.size),
        Concat: (n) => Stream.concat(go(n.first), go(n.second)),
        // R arrays are plain arrays.
        Chunks: (n) => Stream.map(Stream.chunks(go(n.source)), (chunk) => [...chunk]),
      }),
    );
  return go(stream);
};
