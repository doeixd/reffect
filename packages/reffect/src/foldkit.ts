import { Effect, Match, SchemaAST } from "effect";
import { isPredicate } from "foldkit-entity";
import type { AnyQuery, Operandish, Operation, Row } from "foldkit-entity";
import { CargoApi } from "./cargo.ts";
import type { GeneratedFiles } from "./cargo.ts";
import { CompileError, SemanticRef, fail } from "./kernel.ts";
import { foldkitMain, foldkitRuntime } from "./foldkit-runtime.ts";

type Scalar = string | number | boolean | null;
type Kind = "string" | "number" | "boolean" | "null";
interface Slot {
  readonly key: string;
  readonly kinds: readonly Kind[];
}
type Node =
  | { readonly _tag: "Field"; readonly index: number }
  | { readonly _tag: "Input"; readonly index: number }
  | { readonly _tag: "Literal"; readonly value: Scalar }
  | { readonly _tag: "Eq"; readonly left: Node; readonly right: Node }
  | { readonly _tag: "Null"; readonly operand: Node; readonly present: boolean }
  | { readonly _tag: "Contains"; readonly value: Node; readonly search: Node };
export interface QueryAnalysis {
  readonly name: string;
  readonly entity: string;
  readonly fields: readonly Slot[];
  readonly inputs: readonly Slot[];
  readonly operations: readonly Operation[];
  readonly implementations: readonly {
    readonly operation: SemanticRef<"operation">;
    readonly strategy: "generated";
    readonly rationale: string;
  }[];
  readonly crates: readonly string[];
  readonly profile: "foldkit/encoded-primitives@1";
}
interface CheckedQuery {
  readonly analysis: QueryAnalysis;
  readonly where: readonly Node[];
  readonly order: readonly { readonly index: number; readonly direction: "asc" | "desc" }[];
}
export interface FoldkitArtifact extends GeneratedFiles {
  readonly explanation: readonly QueryAnalysis[];
  readonly stages: readonly string[];
}

