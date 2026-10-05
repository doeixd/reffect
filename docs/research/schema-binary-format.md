# SchemaBinary wire format (effect 4.0.0)

Checked 2026-10-05 against the installed `effect` **4.0.0** package:

- `node_modules/effect/src/encoding/SchemaBinary.ts` (5331 lines), the implementation. There is no upstream spec, so the implementation defines the format.
- The upstream `SchemaBinary.test.ts` at tag `effect@4.0.0`, which has byte-level expectations.
- `node_modules/effect/src/rpc/RpcSerialization.ts` (`makeSchemaBinary`/`layerSchemaBinary`, lines 546–659) and `rpc/RpcMessage.ts` (`EncodedSchema`, lines 449–498).

Unless marked otherwise, every hex example below was produced by running scripts against the installed package with Node 26.5.0. Fingerprint and sentinel hashes were also recomputed independently from the algorithm in this document, and they matched. Claims marked **(unverified)** come from reading the code only.

Notation:

- `uv(n)` is an unsigned LEB128 varint.
- `sm(x)` is a sign-magnitude code: `|x|*2 + (x<0 || x is -0 ? 1 : 0)`, written as `uv`.
- `zz(b)` is a zigzag bigint: `b>=0 ? 2b : -2b-1`, written as `uv`.
- `LE` means little-endian.
- An **extent** is a byte region whose end the decoder already knows (see §3.0).

---

## 1. Frame

```
frame   := uv(bodyLen) body            ; bodyLen > 0, counts everything after the header
body    := envelope [fingerprint:8] value
envelope:= 0x20 (default mode) | 0x21 (fingerprint mode)
```

| Item           | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Length header  | `uv`, at most 10 bytes. The value must be ≤ 2^53−1 (`"safe integer length"`). 10 continuation bytes fail with `"uvarint"`. `0` fails with `"nonzero frame length"`.                                                                                                                                                                                                                                                                     |
| Envelope       | High nibble = version 2. Bit 0 = fingerprint flag. Other bits are reserved and must be 0. Any other byte fails with `"version 2 envelope, flags 0"` or `"…flags 1"`, depending on the decoder's mode. The decoder never auto-detects the mode.                                                                                                                                                                                          |
| Fingerprint    | Present only for 0x21: 8 bytes, the u64 layout hash in LE (§5.1). A mismatch fails with `"matching layout fingerprint"`. Fewer than 8 bytes fail with `"complete value"`.                                                                                                                                                                                                                                                               |
| Value          | The rest of the body is the root value's extent. Bytes left over after the root fail with `"no leftover bytes"`. One-shot decode (`toCodec`) also requires exactly one frame in the buffer.                                                                                                                                                                                                                                             |
| Multi-frame    | Streams are plain concatenations of frames. `encodeMany`/`encodeManyUnknownSync`/the `encode` channel produce bytes identical to concatenating single-frame encodes (verified upstream). `parser()` buffers partial frames across feeds. Values decoded before a failure are returned first, and the error is raised on the next call. After that the parser is "spent". `endSync()` with buffered bytes fails with `"complete value"`. |
| `maxFrameSize` | Compared with `bodyLen`; exceeding it fails with `"frame within maxFrameSize"`. RPC uses a 16 MiB default.                                                                                                                                                                                                                                                                                                                              |

Examples (default mode):

| Schema / value           | Bytes                              |
| ------------------------ | ---------------------------------- |
| `Number` 1               | `02 20 02`                         |
| `String` ""              | `01 20`                            |
| `Null`                   | `01 20`                            |
| `Number` 1 (fingerprint) | `0a 21 13 b1 01 86 4c b9 63 af 02` |

---

## 2. Layout compilation

The layout is compiled from `SchemaAST.toEncoded(toBinaryAST(schema.ast))`, so transformations are applied first and the layout describes the **encoded** side. For example, `NumberFromString` is laid out as `String`.

`toBinaryAST` rewrites declarations:

- Native ids (§2.2) and `effect/schema/Json`/`MutableJson` keep their identity.
- Any other declaration is replaced by its `toCodecJson` link, or else its `toCodec` link. Class, TaggedError, Chunk, HashMap, HashSet and Redacted are handled this way and become their struct or array encodings.
- A declaration with neither link fails at compile time with `Error("Binary layout: declaration <id> has no toCodecJson or toCodec")`.

### 2.1 AST to layout

| Encoded AST                                                                                                    | Layout                                            | Wire form (in its extent)                                                                  |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `String`, `TemplateLiteral`                                                                                    | string                                            | UTF-8 bytes. The extent supplies the length.                                               |
| `Symbol`, `UniqueSymbol`                                                                                       | symbol                                            | UTF-8 of `Symbol.keyFor(sym)`. The symbol must be registered.                              |
| `Boolean`                                                                                                      | bool                                              | 1 byte: `00`/`01`. The extent must be exactly 1 byte, and other values fail with `"bool"`. |
| `Null`                                                                                                         | null                                              | 0 bytes. The extent must be empty (`"empty"`).                                             |
| `Undefined`, `Void`                                                                                            | undefined                                         | 0 bytes                                                                                    |
| `Number` with an `isInt` check (id `effect/schema/isInt`, including inside filter groups: `Int`, `isInt32`, …) | **int**                                           | `sm(x)` varint, self-delimiting                                                            |
| `Number` otherwise                                                                                             | number                                            | §3.2                                                                                       |
| `BigInt`                                                                                                       | bigint                                            | `zz(b)`                                                                                    |
| `Literal v`                                                                                                    | literal over the leaf for `typeof v`              | Same as the leaf. Membership is checked on both encode and decode.                         |
| `Unknown`, `Any`, `ObjectKeyword`                                                                              | json                                              | UTF-8 of `JSON.stringify(v)`. Decoded with `JSON.parse`.                                   |
| `Never`                                                                                                        | never                                             | Always rejected (`InvalidType`).                                                           |
| `Enum`                                                                                                         | Union of its literals                             |                                                                                            |
| `Suspend`                                                                                                      | Compiles through. The layout graph may be cyclic. |                                                                                            |
| `Objects`                                                                                                      | struct                                            | §4 / §5                                                                                    |
| `Arrays`                                                                                                       | array                                             | §6                                                                                         |
| `Union`                                                                                                        | §7                                                |                                                                                            |
| Declaration                                                                                                    | §2.2                                              |                                                                                            |

