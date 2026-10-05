/**
 * Nesting depth of authored IR (#29). Every compiler pass walks the IR recursively, and rustc
 * nests generated code as deeply, so a program nested past `NESTING_LIMIT` is refused with a
 * structured diagnostic before any recursive pass runs. The measure itself keeps an explicit
 * stack, so it cannot overflow on the programs it refuses.
 */
import { Computation, EffectFn } from "./effect-ir.ts";
import { Expr, Fn } from "./kernel.ts";
import { StreamIR } from "./stream-ir.ts";

/**
 * The deepest chain of nested expressions, computations, streams and function bodies a program
 * may hold. Twice this compiled through every pass in the 2026-10-05 probe; beyond about four
 * times it the passes overflowed the stack.
 */
export const NESTING_LIMIT = 512;

type IrNode =
  | Expr<unknown>
  | Computation<unknown, unknown>
  | StreamIR<unknown, unknown>
  | Fn
  | EffectFn;
const isIrNode = (value: unknown): value is IrNode =>
  value instanceof Expr ||
  value instanceof Computation ||
  value instanceof StreamIR ||
  value instanceof Fn ||
  value instanceof EffectFn;
const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * The IR nodes directly inside `node`: those its fields hold, through arrays and plain records
 * such as Match cases. Operations, witnesses and literal data hold none.
 */
const childrenOf = (node: IrNode): IrNode[] => {
  if (node instanceof Fn || node instanceof EffectFn) return [node.body];
  if (node instanceof Expr && node.node._tag === "Literal") return [];
  const found: IrNode[] = [];
  const pending: unknown[] = [node.node];
  while (pending.length) {
    const value = pending.pop();
    if (isIrNode(value)) found.push(value);
    else if (Array.isArray(value)) for (const item of value) pending.push(item);
    else if (isPlain(value)) for (const item of Object.values(value)) pending.push(item);
  }
  return found;
};

/**
 * The nesting depth below `root`, counting `root` as 1, or `undefined` once it exceeds `limit`.
 * Shared subterms are measured once; a cycle (which `check` reports) adds nothing.
 */
export const nestingDepth = (root: IrNode, limit = NESTING_LIMIT): number | undefined => {
  const depth = new Map<IrNode, number>();
  const entered = new Set<IrNode>();
  const stack: IrNode[] = [root];
  while (stack.length) {
    const node = stack[stack.length - 1];
    if (depth.has(node)) {
      stack.pop();
      continue;
    }
    const children = childrenOf(node);
    if (!entered.has(node)) {
      entered.add(node);
      for (const child of children) if (!entered.has(child)) stack.push(child);
      continue;
    }
    stack.pop();
    let deepest = 0;
    for (const child of children) deepest = Math.max(deepest, depth.get(child) ?? 0);
    if (deepest + 1 > limit) return undefined;
    depth.set(node, deepest + 1);
  }
  return depth.get(root);
};