const kindsOf = (ast: SchemaAST.AST, path: string): readonly Kind[] => {
  const encoded = SchemaAST.toEncoded(ast);
  if (SchemaAST.isString(encoded)) return ["string"];
  if (SchemaAST.isNumber(encoded)) return ["number"];
  if (SchemaAST.isBoolean(encoded)) return ["boolean"];
  if (SchemaAST.isNull(encoded)) return ["null"];
  if (SchemaAST.isLiteral(encoded)) return [scalarKind(encoded.literal, path)];
  if (SchemaAST.isUnion(encoded)) {
    return [...new Set(encoded.types.flatMap((t) => kindsOf(t, path)))];
  }
  throw fail("UNSUPPORTED_REPRESENTATION", "check", path, "Expected an encoded primitive schema");
};
const scalarKind = (value: unknown, path: string): Kind => {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  throw fail(
    "UNSUPPORTED_REPRESENTATION",
    "check",
    path,
    "Expected an already encoded primitive value",
  );
};
const supported: readonly Operation[] = Object.freeze(["eq", "isNull", "isNotNull", "contains"]);
const refs = new Map(supported.map((op) => [op, SemanticRef.operation(`foldkit/${op}@0.4.0`)]));
const checked = (name: string, body: AnyQuery): CheckedQuery => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    throw fail("INVALID_NAME", "check", name, "Query name must be an ASCII identifier");
  const fields: Slot[] = [];
  const inputs: Slot[] = [];
  const inputSchemas = new Map<string, SchemaAST.AST>();
  const operations = new Set<Operation>();
  const memo = new Map<Operandish, Node>();
  const active = new Set<Operandish>();
  const slot = (slots: Slot[], key: string, ast: SchemaAST.AST, path: string) => {
    const existing = slots.findIndex((s) => s.key === key);
    if (existing >= 0) return existing;
    slots.push(Object.freeze({ key, kinds: Object.freeze(kindsOf(ast, path)) }));
    return slots.length - 1;
  };
  const visit = (node: Operandish, path: string): Node => {
    const existing = memo.get(node);
    if (existing) return existing;
    if (active.has(node))
      throw fail("CYCLIC_IR", "check", path, "Query expressions must be acyclic");
    active.add(node);
    const result: Node = Match.value(node).pipe(
      Match.tagsExhaustive({
        Field: (n): Node => {
          if (n.owner.token !== body.entity.identity.token)
            throw fail("FOREIGN_FIELD", "check", path, "Field belongs to another Entity identity");
          if (!Object.hasOwn(body.entity.fields, n.key))
            throw fail("UNKNOWN_FIELD", "check", path, `Entity has no intrinsic field ${n.key}`);
          // AnyEntity erases its fields; recover the declared field witness at this boundary.
          const declared = body.entity.fields[n.key] as {
            readonly schema: { readonly ast: SchemaAST.AST };
          };
          if (declared.schema.ast !== n.schema.ast)
            throw fail(
              "FIELD_WITNESS_MISMATCH",
              "check",
              path,
              "Field schema differs from its Entity declaration",
            );
          return { _tag: "Field", index: slot(fields, n.key, n.schema.ast, path) };
        },
        Input: (n): Node => {
          const previous = inputSchemas.get(n.key);
          if (previous && previous !== n.schema.ast)
            throw fail(
              "INPUT_WITNESS_MISMATCH",
              "check",
              path,
              "One input key has different schema witnesses",
            );
          inputSchemas.set(n.key, n.schema.ast);
          return { _tag: "Input", index: slot(inputs, n.key, n.schema.ast, path) };
        },
        Literal: (n): Node => {
          scalarKind(n.value, path);
          return { _tag: "Literal", value: (n.value ?? null) as Scalar };
        },
        Eq: (n): Node => {
          operations.add("eq");
          return {
            _tag: "Eq",
            left: visit(n.left, `${path}.left`),
            right: visit(n.right, `${path}.right`),
          };
        },
        Null: (n): Node => {
          if (isPredicate(n.operand) || typeof n.present !== "boolean")
            throw fail(
              "INVALID_IR",
              "check",
              path,
              "Null tests require a scalar operand and boolean presence flag",
            );
          operations.add(n.present ? "isNotNull" : "isNull");
          return { _tag: "Null", operand: visit(n.operand, `${path}.operand`), present: n.present };
        },
        Contains: (n): Node => {
          if (isPredicate(n.value))
            throw fail("INVALID_IR", "check", path, "Containment requires a scalar text value");
          operations.add("contains");
          return {
            _tag: "Contains",
            value: visit(n.value, `${path}.value`),
            search: visit(n.search, `${path}.search`),
          };
        },
      }),
    );
    active.delete(node);
    const frozen = Object.freeze(result);
    memo.set(node, frozen);
    return frozen;
  };
  const where = body.where.map((n, i) => {
    if (!isPredicate(n))
      throw fail("INVALID_IR", "check", `${name}.where.${i}`, "A where clause must be a predicate");
    return visit(n, `${name}.where.${i}`);
  });
  const nodeKinds = (node: Node): readonly Kind[] =>
    Match.value(node).pipe(
      Match.tagsExhaustive({
        Field: (n) => fields[n.index].kinds,
        Input: (n) => inputs[n.index].kinds,
        Literal: (n) => [scalarKind(n.value, name)],
        Eq: (): readonly Kind[] => ["boolean", "null"],
        Null: (): readonly Kind[] => ["boolean"],
        Contains: (): readonly Kind[] => ["boolean", "null"],
      }),
    );
  for (const node of memo.values()) {
    Match.value(node).pipe(
      Match.tag("Contains", (n) => {
        if (
          [n.value, n.search].some((s) => nodeKinds(s).some((k) => k !== "string" && k !== "null"))
        )
          throw fail(
            "UNSUPPORTED_CONTAINMENT",
            "check",
            name,
            "Containment requires encoded text operands",
          );
      }),
      Match.orElse(() => undefined),
    );
  }
  const order = body.orderBy.map((term, i) => {
    const path = `${name}.orderBy.${i}`;
    const node = visit(term.expr, path);
    const index = Match.value(node).pipe(
      Match.tag("Field", (n) => n.index),
      Match.orElse(() => {
        throw fail("UNSUPPORTED_ORDERING", "check", path, "Ordering requires a field reference");
      }),
    );
    if (term.direction !== "asc" && term.direction !== "desc")
      throw fail("UNSUPPORTED_ORDERING", "check", path, "Unknown ordering direction");
    const kinds = fields[index].kinds.filter((k) => k !== "null");
    if (kinds.length !== 1)
      throw fail(
        "UNSUPPORTED_ORDERING",
        "check",
        path,
        "Ordering requires one primitive representation",
      );
    return Object.freeze({ index, direction: term.direction });
  });
  // Upstream dependencies deduplicate by display name and recursively expand shared DAGs.
  // Use the checked, identity-aware traversal above with the same operation vocabulary.
  const missing = [...operations].filter((op) => !supported.includes(op));
  if (missing.length)
    throw fail(
      "UNSUPPORTED_OPERATION",
      "plan",
      name,
      `Unsupported operations: ${missing.join(", ")}`,
    );
  return Object.freeze({
    where: Object.freeze(where),
    order: Object.freeze(order),
    analysis: Object.freeze({
      name,
      entity: body.entity.name,
      fields: Object.freeze(fields),
      inputs: Object.freeze(inputs),
      operations: Object.freeze([...operations]),
      implementations: Object.freeze(
        [...operations].map((op) =>
          Object.freeze({
            operation: refs.get(op)!,
            strategy: "generated" as const,
            rationale:
              op === "contains"
                ? "Verified non-NUL ASCII folding with literal substring search"
                : "Encoded primitive comparison with SQL unknown propagation",
          }),
        ),
      ),
      crates: Object.freeze([]),
      profile: "foldkit/encoded-primitives@1",
    }),
  });
};