Compile-time errors are thrown as JS `Error`, not `SchemaError`:

- symbol property names
- field-id collision or id 0
- members of a union that cannot be told apart
- sentinel hash collision
- unregistered unique symbol

### 2.2 Kind table `K`

The kind byte identifies a union member in default mode (§7). Natives are recognised by `annotations.representation.id`.

| K   | Name          | Used by                                                                                        |
| --- | ------------- | ---------------------------------------------------------------------------------------------- |
| 1   | bool          | Boolean, boolean literals                                                                      |
| 2   | null          | Null                                                                                           |
| 3   | undefined     | Undefined, Void                                                                                |
| 4   | number        | Number **and** int, numeric literals                                                           |
| 5   | string        | String, TemplateLiteral, Symbol, UniqueSymbol, string literals                                 |
| 6   | bytes         | `effect/schema/Uint8Array`                                                                     |
| 7   | bigint        | BigInt, bigint literals                                                                        |
| 8   | int64         | `effect/schema/Date`, `effect/schema/DateTimeUtc`                                              |
| 9   | struct        | Objects without sentinels                                                                      |
| 10  | variant       | Objects/Arrays **with** sentinels (tagged)                                                     |
| 11  | array         | Arrays without sentinels                                                                       |
| 12  | option        | `effect/schema/Option`                                                                         |
| 13  | result        | `effect/schema/Result`                                                                         |
| 14  | duration      | `effect/schema/Duration`                                                                       |
| 15  | bigDecimal    | `effect/schema/BigDecimal`                                                                     |
| 16  | dateTimeZoned | `effect/schema/DateTimeZoned`                                                                  |
| 17  | json          | Unknown/Any/ObjectKeyword, Json declarations (including the encoded side of `Schema.Defect()`) |
| 18  | exit          | `effect/schema/Exit`                                                                           |
| 19  | cause         | `effect/schema/Cause`                                                                          |
| 20  | causeReason   | `effect/schema/CauseReason`                                                                    |

### 2.3 Native and composite layouts

| Layout                    | Bytes (in its extent)                                                                                                                        | Example                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| int64 (Date, DateTimeUtc) | `i64 LE` epoch millis, exactly 8 bytes. Encoding a NaN Date fails. Decode requires \|ms\| ≤ 8.64e15 (`"a valid Date"`/`"a valid DateTime"`). | `Date(1000)` → `09 20 e8 03 00 00 00 00 00 00` |
| dateTimeZoned             | `i64 LE ms` + `00` + `i32 LE offsetMillis` (exactly 4), **or** `i64 LE ms` + `01` + UTF-8 IANA zone id (rest of extent)                      | offset 3600000 → `0e 20 <8×00> 00 80 ee 36 00` |
| duration                  | `01` = +∞, `02` = −∞, or `00` + `zz(nanos)`. Millis are converted to nanos.                                                                  | `seconds(1)` → `07 20 00 80 a8 d6 b9 07`       |
| bigDecimal                | `zz(value) zz(scale)` after `BigDecimal.normalize`                                                                                           | `1.23` → `04 20 f6 01 04`                      |
| bytes                     | Raw bytes (rest of extent)                                                                                                                   | `03 20 01 02`                                  |
| bigint                    | `zz(b)`, unbounded length                                                                                                                    | −1 → `02 20 01`, 300 → `03 20 d8 04`           |
| option                    | `00` (None; nothing may follow) or `01` + value (rest of extent)                                                                             | `some("x")` → `03 20 01 78`                    |
| result                    | `00` + success or `01` + failure (rest of extent)                                                                                            | `fail("e")` → `03 20 01 65`                    |
| exit, cause, causeReason  | §8                                                                                                                                           |                                                |

For option, result and exit, any tag byte other than 0 or 1 fails with `"bool"`.

---

## 3. Scalars

### 3.0 Extents and delimiting

Most values do **not** carry their own length: they consume the rest of their extent. There are only three exceptions:

- **self-delimiting:** `int`, and literals over it
- **packed fixed size:** bool = 1 byte, int64 = 8 bytes, and literals over them
- **zero width:** null, undefined, and literals over them

These are the **inline** slots. Every other value is placed in a **sized** slot (`uv(len) value`) wherever it is not at the end of a known region.

### 3.1 uvarint

- Standard LEB128.
- The writer always emits the minimal form.
- The reader:
  - accepts overlong forms;
  - reads at most 10 bytes;
  - requires the result to be ≤ 2^53−1 (`"safe integer length"`).
- Struct field tags have their own limit (§4.2).
- bigint varints (`zz`) are read without a length limit, bounded only by the frame.

### 3.2 `number` (extent-delimited)

The encoder picks the first form that applies:

1. **varint:** an integer with |x| ≤ 2^48−1 (including −0). Written as `sm(x)`, at most 7 bytes.
2. **decimal:** the smallest `s` in 1..8 such that `m = Math.round(x*10^s)` satisfies |m| ≤ 2^41−1 and `m/10^s === x`. Written as `sm(m)` (≤ 6 bytes) followed by **one byte** `s`. The search stops at the first `s` where |m| leaves the range, and that check also rejects NaN and ±∞.
3. **f64:** 8 bytes, LE IEEE-754. NaN, ±∞, `MAX_SAFE_INTEGER`, π, 2^48 and 1e-9 all end up here.

The decoder chooses the form from the extent length:

- **8** → f64.
- **0 or more than 7** → error `"f64"`.
- **Otherwise:** read an `sm` varint. If bytes remain, exactly one scale byte in 1..8 must follow; the value is `mantissa / 10^s`. Any other tail fails with `"decimal"`.

