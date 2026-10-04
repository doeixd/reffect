import { expect, test } from "vite-plus/test";
import { runtimeModuleNames, runtimeModuleText } from "../scripts/runtime-sources.ts";
import { RuntimeSources } from "../src/runtime-sources.generated.ts";

// LIVE-012: the emitters inline the generated module bodies, so they must be the `.rs` files'.
test("the generated runtime sources match runtime/src (run `vp run runtime:gen`)", () => {
  const names = runtimeModuleNames();
  expect(Object.keys(RuntimeSources).sort()).toEqual(names);
  for (const name of names)
    expect(RuntimeSources[name as keyof typeof RuntimeSources], name).toBe(runtimeModuleText(name));
});
