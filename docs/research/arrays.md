# Arrays and structured iteration

Status: **accepted for implementation (2026-10-02)**, the next piece of the "Before milestone 4" gate after [records and tagged unions](records-unions.md). Checked against installed Effect **4.0.0-rc.118** (`effect/Array` `make`/`empty`/`length`/`map`/`filter`/`reduce`, `Effect.forEach`, `Schema.Array`) and the pinned `RpcServer` with raw JSON bodies.

## Prior work (searched first)

- [Architecture §6](../architecture.md#6-there-are-no-user-written-loops-initially) and [§27](../architecture.md#27-no-arbitrary-loops-improves-fibers): no user-written loops; iteration is structured (`map`, `filter`, `reduce`, `find`, `Effect.forEach`), the generated Rust may contain fused loops, and the compiler owns every loop for cancellation and yielding.
- [Architecture §9–§10](../architecture.md#9-native-representation-does-not-mean-fixed-payload-size): `Vector<T>` lowers to `Vec<T>`, distinct from fixed `Array<T, N>`; JS array semantics are not the runtime language. [§15](../architecture.md#15-operations-carry-access-requirements): `length` borrows, `push` needs `&mut`; read-only functions take slices.
- [Foldkit IR design](../foldkit-ir-design.md) sketches `vector.map`/`vector.filter` operations and composition. The historical name is `Vector`; AGENTS.md's rule to mirror Effect v4 spellings makes the R surface `R.Array`, following `effect/Array` and `Schema.Array`.
- [Records REC-004](records-unions.md#implementation-decisions): non-Copy values are borrowed by name, owned as locals, and copied only in value positions.
- Workload: the `foldkit-plus` Remote wire schemas use `Schema.Array` about 41 times (request batches, results, edges).

## Pinned upstream behavior

- `Array.map(self, (a, i) => b)`, `filter(self, (a, i) => boolean)` and `reduce(self, b, (b, a, i) => b)` are dual; `length` returns a JS number; `make(...elements)` requires a non-empty argument list; `empty()` builds `[]`.
- `Effect.forEach(self, (a, i) => effect, { concurrency?, discard? })` is sequential by default, stops at the first failure without running later elements, and returns results in order (or void with `discard: true`).
- `Schema.Array(item)` is a readonly `Arrays` AST. Decoding a non-array (object, null, string) fails with `Expected array`; element errors are reported first-error-only with **unquoted numeric** path segments: `Expected string\n  at [1]`, `Missing key\n  at ["items"][1]["count"]`, `Expected boolean\n  at [1][0]`.

## Decisions

- **ARR-001 — `R.Array(item)` witness.** It mirrors `Schema.Array`, is interned per item witness, and lowers to `Vec<T>`. It is Cloneable but not Copy.
- **ARR-002 — pure operations.** `R.Array.make(...elements)`, `R.Array.empty(item)`, `length` (u64 — narrower than Effect's number, but equal for every representable length), and dual `map`, `filter` and `reduce`. Callbacks receive the symbolic element and its u64 index, like Effect's `(a, i)`. Callbacks are pure `Expr`s in this slice.
- **ARR-003 — `R.Effect.forEach(self, f, { discard? })`.** Sequential and fail-fast, as upstream defaults; `concurrency` is refused until milestone 12.
- **ARR-004 — lowering.** Each operation is one generated loop over borrowed elements, calling the callback helper per element. `map` uses `Vec::with_capacity`. `reduce` keeps an owned accumulator, borrowed into each step. `forEach` returns on the first failure, and effect helpers keep their entry cancellation checks, so each iteration observes interruption. Loop fusion is deferred until a workload shows the need.
- **ARR-005 — RPC codec.** Recursive `Schema.Array(item)` decoding with `Expected array`, index path segments and first-error reporting; encoding produces JSON arrays. The native path chain gains an index segment.
- **ARR-006 — runner.** Array signatures join composite signatures in being verified through `NativeRpc`; runner arms skip them (REC-006).

## Part A delivered (2026-10-02)

`R.Array(item)` (interned, `Vec<T>`), `R.Array.make`/`empty`/`length` and dual `map`/`filter`/`reduce` with element and u64 index binders, over kernel nodes `ArrayMake`, `ArrayLength` and `ArrayLoop` (op `Map`/`Filter`/`Reduce`). The reference evaluates each iteration with a fresh cache. Native lowering emits one loop per operation over borrowed elements (`&[T]` helper parameters; Copy elements are dereferenced), with `Vec::with_capacity` for `map` and an owned accumulator for `reduce`. `R.Array.length` replaces the callable's built-in, read-only (but configurable) function `length`.

Evidence: [arrays.test.ts](../../packages/reffect/tests/arrays.test.ts) passes 3/3. Reference results equal `effect/Array` on u64, string, struct and union elements, index use and empty arrays; native debug/release under both frame policies agree. TypeScript 7 and 5.9 report no errors. Known extra copies: a `reduce` step that keeps its accumulator copies it, and filtered non-Copy elements are cloned into the output.

## Deferred

Index access and `findFirst` (both need `Option`), sorting (ordering semantics), `append`/`concat`, non-empty array types, fixed-size arrays, loop fusion, concurrent `forEach`, records/maps and `Chunk`.

## Acceptance

Reference results equal `effect/Array` and `Effect.forEach` on a corpus that includes empty arrays, strings and structs as elements, indexes, typed failure partway through `forEach` (later elements not run, as observed through logs), and suspension inside `forEach`. Native debug/release under both frame policies agree with the reference. Raw RPC requests with arrays (top-level, in struct fields, nested arrays, bad elements, non-arrays) match the official server exactly, and stock clients round-trip arrays.
