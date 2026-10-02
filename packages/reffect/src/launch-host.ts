import { Context, Effect } from "effect";

/** Reference host for the internal Launch node: receives server-lifetime service values once. */
export class LaunchHost extends Context.Service<
  LaunchHost,
  { readonly publish: (values: readonly unknown[]) => Effect.Effect<void> }
>()("reffect/LaunchHost") {}
