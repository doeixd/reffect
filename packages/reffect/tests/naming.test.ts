import { expect, test } from "vite-plus/test";
import { namingDigest } from "../src/naming.ts";

// The 32-bit FNV-1a that names composites, encoders and codecs used before #30.
const fnv32 = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

test("names that collided under the 32-bit digest are distinct (#30)", () => {
  // Published FNV-1a 32-bit collisions: two different composites got one name and were refused.
  for (const [a, b] of [
    ["costarring", "liquid"],
    ["declinate", "macallums"],
    ["altarage", "zinke"],
  ]) {
    expect(fnv32(a), `${a}/${b} under FNV-1a`).toBe(fnv32(b));
    expect(namingDigest(a)).not.toBe(namingDigest(b));
  }
});

test("the digest is pinned and distinct across many keys", () => {
  // Pinned: generated names must not change between builds or releases unnoticed.
  expect(namingDigest("reffect/struct@1")).toBe("1fc19fc5cb78696e");
  const keys = Array.from({ length: 200_000 }, (_, i) => `{"fields":[["f${i}","u64"]]}`);
  expect(new Set(keys.map(namingDigest)).size).toBe(keys.length);
  // Code units, so a lone surrogate and its replacement character name differently.
  expect(namingDigest("\ud800")).not.toBe(namingDigest("�"));
});