const token = (value: Scalar): string => {
  if (value === null) return "n";
  if (typeof value === "boolean") return value ? "t" : "f";
  if (typeof value === "number") {
    const bytes = new DataView(new ArrayBuffer(8));
    bytes.setFloat64(0, value);
    return `d${bytes.getBigUint64(0).toString(16).padStart(16, "0")}`;
  }
  return `s${Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16).padStart(4, "0")).join("")}`;
};
const literalRust = (value: Scalar): string => {
  // Only compiler-created ASCII token characters reach Rust source.
  return `parse_value("${token(value)}")?`;
};
const emitQuery = (query: CheckedQuery): string => {
  const lines: string[] = [];
  const emitted = new Map<Node, string>();
  const expr = (node: Node): string => {
    const found = emitted.get(node);
    if (found) return found;
    const source = Match.value(node).pipe(
      Match.tagsExhaustive({
        Field: (n) => `&row[${n.index}]`,
        Input: (n) => `&input[${n.index}]`,
        Literal: (n) => literalRust(n.value),
        Eq: (n) => `eq(${expr(n.left)}, ${expr(n.right)})`,
        Null: (n) => `null(${expr(n.operand)}, ${n.present})`,
        Contains: (n) => `contains(${expr(n.value)}, ${expr(n.search)})?`,
      }),
    );
    const id = emitted.size;
    const borrowed = Match.value(node).pipe(
      Match.tags({ Field: () => true, Input: () => true }),
      Match.orElse(() => false),
    );
    if (borrowed) lines.push(`    let v${id} = ${source};`);
    else lines.push(`    let l${id} = ${source}; let v${id} = &l${id};`);
    emitted.set(node, `v${id}`);
    return `v${id}`;
  };
  // Retain where short-circuiting: later predicates may refuse unsupported runtime values.
  for (const predicate of query.where) {
    const value = expr(predicate);
    lines.push(`    if !matches!(${value}, Value::Bool(true)) { return Ok(false); }`);
  }
  const name = query.analysis.name;
  const validate = (slot: Slot, value: string) => {
    const patterns = [
      "Value::Null",
      ...slot.kinds
        .filter((k) => k !== "null")
        .map(
          (k) =>
            ({ string: "Value::Text(_)", number: "Value::Number(_)", boolean: "Value::Bool(_)" })[
              k
            ],
        ),
    ];
    return `matches!(${value}, ${patterns.join(" | ")})`;
  };
  const checks = [
    ...query.analysis.inputs.map((s, i) => validate(s, `&input[${i}]`)),
    ...query.analysis.fields.map((s, i) => `rows.iter().all(|row| ${validate(s, `&row[${i}]`)})`),
  ];
  const comparison = query.order
    .map(
      (term) => `        let order = compare(&rows[*a][${term.index}], &rows[*b][${term.index}])?;
        if order != Ordering::Equal { return Ok(${term.direction === "desc" ? "order.reverse()" : "order"}); }`,
    )
    .join("\n");
  const validateOrder = query.order
    .map(
      (term) =>
        `        for index in &selected { compare(&rows[*index][${term.index}], &rows[*index][${term.index}])?; }`,
    )
    .join("\n");
  return `fn matches_${name}(input: &[Value], row: &[Value]) -> Result<bool, &'static str> {
${lines.join("\n")}
    Ok(true)
}
pub fn r_${name}(input: &[Value], rows: &[Vec<Value>]) -> Result<Vec<usize>, &'static str> {
    if input.len() != ${query.analysis.inputs.length} || rows.iter().any(|r| r.len() != ${query.analysis.fields.length}) { return Err("incorrect evaluator arity"); }
    if !(${checks.join(" && ") || "true"}) { return Err("INVALID_INPUT: expected an encoded primitive representation"); }
    let mut selected = Vec::new();
    for (index, row) in rows.iter().enumerate() { if matches_${name}(input, row)? { selected.push(index); } }
    if selected.len() > 1 {
${validateOrder}
    }
    let compare_rows = |a: &usize, b: &usize| -> Result<Ordering, &'static str> {
${comparison}
        Ok(Ordering::Equal)
    };
    // All sort keys have been validated; compare_rows is a total order in this profile.
    selected.sort_by(|a, b| compare_rows(a, b).expect("validated primitive sort keys"));
    Ok(selected)
}
`;
};
const compile = Effect.fn("Foldkit.compile")(function* (
  queries: Readonly<Record<string, AnyQuery>>,
) {
  const all = yield* Effect.try({
    try: () => {
      if (!Object.keys(queries).length)
        throw fail("EMPTY_PROGRAM", "check", "queries", "At least one Query is required");
      return Object.entries(queries).map(([name, body]) => checked(name, body));
    },
    catch: (e) =>
      e instanceof CompileError ? e : fail("INVALID_IR", "check", "queries", String(e)),
  });
  const artifact: FoldkitArtifact = Object.freeze({
    explanation: Object.freeze(all.map((q) => q.analysis)),
    stages: Object.freeze([
      "check",
      "derive",
      "normalize",
      "plan",
      "verify",
      "optimize",
      "ownership",
      "lower",
      "emit",
    ]),
    files: Object.freeze({
      "Cargo.toml":
        '[package]\nname = "reffect_generated"\nversion = "0.0.0"\nedition = "2021"\n\n[workspace]\n',
      "src/lib.rs": foldkitRuntime + all.map(emitQuery).join("\n"),
      "src/main.rs": foldkitMain(
        all
          .map(
            (q) =>
              `        "${q.analysis.name}" => (${q.analysis.fields.length}, ${q.analysis.inputs.length}, reffect_generated::r_${q.analysis.name}),`,
          )
          .join("\n"),
      ),
    }),
  });
  return artifact;
});

