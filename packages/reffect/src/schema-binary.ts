/**
 * SchemaBinary transcoders for NativeRpc (milestone 10, docs/research/schema-binary.md, SB-003):
 * Rust functions between a contract schema's SchemaBinary form, as effect 4.0.0 lays it out in
 * default (evolution) mode, and the encoded JSON value the server's verified codecs read and
 * write. Layouts come from the schema's encoded AST, as `SchemaBinary` compiles them; each one is
 * emitted once as straight-line code, so no schema tree is interpreted at run time.
 */
import { Effect, Match, SchemaAST } from "effect";
import { Rpc, RpcSerialization } from "effect/rpc";
import { unsupported } from "./contract-codec.ts";
import { namingDigest } from "./naming.ts";

/** The admitted layouts, a subset of `SchemaBinary`'s (format record §2.1). */
type Layout =
  | { readonly _: "string" | "number" | "int" | "bool" | "null" | "undefined" | "never" }
  | {
      readonly _: "literal";
      readonly leaf: "string" | "number" | "bool";
      readonly values: readonly (string | number | boolean)[];
    }
  | { readonly _: "struct"; readonly fields: readonly Field[] }
  /** Members told apart by their kind byte `K`, in ascending kind order. */
  | {
      readonly _: "union";
      readonly rows: readonly { readonly k: number; readonly layout: Layout }[];
    };
interface Field {
  readonly name: string;
  readonly id: number;
  readonly optional: boolean;
  readonly layout: Layout;
}

