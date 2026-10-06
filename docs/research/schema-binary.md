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

- **SB-001. The option.** `NativeRpc.compile(group, handlers, { serialization: "schema-binary", schemaBinary?: { maxFrameSize?, fingerprintPayloads? } })` mirrors `layerSchemaBinary` and its options. The options sit in their own object because they mean nothing under JSON; giving them without `serialization: "schema-binary"` is refused.
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

- **Step 3, done (2026-10-05): a native SchemaBinary server.**
  - **Runtime.** `rpc_wire.rs` keeps exits, defects and batch validation. The JSON/NDJSON body moved to `rpc_json.rs`, and `rpc_binary.rs` is the SchemaBinary body: frames in, the same JSON-shaped envelopes for dispatch, frames out, written as each answer is ready. Envelope failures carry Effect's issue and path. The check crate's `rpc_binary_host` answers the official server's recorded bad bodies, and two Echo calls, byte for byte.
  - **Generator** (`src/schema-binary.ts`). Layouts come from `SchemaAST.toEncoded` of the payload schema and of `Rpc.exitSchema(rpc)`'s type parameters, so the error union collapses as Effect's does. Each layout gets one `sbr_`/`sbw_` pair between its bytes and the JSON-shaped value the verified codecs read and write.
    - Admitted: strings, u64, numbers (`isInt` ones as `int`, filter groups included), booleans, `null`/`undefined`, literals, structs with `optional`/`optionalKey` fields, and unions told apart by kind (`NullOr`, `UndefinedOr`).
    - Refused while compiling: tagged unions, arrays, records, `Unknown`, `fieldId` annotations, streams, authentication, runtime-served (NativeRemote) procedures, `fingerprintPayloads`.
  - **`-0`.** The JSON path writes `-0` as `0`, as `JSON.stringify` does. Under SchemaBinary the server's own codecs keep it (`jsNumberKeepingSign`), because the wire carries it. The library's `reffect_json` encoders are unchanged.
  - **A present `undefined`** in an `optional` field is `null` in the JSON-shaped value, as `toCodecJson` writes it, and is written back as kind 3.
  - **Evidence** (`tests/schema-binary-rpc.test.ts`). Against the official server running the same R handlers through `Reference.run`:
    - the native answers equal the official bytes for 22 requests: Echo over struct values with `-0`, NaN and the infinities, decimals, f64s, Unicode, and absent, present and `undefined` optionals; Count with an `isInt` payload; Check success and typed failure; Ping; two requests in one body;
    - payloads the official server mishandles are answered with the request's `Die`, whose text equals the official JSON server's for the equivalent JSON payload;
    - the stock client under `layerSchemaBinary` round-trips every value, `-0` included, and keeps working after a procedure the server lacks fails;
    - disabling `-0` preservation makes the byte comparison fail at the `-0` case (mutation check).

- **Step 4, done (2026-10-05): composite shapes.**
  - **Tagged unions.** A variant is written as kind 10, then its sentinel hash (`sentinelSetHash`, ported, since `collectSentinels` is internal), then the struct without its sentinel fields. The reader adds them back, and an unknown hash reads as absent. Unions mix variants with kind rows, and an error union of tagged structs is written as Effect writes it.
  - **Arrays** (`Schema.Array` only):
    - number runs, with the mode byte chosen as `encodeNumberRun` chooses it;
    - inline, string and sized elements;
    - struct row runs: shape declaration and reuse by presence mask, `uv(len*2)` regions, per-field string intern tables (`SELF`, `ELEMENTS`) with the 64-value, zero-hit cutoff, and the reader appending every literal.
  - **Records**: the field-0 map, written first with keys sorted by UTF-8 bytes, read with Effect's checks.
  - **`Unknown`**: JSON text written by `foldkit_json::json_text` (ryu-js, `Number#toString`), and read with `serde_json`.
  - **Refused while compiling:** tuples and `NonEmptyArray`, tagged tuples, unique-symbol sentinels, tagged records, records inside row runs (`KEYS` interning), and arrays of records.
  - **Evidence** (`tests/schema-binary-composites.test.ts`):
    - against the official server running the same R handlers, the native bytes are equal for 15 requests (11 `Echo` bodies, a typed tagged-union failure in each variant, and more);
    - the stock client round-trips each body as Effect's own codec does (inside `Unknown`, `-0` is JSON text `0`);
    - a mutation moving the intern cutoff to 65 fails exactly at the cutoff case. An earlier version of that case did not catch the mutation, because a disabled table stops looking up too; the repeat must follow the 65th value at once.

