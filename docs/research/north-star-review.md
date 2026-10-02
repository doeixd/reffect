# Review of the north-star and runtime-strategy inputs

Reviewed 2026-10-02: [north-star acceptance input](../north_star.md) and [runtime strategy suggestions](../suggestions.txt), both preserved earlier as unverified design input. This record states which claims were verified, which are adopted, and which need a user decision. The inputs themselves stay unchanged.

## Verified claims

- **Pinned source exists.** `foldkit/foldkit` commit `0b2a4fd04171afa8c8911d22aa9bec2f22faae52` contains `packages/foldkit/src/experimental/server/` with `server.ts` (1,513 lines), `serialize.ts` (1,148), `template.ts` (947), `host.ts` (405), `fetch.ts` (131) and `entry.ts` (119), fetched through the GitHub API.
- **The Effect surface is small.** A syntax search of those six files finds `Effect.gen/fail/try/mapError/succeed/void`, `Schema.toCodecJson/encodeEffect/decodeUnknownSync`, `Option.match/isNone`, `Data.TaggedError`, `Context.empty`, `Match.value/tagsExhaustive` and a few `Array`/`Predicate`/`String` helpers. Most of the code is plain TypeScript: strings, collections, regular expressions, closures, local mutation and Foldkit's own HTML/VNode modules.
- **`parse5` is imported** by the SSR modules. The north star's claim that HTML parsing is the largest external dependency is consistent with the imports.
- **Not verified:** the `html5ever`, `url` and `serde_json` equivalence claims. They are plausible substrate candidates only; each needs conformance on Foldkit's admitted cases, as the input itself says.
- **Core versus ecosystem packages.** The local `foldkit-agent` checkout is `doeixd/foldkit-plus`, a collection of Foldkit ecosystem packages (Remote, entity, ssr and others), not a fork of `foldkit/foldkit`. The north star's SSR source is core Foldkit's `experimental/server`.

## Adopted

- **NS-1 — corpus-driven priorities.** Measure the server-reachable graph of a pinned real Foldkit SSR tree, and justify new representations or operations by the blockers they remove. This is the existing [migration tooling](../migration-tooling.md#target-scoped-analysis-and-reports) `rust:foldkit-ssr` analysis, moved earlier. The first step is an exploratory, non-mutating inventory script. It is not the public `Compile.analyze` API, which still needs structured diagnostic codes and a fix registry.
- **NS-2 — the codemod is the syntax frontend.** Ordinary `Effect.gen` and control flow become explicit `R` builders mechanically; the compiler keeps its explicit IR and syntax widening (milestone 15) stays late. This matches AGENTS.md and the migration design.
- **NS-3 — semantic foreign operations.** A JS reference package paired with a Rust implementation and conformance evidence (for example `parse5` with `html5ever`, WHATWG URL with `url`, JSON with `serde_json`) is an operation/implementation registry entry under existing policy, not a new mechanism. Each pairing stays a candidate until conformance passes.
- **Suggestions document.** It is consistent with decisions already in force: async Scope, interruption and finalization before RPC is complete (done as milestone 3A); erase/specialize/preserve; no similarly-named aliasing. New references recorded as candidates only: `id_effect` and related Rust Effect ports as design comparisons (source reuse needs licensing review), and Shuttle for controlled-schedule concurrency tests at milestone 12. Its module-tier ordering is **not** adopted as sequencing; workloads keep driving order (NS-1).

## User decision (2026-10-02)

The user prefers the existing PLAN sequence and asked that these inputs be taken with a grain of salt. Milestone order and acceptance criteria are unchanged; the north star and inventory stay as context, not as roadmap commitments. The original open questions follow for the record.

- **Q-1 — milestone 8 acceptance and order.** The north star proposes that milestone 8 accept only _unmodified_ upstream Foldkit SSR source, mechanically transformed, compiled and hydrated by the stock client. It would also move SSR ahead of Remote and SQL (milestones 4–7). That raises the bar substantially: a codemod for generators/control flow, strings/records/unions/collections, JSON/URL/RegExp operations, a VNode representation and a `parse5`-compatible parser. Recommendation: decide after the inventory quantifies the gap. Strings, records, unions and arrays gate milestones 4 and 8 alike, so the next representation work is useful either way.
- **Q-2 — which Foldkit (resolved).** `foldkit-plus` is an ecosystem package collection, not a fork: Remote targets its packages, while core Foldkit supplies the runtime and `experimental/server` SSR.

## Next

Run the inventory over the pinned upstream SSR graph ([results](foldkit-ssr-inventory.md)) and use it to pick the first owned-string/record workload.
