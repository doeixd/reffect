# Shared owned execution cancellation

Prepared2026-10-07 against AGENTS, PLAN/PROGRESS, QEXEC's signal-override finding, all four owned runners and their cancellation/finalization tests. This repairs an existing public-runner boundary without widening any Effect profile or changing native code.

## Primary evidence

Freshly fetched [Effect4.0.0 internal/effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts), matching installed SHA256 `68c43e18e167d17b39f224d3793f11c7732cd857b7908ecd3ff1d1edf0affac2`. runForkWith eagerly evaluates before ordinary signal.aborted/listener property access. A genuine AbortSignal can shadow those properties, so an intrinsic brand check alone does not preserve preabort or exclude external hooks. [Node24.19.0 AbortSignal implementation](https://github.com/nodejs/node/blob/v24.19.0/lib/internal/abort_controller.js) matches this workspace's runtime; its native getter validates the receiver and reads the underlying aborted state. QEXEC established Queue's intrinsic getter/listener relay and listener retirement.

## Decisions before implementation

- **OCAN-001 — One internal cancellation helper.** Extract Queue's plain-options/brand validation and intrinsic signal relay into owned-execution-signal.ts. Parameterize refusals so each module retains its existing structured diagnostics. A generic Promise result helper receives a preabort observation factory and a start callback accepting only the owned signal. Context construction, semantic profile checks, logs and frame interpretation remain owned by each module. No public helper export, native runtime change, dependency or scalar metadata.
- **OCAN-002 — Preflight and lifetime.** Preserve each runner's option/identity/growth/profile check order before any listener/source work. The helper checks native aborted state before starting, installs an intrinsic listener into a fresh AbortController, checks again, and invokes the existing Effect runner with only the fresh signal. Retire its own listener on fulfillment, rejection and synchronous start errors, leaving unrelated listeners intact. No-signal calls start directly; preabort creates no context or authored logs. Options use descriptors and never invoke a signal option getter. Global runtime monkeypatches and host Proxy traps remain outside the trusted native-signal assumptions. Forwarding follows ordinary AbortSignal event propagation, as the official runner does; host event interception is outside this repair.
- **OCAN-003 — Preserve semantics and receipts.** Deferred, Semaphore and Latch run/runWithFrames keep their public types, default2048 contexts, immutable log observations and existing interruption trails. Masked finalization still settles before return; forwarding cancellation does not add Effect primitives or change the operation receipts. Queue shares the same helper and remains private, with native frames/public admission gated.
- **OCAN-004 — Regression evidence before repair.** Write module/mode regressions using genuine pre-aborted signals with a lying own aborted getter. Source must remain unopened, the getter must stay uncalled and the outer Exit interrupted. Those cases must fail on the old public runners. Also test live signal overrides, listener cleanup and awaited masked finalization. Test shared helper start failures, Promise rejection and unrelated listeners independently, then retain all owned-runner suites and Queue generated debug/release conformance. Native builds remain serial.

## Alternatives and acceptance

Copying the relay into every module would duplicate lifecycle and brand validation. Rejecting all signals with overrides would change previously accepted same-realm branded inputs. Passing external signals directly retains the bug. Extract only cancellation mechanics; a generic executor/profile/frame framework would add unnecessary coupling.

Acceptance requires the old-runner reproducer to fail, repaired plain/framed runners to preserve cancellation and cleanup, stable module-specific refusal codes, clean strict/full checks and builds, and no native layout/allocation change. Record the outcome and remove the completed open-work item. Wider signal/host/coordination profiles and generated Queue frames stay separate.

## Delivered evidence

The pre-aborted lying-getter reproducer failed Deferred, Latch and Semaphore on their old public runners, while Queue passed. All four now delegate plain-options validation and signal forwarding to the internal helper with module-specific refusal callbacks and typed observation results. No Effect primitive, frame decoration, native storage or dependency is added.

Six helper lifecycle tests and sixteen cross-module regressions accompany the four original owned-runner suites:54 tests across6 suites pass. Both execution modes preserve unopened preabort, property-hook isolation, awaited masked cleanup and listener retirement. Rejection and synchronous start errors preserve their original errors and retire only their own listener. Independent extraction review found no blocker.

Generated Queue debug/release parity remains unchanged, including its continuation negative mutation, controlled native allocation counts0 and existing returned-future layouts. Strict package TypeScript, full workspace check and build accompany delivery. The legacy-runner follow-up is complete; wider host contracts and Queue native frames/public admission remain separate.
