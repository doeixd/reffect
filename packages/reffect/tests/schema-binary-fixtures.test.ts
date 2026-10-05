/**
 * Milestone 10 step 1 (docs/research/schema-binary.md): the SchemaBinary bytes the native
 * runtime module is held to, produced by the installed Effect. `runtime/fixtures/schema-binary.json`
 * is what `cargo test` reads (runtime/src/tests.rs); this suite fails when Effect would write or
 * read anything in it differently. Regenerate with `REFFECT_REGENERATE=1`, then `vp fmt` the file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Cause, Effect, Exit, Schema, SchemaIssue } from "effect";
import { SchemaBinary } from "effect/encoding";
import { RpcSerialization } from "effect/rpc";
import { expect, test } from "vite-plus/test";

const FIXTURE = new URL("../runtime/fixtures/schema-binary.json", import.meta.url);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const f64Hex = (x: number) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, x, true);
  return hex(bytes);
};

const serialization = (maxFrameSize: number) =>
  Effect.runSync(
    Effect.service(RpcSerialization.RpcSerialization).pipe(
      Effect.provide(RpcSerialization.layerSchemaBinary({ maxFrameSize })),
    ),
  );
const official = serialization(64);

const expectedOf = (error: unknown) => {
  if (!Schema.isSchemaError(error)) throw error;
  // A failure inside a field is the same issue under its path.
  let issue: SchemaIssue.Issue = error.issue;
  while (issue._tag === "Pointer") issue = issue.issue;
  if (issue._tag !== "InvalidValue") throw new Error(`Not an InvalidValue: ${String(error)}`);
  return issue.annotations?.expected;
};
/**
 * How the RPC parser reads a body: the messages before a failure come first and the failure
 * on the next feed; a body ending inside a frame is no failure, only an unfinished frame.
 */
const failureOf = (bytes: Uint8Array) => {
  const parser = official.makeUnsafe();
  let before = 0;
  try {
    before = parser.decode(bytes).length;
    parser.decode(new Uint8Array());
    return { before, expected: null };
  } catch (error) {
    return { before, expected: expectedOf(error) ?? null };
  }
};

const NUMBERS = [
  0,
  -0,
  1,
  -1,
  1.5,
  -1.5,
  12.5,
  0.1,
  -0.25,
  123.456789,
  0.00000001,
  1e-9,
  2 ** 41 - 1,
  (2 ** 41 - 1) / 10,
  2 ** 48 - 1,
  -(2 ** 48 - 1),
  2 ** 48,
  Number.MAX_SAFE_INTEGER,
  Math.PI,
  1e21,
  -2.5e-3,
  21990232555.51,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
];
const NumberCodec = SchemaBinary.toCodec(Schema.Number);
const FieldCodec = SchemaBinary.toCodec(Schema.Struct({ n: Schema.Number }));
const decodeNumber = Schema.decodeUnknownSync(NumberCodec);

interface Envelope {
  readonly _tag: string;
  readonly [key: string]: unknown;
}
const MESSAGES: ReadonlyArray<Envelope> = [
  { _tag: "Pong" },
  { _tag: "Ping" },
  { _tag: "Eof" },
  { _tag: "Ack", requestId: 5 },
  { _tag: "Interrupt", requestId: "12" },
  { _tag: "Exit", requestId: "1", exit: unhex("0420006f6b") },
  { _tag: "Exit", requestId: 0, exit: unhex("1a20") },
  { _tag: "Chunk", requestId: "1", values: unhex("09") },
  { _tag: "Defect", defect: unhex("0b207b2261223a317d") },
  {
    _tag: "Request",
    id: 0,
    tag: "Echo",
    payload: unhex("0120"),
    headers: [],
  },
  {
    _tag: "Request",
    id: "7",
    tag: "Get",
    payload: unhex("0120"),
    headers: [
      ["a", "b"],
      ["authorization", "Bearer x"],
    ],
    traceId: "t",
    spanId: "s",
    sampled: false,
    isNotification: true,
  },
  {
    _tag: "Request",
    id: 1.5,
    tag: "",
    payload: unhex("0120"),
    headers: [],
    traceId: undefined,
    sampled: undefined,
  },
];
/** A message as JSON the Rust test reads: ids keep their kind, bytes are hex, undefined is null. */
const describe = (message: Envelope) =>
  Object.fromEntries(
    Object.entries(message).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? { bytes: hex(value) }
        : value === undefined
          ? null
          : (key === "id" || key === "requestId") && typeof value === "number"
            ? { number: value }
            : (key === "id" || key === "requestId") && typeof value === "string"
              ? { string: value }
              : value,
    ]),
  );