| Value           | Bytes                                             |
| --------------- | ------------------------------------------------- |
| 0 / −0 / 1 / −1 | `02 20 00` / `02 20 01` / `02 20 02` / `02 20 03` |
| 1.5             | `03 20 1e 01`                                     |
| 12.5            | `04 20 fa 01 01`                                  |
| 2^48−1          | `08 20 fe ff ff ff ff ff 7f`                      |
| 2^48            | `09 20 00 00 00 00 00 00 f0 42` (f64)             |

Porting notes:

- JS `Math.round` is `floor(x+0.5)`, which differs from Rust `f64::round` for negative halves. The difference cannot change which scale is chosen except at the range boundary (unverified that it never matters).
- The decoder **divides** `mantissa / 10^s`. Do not multiply by a reciprocal, because that can give a different f64.

### 3.3 `int`

`sm(x)` varint of any length. `Int` 2^48 → `09 20 80 80 80 80 80 80 80 01`, and `MAX_SAFE_INTEGER` → `fe ff ff ff ff ff ff 1f`.

- **Encode:** requires `Number.isSafeInteger`.
- **Decode:** once more than 7 bytes have been read, the decoder switches to bigint. A result beyond the safe range is rounded rather than rejected by the binary layer; only the schema pass (`isInt`) catches it.

### 3.4 Other scalars

| Scalar         | Wire form                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bool           | `00`/`01`                                                                                                                                                                            |
| string         | Raw UTF-8, no own length. "hé" → `04 20 68 c3 a9`. The encoder uses `TextEncoder`, so lone surrogates become U+FFFD. The decoder is fatal UTF-8 (`"utf-8"`) and keeps a leading BOM. |
| bytes          | Raw                                                                                                                                                                                  |
| bigint         | `zz`                                                                                                                                                                                 |
| int64          | Fixed 8 bytes LE                                                                                                                                                                     |
| null/undefined | Nothing                                                                                                                                                                              |

Booleans, numbers and ints are encoded differently **inside default-mode struct fields** (§4.2).

---

## 4. Structs, default (evolution) mode

### 4.1 Field ids

Each field id is resolved as follows:

- **Default id:** `fnv32(UTF-8(name))`, which is FNV-1a 32-bit (offset `0x811C9DC5`, prime `0x01000193`, xor-then-multiply, u32).
- **Explicit id:** `SchemaBinary.fieldId(n)`, an integer in 1..4294967295, stored as annotation `~effect/encoding/SchemaBinary/fieldId` on the property type. It is ignored in tuples.
- **Reserved:** id 0 is reserved, and a name that hashes to 0 fails to compile.
- **Collisions:** fail at compile time with `"field id collision: <id> (<names>)"`.
- **Field names:** must be strings (symbol keys are illegal).

| Name   | id         | Name   | id         |
| ------ | ---------- | ------ | ---------- |
| `name` | 2369371622 | `_tag` | 1921625614 |
| `age`  | 742476188  | `id`   | 926444256  |
| `a`    | 3826002220 | `n`    | 3943445553 |

### 4.2 Field encoding

```
struct  := [ uv(0) uv(len) extraPair* ]  field*      ; no header, no count; runs to end of extent
field   := uv(tag) payload,   tag = id*8 + wire      ; FIELD_WIRE_FACTOR = 8
```

| wire | Name    | Payload                      | Writer uses it for                                                                                                  |
| ---- | ------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 0    | SIZED   | `uv(len)` + value (extent)   | Everything not listed below: strings, structs, arrays, unions, natives, null/undefined, string and bigint literals… |
| 1    | VARINT  | `sm` varint (any length)     | `int`; `number` that is an integer with \|x\| ≤ 2^48−1                                                              |
| 2    | FIXED64 | f64 LE                       | `number` that is neither varint nor decimal                                                                         |
| 3    | FALSE   | —                            | bool false                                                                                                          |
| 4    | TRUE    | —                            | bool true                                                                                                           |
| 5    | DECIMAL | `sm(m)` + `uv(scale)` (1..8) | short-decimal `number` (same rule as §3.2)                                                                          |
| 6    | FIXED32 | 4 bytes                      | Never written; skip support only                                                                                    |
| 7    | EMPTY   | —                            | Never written; skip support only                                                                                    |

Literal fields use their leaf's wire kinds.

Encoding rules:

- **Order:** the encoder writes the extra map (field 0) first, then the present fields in ascending id order.
- **Absent fields:** an absent optional key is omitted. A missing required key fails on encode with `MissingKey`.

Decoding rules:

- **Order:** any order is accepted.
- **Duplicates:** a duplicate id (known or unknown) fails with `"unique field ids"`.
- **Unknown ids:** skipped using the wire kind alone.
- **Incompatible wire kind:** a known field whose wire kind is not in the reader layout's accepted set is **skipped and treated as absent**, so a required field then fails with `MissingKey`. The accepted sets are:
  - bool: 3, 4
  - number: 1, 2, 5
  - int: 1 only
  - everything else: 0 only
- **Union fields:** a SIZED union field whose member is unknown also decodes as absent (§7).
- **Required fields:** missing required fields are reported as a `Composite` of `MissingKey` (all of them with `errors: "all"`).
- **Tag length:** a field tag is at most 5 bytes (35 bits), and the 5th byte must be < 0x80 (`"uvarint"`).

Examples:

```
Struct{name:String, age:Number} {name:"Ada",age:36}
10 20 | e1 99 a9 90 16  48 | b0 de b7 ce 46  03 41 64 61
        age: id*8+1      sm(36)   name: id*8+0  len "Ada"

fieldId(1) n:Number, fieldId(2) flag:Boolean, fieldId(3) text:String {7,true,"x"}
07 20 | 09 0e | 14 | 18 01 78                    (upstream test)
fieldId(1) n:Number 7.5          →  05 20 0d 96 01 01      (wire 5: sm(75)=96 01, scale 1)
fieldId(0xFFFFFFFF) flag:true     →  07 20 fc ff ff ff 7f
```

