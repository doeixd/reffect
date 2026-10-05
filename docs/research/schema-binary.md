# Milestone 10: native SchemaBinary RPC serialization

Status: researched and planned (2026-10-05). No feature code yet.

The wire format itself is specified separately in [SchemaBinary wire format](schema-binary-format.md). This record covers the sources, the decisions and the plan for serving it natively.

## Sources (checked 2026-10-05)

- **Effect 4.0.0, as installed** (`node_modules/effect`):
  - `src/encoding/SchemaBinary.ts` (5331 lines) is the only definition of the format. There is no separate upstream specification.
  - `src/rpc/RpcSerialization.ts`: `makeSchemaBinary` and `layerSchemaBinary({ maxFrameSize?, fingerprintPayloads? })`.
  - `src/rpc/RpcMessage.ts`: `EncodedSchema` is the envelope.
- **Upstream test.** `packages/effect/test/encoding/SchemaBinary.test.ts` at the 4.0.0 tag (3349 lines). Its byte expectations are quoted in the format record and become fixtures.
- **Probe** (official `RpcServer` and `RpcClient` under `layerSchemaBinary`, HTTP). It captured request and response bytes for a struct echo and for a typed failure. The bytes are in [the format record](schema-binary-format.md#8-exit-and-cause-rpc-responses) and were checked by hand against it:
  - the field tags `fnv32(name)*8+wire` (for example `done` = `8c 87 f0 bc 13`, wire TRUE);
  - the envelope union position (Request 7, Exit 1);
  - the nested default-mode frames;
  - the Cause layout (`01 01 05 00 "no 2"`).

## What official SchemaBinary RPC is

- **Content type and framing.** `application/vnd.effect.rpc+schema-binary`, with `includesFraming: true`. An HTTP body is a concatenation of frames, in both directions.
- **The envelope.** Each message is one fingerprint-mode frame of `RpcMessage.EncodedSchema`, whose 8-byte layout hash for 4.0.0 is `cc 32 8a b0 8f 52 45 25`.
- **The holes.** The envelope's `payload`, `exit`, `values` and `defect` holes are `Uint8Array` fields. Each holds a complete inner frame:
  - a payload frame uses `toCodecDirect(rpc.payloadSchema)`;
  - an exit frame uses `Rpc.exitSchema(rpc)`;
  - an inner frame is in default (evolution) mode unless `fingerprintPayloads: true`.
- **Request ids.** `RequestIdSchema` is `Union[Number, String]`. The stock client sends numbers, and a reply carries the id back in the variant it arrived in.
- **Layouts describe the encoded side** (`toEncoded`). A reffect contract codec is already defined on the encoded side (its JSON form), so each codec's binary layout follows from the same schema AST. One example: the u64 codec is `BigIntFromString`, which is laid out as a string.
- **Output is deterministic.** Without the opt-in `dictionary` option (RPC never sets it), the encoder's output depends only on the schema and the value. Byte-exact comparison against Effect is therefore a valid oracle.

## Prior decisions that apply

- **STREAM-001** ([streaming RPC](streaming-rpc.md)): `NativeRpc.compile` takes `serialization: "json" | "ndjson"`, named after `RpcSerialization.layerJson`/`layerNdjson`. SchemaBinary extends the same option.
- **Contract codecs** (`src/contract-codec.ts`, #14): the admitted schema profile and its verified checks:
  - REC-005 composites, ARR-005 arrays, RECJS-001 records, UNK-002 `Unknown`;
  - LIT-002 literals, OPT-003/004/008 optionals and `NullOr`;
  - NUM-002/003 numbers, LEN-001 lengths, and the u64/String codecs.

  SchemaBinary adds no new schema kinds. It is a second wire for the same profile.

- **The RPC runtime** (`src/rpc-runtime.ts`) dispatches messages as `serde_json::Value` envelopes, and the generated codecs map typed Rust values to and from their encoded JSON form, including the verified schema-failure texts.
- **Divergence records:**
  - STR-007/008: lone surrogates. Binary cannot carry them at all, because the encoder writes U+FFFD and the decoder is fatal UTF-8. This narrows a JSON divergence rather than adding one.
  - NUM-002: non-finite numbers.

## Alternatives

### A. Where the codec runs

- **A1, runtime layout interpreter.** One Rust function walks a layout tree for every value. This is small, but it is what milestone 10 says not to do ("generate specialized codecs from schemas instead of interpreting arbitrary schema trees at runtime"). It also hides per-shape work in data.
- **A2, generated transcoders to the encoded JSON value (chosen first).** Each contract layout gets generated `encode_x(&Value, &mut Vec<u8>)` and `decode_x(&[u8]) -> Result<Value, _>` functions. They are straight-line and specialized: field ids, tags and wire kinds are constants, and recursion follows the schema. They convert between binary and the encoded `Value` that the existing JSON codecs already produce and validate.
  - Typed decoding, schema checks, failure texts, dispatch, middleware and authentication are all unchanged.
  - Only the byte boundary is new, and a small std-only `schema_binary` runtime module supplies the primitives: varints, FNV, frames, number forms, row runs and interning.
- **A3, generated direct typed codecs.** Binary goes straight to and from the typed Rust value. This is the fastest option, but it duplicates every check and failure text the JSON codecs already verify. It is the measured optimization after A2, and it is deferred. A2's functions are its starting point.

### B. Encoder fidelity

- **B1, minimal encoder.** It would write every number as f64, skip interning, and declare a shape on every row. Effect decodes this, but native output is then not byte-equal to Effect's, so tests could only round-trip.
- **B2, exact canonical encoder (chosen).** It ports the deterministic choices:
  - the number form (varint, then decimal, then f64);
  - the number-run mode;
  - shape reuse by presence mask;
  - per-field interning with its 64-value, zero-hit cutoff;
  - minimal varints;
  - ascending field order and UTF-8-sorted extras.

  The rules are bounded (format record, §9.1). Byte equality against Effect is the strongest available evidence, and it is the "canonical byte equality" the milestone asks for.

### C. Scope of the first slice

- **Unary procedures only.** Envelope messages: Request, Exit, Defect, Ack, Interrupt, Ping and Pong.
- **Default-mode payloads.** `fingerprintPayloads: true` needs positional structs and per-schema layout hashes. It is refused with a diagnostic until there is a workload for it.
- **Deferred:** streaming `Chunk`/`values` (milestone 6 shapes over binary) and WebSocket (milestone 11).

## Decisions

- **SB-001. The option.** `NativeRpc.compile(group, handlers, { serialization: "schema-binary", maxFrameSize?, fingerprintPayloads? })` mirrors `layerSchemaBinary`.
  - The defaults are 16 MiB and `false`.
  - `maxFrameSize: "unbounded"` is accepted, as upstream accepts it.
  - `fingerprintPayloads: true` is refused with an unsupported diagnostic in the first slice.
  - Remote, which needs NDJSON for live updates, does not take the option yet.
- **SB-002. The envelope.** The envelope is a fixed fingerprint-mode codec of `RpcMessage.EncodedSchema`, written by hand in the runtime module.
  - Its fingerprint is **not hard-coded**. The compiler reads it at build time from the installed Effect: it encodes `Pong` with the official envelope codec and takes bytes 2–9.
  - The value is pinned by a test against the probe's `cc 32 8a b0 8f 52 45 25`.
  - An Effect upgrade that changes the envelope therefore changes the generated constant and fails that test, instead of drifting silently.
- **SB-003. The contract codecs.** These are the A2 generated transcoders, one per contract codec node (`Scalar` or `Composite`), keyed like the JSON codecs (NUM-003 stems).
  - Layouts are derived from the same schema AST, encoded side.
  - Field ids are `fnv32(name)`, or the `~effect/encoding/SchemaBinary/fieldId` annotation where present.
  - Collisions and id 0 are refused, as Effect refuses them at compile time.
- **SB-004. Exit and Cause.** These follow the JSON path's profile:
  - Success;
  - one typed failure (Fail);
  - a defect (Die) as JSON text, written byte-identically to `JSON.stringify` for the defect shapes reffect emits;
  - Interrupt.

  The error union collapses exactly as `Rpc.exitSchema` does: a single error schema is not a union on the wire, while two errors make a variant union. Both cases are tested.

- **SB-005. The runtime module.** A std-only `runtime/src/schema_binary.rs` holds the primitives and the envelope, and is generated into `runtime-sources.generated.ts`. Its unit tests use the upstream test's byte expectations.
  - It reuses `serde_json`, which the RPC runtime already depends on.
  - It adds no crates.
- **SB-006. Decoder breadth.** The native decoder accepts everything Effect's encoder can produce for the admitted shapes:
  - all three number forms and all number-run modes;
  - shape reuse and back-references;
  - extras in any order;
  - unknown fields skipped by wire kind;
  - fields with an incompatible wire kind treated as absent.

  It also enforces the decoder limits: nesting 512, uvarint and length bounds, allocation bounds and `maxFrameSize`.

- **SB-007. Failures.** Before step 2, a probe of the official server records how it answers each failure case, and the native server answers the same way:
  - a malformed envelope, a wrong fingerprint, or an oversized frame;
  - a payload frame that fails to decode;
  - a payload that decodes but fails a schema check.

  Any difference that remains is recorded in [native divergences](../native-divergences.md).

## Plan

Each step is a focused commit with its own differential test. Suites are run one at a time.

1. **Runtime primitives** (`schema_binary.rs`): uvarint and sm/zz, fnv32/fnv64, the three number forms, frames with `maxFrameSize`, and the envelope codec (fingerprint mode).
   - Rust unit tests use the upstream fixtures: the number, frame, envelope and Exit examples quoted in the format record.
   - Includes a probe test that decodes the four captured RPC messages and re-encodes them byte-equal.
2. **Failure probe** (SB-007). Capture the official server's answers to bad frames and bad payloads, and record them in this document.
3. **Scalar and struct transcoders** (SB-003) for String, u64, Boolean, Number (with checks), literals, `Undefined`/`Void` and `Struct`, in default mode, together with `serialization: "schema-binary"` on `NativeRpc.compile`, unary only.
   - **Acceptance:** the stock `RpcClient` under `layerSchemaBinary` calls a native server for Echo and Fail. The native response bytes equal the official server's for the same requests.
4. **Composites:**
   - `Array` (number runs, row runs with interning) and `Record` (the field-0 map, KEYS interning);
   - optionals and `NullOr`;
   - tagged unions (sentinel hash, collapsed single members);
   - `Unknown` as JSON text.
   - **Acceptance:** a corpus of generated values per shape. For each: Effect encode → native decode → native encode → bytes equal to Effect's; and native encode → Effect decode equals the value.
5. **Exit and Cause** completeness (SB-004): typed errors (one schema and two), defects and interruption, plus authentication and middleware failures over binary.
6. **Bookkeeping:**
   - `examples/todo-fullstack` RPC client option (if cheap);
   - the docs, PROGRESS, open-work and divergences updated.

Later, recorded in [open work](../open-work.md):

- streaming `Chunk` over binary;
- `fingerprintPayloads`;
- A3 direct typed codecs, once measured;
- WebSocket (milestone 11);
- Remote over binary.

## Progress

- **Step 1, done (2026-10-05).** The std-only module `runtime/src/schema_binary.rs` holds:
  - uvarint, sign-magnitude, FNV-1a 32/64, the three number forms with Effect's `decimalScale`;
  - frames, with `maxFrameSize` and fingerprint checks;
  - the envelope codec;
  - Exit and Cause.

  Its reader treats a body that ends inside a frame as Effect's parser does: no failure, only an unfinished frame.
  - `runtime/fixtures/schema-binary.json` is produced by the installed Effect: numbers, envelope messages through `RpcSerialization.layerSchemaBinary`, Exits, and 18 bad bodies with Effect's failure texts. `tests/schema-binary-fixtures.test.ts` fails if Effect writes or reads any of it differently.
  - Rust tests (`runtime/src/tests.rs`) hold the module to that fixture, and to the probe's four messages, which re-encode byte-equal.
  - Wide varints round as `Number(bigint)` does, which settles the earlier `Math.round` question: `js_round` is exact, because `v - floor(v)` is exact.

- **Step 2, done (2026-10-05): how the official server answers** (SB-007). An official `RpcServer.toHttpEffect` under `layerSchemaBinary` was sent bodies through its web handler. The stock client was also run against it.

| Body                                                                                                                                            | Official answer                                                                                                                                                                                                                                                    | Native                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty, or no complete frame                                                                                                                     | `500`, empty body. This is the HTTP protocol's "no messages" answer, which NDJSON shares.                                                                                                                                                                          | Same                                                                                                                                                                                                                                      |
| Messages, then an unfinished frame                                                                                                              | Answers the messages; the rest is ignored                                                                                                                                                                                                                          | Same                                                                                                                                                                                                                                      |
| The **first** frame fails to decode (zero length, `maxFrameSize`, wrong envelope or fingerprint, unknown position, leftover bytes, a bad field) | `200`, one `Defect` frame. Its defect is the JSON text `{"name":"SchemaError","message":"Expected <text>"}`, and a nested field adds `                                                                                                                             |
| at ["sampled"]`.                                                                                                                                | Same: `Invalid` carries the path (step 3)                                                                                                                                                                                                                          |
| A frame fails **after** at least one message                                                                                                    | The messages before it are answered; the failure is never reported (the parser stashes it for a next feed that HTTP never makes)                                                                                                                                   | Same                                                                                                                                                                                                                                      |
| `Ping`                                                                                                                                          | `Pong`                                                                                                                                                                                                                                                             | Same                                                                                                                                                                                                                                      |
| Unknown procedure tag; payload fails to decode or fails its schema                                                                              | `200`, a connection-level `Defect`: `SchemaError: Expected a Uint8Array at ["exit"]`. After it, the stock client fails **every later call**. This is an upstream bug ([Effect-TS/effect#8826](https://github.com/Effect-TS/effect/issues/8826), filed 2026-10-05). | **Divergence SB-REQUEST-DEFECT** (user decision, 2026-10-05): that request's `Exit` with a `Die` whose defect is the JSON path's text (`Unknown request tag: X`, or the formatted schema issue). The client keeps working, as under JSON. |
| Two requests in one body                                                                                                                        | Both answered, in order                                                                                                                                                                                                                                            | Same                                                                                                                                                                                                                                      |
| Duplicate ids, more than 64 requests, an oversized body                                                                                         | Answered                                                                                                                                                                                                                                                           | Refused as the JSON path refuses them ([unary-rpc](unary-rpc.md), already registered)                                                                                                                                                     |
| Request id                                                                                                                                      | A number or string, echoed in the kind it arrived in; fractional numbers accepted                                                                                                                                                                                  | Same                                                                                                                                                                                                                                      |

The answer's content type is `application/vnd.effect.rpc+schema-binary`, and its body is concatenated frames.

## Acceptance (milestone 10, first slice)

- The stock `RpcClient` with `RpcSerialization.layerSchemaBinary` calls the native server for every admitted shape, and success, typed failure, defect and interruption round-trip.
- The native response bytes equal the official server's for the same requests, which is the "canonical byte equality" obligation.
- Per shape, in both directions: Effect encode → Rust decode, and Rust encode → Effect decode.
- The envelope fingerprint is derived from the installed Effect and pinned by a test.
- Every failure answer in SB-007 matches the official server's, or is recorded as a divergence.

## Open questions

- **JSON number text.** `JSON.stringify` number text appears inside defects and `Unknown` values. reffect's defects are strings or `{name,message}` objects, and `serde_json` writes strings as JS does (to be checked by test). An `Unknown` holding non-integer numbers needs the UNK-002 normalization to match JS number text. This is unverified.
- **The `Math.round` port** (format record §3.2): resolved by porting it exactly (`floor`, then a comparison with 0.5, which is exact). Number fixtures include halves, boundaries and non-finite values.
- **Row-shape evolution hazard** (format record §10): a struct with more than 30 fields read by a peer with 30 or fewer. It does not affect reffect while client and server share one contract.
