# `Schema.TaggedError` classes in RPC error schemas

Status: **accepted for implementation (2026-10-02)**. This is the fifth wire feature in the [native RemoteServer design](native-remote.md#order-of-work) (NR-002). Checked against installed Effect **4.0.0** (`Schema.TaggedError`, `SchemaAST.Declaration`, `RpcServer` failure encoding) and the published `foldkit-remote` 0.9.0 wire module.

## Prior work

- Remote declares its RPC errors as classes:
  - `RemoteReadError`, `RemoteMutationError`, `RemoteLiveError` and `RemoteQueryError` each carry `{ message: Schema.String }`.
  - `RemoteProtocolError` carries `{ message, expected: Number, received: Number }`.
  - Read and Live use `Schema.Union([…Error, RemoteProtocolError])`; Mutate and Query use one class.
  - Errors are only ever **encoded** by the server.
- [Records/unions](records-unions.md) (REC-005) map `_tag`-literal Struct unions onto `R.TaggedUnion` and encode cases as `{ "_tag": …, …fields }`.
- [STR-006](string-profile.md) refused plain `Schema.String` because it **decodes** lone surrogates. Native strings are always well-formed, so encoding one with plain `Schema.String` is identical to `StringJson`.

## Pinned behavior

- A TaggedError class schema is a `Declaration` with an `identifier` annotation. Its single encoding link goes `to` its tagged `Objects` (the same node as `typeParameters[0]`). Its static `fields` include `_tag`.
- The official server encodes a typed failure as the struct form (`{"_tag":"ReadError","message":"bad"}`; non-finite numbers become strings, as in NUM-004).
- A handler failing with a **plain object** of the right shape is not an instance. The server then reports a defect (`Die`, `Expected ReadError at ["cause"]["failures"][0]["error"]`). Instances are required at the JS boundary.
- `Schema.decodeUnknownSync(ReadError)(struct)` builds an instance (`instanceof ReadError` and `Error`). Encoding it yields the struct again.

## Decisions

- **TE-001 — tagged classes as tagged-union cases.** In encoded positions (success and error schemas), NativeRpc recognizes a Declaration with an identifier and one encoding link to a `_tag`-literal Objects node that is its type parameter. It maps the class onto an `R.TaggedUnion` case; a union of classes becomes the union, and a single class becomes a one-case union. Recognition is **verified**: a sample of the struct form, generated from the field codecs, must decode to an instance and encode back to the identical sample.
- **TE-002 — R values are the class data.** The R value of a TaggedError is `_tag` plus its fields. Class identity, the `Error` prototype, `name` and `stack` belong to the JS host. A JS boundary (the reference oracle now, a hybrid host later) builds instances by decoding the struct form. NativeRpc binding types map class schemas to their field types (`Schema.Struct<fields>["Type"]`).
- **TE-003 — plain `Schema.String` in encoded positions.** It is admitted for success and error values and their fields. It stays refused for decoding (STR-006).
- **TE-004 — refused:** classes in payloads (decoding), non-tagged `Schema.Class`/`ErrorClass`, classes with checks, extra encoding links, or fields outside the admitted codecs.

## Acceptance

- Raw requests whose handlers fail with each class of a union, and with a single class, produce responses strictly equal to the official server's. This includes non-finite numbers and non-ASCII messages. Success values still match.
- A stock client receives the failure as a class instance (`instanceof`) with the same fields.
- Refusals: a class in a payload, a non-tagged class.

## Delivered (2026-10-02)

All decisions are implemented as recorded. Evidence: [tagged-errors-rpc.test.ts](../../packages/reffect/tests/tagged-errors-rpc.test.ts) 2/2. Responses are strictly equal to the official server for union and single-class failures (including `-0`, `Infinity` and non-ASCII messages), successes and invalid payloads. A stock client receives class instances with the same fields. The reference oracle builds instances with `Schema.decodeUnknownSync(errorSchema)` (TE-002), with no casts.
