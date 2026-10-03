import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess } from "effect/process";
import { NodeServices } from "@effect/platform-node";
import { renderToString } from "foldkit/experimental/server";
import { expect, test } from "vite-plus/test";
import { CargoApi, ssrSerializeRuntime } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// SSR-003 step 1: the native escaping and key fingerprint agree with upstream renderToString,
// which escapes each value as text and as an attribute and fingerprints it as a key.
const corpus = [
  "",
  "plain",
  `a&b<c>d"e'f`,
  "&amp; &#13; already escaped",
  "line\r\nbreak\rcr",
  "tab\tand\nnewline",
  "é accented",
  "é combining",
  "😀 astral 𝕏",
  "<script>alert(1)</script>",
  "x".repeat(300),
  "nul\u0000inside",
];

type Observed =
  | { readonly text: string; readonly attribute: string; readonly key: string }
  | { readonly error: string };

/** What upstream renders for one value: a hydratable span whose title, key and text it is. */
const upstream = (value: string): Effect.Effect<Observed> =>
  renderToString(
    {
      init: () => ({ model: {} }),
      view: (_model: object, h) => ({
        title: "t",
        body: h.span([h.Title(value), h.Key(value)], [value]),
      }),
    },
    { buildId: "b" },
  ).pipe(
    Effect.map((rendered): Observed => {
      const match =
        /^<span title="([^"]*)"[^>]* data-foldkit-key="([0-9a-f]{16})">(.*)<\/span>$/s.exec(
          rendered.html,
        );
      if (!match) throw new Error(`Unexpected markup: ${rendered.html}`);
      return { attribute: match[1]!, key: match[2]!, text: match[3]! };
    }),
    Effect.catchTag("SerializationError", (error) =>
      Effect.succeed<Observed>({
        error: error.cause instanceof Error ? error.cause.message : String(error.cause),
      }),
    ),
    Effect.orDie,
  );

const harness = {
  files: {
    "Cargo.toml":
      '[package]\nname = "ssr_harness"\nversion = "0.0.0"\nedition = "2021"\n\n[dependencies]\nserde_json = "=1.0.151"\n',
    "src/lib.rs": `${ssrSerializeRuntime}\npub use foldkit_ssr::*;\n`,
    "src/main.rs": String.raw`
fn main() {
    let path = std::env::args().nth(1).expect("corpus path");
    let corpus: Vec<String> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let observed: Vec<serde_json::Value> = corpus.iter().map(|value| {
        let (mut text, mut attribute) = (String::new(), String::new());
        match ssr_harness::escape_attribute(value, &mut attribute).and_then(|()| ssr_harness::escape_text(value, &mut text)) {
            Ok(()) => serde_json::json!({ "text": text, "attribute": attribute, "key": ssr_harness::string_key_marker(value) }),
            Err(message) => serde_json::json!({ "error": message }),
        }
    }).collect();
    println!("{}", serde_json::to_string(&observed).unwrap());
}
`,
  },
} as const;

test(
  "native escaping and key markers equal upstream renderToString",
  async () => {
    const expected = await Effect.runPromise(Effect.forEach(corpus, upstream));
    // The corpus exercises every escape, both refusals and astral fingerprints.
    expect(expected.some((o) => "text" in o && o.text.includes("&#13;"))).toBe(true);
    expect(expected.some((o) => "attribute" in o && o.attribute.includes("&quot;"))).toBe(true);
    expect(expected.at(-1)).toMatchObject({ error: expect.stringContaining("NUL") });

    const native = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-ssr-serialize-" });
          const directory = yield* CargoApi.write(harness, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          yield* fs.writeFileString(`${parent}/corpus.json`, JSON.stringify(corpus));
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/ssr_harness${process.platform === "win32" ? ".exe" : ""}`,
            [`${parent}/corpus.json`],
          );
          const output = yield* Stream.decodeText(child.stdout).pipe(
            Stream.runFold(
              () => "",
              (all, chunk) => all + chunk,
            ),
          );
          const parsed: unknown = JSON.parse(output);
          return parsed;
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    // Attributes are serialized before children, so a NUL is reported as an attribute value.
    expect(native).toEqual(expected);
  },
  nativeTestBudget(0) + 180000,
);