### 4.3 Optional fields, `NullOr`, `UndefinedOr`

| Schema                        | Encoded as                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `optionalKey(X)`              | Absent ⇒ field omitted                                                                                                                                                               |
| `optional(X)`                 | Optional key + `Union[X, Undefined]`, so `{a: undefined}` writes the field. `Struct{a: optional(String)}`: `{a:undefined}` → `08 20 e0 92 85 83 72 01 03`; `{a:"x"}` → `… 02 05 78`. |
| `NullOr(X)`, `UndefinedOr(X)` | Ordinary unions (§7). `{a:null}` → `… 01 02`.                                                                                                                                        |

### 4.4 Extra keys (index signatures / records): the field-0 map

```
extras    := uv(0) uv(len) extraPair*                       ; tag 0 = id 0, wire SIZED; at most once
extraPair := uv(keyByteLen*8 + wire) keyUTF8 payload        ; payload as in §4.2
```

Encoding rules:

- A key is written only if it is **not** a declared field name and it matches some index-signature parameter. Other keys are dropped silently.
- Pairs are sorted by the **raw UTF-8 bytes** of the key (byte-wise, shorter prefix first), whatever the insertion order.
- The map is omitted if no pairs remain.

Decoding rules:

- Field 0 with a non-SIZED wire kind fails with `"extra field map"`.
- A key equal to a declared field name fails with `"an extra key distinct from declared fields"`.
- A duplicate key fails with `"unique extra keys"`.
- Keys that match no signature on the reader are skipped.
- Key order is **not** checked.

```
Record(String,Number) {b:2,a:1}  →  09 20 00 06 | 09 61 02 | 09 62 04
Record(String,Number) {x:7.5}    →  08 20 00 05 0d 78 96 01 01
StructWithRest({id:String},[Record(String,Number)]) {id:"a",z:1}
                                 →  0d 20 00 03 09 7a 02 | 80 ae 8d ce 1b 01 61
Record {}                        →  01 20
```

---

## 5. Fingerprint mode (`{ fingerprint: true }`)

Only the parts listed here differ from default mode. Arrays, row-run framing, number runs, scalars, natives and Cause encoding are the same.

| Aspect                    | Default                        | Fingerprint                                                |
| ------------------------- | ------------------------------ | ---------------------------------------------------------- |
| Envelope                  | `20`                           | `21` + 8-byte layout hash                                  |
| Struct                    | Tagged fields, any order       | `bitmap` + positional fields in ascending-id order         |
| Extras                    | Field-0 map, **before** fields | `uv(count) extraPair*` **after** fields (same pair format) |
| Union                     | Kind byte / `0a`+u32 tag       | `uv(position)`                                             |
| Unknown union member      | Decodes as absent              | `"known union member"` error                               |
| Row-run shape declaration | Field-id list                  | Presence mask (structs with ≤ 30 fields)                   |

### 5.1 Layout hash

The hash is `fnv64` (FNV-1a 64-bit: offset `14695981039346656037`, prime `1099511628211`, mod 2^64), taken over a structure byte string per layout node. A child is represented by its own u64 hash, written as 8 bytes LE. `uv` and `u32` below are LE.

| Node                | Structure bytes (F code first)                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| leaves              | `[F]`: bool 1, null 2, undefined 3, number 4, int 5, string 6, symbol 7, bytes 8, bigint 9, json 10, duration 11, bigDecimal 12, dateTimeZoned 13                                           |
| int64               | `[14]` (Date) or `[15]` (DateTimeUtc)                                                                                                                                                       |
| never               | `[16]`                                                                                                                                                                                      |
| struct              | `17 uv(nFields) {u32(id) opt?1:0 u64(child)}*` (fields in ascending id order), then `uv(nExtra) {u64(valueLayout)}*`. Index-signature key parameters are **not** hashed.                    |
| array               | `18 uv(nElements) {opt?1:0 u64(child)}* uv(nRest) u64(rest)*`                                                                                                                               |
| union               | `19 uv(nPositions)`, then for each position: `00 u64(child)` (other) or `01 tuple?1:0 u32(tag) u64(payload)` (variant)                                                                      |
| option              | `20 u64(value)`                                                                                                                                                                             |
| result              | `21 u64(success) u64(failure)`                                                                                                                                                              |
| exit                | `22 u64(value) u64(error) u64(defect)`                                                                                                                                                      |
| cause / causeReason | `23`/`24 u64(error) u64(defect)`                                                                                                                                                            |
| literal             | `25 structure(leaf) uv(nValues)`, then per value sorted by text, then by kind: `kind uv(len) UTF-8(String(v))`. Kinds: string 1, number 2, boolean 3, bigint 4, symbol 5 (`Symbol.keyFor`). |
| back-edge (cycle)   | When a node is already on the DFS stack: `fnv64([0x00, uv(stackDepth − index)])`                                                                                                            |

The frame carries `u64LE(hash)`. Properties:

- Acyclic sharing does not change the hash.
- Different factorings of a recursive schema do change it (upstream test).
- The hash ignores checks, annotations and property declaration order.
- int and number hash differently.
- Recomputation: `{name:String, age:Number}` → `76 7a 26 22 ed 83 53 51`. `Number` → `13 b1 01 86 4c b9 63 af`.

### 5.2 Positional struct

```
struct := bitmap[ceil(nOptional/8)]  fieldValue*  [ uv(extraCount) extraPair* ]   ; extras part iff struct has index signatures
```

- **Bitmap:** bit `i` (byte `i>>3`, LSB first) is set if the _i-th optional field in ascending-id order_ is present. Unused high bits are ignored on decode (verified).
- **Field values:** written in ascending-id order. Required fields always appear; optional fields appear only when their bit is set. An **inline** layout (§3.0) is written raw; anything else is `uv(len) value`.
- **Extras count:** if the count exceeds the remaining bytes, decoding fails with `"complete value"`.

