import { RuntimeSources } from "./runtime-sources.generated.ts";

/**
 * A static runtime module as generated crates inline it: the body from `runtime/src/<name>.rs`
 * in its `mod` item. Dead code is allowed because a crate reaches only part of each module.
 */
export const runtimeModule = (
  name: keyof typeof RuntimeSources,
  visibility: "pub" | "crate-private",
): string =>
  `\n#[allow(dead_code)]\n${visibility === "pub" ? "pub " : ""}mod ${name} {\n${RuntimeSources[name]}}\n`;
