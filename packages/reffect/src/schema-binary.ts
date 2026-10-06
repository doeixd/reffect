/**
 * SchemaBinary transcoders for NativeRpc (milestone 10, docs/research/schema-binary.md, SB-003):
 * Rust functions between a contract schema's SchemaBinary form, as effect 4.0.0 lays it out in
 * default (evolution) mode, and the encoded JSON value the server's verified codecs read and
 * write. Layouts come from the schema's encoded AST, as `SchemaBinary` compiles them; each one is
 * emitted once as straight-line code, so no schema tree is interpreted at run time.
 */
import { Effect, Match, SchemaAST } from "effect";
import { Rpc, RpcSchema, RpcSerialization } from "effect/rpc";
import { unsupported } from "./contract-codec.ts";
import { namingDigest } from "./naming.ts";

type Leaf = "string" | "number" | "int" | "bool" | "null" | "undefined" | "never" | "json";
type LiteralValue = string | number | boolean;
interface StructLayout {
  readonly _: "struct";
  readonly fields: readonly Field[];
  /** The value layout of a string-keyed index signature: a record's entries. */
  readonly extra?: Layout;
}
interface Variant {
  /** The sentinel hash (`sentinelSetHash`). */
  readonly tag: number;
  readonly sentinels: readonly { readonly key: string; readonly literal: LiteralValue }[];
  /** The struct without its sentinel fields, which the reader adds back. */
  readonly payload: StructLayout;
}
/** The admitted layouts, a subset of `SchemaBinary`'s (format record §2.1). */
type Layout =
  | { readonly _: Leaf }
  | { readonly _: "literal"; readonly leaf: "string" | "number" | "bool" }
  | StructLayout
  /** `Schema.Array(item)`: a count, then the elements. */
  | { readonly _: "array"; readonly item: Layout }
  | {
      readonly _: "union";
      /** Tagged members, in declaration order (the encoder tries them in this order). */
      readonly variants: readonly Variant[];
      /** Other members, told apart by their kind byte `K`, in ascending kind order. */
      readonly rows: readonly { readonly k: number; readonly layout: Layout }[];
    };
interface Field {
  readonly name: string;
  readonly id: number;
  readonly optional: boolean;
  readonly layout: Layout;
}

const FIELD_ID_ANNOTATION = "~effect/encoding/SchemaBinary/fieldId";
const utf8 = (text: string) => new TextEncoder().encode(text);
const fnv32 = (bytes: ArrayLike<number>): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 0x01000193);
  return hash >>> 0;
};
/** FNV-1a 32 of the UTF-8 name: a field's default id (`fnv32`). */
export const defaultFieldId = (name: string): number => fnv32(utf8(name));
const compareBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
/** A variant's tag over its sentinels, sorted by key bytes (`sentinelSetHash`). */
const sentinelSetHash = (sentinels: Variant["sentinels"]): number => {
  const out: number[] = [];
  for (const { key, literal } of [...sentinels].sort((a, b) =>
    compareBytes(utf8(a.key), utf8(b.key)),
  )) {
    const keyBytes = utf8(key);
    const valueBytes = utf8(String(literal));
    out.push(1, ...u32(keyBytes.length), ...keyBytes);
    out.push(typeof literal === "string" ? 1 : typeof literal === "number" ? 2 : 3);
    out.push(...u32(valueBytes.length), ...valueBytes);
  }
  return fnv32(out);
};
/** The representation ids of a check, through filter groups (`Int` and `isInt32` group theirs). */
const representationIds = (check: SchemaAST.Check<unknown>): readonly unknown[] =>
  Match.value(check).pipe(
    Match.tag("Filter", (filter) => [
      (filter.annotations?.representation as { readonly id?: unknown } | undefined)?.id,
    ]),
    Match.tag("FilterGroup", (group) => group.checks.flatMap(representationIds)),
    Match.exhaustive,
  );
const literalLeaf = (value: unknown, path: string): "string" | "number" | "bool" => {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  throw unsupported(
    path,
    "Only string, number and boolean literals have SchemaBinary layouts here",
  );
};
/** The kind byte that tells a union member apart (`K`). */
const kindOf = (layout: Layout, path: string): number => {
  switch (layout._) {
    case "bool":
      return 1;
    case "null":
      return 2;
    case "undefined":
      return 3;
    case "number":
    case "int":
      return 4;
    case "string":
      return 5;
    case "struct":
      return 9;
    case "array":
      return 11;
    case "json":
      return 17;
    case "literal":
      return layout.leaf === "string" ? 5 : layout.leaf === "number" ? 4 : 1;
    case "never":
    case "union":
      throw unsupported(path, `A ${layout._} union member has no SchemaBinary kind here`);
  }
};
/** A value read from a fixed number of bytes, or none at all (`isInlineSlot`). */
const inline = (layout: Layout): boolean =>
  layout._ === "literal"
    ? layout.leaf === "bool"
    : layout._ === "bool" || layout._ === "int" || layout._ === "null" || layout._ === "undefined";

