# Foldkit-Plus issues found during Query native integration

Checked 2026-09-30 against source commit `f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c`, published `foldkit-entity@0.4.0`, `foldkit-remote@0.8.0`, `foldkit-remote-drizzle@0.8.0`, Effect `4.0.0-rc.118`, and Drizzle `1.0.0-rc.4`. These are recorded findings, not upstream fixes or filed GitHub issues. Reproductions live in [the upstream regression tests](../../packages/reffect/tests/foldkit-upstream.test.ts), except the package-import failure reproduced below.

## Contains disagrees for Unicode and NUL text

**Confirmed semantic bug.** [Expr documentation](https://github.com/doeixd/Foldkit-Plus/blob/f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c/packages/entity/src/expr.ts) promises ASCII folding to match SQLite. [evaluate](https://github.com/doeixd/Foldkit-Plus/blob/f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c/packages/entity/src/evaluate.ts) calls Unicode `toLowerCase`. [Drizzle compilation](https://github.com/doeixd/Foldkit-Plus/blob/f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c/packages/remote-drizzle/src/compile.ts) emits SQLite lower/LIKE.

For a row whose text is `É`, searching for `é` matches in evaluate and does not match in stock SQLite. For `a\u0000b`, searching for `b` matches in evaluate but not SQLite LIKE, which stops at NUL. The published conformance cases cover ASCII, percent, underscore and null but miss both disagreements.

Suggested upstream work: decide the supported Unicode/NUL contract, implement the same behavior across interpreters or explicitly refuse values outside the portable profile, then add shared conformance cases. reffect currently refuses evaluated non-ASCII/NUL containment operands rather than silently choosing one oracle.

## Shared expression DAGs expand exponentially in upstream traversal

**Confirmed performance bug.** `fieldsIn`/`checkOwnership` used by Query.where and the dependency `walk` have no visited-node set. Build a leaf predicate and repeatedly wrap it as `Expr.eq(previous, previous)`. A depth-12 graph has only 13 predicate objects, but Query.where and Query.dependencies each visit the leaf 4,096 times. Depth 128 can block the JS worker before a compiler ever receives the query.

The issue affects both query construction and support/dependency reporting, even though the IR permits shared immutable descriptions. Suggested upstream work: memoize visited expression identities, preserve first-seen report order, and detect cycles explicitly. reffect uses its own identity-aware, memoized check/report/lowering; its deep-DAG regression bypasses the upstream ownership builder specifically to isolate native compilation.

## Query clauses remain mutable after query construction

**Confirmed immutability/validation gap.** Query factories freeze the descriptor and clause arrays, but Expr factories return mutable objects and do not snapshot them. `Object.assign(predicate, { right: Expr.literal(false) })` after Query.where changes the existing query's result. Replacing a predicate's field with another Entity's field after construction bypasses the original ownership check; neither Query.dependencies nor evaluate revalidates ownership.

The design describes expressions as immutable values, so consumers must currently do additional defensive validation. Suggested upstream work: freeze or snapshot expression graphs, including scalar nodes; address mutable literal payloads separately. reffect validates field owners/witnesses and snapshots the primitive graph during compilation.

## Dependency reports conflate same-name Entity identities

**Confirmed reporting limitation.** `dependenciesOf` deduplicates fields by `${owner.name}.${key}` and exports only name/key. Two distinct Entity identities named `Item`, each with an `id`, collapse to one dependency when passed together to the public expression-report API. Query.where correctly rejects foreign identities at construction; this finding concerns the public report, not a claim that ordinary single-Entity queries read the wrong table.

Suggested upstream work: preserve owner tokens/identity descriptors in semantic dependencies and keep names as display fields. reffect's checker compares owner tokens and declared field witnesses rather than treating the display report as semantic authority.

## Published Remote/Drizzle peer range includes an incompatible Effect RC

**Confirmed package compatibility bug with RC.118.** `foldkit-remote@0.8.0` declares Effect `^4.0.0-rc.116`, which includes RC.118, but its published bundle imports `effect/unstable/rpc`. RC.118 exposes `effect/rpc` and has no corresponding unstable module. The source [wire.ts](https://github.com/doeixd/Foldkit-Plus/blob/f98f4d5cbaebb7aecf2ec636dd198fae01db5b1c/packages/remote/src/wire.ts) has the same old import. Importing the Drizzle entry point transitively loads Remote and fails before compileWhere can be used.

In a temporary project with Node 24:

```sh
npm init -y
npm install effect@4.0.0-rc.118 foldkit-remote-drizzle@0.8.0
node --input-type=module -e 'import("foldkit-remote-drizzle")'
```

Observed: `ERR_MODULE_NOT_FOUND` for `effect/dist/unstable/rpc.js`. Suggested upstream work: update and verify changed Effect import paths, narrow supported RC versions until tested, or provide an independently importable query-compiler subpath. reffect tests use a licensed snapshot of upstream compile.ts without importing the broken Remote dependency chain.

An initial incomplete local installation appeared to lack Drizzle dist files. A direct registry tarball inspection and completed reinstall showed the files present; **missing build output is not a confirmed upstream packaging issue**.

## Dependency declaration compatibility note

Drizzle RC.4 declarations fail TypeScript 7.0.2 checking with private-builder configuration and variance errors across dialects. This is a Drizzle/toolchain issue, not established as a Foldkit-Plus implementation defect (upstream uses TypeScript 5.9.3). reffect strictly checks authored code with skipLibCheck for dependency declarations and records that limitation in [the integration research](foldkit-query.md).

## Native Remote integration findings (2026-10-03, foldkit-plus 0.13.0)

Found while compiling a native RemoteServer against published `foldkit-remote`/`foldkit-remote-server` 0.10.0 and `foldkit-entity` 0.6.0 on Effect 4.0.0. These are suggestions; reffect works around each one.

- **`RemoteServer.memory` hides its server definition.** It returns only the store and an in-process `Remote.clientLayer`, so serving the memory backend over a real `RpcServer` means copying `memory`'s read and query-run closures (reffect's `tests/fixtures/foldkit-remote-memory.ts`). Suggested: expose the `ServerDefinition` (for example `backend.server`), so `RemoteServer.handlers(backend.server, undefined)` can be served directly.
- **`RemoteRpcClient` rejects a stock Effect RPC client.** Its error channels admit only Remote's errors, while `RpcClient.make(RemoteRpc)` also fails with `RpcClientError`. An application therefore needs a small transport adapter (`catchTag("RpcClientError", die)`); upstream's examples use hand-written transports instead. Suggested: accept transport errors in `clientLayer` (mapping them to a Remote error or defect), or document the adapter.
- **Ordering refusals name a sort-dependent pair.** `evaluate`'s `ordered` throws `orders by values this interpreter cannot compare (A and B)` and the null-key message for whichever pair V8's sort compares first. The text is engine-dependent and cannot be reproduced by another interpreter. Suggested: validate the order keys of all matched rows before sorting, and report the first offending row/key in row order (reffect's NR-017).
- **Object-prototype field names leak.** The read path's `field in row` and `renames[field] ?? field` lookups see `Object.prototype` members, so requesting a field named `constructor` or `toString` reads a function. Suggested: use `Object.hasOwn` and `Object.create(null)` maps.
- **`RemoteServer.entity(Entity, …)` drops relation fields.** It declares `Object.keys(entity.fields)`. For an entity from `Entity.relate`, those are only the scalar fields (`relations` holds the rest), so a requested relation such as `owner` is answered as withheld (settled) and never read. Reproduced on 2026-10-03: `RemoteServer.entity(Project, { read })` answered `{ values: { name } , settled: ["owner"] }` for `fields: ["name", "owner"]`. Suggested: declare `fields` plus `relations` keys. reffect's memory profile declares no fields (as `memory` does), so it is unaffected.
