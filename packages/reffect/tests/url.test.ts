/**
 * `R.Url` (docs/research/ssr-data.md, "Page inputs from the URL"): the reference evaluates with
 * WHATWG `URL`, natively the url crate does; both must agree on what a page reads of its URL.
 */
import { Effect, FileSystem } from "effect";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import { CargoApi, Compile, NativeRunner, R, Reference, SourceArtifacts } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// The parameter's value, marked so that a missing parameter and an empty one stay apart.
const param = R.fn([R.String, R.String], R.String, (url, name) =>
  R.Url.searchParam(url, name).pipe(
    R.UndefinedOr.match({
      onUndefined: () => R.String.literal("missing"),
      onDefined: (value) => R.String.concat(R.String.literal("="), value),
    }),
  ),
);
const pathname = R.fn([R.String], R.String, (url) => R.Url.pathname(url));
const program = R.program({ param, pathname });

const urls = [
  "http://reffect.test/",
  "http://reffect.test/todos?status=done",
  "http://reffect.test/a/b%20c/?status=a+b&status=second",
  "http://reffect.test/?status=%E2%9C%93",
  "http://reffect.test/?status=%FF%FE",
  "http://reffect.test/?status=%zz&x=1",
  "http://reffect.test/?status=&other",
  "http://reffect.test/?other#status=hash",
  "http://reffect.test/?st%61tus=encoded-name",
  "http://reffect.test/%7Euser/../x?status=dot",
  "http://reffect.test/café?status=café",
  "https://user@example.test:8443/p?q=1",
  "mailto:someone@example.test",
  "not a url",
  "",
];
const names = ["status", "other", "x", "q", ""];

test("R.Url reads as WHATWG URL does in the reference", async () => {
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
  expect(await run(Reference.run(param, ["http://reffect.test/?status=a+b", "status"]))).toBe(
    "=a b",
  );
  expect(await run(Reference.run(param, ["http://reffect.test/", "status"]))).toBe("missing");
  expect(await run(Reference.run(pathname, ["not a url"]))).toBe("");
  expect(await run(Reference.run(pathname, ["http://reffect.test/a/../b"]))).toBe("/b");
});

test(
  "R.Url natively agrees with the reference on every corpus URL",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-url-" });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          // The url crate is selected only because R.Url is reachable.
          expect(artifact.explanation.crates).toContain("url@2.5.8");
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.build(directory, "debug");
          for (const url of urls) {
            const native = yield* NativeRunner.run(
              artifact,
              directory,
              "pathname",
              pathname,
              [url],
              "debug",
            );
            expect(native, `pathname ${JSON.stringify(url)}`).toEqual(
              yield* Effect.exit(Reference.run(pathname, [url])),
            );
            for (const name of names) {
              const found = yield* NativeRunner.run(
                artifact,
                directory,
                "param",
                param,
                [url, name],
                "debug",
              );
              expect(found, `${JSON.stringify(name)} of ${JSON.stringify(url)}`).toEqual(
                yield* Effect.exit(Reference.run(param, [url, name])),
              );
            }
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
