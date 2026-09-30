# Effect Native roadmap

Effect Native is an ahead-of-time compiler for a statically representable subset of Effect v4 programs. TypeScript executes an Effect-shaped DSL to construct typed IR; a reference interpreter runs that IR through official Effect, and a native backend lowers it to Rust.

This file is the entry point for the vision and sequencing. Detailed design discussions live in [docs/](docs/README.md). Read [PROGRESS.md](PROGRESS.md) for completed work and current implementation status; roadmap items below describe intended capabilities, not shipped features.

## How to use this plan

1. Read the constraints below before choosing an implementation approach.
2. Use the document map to read the design relevant to the task.
3. Check PROGRESS.md and the actual code before assuming an API or milestone exists.
4. Build the smallest vertically complete capability and validate it against the official Effect implementation.
5. Record completed work, validation, and remaining questions in PROGRESS.md. Update this roadmap when priorities or constraints change.

## Design constraints

- Effect stays a dependency and the semantic reference implementation. The JS interpreter delegates execution to official Effect.
- Initially compile explicit typed IR built by symbolic callbacks. Arbitrary TypeScript control flow, generators, operators, loops, and opaque callbacks are outside the compiled subset; build-time TypeScript remains unrestricted.
- Every runtime value has a known CType and native representation. Effect Schema supplies semantic type descriptions; host-dependent transforms require a native implementation or a later hybrid target.
- Match is the initial branching construct. Predicates and structured collection/effect combinators represent branching and iteration as data.
- Infer moves, borrows, sharing, and cloning. Ref expresses shared mutable identity; RcRef/RcMap express resource lifetime. Neither is an alias for Rust borrowing or memory reference counting.
- Compile Effect composition, Context lookups, Layers, and other abstractions away whenever their observable semantics permit it. Preserve Layer sharing/freshness, cancellation, finalizers, and resource lifetimes.
- Use Tokio, Hyper/Tower/Axum, Serde, and SQLx for their native facilities. Keep the Effect-specific runtime focused on supervision, interruption, Scope, observable Exit/Cause, and related semantic adapters.
- The compiler is an Effect library with Services and Layers. The CLI, tests, editors, and build integrations consume the same public compiler API.
- Preserve stock client compatibility: official Effect RPC clients and Foldkit hydration/resume protocols are acceptance targets.
- Keep the IR stable as later syntax producers and hybrid targets broaden authoring options.

## Document map

| Document                                             | Read when working on                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Compiler architecture](docs/architecture.md)        | CType/Schema, Expr, Predicate, Match, functions, ownership, Services/Layers, fibers, Scope, platform lowering, validation, operation registry, original milestones |
| [RPC MVP](docs/rpc-mvp.md)                           | First stock-client demo, shared contracts, unary JSON/HTTP, typed handlers, initial cancellation and streaming upgrades                                            |
| [RPC protocol and transports](docs/rpc-protocol.md)  | Middleware, stream acknowledgements/backpressure, sessions, reverse RPC, notifications, JSON/NDJSON/SchemaBinary, WebSocket/TCP, custom codecs                     |
| [Compiler library API and CLI](docs/compiler-api.md) | Declarative Compile.Spec, targets, compiler services/stages, check/run/watch, results, diagnostics, extension and support metadata                                 |
| [Foldkit SSR and SSG](docs/foldkit-ssr.md)           | Server-reachable init/view/routing, HTML IR, hydration compatibility, native rendering, SSG, streaming HTML                                                        |
| [Foldkit Remote and SQL](docs/foldkit-remote.md)     | Native RemoteServer, Sources, Entity/Query IR, conformance tests, storage bindings, SQLx, authorization, mutations, liveHub, SSR resume                            |

The documents preserve the original discussions and examples. API spellings and package names are provisional. Some discussions propose different demo orderings; the sequence below consolidates them around their dependencies. Original citation placeholders do not resolve to sources: verify external claims against the installed Effect v4 API and relevant upstream specifications when implementing them.

