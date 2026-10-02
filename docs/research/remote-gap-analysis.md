# Milestone 4 gap analysis: what a native RemoteServer still needs

Research note, 2026-10-02. It measures what stands between reffect and [milestone 4](../implementation-milestones.md#20-milestone-4--native-foldkit-remoteserver) ("take the existing `foldkit-remote` wire protocol unchanged; a normal Foldkit browser using `Remote.clientLayer` talks to the Rust backend"). Sources: `foldkit-plus` at `67cf3735` (`packages/remote/src/wire.ts`, `packages/remote-server/src/index.ts` and tests), [Foldkit Remote design](../foldkit-remote.md), and probes of installed Effect 4.0.0-rc.118.

## The protocol

`RemoteRpc` has four procedures: `Read` (batch of entity requirements → normalized entities plus settled fields), `Mutate`, `Query` (paged edges, optionally with selected entities) and `Live` (a stream; milestone 6/7). Milestone 4 covers the first three.

## Wire features still missing

Counted in `wire.ts` (all Remote sources in parentheses):

| Feature                                      | Count           | Where it matters                                                                                                 |
| -------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Schema.optional` / `optionalKey`            | 14 / 1 (28 / 1) | Window bounds, `windows`, `relations`, optional result arrays, the last relation level's refused `relations` key |
| `Schema.Number` (plain and `isInt` + `>= 0`) | 11 (27)         | Protocol `version` on every request, page sizes, live cursors, `RemoteProtocolError.expected/received`           |
| `Schema.Record(String, X)`                   | 6 (17)          | Request `windows`/`relations` keyed by field name; entity `values`                                               |
| `Schema.Unknown`                             | 5 (14)          | Entity `values`, mutation `input`/`output`, query `input`                                                        |
| `Schema.TaggedError` classes in error unions | 5 (6)           | `RemoteReadError \| RemoteProtocolError`, mutation/query errors                                                  |
| Checked arrays                               | 1               | `Fields` is `Array(String).check(isMaxLength(256))`                                                              |
| Literal unions                               | in unions       | `'prepend' \| 'append'` (mutations and live only)                                                                |

Already admitted: strings, `u64` via its canonical codec, booleans, structs, tagged unions and arrays.

## Probed semantics that constrain the design

- **Numbers.** The JSON codec for `Schema.Number` accepts JSON numbers and the strings `"NaN"`, `"Infinity"` and `"-Infinity"`, encodes non-finite values back as those strings, and otherwise fails with `Expected number | "Infinity" | "-Infinity" | "NaN"`. `isInt` means a safe integer (2^53 is rejected with `Expected an integer`). Remote numbers are JS doubles, unlike the existing `u64` decimal-string codec, so this needs an `f64`-style witness, as the [Query adapter](foldkit-query.md) already uses internally.
- **Optional fields.** With `Schema.optional`, a JSON `null` decodes as an absent key, and encoding `undefined` produces `null`. `optionalKey` refuses an explicit `undefined`. Presence and absence must therefore be modelled, not just nullability.
- **Records.** Decoded key order follows JS objects: integer-like keys first in ascending numeric order, then other keys in insertion order (`{"z":1,"a":2,"10":3,"2":4}` → `2, 10, z, a`). `serde_json`'s default map sorts lexicographically, so an ordered map with JS ordering rules is needed wherever order reaches a client.
- **Unknown.** The engine never needs a general dynamic value. Entity `values` are encoded from Effect Schema fields that each `Entity` declares. Mutation and query `input` are decoded by the selected mutation's or query's own `Input` schema after dispatch on its name: a two-stage decode of a raw JSON value.

## Engine shape (from the existing design)

[`docs/foldkit-remote.md`](../foldkit-remote.md#foldkit-remote-server-is-the-part-wed-implement-natively) proposes a generated, domain-specialized engine: entity and field enums, selection bitsets, per-entity Source functions and no trait objects. `remote-server` defines the behavior to preserve: protocol version checks, declared-field filtering, authorization, read grouping and id deduplication, nested relation traversal (depth 8), windows, settled fields, normalization, mutations with connection changes and deletes, and queries with optional selection. Its Sources are small Effect callbacks; `authorize` is an arbitrary callback that [milestone §21](../implementation-milestones.md#21-authorization-must-become-portable) says must become a compiled function or a declarative rule.

## Recommendation

1. **Design the native engine before adding more generic schema features.** Write a NativeRemote design record from `remote-server/src/index.ts` and its tests (about 2,800 test lines). Cover how an application's Entities, Sources and authorization are authored in R; what is generated (enums, bitsets, per-entity codecs, dispatch); what is a reused runtime algorithm; and how the TypeScript server serves as the differential oracle with the stock `Remote.clientLayer`. The design decides which features must be generic. For example, `Unknown` becomes typed per-entity codecs plus two-stage input decoding, not a dynamic JSON type.
2. **Then the features every request needs, in this order:** `Schema.Number` (JSON double semantics, including the non-finite strings and safe-integer checks), optional fields (absent versus `null` versus `undefined`), `TaggedError` classes in error unions, array length checks, and ordered `Record` maps with JS key order.
3. **Defer** literal unions and `Live` to the mutation and streaming work that needs them.
