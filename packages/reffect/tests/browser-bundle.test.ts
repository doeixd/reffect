/**
 * #14: todo-remote's browser app runs the same R view the native server renders, through
 * `R.Html.toFoldkitView`. The browser bundle must carry the R authoring layer and its reference
 * interpreter only: never the compiler, lowering, Cargo, the RPC/Remote servers or the Rust
 * runtime sources they emit.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite-plus";
import { expect, test } from "vite-plus/test";

const COMPILER = [
  "compiler.ts",
  "lower.ts",
  "cargo.ts",
  "native-rpc.ts",
  "native-remote.ts",
  "rpc-runtime.ts",
  "ssr-page.ts",
  "runtime-sources.generated.ts",
];

test("the todo-remote browser bundle holds the R view but no compiler code", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "reffect-browser-"));
  try {
    await build({
      root: resolve(process.cwd(), "../../examples/todo-remote/web"),
      logLevel: "silent",
      build: { outDir, sourcemap: true, minify: false, emptyOutDir: true },
    });
    const assets = join(outDir, "assets");
    const map = readdirSync(assets).find(
      (name) => name.startsWith("index") && name.endsWith(".js.map"),
    );
    if (!map) throw new Error("No bundle source map");
    const { sources }: { sources: ReadonlyArray<string> } = JSON.parse(
      readFileSync(join(assets, map), "utf8"),
    );
    const reffect = sources
      .filter((source) => source.includes("packages/reffect/src/"))
      .map((source) => source.slice(source.indexOf("packages/reffect/src/") + 21));
    // The view itself is in: authoring, the Html IR and the reference that evaluates it.
    for (const module of ["authoring.ts", "html.ts", "html-ir.ts", "reference.ts"])
      expect(reffect, module).toContain(module);
    expect(reffect.filter((module) => COMPILER.includes(module))).toEqual([]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 120000);