const structOf = (ast: SchemaAST.Objects, path: string): StructLayout => {
  if (ast.indexSignatures.length > 1)
    throw unsupported(path, "One index signature under SchemaBinary is supported");
  const signature = ast.indexSignatures[0];
  if (signature && !SchemaAST.isString(SchemaAST.toEncoded(signature.parameter)))
    throw unsupported(path, "Only string-keyed records under SchemaBinary are supported");
  const fields = ast.propertySignatures.map((property): Field => {
    if (typeof property.name !== "string")
      throw unsupported(path, "SchemaBinary field names are strings");
    if (property.type.annotations?.[FIELD_ID_ANNOTATION] !== undefined)
      throw unsupported(path, "SchemaBinary.fieldId annotations are not supported yet");
    const id = defaultFieldId(property.name);
    if (id === 0) throw unsupported(path, `Field ${property.name} hashes to the reserved id 0`);
    return {
      name: property.name,
      id,
      optional: SchemaAST.isOptional(property.type),
      layout: layoutOf(property.type, `${path}.${property.name}`),
    };
  });
  if (new Set(fields.map((field) => field.id)).size !== fields.length)
    throw unsupported(path, "Two fields share a SchemaBinary id");
  return {
    _: "struct",
    fields: [...fields].sort((a, b) => a.id - b.id),
    ...(signature ? { extra: layoutOf(signature.type, `${path}[string]`) } : {}),
  };
};
/** The SchemaBinary layout of a schema, from its encoded side (`toEncoded`). */
const layoutOf = (ast: SchemaAST.AST, path: string): Layout => {
  const encoded = SchemaAST.toEncoded(ast);
  if (encoded.annotations?.[FIELD_ID_ANNOTATION] !== undefined)
    throw unsupported(path, "SchemaBinary.fieldId annotations are not supported yet");
  if (SchemaAST.isString(encoded)) return { _: "string" };
  if (SchemaAST.isNumber(encoded))
    return (encoded.checks ?? []).flatMap(representationIds).includes("effect/schema/isInt")
      ? { _: "int" }
      : { _: "number" };
  if (SchemaAST.isBoolean(encoded)) return { _: "bool" };
  if (SchemaAST.isNull(encoded)) return { _: "null" };
  if (SchemaAST.isUndefined(encoded) || SchemaAST.isVoid(encoded)) return { _: "undefined" };
  if (SchemaAST.isNever(encoded)) return { _: "never" };
  if (SchemaAST.isUnknown(encoded)) return { _: "json" };
  if (SchemaAST.isLiteral(encoded))
    return { _: "literal", leaf: literalLeaf(encoded.literal, path) };
  if (SchemaAST.isObjects(encoded)) return structOf(encoded, path);
  if (SchemaAST.isArrays(encoded)) {
    if (encoded.elements.length !== 0 || encoded.rest.length !== 1)
      throw unsupported(path, "Only Schema.Array under SchemaBinary is supported");
    return { _: "array", item: layoutOf(encoded.rest[0], `${path}[]`) };
  }
  if (SchemaAST.isUnion(encoded)) return unionOf(encoded, path);
  throw unsupported(path, `${encoded._tag} schemas under SchemaBinary are not supported yet`);
};
/** Effect's member flattening and classification (`compileUnion`, format record §7). */
const unionOf = (ast: SchemaAST.Union, path: string): Layout => {
  const members: SchemaAST.AST[] = [];
  const visit = (member: SchemaAST.AST) => {
    const encoded = SchemaAST.toEncoded(member);
    if (SchemaAST.isUnion(encoded) && !encoded.checks) encoded.types.forEach(visit);
    else if (!SchemaAST.isNever(encoded) && !members.includes(encoded)) members.push(encoded);
  };
  ast.types.forEach(visit);
  if (members.length === 0) return { _: "never" };
  const variants: Variant[] = [];
  const others: Layout[] = [];
  const literals = new Map<"string" | "number" | "bool", number>();
  for (const member of members) {
    if (SchemaAST.isLiteral(member)) {
      const leaf = literalLeaf(member.literal, path);
      literals.set(leaf, (literals.get(leaf) ?? 0) + 1);
      continue;
    }
    const keys = sentinelsOf(member, path);
    if (SchemaAST.isObjects(member)) {
      if (keys.length > 0) {
        const full = structOf(member, path);
        if (full.extra)
          throw unsupported(path, "Tagged records under SchemaBinary are not supported yet");
        const names = new Set(keys.map((sentinel) => sentinel.key));
        variants.push({
          tag: sentinelSetHash(keys),
          sentinels: keys,
          payload: { _: "struct", fields: full.fields.filter((field) => !names.has(field.name)) },
        });
        continue;
      }
    }
    others.push(layoutOf(member, path));
  }
  const literalRows = [...literals.keys()].map((leaf): Layout => ({ _: "literal", leaf }));
  if (variants.length === 0 && others.length === 0 && literalRows.length === 1)
    return literalRows[0];
  const rows = [...literalRows, ...others].map((layout) => ({ k: kindOf(layout, path), layout }));
  if (new Set(rows.map((row) => row.k)).size !== rows.length)
    throw unsupported(path, "Union members SchemaBinary cannot tell apart");
  if (variants.length === 0 && literalRows.length === 0 && others.length === 1) return others[0];
  if (new Set(variants.map((variant) => variant.tag)).size !== variants.length)
    throw unsupported(path, "Two union members share a SchemaBinary sentinel hash");
  return { _: "union", variants, rows: rows.sort((a, b) => a.k - b.k) };
};
/**
 * A member's sentinels, as `SchemaAST.collectSentinels` finds them: its required properties whose
 * type is a literal. Tagged tuples and unique-symbol sentinels are refused.
 */
const sentinelsOf = (member: SchemaAST.AST, path: string): Variant["sentinels"] => {
  if (SchemaAST.isArrays(member)) {
    if (
      member.elements.some(
        (element) => !SchemaAST.isOptional(element) && SchemaAST.isLiteral(element),
      )
    )
      throw unsupported(path, "Tagged tuples under SchemaBinary are not supported yet");
    return [];
  }
  if (!SchemaAST.isObjects(member)) return [];
  return member.propertySignatures.flatMap((property) => {
    const type = property.type;
    if (SchemaAST.isOptional(type)) return [];
    if (SchemaAST.isUniqueSymbol(type))
      throw unsupported(path, "Unique-symbol sentinels under SchemaBinary are not supported");
    if (!SchemaAST.isLiteral(type)) return [];
    if (typeof property.name !== "string")
      throw unsupported(path, "SchemaBinary sentinel keys are strings");
    return [{ key: property.name, literal: literalOf(type.literal, path) }];
  });
};
const literalOf = (value: unknown, path: string): LiteralValue => {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw unsupported(path, "Only string, finite number and boolean sentinels are supported");
};