```
Person{name:String, age:Int, active:Boolean, nickname:optional(String)} {Ada,36,true}
10 21 b8 d5 55 26 43 e7 74 35 | 00 | 48 | 03 41 64 61 | 01
                  fp            bitmap age(int, inline) name(sized) active(inline)
with nickname "A":  … | 01 | 02 01 41 | 48 | 03 41 64 61 | 01      (nickname id 355814093 sorts first;
                                                                    union pos 1 = string)
Record(String,Number) {b:2,a:1}  →  … fp … | 02 | 09 61 02 | 09 62 04
```

---

## 6. Arrays

### 6.1 Element layouts

`elements` are the fixed or optional slots and `rest` is the variadic part.

- **Count:** written as `uv(count)` iff `rest` is non-empty **or** some element is optional (`hasCount`). Fixed tuples have no count.
- **Minimum length:** `minCount = requiredElements + max(0, rest.length−1)`.
- **Slot mapping:** for index `i`:
  - `i < elements.length` → that element;
  - otherwise, if `i ≥ max(elements.length, count − (rest.length−1))` → trailing rest slot `rest[i − threshold + 1]`;
  - otherwise → `rest[0]`.
- **Inline/sized:** each slot is inline (raw) if its layout is inline, otherwise `uv(len) value`.

| Schema                                          | Encoding                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Array(S)` (uniform): **number**                | `uv(count)` + one **mode byte** + elements (§6.2), even for count 0 (`03 20 00 01`)                                           |
| `Array(S)` (uniform): struct, count > 0         | **Row run** (§6.3)                                                                                                            |
| `Array(S)` (uniform): inline S                  | Raw elements                                                                                                                  |
| `Array(S)` (uniform): other                     | `uv(len) value` each                                                                                                          |
| `NonEmptyArray(S)` (`elements=[S]`, `rest=[S]`) | Struct → row run. Otherwise per-slot sized/inline. **No number run:** `NonEmptyArray(Number) [1,2]` → `06 20 02 01 02 01 04`. |

Further examples:

| Value                                    | Bytes                     |
| ---------------------------------------- | ------------------------- |
| `Array(Int) [1,-2]`                      | `04 20 02 02 05`          |
| `Array(Boolean) [t,f]`                   | `04 20 02 01 00`          |
| `Array(Null)` ×3                         | `02 20 03`                |
| `Array(String) ["a","bc"]`               | `07 20 02 01 61 02 62 63` |
| `Tuple[String,Number] ["key",42]`        | `07 20 03 6b 65 79 01 54` |
| `Tuple[Int,Boolean] [5,true]`            | `03 20 0a 01`             |
| `Tuple[Number, optionalKey(Number)] [1]` | `04 20 01 01 02`          |

Decoding rules:

- **Too many elements:** extra elements beyond a rest-less tuple fail with `UnexpectedKey`.
- **Too few elements:** fewer than `minCount` (or a fixed tuple's extent running out) fails with `MissingKey`.
- **Allocation bound:** `count > remaining + 1,048,576` (or > 4,194,304 for zero-width rest elements) fails with `"array count within allocation limit"`.
- **Unknown union members:** an element that decodes as an unknown union member fails with `MissingKey`, or with `"known union member"` for optional tuple slots.

### 6.2 Uniform number arrays (`NUMBER_RUN_*`)

```
numberRun := uv(count) mode element*
mode 1 VARINT  : sm(x) per element                            ; chosen iff every x is varint-eligible (§3.2 rule 1)
mode 2 DECIMAL : uv((sm(m))*16 + s) per element, s in 0..8    ; iff every x is (integer with |x| ≤ 2^41−1) or has a decimal scale
mode 0 F64     : 8 bytes LE per element, extent must be exactly count*8
```

The encoder picks mode 1, else mode 2, else mode 0. In mode 2, integers always use `s=0`. On decode, any other mode byte fails with `"f64"`, and `s > 8` fails with `"decimal"`.

| Value      | Bytes                                                       |
| ---------- | ----------------------------------------------------------- |
| `[1, 2.5]` | `06 20 02 02 20 a1 06` (2→0x20; 2.5→sm(25)=50, 50*16+1=801) |
| `[1, π]`   | `13 20 02 00 <f64 1> <f64 π>`                               |

### 6.3 Struct row runs

A row run is used whenever the array's uniform element layout is a struct (`Array(Struct)`, `NonEmptyArray(Struct)`) and count > 0, in **both** modes. **This is the only accepted encoding for such arrays.** The tables and shapes below are scoped to a single array value; each array value starts empty.

```
run      := uv(count) row*
row      := uv(rowLen) shapeCode [decl] [extrasRegion] fieldRegion*
shapeCode:= 0 (declare new shape) | k ≥ 1 (reuse shape k−1)
```

**Declaring a shape (code 0):**

- **Default mode, or any struct with more than 30 fields:**
  - No separate declaration.
  - The extras block, if present, is introduced by `uv(0)`, and each present field's region is preceded by `uv(fieldId)` (the plain id, not a tag).
  - The reader records the slot sequence in order. Unknown ids become placeholder slots.
- **Fingerprint mode, ≤ 30 fields (`RUN_MAX_FIELDS`):**
  - `uv(mask)`, where bit `i` (i < 30) marks the i-th field in ascending-id order.
  - Bit 30 (`RUN_EXTRA_BIT`) marks the extras block.
  - Masks > 2^31−1 or with bits ≥ the field count fail with `"a known row shape"`.

**Reusing a shape (k ≥ 1):** no ids or mask. The slot order is the order recorded when the shape was declared. Shapes are recorded only when the struct has ≤ 30 fields; wider structs declare every row. The writer reuses a shape iff the row's presence mask (fields plus extras bit) was declared earlier in this run. An unknown `k` fails with `"a known row shape"`.

**Slot order:** the extras block (if present), then present fields in ascending id order.

**Regions:** every region code is `uv(len*2)` (even). For **interned** fields, a code may instead be odd: `uv(ref*2+1)`, a back-reference into that field's table. An out-of-range ref fails with `"a known back-reference"`. The intern kind of a field depends on its layout:

| Field layout                 | Intern kind | Effect                                                                                                                                                                                            |
| ---------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly `string`             | SELF        | The region code is a ref or `len*2` + UTF-8. Each literal value is appended to the table.                                                                                                         |
| `Array(String)`              | ELEMENTS    | Field region `len*2`. Inside it, after the count, each element is `ref*2+1` or `len*2`+bytes, using the field's table.                                                                            |
| Struct with index signatures | KEYS        | Field region `len*2`. Inside, each extra pair's key code is `ref*16 + wire*2 + 1` or `keyLen*16 + wire*2` followed by the key bytes. Applies to the default field-0 map and to positional extras. |
| Anything else                | NONE        | `len*2` region holding the extent-delimited value. A number field here uses the §3.2 forms, **not** field wire kinds.                                                                             |

Further details:

- **Row-level extras block:** a `len*2` region of ordinary §4.4 pairs (`keyLen*8+wire`, not interned).
- **Table scope:** tables are per field, so skipped or unknown fields never shift another field's references. The reader appends every literal it reads, including keys it has no signature for.
- **Nested runs:** a run nested inside a row field starts its own tables.

```
Array(Struct{id:String,label:String}) [{r1,even},{r2,even},{r3,odd}]   (id < label)
default: 25 20 03 | 13 00 e0d5e1b903 04 7231 fdafdcb40f 08 6576656e | 05 01 04 7232 01 | 08 01 04 7233 06 6f6464
fp:      24 21 <fp> 03 | 0a 00 03 04 7231 08 6576656e | 05 01 04 7232 01 | 08 01 04 7233 06 6f6464

