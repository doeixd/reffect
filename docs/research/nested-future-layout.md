# Nested future storage investigation

Prepared 2026-10-05 before layout experiments. Read the current plan/progress,
nested topology/lowering/runtime/conformance records, generated TaskGroup
emission, and DeferredTurnHandle task wrapper. Root owns implementation; this
record investigates layout and pinning without broadening the private profile.

Primary sources checked on this date:

- [Rust local pin macro](https://doc.rust-lang.org/std/pin/macro.pin.html): a pinned
  local crossing await occupies the enclosing future's storage; local pinning
  does not imply heap allocation. The borrow cannot escape its owning block.
- [Rust pin contract](https://doc.rust-lang.org/std/pin/index.html): a pinned
  pointee must remain valid at its address until its destructor finishes.
- [Tokio 1.53.1 pin macro source](https://github.com/tokio-rs/tokio/blob/tokio-1.53.1/tokio/src/macros/pin.rs):
  the macro moves its input into a shadowed owned local before borrowing it.
  Unsafe projection stays encapsulated in the upstream macro.

## Candidate and proof obligations

**NFL-001 — Borrow at the group-driver boundary first.** Generated code currently
creates by-value child futures, then passes them into another async function
which pins them locally. A checked private driver accepting `Pin<&mut F>` can
poll caller-pinned children without carrying another by-value generic future
through that async boundary. Keep generic concrete futures, inline owners,
fixed routes and the existing task acknowledgement wrapper. No Box, spawn,
new context field or public profile expansion is needed.

The caller must declare child contexts before futures, pin futures before
constructing the driver, await/drain the driver inside that block, and never move
the pinned pointees afterward. `Pin<&mut F>` does not require `F: Unpin`; moving
the pin reference is allowed. Poll using `as_mut()` to create a shorter reborrow.
The driver may own cancellation senders/receiver as before. Ordinary non-Deferred
coordinators can retain their existing ownership boundary.

**NFL-002 — Preserve the task wrapper initially.** DeferredTurnHandle.task
acknowledges semantic Ready versus Pending. Removing it while changing storage
would mix layout optimization with completion-turn semantics. If its own async
by-value argument causes substantial inflation, evaluate a separate borrowed
wrapper later, preserving identical poll/ack behavior and owner drop ordering.

Validation must distinguish observed compiler layout from a language guarantee:
measure standalone owned/borrowed equivalents with rustc debug/release, then
measure the actual four emitted nested workloads and retain their exact traces,
interruption/finalizer drainage, public refusals and quiet allocation budget.
The existing 33–44 KB measurements are observations, not portable ABI values.

## Standalone measurements

Rust 1.98.1 (`48a229cea`, x86-64), both `rustc --edition=2024` and the same
command with `-O`, reports identical layouts below. A concrete leaf Future
contains `[u8; 1024]`, returns Pending, and keeps its payload observable through
`std::hint::black_box`. The owned wrapper pins its generic argument and awaits
`poll_fn`; the borrowed wrapper receives `Pin<&mut F>` and awaits the same poll
closure. The task wrapper repeats the owned pin/poll structure, matching the
storage-relevant part of the existing acknowledgement adapter.

| Construction                                             | Owned driver | Caller-pinned borrowed driver |
| -------------------------------------------------------- | -----------: | ----------------------------: |
| Caller containing one payload leaf                       |       2080 B |                        1072 B |
| Caller retaining the task wrapper around that leaf       |       4176 B |                        2120 B |
| One additional nested driver around the preceding caller |       8384 B |                        2168 B |

The owned driver alone is 2072 bytes. The nested borrowed case keeps the task
wrapper while avoiding repeated doubling at group boundaries. Repeating the
experiment with Tokio's exact move/shadow/borrow macro expansion instead of
`std::pin::pin!` produces the same measurements. No project-native suite or
Cargo lane was used: standalone commands compile `/tmp/nested-future-layout.rs`
and `/tmp/nested-future-layout-tokio.rs` in debug and optimized modes.

**NFL-003 — Treat shrinkage as a measured compiler property.** Rust's async
layout is unspecified. These measurements establish the hypothesis on the
project toolchain; actual generated invocation measurements must establish the
benefit for the admitted workloads. A relative future-size regression gate is
more robust than requiring these standalone or native exact byte counts.

## Lifetime and semantic risks

- The borrowed coordinator stores references to future locals inside its
  caller's async state. This is supported local pinning; the outer future itself
  must be pinned before polling, as required by the Future API. The compiler
  tracks those local borrows. Never manufacture the driver in a helper that
  returns references to its own locals.
- Borrowed futures must remain in scope until the driver finishes. The driver
  still needs every existing Ready/started/loser-drain check: a borrowed future
  is not permission to repoll after Ready or stop awaiting cleanup.
- When a driver returns, its pinned child future storage remains alive until
  the generated block ends. This may shift destructor timing slightly compared
  with owned children dropped at driver return. The admitted source profile has
  no user-defined native Drop hook, and registered Deferred waiters must already
  be drained before return; verify those conditions rather than assuming
  pinning proves them. Generated driver call is immediately matched inside the
  same block, so no authored continuation occurs between return and local drop.
- Forced host Drop/panic during an armed completion remains unsupported, exactly
  as before. Borrowing establishes memory validity, not a new cancellation
  contract. Ordinary coordinator and public admission behavior remain unchanged.

Recommendation: implement NFL-001 alone first, retain task acknowledgement,
and run the actual exact-trace/cost matrix. Consider a separately borrowed task
adapter only if remaining measured future growth justifies that additional
semantic surface.
