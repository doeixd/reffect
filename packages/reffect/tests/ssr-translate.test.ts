/**
 * Milestone 8B step 2 (docs/research/ssr-codemod.md): the pinned upstream SSR source translates
 * to the committed R builder module, the same way every time, and a construct outside the
 * profile is refused with its location. `REFFECT_REGENERATE=1` rewrites the committed module.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { CompileError } from "../src/index.ts";
import { translateSsr } from "../src/ssr-translate.ts";

const fixture = "tests/fixtures/upstream-ssr";
const generated = "../../examples/ssr-8b/page.ts";
const options = (root: string) => ({
  tsconfig: `${root}/tsconfig.json`,
  entry: `${root}/src/entry.server.ts`,
  reffect: {
    authoring: "../../packages/reffect/src/authoring.ts",
    kernel: "../../packages/reffect/src/kernel.ts",
  },
  buildId: "ssr-8b",
  provenance: "foldkit@0.165.0 examples/ssr (packages/reffect/tests/fixtures/upstream-ssr)",
});
/** The translation as the repository formatter writes it. */
const formatted = (source: string) => {
  const candidate = resolve("../../examples/ssr-8b/.page.candidate.ts");
  writeFileSync(candidate, source);
  try {
    execFileSync("vp", ["fmt", candidate], { stdio: "pipe", shell: process.platform === "win32" });
    return readFileSync(candidate, "utf8");
  } finally {
    rmSync(candidate, { force: true });
  }
};

test("the pinned source translates to the committed module, the same way twice", async () => {
  const first = await translateSsr(options(fixture));
  const second = await translateSsr(options(fixture));
  expect(second).toBe(first);
  const module = formatted(first);
  if (process.env.REFFECT_REGENERATE === "1") writeFileSync(generated, module);
  expect(module).toBe(readFileSync(generated, "utf8"));
  // The output needs no casts.
  expect(module).not.toMatch(/ as (never|unknown|any)\b/);
}, 120000);

test("a construct outside the profile is refused with its file and position", async () => {
  // A mutated copy beside the fixture, so packages still resolve.
  const root = mkdtempSync(join("tests/fixtures", "upstream-ssr-mutated-"));
  try {
    cpSync(fixture, root, { recursive: true });
    const main = join(root, "src/main.ts");
    const source = readFileSync(main, "utf8");
    writeFileSync(main, source.replace("[model.count.toString()]", "[model.count.toFixed(2)]"));
    const error = await translateSsr(options(root)).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(CompileError);
    const line =
      source.split("\n").findIndex((text) => text.includes("model.count.toString()")) + 1;
    expect((error as CompileError).message).toContain("toFixed");
    const path = (error as CompileError).diagnostics[0]?.path ?? "";
    expect(path).toMatch(/^src\/main\.ts:\d+:\d+$/);
    expect(path.split(":")[1]).toBe(String(line));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
