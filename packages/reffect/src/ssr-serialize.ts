/**
 * The native subset of Foldkit's SSR serializer (SSR-003): text and attribute escaping with
 * upstream's NUL refusal, and the hydration key fingerprint. A line-for-line port of foldkit
 * 0.165.0 `experimental/server/serialize.js` (`escapeText`, `escapeAttributeValue`,
 * `assertRepresentable`) and `hydrationMarkers.js` (`fingerprint`, `hydrationKeyMarker`), MIT.
 * Rust strings hold no lone surrogates, so only NUL needs refusing here.
 */
import { runtimeModule } from "./runtime-module.ts";

export const ssrSerializeRuntime = runtimeModule("foldkit_ssr", "crate-private");