const encode = (analysis: QueryAnalysis, input: Row, rows: readonly Row[]): string => {
  const value = (record: Row, slot: Slot, path: string) => {
    const item = Object.hasOwn(record, slot.key) ? record[slot.key] : null;
    const kind = scalarKind(item, path);
    // Foldkit treats absent values as SQL null even where the schema is not nullable.
    if (kind !== "null" && !slot.kinds.includes(kind))
      throw fail(
        "INVALID_INPUT",
        "evaluate",
        path,
        "Value is not in the schema's encoded primitive representation",
      );
    return token((item ?? null) as Scalar);
  };
  return (
    [
      "reffect-query-v1",
      String(rows.length),
      ...analysis.inputs.map((s) => value(input, s, `input.${s.key}`)),
      ...rows.flatMap((r, i) => analysis.fields.map((s) => value(r, s, `rows.${i}.${s.key}`))),
    ].join("\n") + "\n"
  );
};
const run = Effect.fn("Foldkit.run")(function* <A extends Row>(
  artifact: FoldkitArtifact,
  directory: string,
  name: string,
  input: Row,
  rows: readonly A[],
  profile: "debug" | "release" = "debug",
) {
  const supplied = Array.from(rows);
  const payload = yield* Effect.try({
    try: () => {
      const analysis = artifact.explanation.find((q) => q.name === name);
      if (!analysis) throw fail("UNKNOWN_QUERY", "evaluate", name, "Query is not in this artifact");
      return encode(analysis, input, supplied);
    },
    catch: (e) =>
      e instanceof CompileError ? e : fail("INVALID_INPUT", "evaluate", name, String(e)),
  });
  const result = yield* CargoApi.runInput(directory, name, payload, profile);
  return yield* Effect.try({
    try: () => {
      const seen = new Set<number>();
      return result.stdout.trim() === ""
        ? []
        : result.stdout
            .trim()
            .split("\n")
            .map((line) => {
              const index = Number(line);
              if (
                !/^\d+$/.test(line) ||
                !Number.isSafeInteger(index) ||
                index >= supplied.length ||
                seen.has(index)
              )
                throw fail(
                  "INVALID_NATIVE_RESULT",
                  "evaluate",
                  name,
                  "Evaluator returned invalid row indices",
                );
              seen.add(index);
              return supplied[index];
            });
    },
    catch: (e) =>
      e instanceof CompileError ? e : fail("INVALID_NATIVE_RESULT", "evaluate", name, String(e)),
  });
});

/** A compiler consumer of the published Foldkit IR; inputs and rows are already encoded. */
export const Foldkit = Object.freeze({
  compile,
  run,
  supported,
  build: Effect.fn("Foldkit.build")(function* (
    queries: Readonly<Record<string, AnyQuery>>,
    output: string,
    profile: "debug" | "release" = "release",
  ) {
    const artifact = yield* compile(queries);
    const directory = yield* CargoApi.write(artifact, output);
    const process = yield* CargoApi.build(directory, profile);
    return { artifact, directory, process, stages: artifact.stages.concat("build") };
  }),
});
