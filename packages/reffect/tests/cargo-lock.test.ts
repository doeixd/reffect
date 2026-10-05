import { expect, test } from "vite-plus/test";
import { unlockedPackages } from "../src/cargo.ts";
import { RuntimeCargoLock } from "../src/runtime-sources.generated.ts";

const registry = 'source = "registry+https://github.com/rust-lang/crates.io-index"';
const entry = (name: string, version: string, checksum: string) =>
  `[[package]]\nname = "${name}"\nversion = "${version}"\n${registry}\nchecksum = "${checksum}"\n`;
const pinned = `version = 4\n\n${entry("serde", "1.0.0", "aa")}\n${entry("itoa", "1.0.1", "bb")}`;

// #41: a generated build resolves against reffect's lock; anything it reaches outside that lock
// would come from the local registry cache, so it must be reported.
test("a resolved lock is checked against the pinned crate set", () => {
  const root =
    '[[package]]\nname = "reffect_generated"\nversion = "0.0.0"\ndependencies = ["serde"]\n';
  expect(
    unlockedPackages(`version = 4\n\n${root}\n${entry("serde", "1.0.0", "aa")}`, pinned),
  ).toEqual([]);
  expect(
    unlockedPackages(
      `version = 4\r\n\r\n${entry("serde", "1.0.1", "aa")}\n${entry("itoa", "1.0.1", "cc")}\n${entry("ryu", "1.0.0", "dd")}`,
      pinned,
    ),
  ).toEqual(["serde@1.0.1", "itoa@1.0.1", "ryu@1.0.0"]);
});

test("reffect's own lock pins every crate it lists", () => {
  expect(RuntimeCargoLock).toContain('name = "subtle"');
  expect(RuntimeCargoLock).toContain('name = "signal-hook-registry"');
  expect(unlockedPackages(RuntimeCargoLock)).toEqual([]);
});
