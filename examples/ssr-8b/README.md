# Milestone 8B: the upstream SSR example, translated

`page.ts` is generated, not written. reffect's translator (`packages/reffect/src/ssr-translate.ts`) reads the pinned, unmodified upstream Foldkit example (`foldkit@0.165.0` `examples/ssr`, vendored in `packages/reffect/tests/fixtures/upstream-ssr`). Through the TypeScript 7 API, it writes these R builders.

- **Regenerate:** `REFFECT_REGENERATE=1 vp test tests/ssr-translate.test.ts` from `packages/reffect`. Without the variable, the test checks that a fresh translation still equals this file.
- **Acceptance:**
  - `tests/ssr-8b.test.ts` serves `page` natively. Its answers equal the pinned example's own `renderPage`, run through Vite with the build id the Foldkit plugin compiles in.
  - `tests/ssr-8b-hydrate.test.ts` checks that the pinned client entry hydrates the native page.

The design and evidence are in `docs/research/ssr-codemod.md`.