Struct{id, a?:String, n?:Number}, rows {0,a:x},{1},{2,a:x},{3,n:1.5}   (id < a < n)
default: 31 20 04 | 0f 00 <id> 02 30 <a> 02 78 | 08 00 <id> 02 31 | 04 01 02 32 01 | 10 00 <id> 02 33 <n> 04 1e 01
fp:      23 21 <fp> 04 | 06 00 03 02 30 02 78 | 04 00 01 02 31 | 04 01 02 32 01 | 07 00 05 02 33 04 1e 01

Struct{tags:Array(String), attrs:Record(String,String)}  (tags < attrs)
rows {tags:[x,y],attrs:{k:v}}, {tags:[y],attrs:{k:w}}
26 20 02 | 18 00 <tags> 0a [02 02 78 02 79] <attrs> 0c [00 04 10 6b 01 76]
         | 0a 01 04 [01 03] 0a [00 03 01 01 77]          ; 03 = ref 1 ("y"); key code 01 = ref 0 ("k")
```

**Writer interning heuristic:**

- A table that already holds 64 values (`INTERN_DISABLE_AT`) and has had zero hits stops interning when the next new value arrives. That value and every later one are written literally.
- At 16 values (`INTERN_MAP_AT`) the table switches to a hash map. This affects performance only.
- Both behaviours are deterministic given the row sequence.

---

## 7. Unions

`flattenMembers` flattens nested unions and suspends, drops `Never`, deduplicates by AST identity and expands enums. Members are then classified:

- Literals are grouped **by kind** into one literal row per kind.
- A unique symbol becomes a symbol row (kind 5).
- An `Objects` or `Arrays` member with **sentinels** becomes a **variant**. Sentinels are every _required_ property or element whose type is a `Literal` or `UniqueSymbol`; a struct may have several.
- Every other member becomes a row keyed by its K kind. Two rows of the same kind fail to compile: for example two plain structs, `Date | DateTimeUtc`, `String | Symbol`, or **`Literal("a") | String`**.

Special cases:

- If the only members are literals of a single kind, the result is that literal layout, with no union byte (`Literals(["a","b"]) "b"` → `02 20 62`).
- If there is a single non-literal row and no variants, the result is that member's layout, with no union byte.

### 7.1 Variant tag (sentinel hash)

1. Sort the sentinels: numeric keys (tuple indices) first in ascending order, then string keys by UTF-8 bytes.
2. For each sentinel, append `[keyIsNumber?0:1] u32LE(keyLen) UTF-8(String(key)) kind u32LE(valLen) UTF-8(String(literal))`, where kind is string 1, number 2, boolean 3, bigint 4, symbol 5.
3. Take `fnv32` of the whole byte string.

Results:

- `{_tag:"A"}` → `0x149ac622`.
- Equal tags fail to compile with `"sentinel collision"`.
- **Struct variant payload:** the struct **without** its sentinel fields; the decoder re-adds them.
- **Tuple variant payload:** the full tuple, sentinels included.

### 7.2 Default-mode encoding

```
union := 0x0a u32LE(tag) payload        ; variant
       | K-byte value                   ; literal row / other row
```

The payload and value consume the rest of the union's extent.

Encoder member selection:

- If every variant pins one key to a distinct literal, that key acts as a discriminator.
- Otherwise the variants are scanned in declaration order, and the first whose sentinels all match **own** properties wins.
- Failing that, the other rows are scanned in this order: non-struct, non-json rows (literal rows first, then members in declaration order), then struct, then json (json matches anything).
- No match fails with `InvalidType`.

Decoder: an unknown tag or kind skips the rest of the extent and yields **absent**. Absent means the field is omitted, an array element or required value raises `MissingKey`, and a top-level value raises `MissingKey`.

| Value                                                 | Bytes                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `Union[Number,String]` 5 / "x"                        | `03 20 04 0a` / `03 20 05 78`                                |
| `NullOr(String)` null                                 | `02 20 02`                                                   |
| `Union[Literal "a", Literal 1]` 1                     | `03 20 04 02`                                                |
| `Union[A{_tag:"A",n:Number}, B{_tag:"B",s:String}]` A | `0c 20 0a 22 c6 9a 14 89 c3 86 c3 75 02` (n field: VARINT 1) |
| `Union[Struct{a:Int}, String]` {a:1}                  | `08 20 09 e1 92 85 83 72 02`                                 |

### 7.3 Fingerprint-mode encoding

`uv(position) payload`. The positions are:

- variants sorted by **numeric tag ascending**, then
- the other rows sorted by **K ascending**.

Declaration order does not affect positions. Example:

```
Union[A,B] A  →  0c 21 <fp> 01 01 02        (B tag 0x139ac48f < A tag → B=0, A=1)
```

---

## 8. Exit and Cause (RPC responses)

```
exit        := 00 value                    ; Success, value = rest of extent
             | 01 cause                    ; Failure