## Implementation sequence

The original architecture defines milestones 0–9; the RPC and Foldkit discussions add concrete demonstration paths. Use this sequence for planning while retaining those detailed proposals in the linked documents.

| Step                                   | Scope                                                                                                                                   | Acceptance evidence                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. IR kernel and reference interpreter | CType, Expr, Predicate, Match, Fn, Effect, stable serialization; primitive and structured data                                          | Validated IR executes through official Effect; property/differential fixtures establish reference semantics     |
| 2. Pure Rust backend                   | Pure functions, structs/enums, strings, predicates, collections; move/borrow analysis                                                   | Generated Rust builds and matches JS reference results for the supported subset                                 |
| 3. Effect basics and compiler API      | Async/typed failure, Services, Layer planning, Scope, timers/retry; library stages and thin CLI                                         | A real CLI application builds through the public API; resource and Layer semantics have reference coverage      |
| 4. Unary RPC MVP                       | Shared RpcGroup/Schema contracts, codecs, dispatcher, JSON/HTTP transport                                                               | An unmodified Effect RpcClient calls the generated Rust binary and observes matching successes and typed errors |
| 5. Request semantics and concurrency   | Middleware/request services, interruption/finalizers, structured concurrency and required synchronization primitives                    | Client interruption finalizes native resources; auth/context and concurrent handler behavior match Effect       |
| 6. Native Remote and query semantics   | In-memory Sources, normalized responses, Entity/Query IR interpreter                                                                    | Stock foldkit-remote talks to Rust; upstream query conformance cases agree on IDs and ordering                  |
| 7. SQL and streaming                   | Storage bindings → SQLx; scoped cursors, RPC chunks/acknowledgements, NDJSON and bounded backpressure                                   | Database-backed RPC/Remote works; stopping consumption closes streams and scoped resources                      |
| 8. Foldkit SSR integration             | Native route/Flags/init/view renderer, Data.satisfy, in-process Remote handlers, minimal resume payload                                 | Stock Foldkit hydrates native HTML; resumed data avoids duplicate startup fetching                              |
| 9. Broader coverage and targets        | WebSocket sessions, notifications/reverse RPC, SchemaBinary/TCP/custom codecs, richer resources, syntax widening and Node/native hybrid | Each new profile has explicit compatibility tests and reports unsupported or host-dependent operations          |

Pure SSR/SSG can be explored after unary RPC without waiting for Remote/SQL. The integrated SSR demo depends on data loading and resume support. Extend runtime coverage in response to these demos rather than attempting the full Effect surface before proving interoperability.

The intended combined showcase is one generated Rust binary serving Foldkit HTML, Effect RPC, Remote data, live streams, and SQLx-backed storage while an ordinary TypeScript browser bundle hydrates and uses stock clients.

## Validation strategy

- Compare the same IR through the official Effect JS interpreter and generated Rust, including failure and resource behavior when observable.
- Test RPC interoperability with the official client, including cancellation, streaming, middleware, and framing as each profile becomes supported.
- Cross-encode/decode SchemaBinary with Effect; compare bytes where canonical encoding requires it.
- Run Entity/Query conformance cases against reference, SQL, and Rust implementations.
- Compare Foldkit rendering output and verify successful stock hydration and Remote resume.

Use [AGENTS.md](AGENTS.md) for repository tooling, commit, and review requirements.

## Decisions to settle during implementation

- Exact public names and package/crate boundaries: C/Compiled/Native and effect-native are design vocabulary, not a finalized API.
- The supported portable Schema subset and boundary representations for numeric, JSON, SQL, and binary values.
- The installed Effect version and precise RPC wire/profile semantics to pin for compatibility tests.
- Ownership/access-mode rules, escaping task captures, and when shared ownership or cloning is necessary.
- Which Effect semantics require runtime representation and which can be erased for each capability profile.
- The extension contract for native intrinsics, platform backends, and serializers; later syntax and hybrid-host boundaries.
