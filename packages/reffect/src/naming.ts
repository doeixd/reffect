/**
 * The digest generated names and composite witness ids are built from (#30). Names must be stable
 * across builds and distinct within one, and a collision is refused (`NATIVE_NAME_COLLISION`, a
 * schema-json `TYPE_MISMATCH`) rather than miscompiled. A 32-bit FNV-1a gave about a 1% chance of
 * such a refusal at 10k composites; 64 bits put it near 3e-12.
 *
 * cyrb64: two 32-bit multiply-xor lanes over UTF-16 code units with a final avalanche mix,
 * synchronous and dependency-free, so it runs wherever the compiler does. Not cryptographic.
 */
export const namingDigest = (text: string): string => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ unit, 2654435761);
    h2 = Math.imul(h2 ^ unit, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
};