cause       := uv(nReasons) { uv(len) reason }*
reason      := 00 error | 01 defect        ; rest of the reason's region
             | 02                          ; Interrupt, no fiber id (region must be empty)
             | 03 f64LE(fiberId)           ; Interrupt with id (region exactly 8 bytes)
causeReason := reason (unprefixed)
```

- An unknown reason tag inside a Cause is **skipped** (dropped from the Cause) in both modes. A standalone CauseReason, or a required field holding one, raises `MissingKey`.
- `Schema.Defect()` is `Json`, so a defect is `JSON.stringify` text. An `Error` becomes `{"name":…,"message":…}`.

`Exit(String, String, Defect())`:

| Value                  | Bytes                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `succeed("ok")`        | `04 20 00 6f 6b`                                                                       |
| `fail("e")`            | `06 20 01 01 02 00 65`                                                                 |
| `die(Error("boom"))`   | `26 20 01 01 22 01 7b226e616d65223a224572726f72222c226d657373616765223a22626f6f6d227d` |
| `interrupt(7)`         | `0d 20 01 01 09 03 00 00 00 00 00 00 1c 40`                                            |
| `interrupt()`          | `05 20 01 01 01 02`                                                                    |
| `Exit(Void,…) succeed` | `02 20 00`                                                                             |

**RPC framing** (`layerSchemaBinary`, content type `application/vnd.effect.rpc+schema-binary`, `includesFraming: true`):

- **Envelope:** each message is one **fingerprint-mode** frame of `RpcMessage.EncodedSchema` (no dictionary). Its fingerprint for 4.0.0 is `cc 32 8a b0 8f 52 45 25`. One `parser` and one `encoder` are kept per connection, and `encodeMany` is used for batches.
- **Holes:** the holes in the envelope (`payload`, `exit`, `values`, `defect`) are `Uint8Array` fields. Each holds a **complete inner frame** (its own `uv` length and envelope) from `toCodecDirect(schema)`:
  - **default mode**, unless `fingerprintPayloads: true`;
  - `exit` uses `Rpc.exitSchema(rpc)` = `Exit(success | Void for streams, Union[error, streamError, middleware errors], defectSchema)`;
  - `values` uses `NonEmptyArray(streamSuccess)`.
- **Envelope union positions:** variants sorted by `_tag` hash:

| Position | `_tag` | Position | `_tag` | Position | `_tag`    |
| -------- | ------ | -------- | ------ | -------- | --------- |
| 0        | Ack    | 3        | Ping   | 6        | Pong      |
| 1        | Exit   | 4        | Eof    | 7        | Request   |
| 2        | Defect | 5        | Chunk  | 8        | Interrupt |

- **Request fields** (ascending id): `spanId?`, `payload`, `id`, `sampled?`, `tag`, `traceId?`, `headers`, `isNotification?`. The bitmap bits are spanId=0, sampled=1, traceId=2, isNotification=3. `optional(X)` fields are sized `Union[X,Undefined]`. `RequestIdSchema` is `Union[Number(pos 0), String(pos 1)]`.

```
Exit{requestId:"1", exit:<04 20 00 6f 6b>} →  13 21 cc328ab08f524525 | 01 | 02 01 31 | 05 04 20 00 6f 6b
Pong                                       →  0a 21 <fp> 06
Ack{requestId:5}                           →  0d 21 <fp> 00 02 00 0a
Chunk{requestId:"1", values:<09>}          →  0f 21 <fp> 05 | 01 09 | 02 01 31          (values id < requestId)
Request{id:"1",tag:"Get",payload:<01 20>,headers:[["a","b"]]}
  →  1c 21 <fp> 07 | 00 | 02 01 20 | 02 01 31 | 03 47 65 74 | 06 01 04 01 61 01 62