/** The fingerprint of `RpcMessage.EncodedSchema` in the installed Effect (SB-002). */
export const envelopeFingerprint = (): readonly number[] => {
  const service = Effect.runSync(
    Effect.service(RpcSerialization.RpcSerialization).pipe(
      Effect.provide(RpcSerialization.layerSchemaBinary()),
    ),
  );
  const pong = service.makeUnsafe().encode({ _tag: "Pong" });
  if (!(pong instanceof Uint8Array) || pong.length !== 11)
    throw new Error("The SchemaBinary envelope did not encode Pong as one fingerprinted frame");
  return Array.from(pong.subarray(2, 10));
};

const rustString = (text: string) => JSON.stringify(text);
const SB = "schema_binary";
const FAILURE = `${SB}::Failure`;
/** A layout's intern kind inside a row run (`internKind`). */
type Intern = "self" | "elements" | "keys" | "none";
const internOf = (layout: Layout): Intern =>
  layout._ === "string"
    ? "self"
    : layout._ === "array" && layout.item._ === "string"
      ? "elements"
      : layout._ === "struct" && layout.extra
        ? "keys"
        : "none";
const literalMatch = (value: string, literal: LiteralValue) =>
  typeof literal === "string"
    ? `${value}.and_then(Value::as_str) == Some(${rustString(literal)})`
    : typeof literal === "number"
      ? `${value}.and_then(Value::as_f64) == Some(${literal === Math.trunc(literal) ? `${literal}.0` : literal})`
      : `${value}.and_then(Value::as_bool) == Some(${literal})`;
const literalValue = (literal: LiteralValue) =>
  typeof literal === "string"
    ? `Value::String(${rustString(literal)}.into())`
    : typeof literal === "number"
      ? `number_value(${literal === Math.trunc(literal) ? `${literal}.0` : literal})`
      : `Value::Bool(${literal})`;

