// Test-only upstream snapshot of foldkit/foldkit@0b2a4fd04171afa8c8911d22aa9bec2f22faae52
// packages/foldkit/src/experimental/server/serialize.ts lines 185-243 and 259-281; logic unchanged,
// formatted to repository style.
// See FOLDKIT-LICENSE and docs/research/string-profile.md.

// NOTE: `\r` is escaped because the HTML parser normalizes CR and CRLF to LF
// before tokenization; a verbatim carriage return would read back as a
// different string and guarantee a hydration mismatch. The entity survives
// tokenization and decodes back to the original character.
const TEXT_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\r": "&#13;",
};

const ATTRIBUTE_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  '"': "&quot;",
  "<": "&lt;",
  // As in text, a carriage return is normalized away (CR and CRLF collapse to LF
  // before tokenization) unless encoded as a character reference, which decodes
  // back to the original after normalization.
  "\r": "&#13;",
};

// NUL (U+0000) has no HTML representation: the tokenizer replaces it with U+FFFD
// or drops it, so it can never round-trip. It is rejected wherever a value is
// escaped for output rather than silently corrupted.
const assertNoNul = (value: string, context: string): void => {
  if (value.includes("\u0000")) {
    throw new Error(
      `[foldkit] ${context} contains a NUL (U+0000) character, which has no ` +
        "HTML representation and cannot round-trip. Remove it from the value.",
    );
  }
};

// A high surrogate with no low one after it, or a low surrogate with no high one
// before it. Such a code unit is not a character: encoding the page as UTF-8,
// which every HTTP response and generated file does, replaces it with U+FFFD, so
// what a visitor receives is not what the view rendered.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const assertNoLoneSurrogate = (value: string, context: string): void => {
  if (LONE_SURROGATE.test(value)) {
    throw new Error(
      `[foldkit] ${context} contains an unpaired surrogate code unit, which ` +
        "is not a character. Encoding the page as UTF-8 replaces it with " +
        "U+FFFD, so the served text would not be the text the view rendered. " +
        "Remove it from the value.",
    );
  }
};

// Everything a serialized value must satisfy to survive the trip through an
// HTML parser and a UTF-8 encoder unchanged.
const assertRepresentable = (value: string, context: string): void => {
  assertNoNul(value, context);
  assertNoLoneSurrogate(value, context);
};

/** Escapes a string for use as HTML text content.
 *
 * @internal Shared with the template injector; not part of the `foldkit/experimental/server` surface.
 */
export const escapeText = (value: string): string => {
  assertRepresentable(value, "text content");
  return value.replace(/[&<>\r]/g, (character) => TEXT_ESCAPES[character] ?? character);
};

/** Escapes a string for use inside a double-quoted HTML attribute value.
 *
 * @internal Shared with the template injector; not part of the `foldkit/experimental/server` surface.
 */
export const escapeAttributeValue = (value: string): string => {
  assertRepresentable(value, "attribute value");
  return value.replace(/[&"<\r]/g, (character) => ATTRIBUTE_ESCAPES[character] ?? character);
};