- **Step 5, done (2026-10-05): authentication.**
  - The bearer adapter's denial is the middleware's error in `Rpc.exitSchema`'s failure union. The transcoders already derive that union, so `WhoAmI`'s errors (`Boolean | Literal("Unauthorized")`) are kind rows. The refusal is lifted.
  - The session cookie's RPC check now requires the SchemaBinary media type under binary. It is not exercised by a test yet.
  - **Evidence** (`tests/schema-binary-auth.test.ts`, the `examples/rpc-auth` contract and handlers):
    - against the official server with the same middleware, the native bytes are equal for a missing token, a wrong token, a transport header, an envelope header, a typed failure and a public procedure;
    - the stock client gets `"Unauthorized"` and `false` as typed failures, and the principals as successes.

- **Streaming, done (2026-10-05).** A chunk is a `Chunk` message whose `values` hole is a `NonEmptyArray(streamSuccess)` frame: a count, then a row run for structs, raw inline slots, or sized ones. There is no number run, unlike `Array`. The exit is `Rpc.exitSchema`'s `Void` success or failure union.
  - `forward_chunks` now builds each chunk through the serialization's `chunk_message`: JSON is unchanged, and binary tags the chunk so `sb_chunk` picks the procedure's element codec.
  - **Evidence** (`tests/schema-binary-stream.test.ts`, the streaming corpus of `stream-rpc` plus a struct stream). The native bytes equal the official server's for chunked number, string and struct streams (row runs with back-references inside a chunk), a typed stream failure, an empty stream, and a stream beside a unary call (compared per request). The stock client collects each stream.
  - Runtime-served streams (NativeRemote Live) remain refused with NativeRemote.

- **NativeRemote, done (2026-10-06).** `NativeRemote.compile(..., { serialization: "schema-binary" })` serves Read, Query, Mutate and Live over SchemaBinary.
  - **Live** streams incrementally, because SchemaBinary frames every message. It now needs `"ndjson"` or `"schema-binary"`.
  - **`KEYS` interning.** The Remote contract's row runs hold records (`NormalizedEntity.values`). Effect interns those records' keys per field: `ref*16+wire*2+1`, or `keyLen*16+wire*2` and the key. Keyed variants of the record reader and writer (`sbrk_`/`sbwk_`) now carry it.
    - Only a field whose layout is directly a record interns. `optional(Record)` is a union, so `ReadRequest.windows` and `relations` do not, matching `internKind`.
  - **`-0` on the wire.** The remote engine's own numbers (a protocol error's `received`) keep `-0` under SchemaBinary. The emitted crate-root `NEGATIVE_ZERO_ON_WIRE` tells it whether to; JSON is unchanged.
  - **Evidence** (`tests/schema-binary-remote.test.ts`):
    - the whole `remote-read` corpus (now shared, `tests/remote-read-corpus.ts`) gives native bytes equal to foldkit-remote-server's handlers under `layerSchemaBinary`, including relation trees, the 900-request batch, the id limit and the version edge cases;
    - a mutation that never back-references a key fails at the first relation case;
    - over a stock binary client, live events from the native hub equal upstream `liveHub`'s while R mutations land, the mutation answers (an unknown mutation included) are byte-equal, and a read after them matches.

- **The showcase on SchemaBinary, done (2026-10-06).** `examples/todo-fullstack/main.ts --binary` compiles the server with `serialization: "schema-binary"`. The browser app (`examples/todo-remote/web`) picks its stock client's serialization from `TODO_REMOTE_RPC`, through a Vite `define`; a bundle without it uses NDJSON.
  - **Evidence:** `tests/todo-fullstack-browser.test.ts` now runs under both serializations in Chrome. It covers the login page, the HttpOnly session cookie, hydration, a toggle committed through cookie-authenticated RPC, and the reload that renders it.
  - Under SchemaBinary this also exercises the cookie's RPC media-type check. A client still speaking NDJSON would fail against the binary server, so the pass shows the browser used SchemaBinary.

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