/** The functions of every layout reached, each emitted once under a digest of its layout. */
class Emitter {
  readonly items = new Map<string, string>();
  json = false;
  name(layout: Layout): string {
    const name = namingDigest(JSON.stringify(layout));
    if (!this.items.has(name)) {
      this.items.set(name, "");
      this.items.set(
        name,
        this.read(layout, name) +
          this.write(layout, name) +
          this.readField(layout, name) +
          this.writeField(layout, name),
      );
    }
    return name;
  }
  /** Reads the whole extent; `None` is an unknown union member, which reads as absent. */
  private read(layout: Layout, name: string): string {
    const head = `fn sbr_${name}(r: &mut ${SB}::Reader) -> Result<Option<Value>, ${FAILURE}> {\n`;
    switch (layout._) {
      case "string":
        return `${head}    Ok(Some(Value::String(r.string()?)))\n}\n`;
      case "number":
        return `${head}    Ok(Some(number_value(r.number()?)))\n}\n`;
      case "int":
        return `${head}    Ok(Some(number_value(r.sm()?)))\n}\n`;
      case "bool":
        return `${head}    Ok(Some(Value::Bool(r.bool()?)))\n}\n`;
      case "null":
      case "undefined":
        return `${head}    r.empty()?;\n    Ok(Some(Value::Null))\n}\n`;
      case "never":
        return `${head}    let _ = r;\n    Err(${FAILURE}::new(${SB}::Issue::Invalid("never")))\n}\n`;
      case "json":
        this.json = true;
        return `${head}    let text = r.string()?;\n    serde_json::from_str::<Value>(&text).map(Some).map_err(|_| ${SB}::Invalid("json").into())\n}\n`;
      case "literal":
        // Membership is the verified JSON codec's check, with its own message.
        return this.read({ _: layout.leaf }, name);
      case "struct":
        return this.readStruct(layout, head);
      case "array":
        return this.readArray(layout.item, head);
      case "union": {
        const variants = layout.variants
          .map((variant) => {
            const sentinels = variant.sentinels
              .map(
                ({ key, literal }) =>
                  `object.insert(${rustString(key)}.into(), ${literalValue(literal)}); `,
              )
              .join("");
            return `            ${variant.tag} => { let Some(Value::Object(mut object)) = sbr_${this.name(variant.payload)}(r)? else { return Ok(None) }; ${sentinels}Ok(Some(Value::Object(object))) }\n`;
          })
          .join("");
        const variantArm = layout.variants.length
          ? `        ${SB}::K_VARIANT => match ${SB}::read_u32(r)? {\n${variants}            _ => { r.rest(); Ok(None) }\n        },\n`
          : "";
        // A present `undefined` reads as `null`, as `toCodecJson` writes it.
        const arms = layout.rows
          .map(({ k, layout: member }) => `        ${k} => sbr_${this.name(member)}(r),\n`)
          .join("");
        return `${head}    match r.byte()? {\n${variantArm}${arms}        _ => { r.rest(); Ok(None) }\n    }\n}\n`;
      }
    }
  }
  private readStruct(layout: StructLayout, head: string, keyed = false): string {
    const names = layout.fields.map((field) => rustString(field.name)).join(", ");
    const arms = layout.fields
      .map(
        (field) =>
          `            ${field.id} => if let Some(value) = sbf_${this.name(field.layout)}(r, wire).map_err(|failure: ${FAILURE}| failure.at_key(${rustString(field.name)}))? { object.insert(${rustString(field.name)}.into(), value); },\n`,
      )
      .join("");
    const extras = layout.extra
      ? `{
                if wire != ${SB}::FIELD_WIRE_SIZED { return Err(${SB}::Invalid("extra field map").into()); }
                let mut map = r.sized()?;
                let mut keys: Vec<String> = Vec::new();
                while !map.is_empty() {
                    ${
                      keyed
                        ? `let (key, pair_wire) = ${SB}::read_interned_key(&mut map, table)?;`
                        : `let code = map.uv()?;
                    let len = usize::try_from(code / 8).map_err(|_| ${SB}::Invalid("complete value"))?;
                    let key = ${SB}::Reader::new(map.take(len)?).string()?;
                    let pair_wire = (code % 8) as u8;`
                    }
                    if [${names}].contains(&key.as_str()) { return Err(${SB}::Invalid("an extra key distinct from declared fields").into()); }
                    if keys.contains(&key) { return Err(${SB}::Invalid("unique extra keys").into()); }
                    keys.push(key.clone());
                    if let Some(value) = sbf_${this.name(layout.extra)}(&mut map, pair_wire).map_err(|failure: ${FAILURE}| failure.at_key(&key))? { object.insert(key, value); }
                }
            }`
      : `${SB}::skip_extras(r, wire, &[${names}])?`;
    return (
      head +
      `    let mut object = serde_json::Map::new();\n    let mut seen: Vec<u64> = Vec::new();\n` +
      `    while !r.is_empty() {\n        let (id, wire) = ${SB}::read_field(r)?;\n` +
      `        if seen.contains(&id) { return Err(${SB}::Invalid("unique field ids").into()); }\n        seen.push(id);\n` +
      `        match id {\n            0 => ${extras},\n${arms}` +
      `            _ => ${SB}::skip_field(r, wire)?,\n        }\n    }\n    Ok(Some(Value::Object(object)))\n}\n`
    );
  }
  private readArray(item: Layout, head: string): string {
    const zeroWidth = item._ === "null" || item._ === "undefined";
    const count = `    let count = ${SB}::read_count(r, ${zeroWidth})?;\n`;
    const each = (read: string) =>
      `${head}${count}    let mut items = Vec::with_capacity(count.min(r.remaining()));\n    for index in 0..count {\n        items.push((|| -> Result<Value, ${FAILURE}> { ${read} })().map_err(|failure| failure.at_index(index))?);\n    }\n    Ok(Some(Value::Array(items)))\n}\n`;
    if (item._ === "struct") {
      return `${head}${count}    if count > 0 { return sbrun_r_${this.run(item)}(r, count); }\n    Ok(Some(Value::Array(Vec::new())))\n}\n`;
    }
    if (item._ === "number")
      return `${head}${count}    Ok(Some(Value::Array(${SB}::read_number_run(r, count)?.into_iter().map(number_value).collect())))\n}\n`;
    if (item._ === "int") return each("Ok(number_value(r.sm()?))");
    if (item._ === "string")
      return each(
        `let len = usize::try_from(r.uv()?).map_err(|_| ${SB}::Invalid("complete value"))?; Ok(Value::String(${SB}::Reader::new(r.take(len)?).string()?))`,
      );
    const read = `sbr_${this.name(item)}`;
    const missing = `.ok_or(${FAILURE}::new(${SB}::Issue::MissingKey))?`;
    if (inline(item)) {
      const width = zeroWidth ? 0 : 1;
      return each(
        `let mut slot = ${SB}::Reader::new(r.take(${width})?); let value = ${read}(&mut slot)?${missing}; slot.finish()?; Ok(value)`,
      );
    }
    return each(
      `let mut slot = r.sized()?; let value = ${read}(&mut slot)?${missing}; slot.finish()?; Ok(value)`,
    );
  }
  /** A struct field's payload by wire kind; an incompatible kind is skipped as absent. */
  private readField(layout: Layout, name: string): string {
    const head = `fn sbf_${name}(r: &mut ${SB}::Reader, wire: u8) -> Result<Option<Value>, ${FAILURE}> {\n`;
    const skip = `{ ${SB}::skip_field(r, wire)?; Ok(None) }`;
    const kind = layout._ === "literal" ? layout.leaf : layout._;
    switch (kind) {
      case "bool":
        return `${head}    match wire { ${SB}::FIELD_WIRE_FALSE => Ok(Some(Value::Bool(false))), ${SB}::FIELD_WIRE_TRUE => Ok(Some(Value::Bool(true))), _ => ${skip} }\n}\n`;
      case "number":
        return `${head}    match wire { ${SB}::FIELD_WIRE_VARINT | ${SB}::FIELD_WIRE_FIXED64 | ${SB}::FIELD_WIRE_DECIMAL => Ok(Some(number_value(${SB}::field_number(r, wire)?))), _ => ${skip} }\n}\n`;
      case "int":
        return `${head}    match wire { ${SB}::FIELD_WIRE_VARINT => Ok(Some(number_value(r.sm()?))), _ => ${skip} }\n}\n`;
      default:
        return `${head}    if wire != ${SB}::FIELD_WIRE_SIZED ${skip} else {\n        let mut slot = r.sized()?;\n        let value = sbr_${name}(&mut slot)?;\n        if value.is_some() { slot.finish()?; }\n        Ok(value)\n    }\n}\n`;
    }
  }
  /** Writes a value the server's own encoders produced into its extent. */
  private write(layout: Layout, name: string): string {
    const head = `fn sbw_${name}(value: &Value, out: &mut Vec<u8>) -> Result<(), String> {\n`;
    switch (layout._) {
      case "string":
        return `${head}    out.extend_from_slice(value.as_str().ok_or("a string")?.as_bytes());\n    Ok(())\n}\n`;
      case "number":
        return `${head}    ${SB}::put_number(out, value_number(value)?);\n    Ok(())\n}\n`;
      case "int":
        return `${head}    ${SB}::put_sm(out, int_number(value)?);\n    Ok(())\n}\n`;
      case "bool":
        return `${head}    out.push(u8::from(value.as_bool().ok_or("a boolean")?));\n    Ok(())\n}\n`;
      case "null":
      case "undefined":
        return `${head}    let _ = (value, out);\n    Ok(())\n}\n`;
      case "never":
        return `${head}    let _ = (value, out);\n    Err("never".into())\n}\n`;
      case "json":
        this.json = true;
        return `${head}    out.extend_from_slice(foldkit_json::json_text(value).as_bytes());\n    Ok(())\n}\n`;
      case "literal":
        return this.write({ _: layout.leaf }, name);
      case "struct":
        return this.writeStruct(layout, head);
      case "array":
        return this.writeArray(layout.item, head);
      case "union": {
        // The member a JSON value can only be, as Effect's member selection finds it: the first
        // variant whose sentinels all match, then a member of the value's kind.
        const variants = layout.variants
          .map((variant) => {
            const guard = variant.sentinels
              .map(({ key, literal }) => literalMatch(`object.get(${rustString(key)})`, literal))
              .join(" && ");
            return `    if let Value::Object(object) = value { if ${guard} { ${SB}::put_variant(out, ${variant.tag}); return sbw_${this.name(variant.payload)}(value, out); } }\n`;
          })
          .join("");
        const pick = (k: number) => {
          const member = layout.rows.find((row) => row.k === k);
          return member === undefined
            ? undefined
            : `{ out.push(${k}); sbw_${this.name(member.layout)}(value, out) }`;
        };
        const json = pick(17);
        const arms = [
          ["Value::Null", pick(2) ?? pick(3)],
          ["Value::Bool(_)", pick(1)],
          ["Value::Number(_)", pick(4)],
          ["Value::String(_)", pick(5) ?? pick(4)],
          ["Value::Array(_)", pick(11)],
          ["Value::Object(_)", pick(9)],
        ]
          .filter((arm) => arm[1] !== undefined)
          .map(([pattern, body]) => `        ${pattern} => ${body},\n`)
          .join("");
        return `${head}${variants}    match value {\n${arms}        _ => ${json ?? `Err("a union member".into())`},\n    }\n}\n`;
      }
    }
  }
  private writeStruct(layout: StructLayout, head: string, keyed = false): string {
    const object = `    let object = value.as_object().ok_or("an object")?;\n`;
    const names = layout.fields.map((field) => rustString(field.name)).join(", ");
    const tag = keyed ? `${SB}::Tag::Interned(key, table)` : `${SB}::Tag::Key(key)`;
    // The extra pairs come first, sorted by their keys' UTF-8 bytes.
    const extras = layout.extra
      ? `    let mut extras: Vec<(&String, &Value)> = object.iter().filter(|(key, _)| ![${names}].contains(&key.as_str())).collect();
    extras.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    if !extras.is_empty() {
        let mut map = Vec::new();
        for (key, item) in extras { sbt_${this.name(layout.extra)}(item, &mut map, ${tag})?; }
        ${SB}::put_field_tag(out, ${SB}::Tag::Id(0), ${SB}::FIELD_WIRE_SIZED);
        ${SB}::put_sized(out, &map);
    }
`
      : "";
    const fields = layout.fields
      .map((field) => {
        const key = rustString(field.name);
        const missing = field.optional
          ? ""
          : ` else { return Err(format!("Missing key {}", ${key})); }`;
        return `    if let Some(item) = object.get(${key}) { sbt_${this.name(field.layout)}(item, out, ${SB}::Tag::Id(${field.id}))?; }${missing}\n`;
      })
      .join("");
    return `${head}${object}${extras}${fields}    let _ = out;\n    Ok(())\n}\n`;
  }
  /** A record read and written with its keys interned against a row-run field's table (KEYS). */
  private keyed(layout: StructLayout): string {
    const name = `k_${namingDigest(JSON.stringify(layout))}`;
    if (this.items.has(name)) return name.slice(2);
    this.items.set(name, "");
    const digest = name.slice(2);
    this.items.set(
      name,
      this.readStruct(
        layout,
        `fn sbrk_${digest}(r: &mut ${SB}::Reader, table: &mut Vec<String>) -> Result<Option<Value>, ${FAILURE}> {\n`,
        true,
      ) +
        this.writeStruct(
          layout,
          `fn sbwk_${digest}(value: &Value, out: &mut Vec<u8>, table: &std::cell::RefCell<${SB}::InternWrite>) -> Result<(), String> {\n`,
          true,
        ),
    );
    return digest;
  }
  private writeArray(item: Layout, head: string): string {
    const items = `    let items = value.as_array().ok_or("an array")?;\n    ${SB}::put_uv(out, items.len() as u64);\n`;
    if (item._ === "struct")
      return `${head}${items}    if !items.is_empty() { sbrun_w_${this.run(item)}(items, out)?; }\n    Ok(())\n}\n`;
    if (item._ === "number")
      return `${head}${items}    let xs = items.iter().map(value_number).collect::<Result<Vec<f64>, String>>()?;\n    ${SB}::put_number_run(out, &xs);\n    Ok(())\n}\n`;
    if (item._ === "string")
      return `${head}${items}    for item in items { ${SB}::put_sized(out, item.as_str().ok_or("a string")?.as_bytes()); }\n    Ok(())\n}\n`;
    const write = `sbw_${this.name(item)}`;
    if (inline(item))
      return `${head}${items}    for item in items { ${write}(item, out)?; }\n    Ok(())\n}\n`;
    return `${head}${items}    for item in items { let mut slot = Vec::new(); ${write}(item, &mut slot)?; ${SB}::put_sized(out, &slot); }\n    Ok(())\n}\n`;
  }
  /** A tagged struct field (or extra entry), with the wire kind its value selects. */
  private writeField(layout: Layout, name: string): string {
    const head = `fn sbt_${name}(value: &Value, out: &mut Vec<u8>, tag: ${SB}::Tag) -> Result<(), String> {\n`;
    const kind = layout._ === "literal" ? layout.leaf : layout._;
    switch (kind) {
      case "bool":
        return `${head}    ${SB}::put_bool_tagged(out, tag, value.as_bool().ok_or("a boolean")?);\n    Ok(())\n}\n`;
      case "number":
        return `${head}    ${SB}::put_number_tagged(out, tag, value_number(value)?);\n    Ok(())\n}\n`;
      case "int":
        return `${head}    let x = int_number(value)?;\n    ${SB}::put_field_tag(out, tag, ${SB}::FIELD_WIRE_VARINT);\n    ${SB}::put_sm(out, x);\n    Ok(())\n}\n`;
      default:
        return `${head}    let mut slot = Vec::new();\n    sbw_${name}(value, &mut slot)?;\n    ${SB}::put_field_tag(out, tag, ${SB}::FIELD_WIRE_SIZED);\n    ${SB}::put_sized(out, &slot);\n    Ok(())\n}\n`;
    }
  }
  /**
   * A stream chunk's elements, `NonEmptyArray(item)`: one slot layout repeated, so a count, then a
   * row run for structs, raw inline slots, or sized ones; no number run (format record §6.1).
   */
  nonEmpty(item: Layout): string {
    const name = `ne_${namingDigest(JSON.stringify(item))}`;
    if (this.items.has(name)) return name;
    this.items.set(name, "");
    const head = `fn sb${name}(items: &[Value], out: &mut Vec<u8>) -> Result<(), String> {\n    ${SB}::put_uv(out, items.len() as u64);\n`;
    const body =
      item._ === "struct"
        ? `    if !items.is_empty() { sbrun_w_${this.run(item)}(items, out)?; }\n`
        : inline(item)
          ? `    for item in items { sbw_${this.name(item)}(item, out)?; }\n`
          : `    for item in items { let mut slot = Vec::new(); sbw_${this.name(item)}(item, &mut slot)?; ${SB}::put_sized(out, &slot); }\n`;
    this.items.set(name, `${head}${body}    Ok(())\n}\n`);
    return name;
  }
  /** A struct array's row run (format record §6.3): shapes, regions and per-field intern tables. */
  private run(layout: StructLayout): string {
    const name = `run_${namingDigest(JSON.stringify(layout))}`;
    if (this.items.has(name)) return name.slice(4);
    this.items.set(name, "");
    const fields = layout.fields;
    const wide = fields.length > 30;
    const kinds = fields.map((field) => internOf(field.layout));
    const digest = name.slice(4);
    const tables = fields
      .map((_, i) => (kinds[i] === "none" ? "" : `    t${i}: Vec<String>,\n`))
      .join("");
    const writeTables = fields
      .map((_, i) =>
        kinds[i] === "none"
          ? ""
          : kinds[i] === "keys"
            ? `    let t${i} = std::cell::RefCell::new(${SB}::InternWrite::default());\n`
            : `    let mut t${i} = ${SB}::InternWrite::default();\n`,
      )
      .join("");
    const names = fields.map((field) => rustString(field.name)).join(", ");
    const unknown = fields.length;
    const extras = fields.length + 1;
    // Writer.
    const presence = fields
      .map((field, i) =>
        field.optional
          ? `        if object.contains_key(${rustString(field.name)}) { mask |= 1 << ${i}; }\n`
          : `        if object.contains_key(${rustString(field.name)}) { mask |= 1 << ${i}; } else { return Err(format!("Missing key {}", ${rustString(field.name)})); }\n`,
      )
      .join("");
    const regions = fields
      .map((field, i) => {
        const region =
          kinds[i] === "self"
            ? `t${i}.put(&mut row, item.as_str().ok_or("a string")?);`
            : kinds[i] === "elements"
              ? `let strings = item.as_array().ok_or("an array")?; let mut region = Vec::new(); ${SB}::put_uv(&mut region, strings.len() as u64); for string in strings { t${i}.put(&mut region, string.as_str().ok_or("a string")?); } ${SB}::put_region(&mut row, &region);`
              : kinds[i] === "keys" && field.layout._ === "struct"
                ? `let mut region = Vec::new(); sbwk_${this.keyed(field.layout)}(item, &mut region, &t${i})?; ${SB}::put_region(&mut row, &region);`
                : `let mut region = Vec::new(); sbw_${this.name(field.layout)}(item, &mut region)?; ${SB}::put_region(&mut row, &region);`;
        return `        if let Some(item) = object.get(${rustString(field.name)}) { if declare { ${SB}::put_uv(&mut row, ${field.id}); } ${region} }\n`;
      })
      .join("");
    // A record row's extra pairs: presence bit 30, then one region of plain pairs before the
    // fields, introduced by id 0 when the shape is declared (`encodeRunRow`).
    const extrasMask = layout.extra
      ? `        let mut extras: Vec<(&String, &Value)> = object.iter().filter(|(key, _)| ![${names}].contains(&key.as_str())).collect();
        extras.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        if !extras.is_empty() { mask |= 1 << ${SB}::RUN_MAX_FIELDS; }
`
      : "";
    const extrasRegion = layout.extra
      ? `        if !extras.is_empty() {
            if declare { ${SB}::put_uv(&mut row, 0); }
            let mut region = Vec::new();
            for (key, item) in extras { sbt_${this.name(layout.extra)}(item, &mut region, ${SB}::Tag::Key(key))?; }
            ${SB}::put_region(&mut row, &region);
        }
`
      : "";
    const write = `fn sbrun_w_${digest}(items: &[Value], out: &mut Vec<u8>) -> Result<(), String> {
    let mut shapes: Vec<u64> = Vec::new();
${writeTables}    for item in items {
        let object = item.as_object().ok_or("an object")?;
        let mut mask: u64 = 0;
${presence}${extrasMask}        let mut row = Vec::new();
        let shape = ${wide ? "None::<usize>" : "shapes.iter().position(|seen| *seen == mask)"};
        match shape {
            Some(index) => ${SB}::put_uv(&mut row, index as u64 + 1),
            None => { ${SB}::put_uv(&mut row, 0); ${wide ? "let _ = &mut shapes;" : "shapes.push(mask);"} }
        }
        let declare = shape.is_none();
${extrasRegion}${regions}        ${SB}::put_sized(out, &row);
    }
    Ok(())
}
`;
    // Reader.
    const slotArms = fields
      .map((field, i) => {
        const key = rustString(field.name);
        const at = `.map_err(|failure: ${FAILURE}| failure.at_key(${key}))?`;
        const body =
          kinds[i] === "self"
            ? `let value = region.string().map_err(${FAILURE}::from)${at}; state.t${i}.push(value.clone()); object.insert(${key}.into(), Value::String(value));`
            : kinds[i] === "elements"
              ? `let value = (|| -> Result<Value, ${FAILURE}> { let count = ${SB}::read_count(&mut region, false)?; let mut strings = Vec::new(); for index in 0..count { strings.push(Value::String(${SB}::read_interned(&mut region, &mut state.t${i}).map_err(|invalid| ${FAILURE}::from(invalid).at_index(index))?)); } region.finish()?; Ok(Value::Array(strings)) })()${at}; object.insert(${key}.into(), value);`
              : kinds[i] === "keys" && field.layout._ === "struct"
                ? `let value = (|| -> Result<Option<Value>, ${FAILURE}> { let value = sbrk_${this.keyed(field.layout)}(&mut region, &mut state.t${i})?; if value.is_some() { region.finish()?; } Ok(value) })()${at}; if let Some(value) = value { object.insert(${key}.into(), value); }`
                : `let value = (|| -> Result<Option<Value>, ${FAILURE}> { let value = sbr_${this.name(field.layout)}(&mut region)?; if value.is_some() { region.finish()?; } Ok(value) })()${at}; if let Some(value) = value { object.insert(${key}.into(), value); }`;
        return `        ${i} => { ${body} }\n`;
      })
      .join("");
    const refArms = fields
      .map((field, i) =>
        kinds[i] === "none"
          ? `            ${i} => return Err(${SB}::Invalid("a known back-reference").into()),\n`
          : `            ${i} => { let value = state.t${i}.get(index).cloned().ok_or(${SB}::Invalid("a known back-reference"))?; object.insert(${rustString(field.name)}.into(), Value::String(value)); }\n`,
      )
      .join("");
    const idArms = fields.map((field, i) => `                ${field.id} => ${i},\n`).join("");
    const read = `#[derive(Default)]
struct SbRun${digest} {
    shapes: Vec<Vec<usize>>,
${tables}}
fn sbrun_slot_${digest}(state: &mut SbRun${digest}, slot: usize, row: &mut ${SB}::Reader, object: &mut serde_json::Map<String, Value>) -> Result<(), ${FAILURE}> {
    let code = row.uv()?;
    if code % 2 == 1 {
        let index = usize::try_from((code - 1) / 2).map_err(|_| ${SB}::Invalid("a known back-reference"))?;
        match slot {
${refArms}            _ => {}
        }
        return Ok(());
    }
    let len = usize::try_from(code / 2).map_err(|_| ${SB}::Invalid("complete value"))?;
    let mut region = ${SB}::Reader::new(row.take(len)?);
    match slot {
${slotArms}        ${extras} => ${
      layout.extra
        ? `{
            let mut keys: Vec<String> = Vec::new();
            while !region.is_empty() {
                let code = region.uv()?;
                let len = usize::try_from(code / 8).map_err(|_| ${SB}::Invalid("complete value"))?;
                let key = ${SB}::Reader::new(region.take(len)?).string()?;
                if [${names}].contains(&key.as_str()) { return Err(${SB}::Invalid("an extra key distinct from declared fields").into()); }
                if keys.contains(&key) { return Err(${SB}::Invalid("unique extra keys").into()); }
                keys.push(key.clone());
                if let Some(value) = sbf_${this.name(layout.extra)}(&mut region, (code % 8) as u8).map_err(|failure: ${FAILURE}| failure.at_key(&key))? { object.insert(key, value); }
            }
        }`
        : `${SB}::skip_extra_pairs(&mut region, &[${names}])?`
    },
        _ => {}
    }
    Ok(())
}
fn sbrun_row_${digest}(state: &mut SbRun${digest}, r: &mut ${SB}::Reader) -> Result<Value, ${FAILURE}> {
    let mut row = r.sized()?;
    let mut object = serde_json::Map::new();
    let code = row.uv()?;
    if code == 0 {
        let mut declared = Vec::new();
        let mut seen: Vec<u64> = Vec::new();
        while !row.is_empty() {
            let id = row.uv()?;
            if seen.contains(&id) { return Err(${SB}::Invalid("unique field ids").into()); }
            seen.push(id);
            let slot = match id {
                0 => ${extras},
${idArms}                _ => ${unknown},
            };
            declared.push(slot);
            sbrun_slot_${digest}(state, slot, &mut row, &mut object)?;
        }
        ${wide ? "let _ = declared;" : "state.shapes.push(declared);"}
    } else {
        let shape = usize::try_from(code - 1).ok().and_then(|index| state.shapes.get(index)).cloned().ok_or(${SB}::Invalid("a known row shape"))?;
        for slot in shape { sbrun_slot_${digest}(state, slot, &mut row, &mut object)?; }
        row.finish()?;
    }
    Ok(Value::Object(object))
}
fn sbrun_r_${digest}(r: &mut ${SB}::Reader, count: usize) -> Result<Option<Value>, ${FAILURE}> {
    let mut state = SbRun${digest}::default();
    let mut items = Vec::with_capacity(count.min(r.remaining()));
    for index in 0..count {
        items.push(sbrun_row_${digest}(&mut state, r).map_err(|failure| failure.at_index(index))?);
    }
    Ok(Some(Value::Array(items)))
}
`;
    this.items.set(name, write + read);
    return digest;
  }
}

