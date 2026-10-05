/**
 * `js_std` (docs/research/ssr-codemod.md, step 1d): each operation's reference is the ECMAScript
 * or Effect function it names, and the native port must agree with it on every corpus input.
 */
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { expect, test } from "vite-plus/test";
import {
  CargoApi,
  Compile,
  NativeRpc,
  NativeRunner,
  R,
  Reference,
  SourceArtifacts,
} from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// `Number.parse` read through Option, its value written as JS writes it, and whether it is safe.
const parsed = R.fn([R.String], R.String, (text) =>
  R.Number.parse(text).pipe(
    R.Option.match({
      onNone: () => R.String.literal("none"),
      onSome: (value) =>
        R.String.concat(
          R.String.concat(R.String.literal("some "), R.String.fromNumber(value)),
          R.Match.bool(
            R.Number.isSafeInteger(value),
            R.String.literal(" safe"),
            R.String.literal(""),
          ),
        ),
    }),
  ),
);
const cookies = R.fn([R.String], R.Record(R.String, R.String), (header) =>
  R.Cookies.parseHeader(header),
);
const program = R.program({ parsed });

const numbers = [
  "",
  " ",
  "  ",
  "NaN",
  "Infinity",
  "-Infinity",
  "+Infinity",
  " Infinity",
  "infinity",
  "inf",
  "nan",
  "1",
  "-0",
  "+1.5",
  "1.",
  ".5",
  ".",
  "+.5e1",
  "1e3",
  "1E-3",
  "1e",
  "e3",
  "1e+",
  "0x1F",
  "0X1f",
  "0x",
  "-0x1",
  "+0x1",
  "0b101",
  "0B2",
  "0o17",
  "0o8",
  "0x1.5",
  "1_000",
  " 42 ",
  " 42 ",
  "﻿7　",
  "᠎7",
  "0x1fffffffffffff",
  "0x20000000000001",
  "0x20000000000003",
  "0x20000000000002",
  `0x${"f".repeat(256)}`,
  `0x${"f".repeat(255)}`,
  `0b${"1".repeat(60)}`,
  "1e400",
  "-1e400",
  "4.9e-324",
  "2.4703282292062328e-324",
  "1e-400",
  "00012",
  "1.2.3",
  "12abc",
  "١٢",
  "9007199254740991",
  "9007199254740992",
  "-9007199254740991",
  "123456789012345678901234567890",
  "0.1",
  "1e21",
];

const headers = [
  "",
  "a=1; b=2",
  "a=1;a=2",
  " a = 1 ;b=2 ",
  "\u00A0a=1\u2028; b=\uFEFF2",
  'a="quoted"; b=" spaced "',
  'a="',
  'a=""',
  'a="x',
  "noeq; b=2",
  "b=2; noeq",
  "=v; b=2",
  ";;a=1;;",
  "a=%41%42",
  "a=%zz; b=%4",
  "a=%E2%82%AC",
  "a=%E2%82",
  "a=%C0%80",
  "a=%ED%A0%80",
  "a=%F4%90%80%80",
  "a=100%",
  "__proto__=x; constructor=y; toString=z",
  "2=b; 1=a; x=1; 0=z; 01=q; 4294967295=m; 4294967294=n",
  "a=b=c",
  "a=\u00e9; \u00e9=a",
  "k=v;",
  "k=v ; ",
  "s=caf%C3%A9; e=\u00f0\u009f",
  "foldkit-ssr-count=7; other=1",
];

test("Number.parse reads as Effect's and isSafeInteger as the JS global, in the reference", async () => {
  const run = (text: string) => Effect.runPromise(Reference.run(parsed, [text]));
  expect(await run("0x1F")).toBe("some 31 safe");
  expect(await run(" ")).toBe("none");
  expect(await run("NaN")).toBe("some NaN");
  expect(await run("1.5")).toBe("some 1.5");
});

test(
  "the native port agrees with the reference on every corpus string",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-js-std-" });
          const artifact = yield* Compile.make(program).pipe(
            Compile.withSourceArtifacts(SourceArtifacts.None),
            Compile.run,
          );
          // A std port: no crate is selected for it.
          expect(artifact.explanation.crates.filter((crate) => crate !== "ryu-js@1.0.3")).toEqual(
            [],
          );
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.build(directory, "debug");
          for (const text of numbers) {
            const native = yield* NativeRunner.run(
              artifact,
              directory,
              "parsed",
              parsed,
              [text],
              "debug",
            );
            expect(native, JSON.stringify(text)).toEqual(
              yield* Effect.exit(Reference.run(parsed, [text])),
            );
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);

// Records cross as JSON objects, so Cookies.parseHeader is served natively and by the official
// RpcServer running the reference, and the answers compared.
const Group = RpcGroup.make(
  Rpc.make("Cookies", {
    payload: { header: Schema.String },
    success: Schema.Record(Schema.String, Schema.String),
  }),
);
const request = (header: string) =>
  JSON.stringify({ _tag: "Request", id: "1", tag: "Cookies", payload: { header }, headers: [] });

test(
  "Cookies.parseHeader natively answers as Effect's, key order included",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handlers = Group.toLayer({
            Cookies: ({ header }) =>
              Reference.run(cookies, [header]).pipe(Effect.catchTag("CompileError", Effect.die)),
          });
          const official = HttpEffect.toWebHandler(
            yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
              Effect.provide([handlers, RpcSerialization.layerJson]),
            ),
          );
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-cookies-" });
          const artifact = yield* NativeRpc.compile(Group, {
            Cookies: NativeRpc.bind(cookies, ["header"]),
          });
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(
            Schema.Struct({
              schema: Schema.Literal("reffect.rpc.ready@1"),
              address: Schema.String,
            }),
          )(JSON.parse(ready.value));
          for (const header of headers) {
            const body = request(header);
            const native = yield* Effect.promise(() =>
              fetch(`http://${address}/rpc`, { method: "POST", body }).then((r) => r.text()),
            );
            const reference = yield* Effect.promise(() =>
              official(new Request("http://reffect.test/rpc", { method: "POST", body })).then((r) =>
                r.text(),
              ),
            );
            // Byte equality: the object's key order is the JS own-property order.
            expect(native, JSON.stringify(header)).toBe(reference);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 240000,
);