const FIELD_ID_ANNOTATION = "~effect/encoding/SchemaBinary/fieldId";
/** FNV-1a 32 of the UTF-8 name: a field's default id (`fnv32`). */
export const defaultFieldId = (name: string): number => {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) hash = Math.imul(hash ^ byte, 0x01000193);
  return hash >>> 0;
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
const literalOf = (value: SchemaAST.LiteralValue, path: string): Layout => {
  if (typeof value === "string") return { _: "literal", leaf: "string", values: [value] };
  if (typeof value === "number") return { _: "literal", leaf: "number", values: [value] };
  if (typeof value === "boolean") return { _: "literal", leaf: "bool", values: [value] };
  throw unsupported(path, "BigInt literals under SchemaBinary are not supported yet");
};
/** The kind byte that tells a union member apart (`K`). */
const kindOf = (layout: Layout): number => {
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
    case "literal":
      return layout.leaf === "string" ? 5 : layout.leaf === "number" ? 4 : 1;
    case "never":
    case "union":
      throw new Error(`No kind for a ${layout._} layout`);
  }
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
  if (SchemaAST.isLiteral(encoded)) return literalOf(encoded.literal, path);
  if (SchemaAST.isObjects(encoded)) {
    if (encoded.indexSignatures.length)
      throw unsupported(path, "Records under SchemaBinary are not supported yet");
    const fields = encoded.propertySignatures.map((property): Field => {
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
    const ids = new Set(fields.map((field) => field.id));
    if (ids.size !== fields.length) throw unsupported(path, "Two fields share a SchemaBinary id");
    return { _: "struct", fields: [...fields].sort((a, b) => a.id - b.id) };
  }
  if (SchemaAST.isUnion(encoded)) return unionOf(encoded, path);
  throw unsupported(path, `${encoded._tag} schemas under SchemaBinary are not supported yet`);
};
/** Effect's member flattening and classification (format record §7), for unions without variants. */
const unionOf = (ast: SchemaAST.Union, path: string): Layout => {
  const members: Layout[] = [];
  const visit = (member: SchemaAST.AST) => {
    const encoded = SchemaAST.toEncoded(member);
    if (SchemaAST.isUnion(encoded) && !encoded.checks) encoded.types.forEach(visit);
    else if (!SchemaAST.isNever(encoded)) {
      if (
        SchemaAST.isObjects(encoded) &&
        encoded.propertySignatures.some(
          (property) =>
            !SchemaAST.isOptional(property.type) &&
            SchemaAST.isLiteral(SchemaAST.toEncoded(property.type)),
        )
      )
        throw unsupported(path, "Tagged unions under SchemaBinary are not supported yet");
      members.push(layoutOf(encoded, path));
    }
  };
  ast.types.forEach(visit);
  const literals = members.filter((member) => member._ === "literal");
  const others = members.filter((member) => member._ !== "literal");
  const literalRows = [...new Set(literals.map((literal) => literal.leaf))].map((leaf): Layout => ({
    _: "literal",
    leaf,
    values: literals.filter((literal) => literal.leaf === leaf).flatMap((l) => l.values),
  }));
  if (others.length === 0 && literalRows.length === 1) return literalRows[0];
  if (others.length === 1 && literalRows.length === 0) return others[0];
  const rows = [...literalRows, ...others].map((layout) => ({ k: kindOf(layout), layout }));
  if (new Set(rows.map((row) => row.k)).size !== rows.length)
    throw unsupported(path, "Union members SchemaBinary cannot tell apart");
  return { _: "union", rows: rows.sort((a, b) => a.k - b.k) };
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

/** The functions of every layout reached, each emitted once under a digest of its layout. */
class Emitter {
  readonly items = new Map<string, string>();
  name(layout: Layout): string {
    const name = namingDigest(JSON.stringify(layout));
    if (!this.items.has(name)) {
      this.items.set(name, "");
      this.items.set(name, this.read(layout, name) + this.write(layout, name));
    }
    return name;
  }
  /** Reads the whole extent; `None` is an unknown union member, which reads as absent. */
  private read(layout: Layout, name: string): string {
    const head = `fn sbr_${name}(r: &mut ${SB}::Reader) -> Result<Option<Value>, ${SB}::Failure> {\n`;
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
        return `${head}    let _ = r;\n    Err(${SB}::Failure::new(${SB}::Issue::Invalid("never")))\n}\n`;
      case "literal":
        // Membership is the verified JSON codec's check, with its own message.
        return this.read({ _: layout.leaf }, name);
      case "struct": {
        const arms = layout.fields
          .map((field) => `            ${field.id} => ${this.readField(field)}\n`)
          .join("");
        const names = layout.fields.map((field) => rustString(field.name)).join(", ");
        return (
          head +
          `    let mut object = serde_json::Map::new();\n    let mut seen: Vec<u64> = Vec::new();\n` +
          `    while !r.is_empty() {\n        let (id, wire) = ${SB}::read_field(r)?;\n` +
          `        if seen.contains(&id) { return Err(${SB}::Invalid("unique field ids").into()); }\n        seen.push(id);\n` +
          `        match id {\n            0 => ${SB}::skip_extras(r, wire, &[${names}])?,\n${arms}` +
          `            _ => ${SB}::skip_field(r, wire)?,\n        }\n    }\n    Ok(Some(Value::Object(object)))\n}\n`
        );
      }
      case "union": {
        // A present `undefined` reads as `null`, as `toCodecJson` writes it.
        const arms = layout.rows
          .map(({ k, layout: member }) => `        ${k} => sbr_${this.name(member)}(r),\n`)
          .join("");
        return `${head}    match r.byte()? {\n${arms}        _ => { r.rest(); Ok(None) }\n    }\n}\n`;
      }
    }
  }
  /** A struct field's arm: its payload by wire kind; an incompatible kind is skipped as absent. */
  private readField(field: Field): string {
    const key = rustString(field.name);
    const at = `.map_err(|failure: ${SB}::Failure| failure.at_key(${key}))?`;
    const layout = field.layout._ === "literal" ? { _: field.layout.leaf } : field.layout;
    switch (layout._) {
      case "bool":
        return `if wire == ${SB}::FIELD_WIRE_FALSE || wire == ${SB}::FIELD_WIRE_TRUE { object.insert(${key}.into(), Value::Bool(wire == ${SB}::FIELD_WIRE_TRUE)); } else { ${SB}::skip_field(r, wire)?; },`;
      case "number":
        return `if matches!(wire, ${SB}::FIELD_WIRE_VARINT | ${SB}::FIELD_WIRE_FIXED64 | ${SB}::FIELD_WIRE_DECIMAL) { let x = ${SB}::field_number(r, wire).map_err(${SB}::Failure::from)${at}; object.insert(${key}.into(), number_value(x)); } else { ${SB}::skip_field(r, wire)?; },`;
      case "int":
        return `if wire == ${SB}::FIELD_WIRE_VARINT { let x = r.sm().map_err(${SB}::Failure::from)${at}; object.insert(${key}.into(), number_value(x)); } else { ${SB}::skip_field(r, wire)?; },`;
      default: {
        const read = `sbr_${this.name(field.layout)}`;
        return `if wire == ${SB}::FIELD_WIRE_SIZED { let value = (|| -> Result<Option<Value>, ${SB}::Failure> { let mut slot = r.sized()?; match ${read}(&mut slot)? { Some(value) => { slot.finish()?; Ok(Some(value)) } None => Ok(None) } })()${at}; if let Some(value) = value { object.insert(${key}.into(), value); } } else { ${SB}::skip_field(r, wire)?; },`;
      }
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
        return `${head}    let x = value_number(value)?;\n    if x.fract() != 0.0 || x.abs() > 9007199254740991.0 { return Err("an integer".into()); }\n    ${SB}::put_sm(out, x);\n    Ok(())\n}\n`;
      case "bool":
        return `${head}    out.push(u8::from(value.as_bool().ok_or("a boolean")?));\n    Ok(())\n}\n`;
      case "null":
      case "undefined":
        return `${head}    let _ = (value, out);\n    Ok(())\n}\n`;
      case "never":
        return `${head}    let _ = (value, out);\n    Err("never".into())\n}\n`;
      case "literal":
        return this.write({ _: layout.leaf }, name);
      case "struct": {
        const fields = layout.fields.map((field) => this.writeField(field)).join("");
        return `${head}    let object = value.as_object().ok_or("an object")?;\n${fields}    let _ = out;\n    Ok(())\n}\n`;
      }
      case "union": {
        // The member a JSON value can only be, as Effect's member selection finds it.
        const pick = (k: number) => {
          const member = layout.rows.find((row) => row.k === k);
          return member === undefined
            ? undefined
            : member.layout._ === "null"
              ? `{ out.push(${k}); Ok(()) }`
              : `{ out.push(${k}); sbw_${this.name(member.layout)}(value, out) }`;
        };
        const arms = [
          ["Value::Null", pick(2) ?? pick(3)],
          ["Value::Bool(_)", pick(1)],
          ["Value::Number(_)", pick(4)],
          ["Value::String(_)", pick(5) ?? pick(4)],
          ["Value::Object(_)", pick(9)],
        ]
          .filter((arm) => arm[1] !== undefined)
          .map(([pattern, body]) => `        ${pattern} => ${body},\n`)
          .join("");
        return `${head}    match value {\n${arms}        _ => Err("a union member".into()),\n    }\n}\n`;
      }
    }
  }
  private writeField(field: Field): string {
    const key = rustString(field.name);
    const layout = field.layout._ === "literal" ? { _: field.layout.leaf } : field.layout;
    const missing = field.optional
      ? ""
      : ` else { return Err(format!("Missing key {}", ${key})); }`;
    const body = (() => {
      switch (layout._) {
        case "bool":
          return `${SB}::put_bool_field(out, ${field.id}, value.as_bool().ok_or("a boolean")?);`;
        case "number":
          return `${SB}::put_number_field(out, ${field.id}, value_number(value)?);`;
        case "int":
          return `let x = value_number(value)?; if x.fract() != 0.0 || x.abs() > 9007199254740991.0 { return Err("an integer".into()); } ${SB}::put_tag(out, ${field.id}, ${SB}::FIELD_WIRE_VARINT); ${SB}::put_sm(out, x);`;
        default:
          return `let mut slot = Vec::new(); sbw_${this.name(field.layout)}(value, &mut slot)?; ${SB}::put_sized_field(out, ${field.id}, &slot);`;
      }
    })();
    return `    if let Some(value) = object.get(${key}) { ${body} }${missing}\n`;
  }
}

/** One procedure's transcoders: its payload, and its exit as `Rpc.exitSchema` writes it. */
export interface BinaryProcedure {
  readonly tag: string;
  readonly rpc: Rpc.AnyWithProps;
}
/**
 * The generated `sb_payload` and `sb_exit` the SchemaBinary body calls (`rpc_binary.rs`), with
 * the envelope fingerprint and frame limit it reads.
 */
export const schemaBinaryCodecs = (
  procedures: readonly BinaryProcedure[],
  maxFrameSize: number | undefined,
): string => {
  const emitter = new Emitter();
  const arms = procedures.map(({ tag, rpc }) => {
    const path = `rpc.${tag}`;
    const exit = Rpc.exitSchema(rpc).ast;
    if (!SchemaAST.isDeclaration(exit) || exit.typeParameters.length !== 3)
      throw unsupported(path, "Rpc.exitSchema is not the Exit declaration this compiler reads");
    return {
      tag,
      payload: emitter.name(layoutOf(rpc.payloadSchema.ast, `${path}.payload`)),
      success: emitter.name(layoutOf(exit.typeParameters[0], `${path}.success`)),
      error: emitter.name(layoutOf(exit.typeParameters[1], `${path}.error`)),
    };
  });
  const never = emitter.name({ _: "never" });
  const fingerprint = envelopeFingerprint()
    .map((byte) => `0x${byte.toString(16).padStart(2, "0")}`)
    .join(", ");
  return `
/// \`RpcMessage.EncodedSchema\`'s layout fingerprint in the Effect this server was built against.
const ENVELOPE_FINGERPRINT: [u8; 8] = [${fingerprint}];
const MAX_FRAME_SIZE: Option<u64> = ${maxFrameSize === undefined ? "None" : `Some(${maxFrameSize})`};
type SbRead = fn(&mut ${SB}::Reader) -> Result<Option<Value>, ${SB}::Failure>;
type SbWrite = fn(&Value, &mut Vec<u8>) -> Result<(), String>;
/// A request's payload frame as the JSON value its procedure's codec reads; an unknown tag reads
/// nothing, and dispatch refuses it.
fn sb_payload(tag: &str, bytes: &[u8]) -> Result<Value, String> {
    let read: SbRead = match tag {
${arms.map((arm) => `        ${rustString(arm.tag)} => sbr_${arm.payload},\n`).join("")}        _ => return Ok(Value::Null),
    };
    let decode = || -> Result<Value, ${SB}::Failure> {
        let mut r = ${SB}::Reader::new(${SB}::one_frame(bytes, None)?);
        let value = read(&mut r)?.ok_or(${SB}::Failure::new(${SB}::Issue::MissingKey))?;
        r.finish()?;
        Ok(value)
    };
    decode().map_err(|failure| failure.message())
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
};
