# Pinned upstream SSR source (milestone 8B)

The input milestone 8B transforms, byte for byte as published (docs/research/ssr-codemod.md):

- `src/main.ts`, `src/entry.server.ts`, `src/cookie.ts`, `src/entry.ts` (the stock client): `foldkit/foldkit` `examples/ssr/src` at tag `foldkit@0.165.0`, commit `0b2a4fd04171afa8c8911d22aa9bec2f22faae52`.
- `foldkit-ui/button/index.ts`, `foldkit-ui/button/public.ts`: `packages/ui/src/button` at the same commit.
- `foldkit-ui/index.ts` is reduced to the one export the example imports (`Button`), and `tsconfig.json` maps `@foldkit/ui` to it; neither is upstream source.

SHA-256 of the upstream files:

```
de8f0caec68e8a3b1af89ca7558ab2c473842ee601def2dc7a16ad40b72b8b35  src/main.ts
5de244e5fcafd35f35d60c358c873135ba9f6fc712bd23badea29aa94901991f  src/entry.server.ts
c4dae1c01525404471c5617af1963444d5f66b70b9dd088b77549e77bbcc9f26  src/cookie.ts
6b65efdcf01bec01d1d4c0ac572a0ef0eff331d4299d27a498477c93b2d3c4bf  src/entry.ts
a3bca3a3a82591271f7bf5c7c75902bdae8a9eeff6815f09e68e4d099fad66e5  foldkit-ui/button/index.ts
ce512cd8e100cd1c7b82b8efb4d3201952c2f1c2b177a29c565536a47f7db551  foldkit-ui/button/public.ts
```

Foldkit is MIT licensed; see `../FOLDKIT-LICENSE`. Formatting and linting skip this directory so the bytes stay upstream's.