```

Two error-schema effects to watch:

- **A single failure schema is not a union on the wire.** With one schema (for example one `TaggedError` E1), `Union([E1])` collapses to E1 itself, and `_tag` is written as an ordinary field: `fail(E1{msg:"m"})` → `14 20 01 01 10 00 <_tag id> 02 45 31 <msg id> 01 6d`.
- **Adding a second error variant changes the bytes.** With `Union[E1,E2]`, the same error is written as a variant: `… 0d 00 0a <u32 tag> <msg id> 01 6d`. This is a wire break between those two schemas.

---

## 9. Canonical encoding and what a minimal encoder may omit

### 9.1 Deterministic output

Without `dictionary`, every encoder choice is a deterministic function of (schema, value). Each frame is independent, so `encodeMany` produces the same bytes as single encodes, and byte-exact differential tests against Effect are possible. The rules that fix the output are:

- field order by id, with the extras map first in default mode
- extras sorted by UTF-8
- number form and number-run mode rules
- union member selection (declaration order for scanned variants)
- row-shape declaration at first occurrence of a presence mask
- intern back-references at first repeat, with the 64-value/zero-hit cutoff
- minimal varints and lengths
- `JSON.stringify` output for json leaves (a Rust port must reproduce JS number formatting to be byte-identical)

The caches (index-signature cache, `extraShape`, arena) have no effect on the bytes.

### 9.2 State across frames: the `dictionary` option

This is opt-in on both the `encoder` and the `parser`, and only allowed for exact schemas. RPC does **not** use it. Mode and dictionary use cannot be detected on the wire, so both peers must be configured the same way.

- **Tables:** each `string` leaf (and string literal leaf) has a table, indexed by a slot number that is assigned in **compile order** of string leaves and memoized by AST identity. Fields that share an AST object share a table. The exact slot numbering for complex schemas was **not verified**.
- **States:**
  - **Watching:** the leaf writes plain strings and records them. The first repeat switches the slot to _referencing_. After 64 distinct strings without a repeat the slot switches to _gave up_.
  - **Referencing:** the string extent holds `uv(ref*2+1)` or `00` + UTF-8 (new strings are added up to 512 entries). Unexpected odd or even markers fail with `"a dictionary reference"`/`"a dictionary marker"`.
  - **Gave up:** the leaf writes plain strings.
- **Failed encodes:** a frame or batch that fails to encode rolls back its table changes.
- **Example** for `Struct{s}` with values a, b, a, a, c: the string extents are `61`, `62`, `61`, `01` (ref 0), `00 63`.

### 9.3 What a conforming decoder accepts

These were verified against Effect's decoder unless marked otherwise. A minimal encoder may therefore:

- **Numbers:**
  - Always write `number` leaves as f64 (8 bytes), and always use FIXED64 for number struct fields.
  - Always use number-run mode 0 (F64). Mode 1 also works when every element is an integer and fits; DECIMAL with scale 0 is allowed for integers.
  - Never write a decimal form for a value that is an integer, or use a decimal where f64 would do.
- **Varints:** overlong uvarints and sizes are accepted. **Except:** an extent-delimited `number` holds at most 7 varint bytes, because an 8-byte extent is read as **f64** (a 2^48 varint in an 8-byte extent decodes as `1.9e-301`). VARINT field and run elements may be any length.
- **Order:**
  - Struct fields may appear in any order.
  - The default-mode extras map may appear anywhere, but at most once.
  - Extra keys may be in any order (duplicates are rejected).
- **Row runs:**
  - Always declare the shape (code 0) on every row, in both modes.
  - Never back-reference: always write literal `len*2` regions for interned fields, array elements and keys.
- **Positional structs:** leave unused bitmap bits as 0. Stray high bits are ignored.
- **Dictionary:** omit it (it is only meaningful when negotiated).

A minimal encoder must **not** deviate on any of these, because they are fixed structure:

- the row-run framing itself (row length, shape code, `len*2` region codes) for `Array`/`NonEmptyArray` of struct
- the number-run mode byte for `Array(Number)` (not for `NonEmptyArray`)
- field wire kinds (bool → 3/4 only, int → 1 only, number → 1/2/5, others → 0)
- union kind, tag or position bytes
- inline versus sized slots
- the fingerprint bytes
- §3.2 extent lengths

The decoder also treats bytes it cannot place, such as unknown fields, unknown union members and unknown reason tags, as skippable in default mode. That is the evolution contract. Beyond the binary layer, non-exact schemas (those with checks or transformations) re-run the Schema decode pass on the decoded encoded-side value.

---

## 10. Decoder limits and errors

| Limit                      | Value                                                                                                                     | Error (`Expected …`)                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Nesting                    | 512 nested `decodeValue` calls (a literal counts as 2)                                                                    | `"nesting depth at most 512"`                           |
| Varint (length/count/size) | ≤ 10 bytes, ≤ 2^53−1                                                                                                      | `"uvarint"`, `"safe integer length"`                    |
| Field tag                  | ≤ 5 bytes (35 bits)                                                                                                       | `"uvarint"`                                             |
| Array count                | ≤ remaining + 1,048,576; zero-width elements ≤ 4,194,304                                                                  | `"array count within allocation limit"`                 |
| Frame                      | `bodyLen` ≥ 1; ≤ `maxFrameSize` (RPC default 16 MiB, `"unbounded"` disables it)                                           | `"nonzero frame length"`, `"frame within maxFrameSize"` |
| Encoder                    | No depth limit apart from the JS stack. JSON-leaf cycles fail with `"acyclic value"`. Recursive schemas run a cycle walk. |                                                         |

Other decode messages:

- Truncation and extents: `"complete value"`, `"no leftover bytes"`.
- Envelope: `"version 2 envelope, flags 0|1"`, `"matching layout fingerprint"`.
- Scalars: `"utf-8"`, `"bool"`, `"empty"`, `"f64"`, `"decimal"`, `"a decimal scale in [1, 8]"`, `"int64"`, `"a valid Date"`, `"a valid DateTime"`, `"time zone"`, `"duration"`, `"json"`.
- Structs and unions: `"known union member"`, `"unique field ids"`, `"unique extra keys"`, `"an extra key distinct from declared fields"`, `"extra field map"`.
- Row runs: `"a known row shape"`, `"a known back-reference"`.
- Dictionary: `"a dictionary reference"`, `"a dictionary marker"`.
- Parser state: `"parser is spent"`.
- Literal mismatch: the literal list, for example `"ok"` or `"info" | "warning"`.
- Structural issues: `MissingKey` (`Composite` for structs), `UnexpectedKey`, `InvalidType`.

All of these are surfaced as `Schema.SchemaError`, and issues carry a `Pointer` path such as `["xs"][0]`.

Encode messages:

- type mismatches: `"a number"`, `"an integer"`, `"a string"`, `"a boolean"`, `"an object"`, `"an array"`, `"a Uint8Array"`
- `"registered symbol"`, `"a JSON-serializable value"`, `"acyclic value"`
- `MissingKey`

**Evolution hazard:** shape reuse depends on each side's own field count. A writer struct with ≤ 30 fields read by a reader that has > 30 fields for the same struct fails with `"a known row shape"` (from reading the code, **unverified** by experiment).