const ExitCodec = SchemaBinary.toCodec(Schema.Exit(Schema.String, Schema.String, Schema.Defect()));
const EXITS = [
  { name: "success", exit: Exit.succeed("ok") },
  { name: "fail", exit: Exit.fail("e") },
  { name: "die", exit: Exit.die(new Error("boom")) },
  { name: "dieString", exit: Exit.die("bad") },
  { name: "interrupt", exit: Exit.failCause(Cause.interrupt()) },
  { name: "interruptFiber", exit: Exit.failCause(Cause.interrupt(7)) },
  {
    name: "parallel",
    exit: Exit.failCause(Cause.combine(Cause.fail("a"), Cause.die("b"))),
  },
];

const ENVELOPE_FP = "cc328ab08f524525";
/** A fingerprint-mode frame around a value given in hex. */
const frame = (value: string) => {
  const body = `21${ENVELOPE_FP}${value}`;
  return `${(body.length / 2).toString(16).padStart(2, "0")}${body}`;
};
// A Request with bitmap `bits`, then its fields from payload to headers, as hex.
const request = (bits: string, fields: string) => frame(`07${bits}${fields}`);
const BAD_BODIES: ReadonlyArray<{ readonly name: string; readonly bytes: string }> = [
  { name: "zero length", bytes: "00" },
  { name: "over maxFrameSize", bytes: frame("06".repeat(64)) },
  { name: "default envelope", bytes: "022006" },
  { name: "fingerprint mismatch", bytes: "0a21cc328ab08f52452606" },
  { name: "short fingerprint", bytes: "0521cc328ab0" },
  { name: "unknown position", bytes: frame("09") },
  { name: "leftover", bytes: frame("0600") },
  { name: "overlong header", bytes: "ffffffffffffffffffff01" },
  { name: "unsafe length", bytes: "ffffffffffffffff7f" },
  // payload `01 20`, id 0, sampled, tag "T", no headers.
  {
    name: "sampled not a bool",
    bytes: request("02", "020120" + "020000" + "020002" + "0154" + "0100"),
  },
  {
    name: "undefined with bytes",
    bytes: request("02", "020120" + "020000" + "020102" + "0154" + "0100"),
  },
  {
    name: "notification false",
    bytes: request("08", "020120" + "020000" + "0154" + "0100" + "020000"),
  },
  { name: "id not a union member", bytes: request("00", "020120" + "020200" + "0154" + "0100") },
  { name: "bad utf-8 tag", bytes: request("00", "020120020000" + "01ff" + "0100") },
  { name: "truncated slot", bytes: request("00", "020120020000" + "0954") },
  { name: "pong then zero", bytes: frame("06") + "00" },
  { name: "truncated frame", bytes: frame("06") + "0a21cc" },
  { name: "truncated header", bytes: frame("06") + "ff" },
];

const generate = () => ({
  "//": "Generated by tests/schema-binary-fixtures.test.ts from the installed effect; do not edit.",
  numbers: NUMBERS.map((x) => {
    const bytes = Schema.encodeSync(NumberCodec)(x);
    return {
      bits: f64Hex(x),
      frame: hex(bytes),
      field: hex(Schema.encodeSync(FieldCodec)({ n: x })),
      // What Effect reads back, as bits: decoding divides, and -0 survives.
      decoded: f64Hex(decodeNumber(bytes)),
    };
  }),
  envelopeFingerprint: hex(
    (official.makeUnsafe().encode({ _tag: "Pong" }) as Uint8Array).subarray(2, 10),
  ),
  messages: MESSAGES.map((message) => ({
    message: describe(message),
    frame: hex(official.makeUnsafe().encode(message) as Uint8Array),
  })),
  exits: EXITS.map(({ name, exit }) => ({
    name,
    frame: hex(Schema.encodeSync(ExitCodec)(exit)),
  })),
  failures: BAD_BODIES.map(({ name, bytes }) => ({ name, bytes, ...failureOf(unhex(bytes)) })),
});

test("the committed SchemaBinary fixtures are what the installed Effect writes and reads", () => {
  const generated = generate();
  if (process.env.REFFECT_REGENERATE === "1")
    writeFileSync(FIXTURE, `${JSON.stringify(generated, null, 2)}\n`);
  expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(generated);
  // The probe's envelope fingerprint (docs/research/schema-binary.md).
  expect(generated.envelopeFingerprint).toBe("cc328ab08f524525");
  // Only the truncated bodies end without a failure.
  expect(
    generated.failures.filter((failure) => failure.expected === null).map(({ name }) => name),
  ).toEqual(["truncated frame", "truncated header"]);
});
