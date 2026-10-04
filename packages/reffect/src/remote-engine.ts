/**
 * The native Foldkit Remote read engine (NR-001, NR-008..011): a line-for-line Rust port of
 * `foldkit-remote-server`'s `readHelper`, `splitAliases`, `groupByEntity`, `allowedFields`,
 * `windowsOf`, limit checks, and the memory backend's `valueFor`/`pageOf`, over validated JSON.
 * Upstream: foldkit-plus `packages/remote-server/src/index.ts` and `packages/remote/src`
 * (`relation.ts`, `requirement.ts`), MIT, Copyright (c) 2026 Patrick Glenn.
 */
import { runtimeModule } from "./runtime-module.ts";

export const remoteEngineRuntime = runtimeModule("remote_engine", "crate-private");