/** One procedure's transcoders: its payload, and its exit as `Rpc.exitSchema` writes it. */
export interface BinaryProcedure {
  readonly tag: string;
  readonly rpc: Rpc.AnyWithProps;
}
/**
 * The generated `sb_payload` and `sb_exit` the SchemaBinary body calls (`rpc_binary.rs`), with
 * the envelope fingerprint and frame limit it reads. `json` reports whether an `Unknown` layout
 * was reached, whose JSON text needs `foldkit_json` and ryu-js.
 */
export const schemaBinaryCodecs = (
  procedures: readonly BinaryProcedure[],
  maxFrameSize: number | undefined,
): { readonly text: string; readonly json: boolean } => {
  const emitter = new Emitter();
  const arms = procedures.map(({ tag, rpc }) => {
    const path = `rpc.${tag}`;
    const exit = Rpc.exitSchema(rpc).ast;
    if (!SchemaAST.isDeclaration(exit) || exit.typeParameters.length !== 3)
      throw unsupported(path, "Rpc.exitSchema is not the Exit declaration this compiler reads");
    // A refusal while emitting is a compile error at the schema it came from.
    const emitted = (emit: () => string, at: string) => {
      try {
        return emit();
      } catch (cause) {
        throw cause instanceof Error && !("diagnostics" in cause)
          ? unsupported(at, cause.message)
          : cause;
      }
    };
    const named = (ast: SchemaAST.AST, at: string) =>
      emitted(() => emitter.name(layoutOf(ast, at)), at);
    const stream = RpcSchema.isStreamSchema(rpc.successSchema)
      ? rpc.successSchema.success
      : undefined;
    return {
      tag,
      chunk:
        stream &&
        emitted(() => emitter.nonEmpty(layoutOf(stream.ast, `${path}.stream`)), `${path}.stream`),
      payload: named(rpc.payloadSchema.ast, `${path}.payload`),
      success: named(exit.typeParameters[0], `${path}.success`),
      error: named(exit.typeParameters[1], `${path}.error`),
    };
  });
  const never = emitter.name({ _: "never" });
  const fingerprint = envelopeFingerprint()
    .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
    .join(", ");
  const text = `
/// \`RpcMessage.EncodedSchema\`'s layout fingerprint in the Effect this server was built against.
const ENVELOPE_FINGERPRINT: [u8; 8] = [${fingerprint}];
const MAX_FRAME_SIZE: Option<u64> = ${maxFrameSize === undefined ? "None" : `Some(${maxFrameSize})`};
type SbRead = fn(&mut ${SB}::Reader) -> Result<Option<Value>, ${FAILURE}>;
type SbWrite = fn(&Value, &mut Vec<u8>) -> Result<(), String>;
/// A safe integer a JSON-shaped value holds (an \`int\` layout).
#[allow(dead_code)]
fn int_number(value: &Value) -> Result<f64, String> {
    let x = value_number(value)?;
    if x.fract() != 0.0 || x.abs() > 9007199254740991.0 { return Err("an integer".into()); }
    Ok(x)
}
/// A request's payload frame as the JSON value its procedure's codec reads; an unknown tag reads
/// nothing, and dispatch refuses it.
fn sb_payload(tag: &str, bytes: &[u8]) -> Result<Value, String> {
    let read: SbRead = match tag {
${arms.map((arm) => `        ${rustString(arm.tag)} => sbr_${arm.payload},\n`).join("")}        _ => return Ok(Value::Null),
    };
    let decode = || -> Result<Value, ${FAILURE}> {
        let mut r = ${SB}::Reader::new(${SB}::one_frame(bytes, None)?);
        let value = read(&mut r)?.ok_or(${FAILURE}::new(${SB}::Issue::MissingKey))?;
        r.finish()?;
        Ok(value)
    };
    decode().map_err(|failure| failure.message())
}
/// A streamed chunk's elements, written as its procedure's \`NonEmptyArray\` frame.
fn sb_chunk(tag: &str, values: &[Value]) -> Result<Vec<u8>, String> {
    let mut value = Vec::new();
    match tag {
${arms
  .flatMap((arm) =>
    arm.chunk ? [`        ${rustString(arm.tag)} => sb${arm.chunk}(values, &mut value)?,\n`] : [],
  )
  .join("")}        _ => return Err("a streaming procedure".into()),
    }
    let mut frame = Vec::new();
    ${SB}::put_frame(&mut frame, None, &value);
    Ok(frame)
}
/// An answer's exit, as the JSON value the server builds, written as its procedure's frame.
fn sb_exit(tag: &str, exit: &Value) -> Result<Vec<u8>, String> {
    let (success, error): (SbWrite, SbWrite) = match tag {
${arms.map((arm) => `        ${rustString(arm.tag)} => (sbw_${arm.success}, sbw_${arm.error}),\n`).join("")}        _ => (sbw_${never}, sbw_${never}),
    };
    let mut value = Vec::new();
    match exit.get("_tag").and_then(Value::as_str) {
        Some("Success") => {
            let mut success_value = Vec::new();
            success(exit.get("value").unwrap_or(&Value::Null), &mut success_value)?;
            ${SB}::put_exit_success(&mut value, &success_value);
        }
        Some("Failure") => {
            let mut reasons = Vec::new();
            for reason in exit.get("cause").and_then(Value::as_array).ok_or("a Cause")? {
                reasons.push(match reason.get("_tag").and_then(Value::as_str) {
                    Some("Fail") => {
                        let mut error_value = Vec::new();
                        error(reason.get("error").unwrap_or(&Value::Null), &mut error_value)?;
                        ${SB}::Reason::Fail(error_value)
                    }
                    Some("Die") => ${SB}::Reason::Die(json_text(reason.get("defect").unwrap_or(&Value::Null)).into_bytes()),
                    Some("Interrupt") => ${SB}::Reason::Interrupt(None),
                    _ => return Err("a Cause reason".into()),
                });
            }
            ${SB}::put_exit_failure(&mut value, &reasons);
        }
        _ => return Err("an Exit".into()),
    }
    let mut frame = Vec::new();
    ${SB}::put_frame(&mut frame, None, &value);
    Ok(frame)
}
${[...emitter.items.values()].join("")}`;
  return { text, json: emitter.json };
};
