import { Cause, Effect, Exit, Option, Schema, SchemaAST, SchemaIssue } from "effect";
import { Rpc, type RpcGroup } from "effect/rpc";
import { Compile, Rust, type Plan } from "./compiler.ts";
import { FailureFrames } from "./frame-policy.ts";
import type { FailureFramePolicy } from "./frame-policy.ts";
import { SourceArtifacts } from "./artifact-policy.ts";
import type { GeneratedFiles } from "./cargo.ts";
import { EffectFn, SyncEffects, isAsyncComputation, launch } from "./effect-ir.ts";
import { Service } from "./context.ts";
import { StaticLayer } from "./layer.ts";
import {
  CompileError,
  BoolType,
  Fn,
  IRType,
  NeverType,
  Program,
  StringType,
  U64Type,
  UnitType,
  fail,
} from "./kernel.ts";
import type { AnyFn } from "./kernel.ts";
import { Rs } from "./rust-emit.ts";
import { ArrayType, Struct, TaggedUnion, rustFieldNames, rustVariantName } from "./records.ts";
import { arrayItem, structLayout, unionCases } from "./kernel.ts";
import type { RsExpr } from "./rust-emit.ts";
import { RpcCodecs, u64RangeOf } from "./rpc-codecs.ts";
import { RpcBearer } from "./rpc-auth.ts";
import { rpcAuthRuntime } from "./rpc-auth-runtime.ts";
import { rpcRuntime } from "./rpc-runtime.ts";

const U64Json = RpcCodecs.U64Json;
const StringJson = RpcCodecs.StringJson;

type Scalar = "u64" | "bool" | "unit" | "never" | "string";
/** A struct or tagged union recognized structurally from the contract (REC-005). */
interface Composite {
  readonly type: IRType<unknown>;
  /** Fields per struct, or per union case keyed by tag; codecs in schema order. */
  readonly fields: readonly { readonly name: string; readonly codec: Codec }[];
  readonly cases: readonly {
    readonly tag: string;
    readonly fields: readonly { readonly name: string; readonly codec: Codec }[];
  }[];
  /** Official `defaultFormatter` text for a value that is not this shape at all. */
  readonly expected: string;
  /** Element codec of a `Schema.Array` (ARR-005). */
  readonly item?: Codec;
}
/** Rust function-name stem for a composite's generated codec. */
const codecName = (type: IRType<unknown>): string =>
  arrayItem(type) ? `Array_${type.id.slice(type.id.lastIndexOf("/") + 1)}` : type.native.type;
type Codec = Scalar | Composite;
type Registry = Map<IRType<unknown>, Composite>;
const isScalar = (codec: Codec): codec is Scalar => typeof codec === "string";
const witness = {
  u64: U64Type,
  bool: BoolType,
  unit: UnitType,
  never: NeverType,
  string: StringType,
};
const witnessOf = (codec: Codec): IRType<unknown> =>
  isScalar(codec) ? witness[codec] : codec.type;
export interface RpcBinding<F extends AnyFn = AnyFn> {
  readonly fn: F;
  readonly fields: readonly string[];
  readonly principal: boolean;
  /** Server-lifetime services passed, in order, before the payload arguments. */
  readonly services: readonly Service[];
}
type NativeValue<A> = [A] extends [never] ? never : [A] extends [undefined] ? void : A;
type HandlerError<P extends Rpc.Any> = P extends {
  readonly errorSchema: infer E extends Schema.Top;
}
  ? E["Type"]
  : never;
type HasMiddleware<P extends Rpc.Any> = [Rpc.Middleware<P>] extends [never] ? false : true;
type Bindings<Rpcs extends Rpc.Any> = {
  readonly [Tag in Rpcs["_tag"]]: RpcBinding<
    | ([HandlerError<Rpc.ExtractTag<Rpcs, Tag>>] extends [never]
        ? Fn<readonly IRType<unknown>[], NativeValue<Rpc.Success<Rpc.ExtractTag<Rpcs, Tag>>>>
        : never)
    | EffectFn<
        readonly IRType<unknown>[],
        NativeValue<Rpc.Success<Rpc.ExtractTag<Rpcs, Tag>>>,
        NativeValue<HandlerError<Rpc.ExtractTag<Rpcs, Tag>>>
      >
  > & {
    readonly principal: HasMiddleware<Rpc.ExtractTag<Rpcs, Tag>>;
    readonly fields: Rpc.Payload<Rpc.ExtractTag<Rpcs, Tag>> extends Readonly<
      Record<string, unknown>
    >
      ? readonly Extract<keyof Rpc.Payload<Rpc.ExtractTag<Rpcs, Tag>>, string>[]
      : readonly [];
  };
};
export interface RpcArtifact extends GeneratedFiles {
  readonly failureFrames: FailureFramePolicy;
  readonly explanation: Plan;
  readonly stages: readonly string[];
  readonly sourceArtifacts: typeof SourceArtifacts.None;
  readonly runtime: {
    readonly id: "rust/axum-unary-json@1";
    readonly crates: readonly string[];
    readonly handlerProfile: "synchronous-scalars" | "suspended-scalars";
    /** Server-lifetime service IDs in launch-tuple order; empty without a layer. */
    readonly services: readonly string[];
    readonly auth:
      | {
          readonly middleware: string;
          readonly principalService: string;
          readonly credentialsEnv: string;
        }
      | undefined;
  };
}
const unsupported = (path: string, message: string) =>
  fail("RPC_UNSUPPORTED", "rpc", path, message);
// The pinned server formats decode issues with the default formatter (the internal
// `defaultFormatter` is `makeFormatterDefault()`); a null input
// yields the top-level "Expected ..." text, to which the native decoder appends paths.
const formatIssue = SchemaIssue.makeFormatterDefault();
const expectedOf = (type: IRType<unknown>): string =>
  Exit.match(Schema.decodeUnknownExit(type.schema as Schema.Codec<unknown>)(null), {
    onSuccess: () => {
      throw unsupported(type.id, "A composite schema unexpectedly accepted null");
    },
    onFailure: (cause) =>
      Option.match(Cause.findErrorOption(cause), {
        onNone: () => {
          throw unsupported(type.id, "Composite decoding failed without a Schema issue");
        },
        onSome: (error) => formatIssue(error.issue),
      }),
  });
const fieldsOf = (
  ast: SchemaAST.Objects,
  path: string,
  registry: Registry,
  tagged: boolean,
): { readonly tag: string | undefined; readonly fields: Composite["fields"] } => {
  if (
    ast.encoding ||
    ast.checks ||
    ast.context ||
    ast.indexSignatures.length ||
    ast.encodingChecks ||
    Object.keys(ast.annotations ?? {}).some((key) => key !== "identifier" || tagged)
  )
    throw unsupported(
      path,
      "Only plain required Struct shapes (with an optional identifier) are supported",
    );
  let tag: string | undefined;
  const fields: { readonly name: string; readonly codec: Codec }[] = [];
  for (const property of ast.propertySignatures) {
    if (typeof property.name !== "string" || !wellFormed(property.name))
      throw unsupported(path, "Struct field names must be well-formed strings");
    if (property.type.context?.isOptional)
      throw unsupported(`${path}.${property.name}`, "Optional fields are not supported yet");
    if (property.name === "_tag") {
      const literal = property.type;
      if (!tagged || !SchemaAST.isLiteral(literal) || typeof literal.literal !== "string")
        throw unsupported(`${path}._tag`, "`_tag` is admitted only as a string union discriminant");
      tag = literal.literal;
      continue;
    }
    fields.push({
      name: property.name,
      codec: codec(property.type, `${path}.${property.name}`, false, registry),
    });
  }
  if (tagged && tag === undefined)
    throw unsupported(path, "Union members must be Structs with a string `_tag` literal");
  return { tag, fields };
};
const witnessFields = (fields: Composite["fields"]) =>
  Object.fromEntries(fields.map((field) => [field.name, witnessOf(field.codec)]));
const composite = (ast: SchemaAST.AST, path: string, registry: Registry): Composite => {
  if (SchemaAST.isObjects(ast)) {
    const { fields } = fieldsOf(ast, path, registry, false);
    const plain = Struct(witnessFields(fields));
    const identifier = ast.annotations?.identifier;
    const type = typeof identifier === "string" ? plain.annotate({ identifier }) : plain;
    return register(registry, { type, fields, cases: [], expected: expectedOf(type) });
  }
  if (SchemaAST.isArrays(ast)) {
    if (
      ast.elements.length ||
      ast.rest.length !== 1 ||
      ast.checks ||
      ast.encoding ||
      ast.context ||
      ast.annotations ||
      ast.encodingChecks
    )
      throw unsupported(
        path,
        "Only plain Schema.Array(item) is supported; tuples and checks are not",
      );
    const item = codec(ast.rest[0], `${path}[]`, false, registry);
    if (item === "never") throw unsupported(path, "Array items cannot be Never");
    const type = ArrayType.of(witnessOf(item));
    return register(registry, { type, fields: [], cases: [], item, expected: expectedOf(type) });
  }
  if (SchemaAST.isUnion(ast)) {
    if (ast.checks || ast.encoding || ast.context || ast.annotations)
      throw unsupported(path, "Annotated or checked unions are not supported");
    const cases = ast.types.map((member, i) => {
      if (!SchemaAST.isObjects(member))
        throw unsupported(
          `${path}.members[${i}]`,
          "Only tagged Struct union members are supported",
        );
      const { tag, fields } = fieldsOf(member, `${path}.members[${i}]`, registry, true);
      return { tag: tag!, fields };
    });
    if (new Set(cases.map((c) => c.tag)).size !== cases.length)
      throw unsupported(path, "Union discriminants must be distinct");
    const type = TaggedUnion(
      Object.fromEntries(cases.map((c) => [c.tag, witnessFields(c.fields)])),
    );
    return register(registry, { type, fields: [], cases, expected: expectedOf(type) });
  }
  throw unsupported(path, "Unsupported schema");
};
const register = (registry: Registry, shape: Composite): Composite => {
  const existing = registry.get(shape.type);
  if (existing) return existing;
  registry.set(shape.type, shape);
  return shape;
};
const codec = (ast: SchemaAST.AST, path: string, payload: boolean, registry: Registry): Codec => {
  if (u64RangeOf(ast)) {
    if (!payload) throw unsupported(path, "u64Range schemas are supported for payloads only");
    return "u64";
  }
  if (ast === U64Json.ast) return "u64";
  if (ast === StringJson.ast) return "string";
  if (SchemaAST.isObjects(ast) || SchemaAST.isUnion(ast) || SchemaAST.isArrays(ast))
    return composite(ast, path, registry);
  if (ast.checks || ast.encoding || ast.context || ast.annotations)
    throw unsupported(
      path,
      "Checked, annotated, optional or transformed schemas require a supported codec",
    );
  if (SchemaAST.isBoolean(ast)) return "bool";
  if (SchemaAST.isUndefined(ast)) return "unit";
  if (SchemaAST.isNever(ast)) return "never";
  if (SchemaAST.isString(ast))
    throw unsupported(
      path,
      "Plain Schema.String admits lone surrogates; use NativeRpc.StringJson for native strings",
    );
  throw unsupported(
    path,
    "Only Boolean, Undefined, Never, NativeRpc.U64Json, NativeRpc.StringJson, Structs and tagged unions are supported",
  );
};
const local = (name: string) => Rs.identExpr(Rs.ident(name));
const callLocal = (name: string, ...args: readonly RsExpr[]) => Rs.call(local(name), args);
const encode = (kind: Codec, value: RsExpr): RsExpr => {
  if (!isScalar(kind)) return callLocal(`encode_${codecName(kind.type)}`, Rs.refExpr(value));
  if (kind === "never") return Rs.unreachableMatch(value);
  if (kind === "unit")
    return Rs.block(
      [Rs.letDiscard(Rs.unitType(), value)],
      Rs.pathExpr(Rs.path([Rs.ident("Value"), Rs.ident("Null")])),
    );
  if (kind === "string") return Rs.pathCall([Rs.ident("Value")], Rs.ident("String"), [value]);
  return Rs.pathCall([Rs.ident("Value")], Rs.ident(kind === "u64" ? "String" : "Bool"), [
    kind === "u64" ? Rs.dotCall(value, Rs.ident("to_string"), []) : value,
  ]);
};
const wellFormed = (value: string) =>
  !Array.from(value).some(
    (char) => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff,
  );
const bind = <F extends AnyFn, const Fields extends readonly string[] = readonly []>(
  fn: F,
  fields?: Fields,
): RpcBinding<F> & { readonly fields: Fields; readonly principal: false } =>
  Object.freeze({
    fn,
    fields: Object.freeze(Array.from(fields ?? [])) as unknown as Fields,
    principal: false,
    services: Object.freeze([]),
  });
/** Bind a protected handler with its canonical u64 principal before the payload arguments. */
const bindPrincipal = <F extends AnyFn, const Fields extends readonly string[] = readonly []>(
  fn: F & (F["input"] extends readonly [IRType<bigint>, ...IRType<unknown>[]] ? unknown : never),
  fields?: Fields,
): RpcBinding<F> & { readonly fields: Fields; readonly principal: true } =>
  Object.freeze({
    fn,
    fields: Object.freeze(Array.from(fields ?? [])) as unknown as Fields,
    principal: true,
    services: Object.freeze([]),
  });
/**
 * Bind a public handler whose leading arguments are services built once by the server `layer`,
 * like handlers closing over services in `RpcGroup.toLayer`.
 */
const bindServices = <
  F extends AnyFn,
  const Services extends readonly Service[],
  const Fields extends readonly string[] = readonly [],
>(
  services: Services,
  fn: F,
  fields?: Fields,
): RpcBinding<F> & { readonly fields: Fields; readonly principal: false } =>
  Object.freeze({
    fn,
    fields: Object.freeze(Array.from(fields ?? [])) as unknown as Fields,
    principal: false,
    services: Object.freeze(Array.from(services)),
  });

const compile = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  bindings: Bindings<Rpcs>,
  options: {
    readonly path?: string;
    readonly auth?: RpcBearer;
    readonly failureFrames?: FailureFramePolicy;
    /** Built once at startup and released after in-flight requests on graceful shutdown. */
    readonly layer?: StaticLayer<Service, unknown>;
  } = {},
): Effect.Effect<RpcArtifact, import("./kernel.ts").CompileError> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.try({
      try: () => {
        const path = options.path ?? "/rpc";
        if (!/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path))
          throw unsupported(
            "path",
            "Path must be a literal absolute route without a trailing slash",
          );
        const entries = Array.from(group.requests.values());
        if (entries.length === 0) throw unsupported("group", "RPC group must contain a procedure");
        if (Reflect.ownKeys(bindings).length !== entries.length)
          throw unsupported("bindings", "Bindings must match the RPC group exactly");
        const auth = options.auth;
        if (auth && !(auth instanceof RpcBearer))
          throw unsupported("auth", "Expected a checked bearer adapter");
        if (
          auth &&
          (auth.middleware.error.ast !== auth.denialAst ||
            !SchemaAST.isLiteral(auth.denialAst) ||
            auth.denialAst.literal !== auth.denied ||
            auth.denialAst.checks ||
            auth.denialAst.encoding ||
            auth.denialAst.context ||
            auth.denialAst.annotations)
        )
          throw unsupported("auth", "Middleware denial schema changed after adapter creation");
        let protectedCount = 0;
        let ranges = false;
        const registry: Registry = new Map();
        const functions: Record<string, AnyFn> = {};
        const layer = options.layer;
        if (layer !== undefined && !(layer instanceof StaticLayer))
          throw unsupported("layer", "Expected an R.Layer provider graph");
        // Launch tuple positions, deduplicated by service ID in first-binding order.
        const serverServices: Service[] = [];
        const servicePosition = (service: Service, procedure: string): number => {
          if (!(service instanceof Service))
            throw unsupported(procedure, "Expected an R.Context service");
          const index = serverServices.findIndex((known) => known.id === service.id);
          if (index >= 0) {
            if (!IRType.same(serverServices[index].type, service.type))
              throw unsupported(procedure, "Service ID reused with a different witness");
            return index;
          }
          if (!layer) throw unsupported(procedure, "Server services require a NativeRpc layer");
          if (![U64Type, BoolType, UnitType].some((type) => IRType.same(service.type, type)))
            throw unsupported(procedure, "Server services must be Boolean, u64 or Unit scalars");
          serverServices.push(service);
          return serverServices.length - 1;
        };
        const arms = entries.map((definition, index) => {
          if (!Rpc.isRpc(definition)) throw unsupported("group", "Expected a stock RPC definition");
          const rpc: Rpc.AnyWithProps = definition;
          const procedure = `rpc.${rpc._tag}`;
          if (!wellFormed(rpc._tag)) throw unsupported(procedure, "RPC tags must be valid Unicode");
          const descriptor = Object.getOwnPropertyDescriptor(bindings, rpc._tag);
          const binding: RpcBinding | undefined = descriptor?.value;
          if (!binding || (!(binding.fn instanceof Fn) && !(binding.fn instanceof EffectFn)))
            throw unsupported(procedure, "Missing own-data handler binding");
          const protectedRpc = rpc.middlewares.size !== 0;
          if (
            protectedRpc &&
            (!auth || rpc.middlewares.size !== 1 || !rpc.middlewares.has(auth.middleware))
          )
            throw unsupported(
              procedure,
              "Exactly one middleware with a matching bearer adapter is supported",
            );
          if (binding.principal !== protectedRpc)
            throw unsupported(
              procedure,
              "Protected procedures require bindPrincipal; public procedures require bind",
            );
          if (protectedRpc) protectedCount++;
          const services = binding.services ?? [];
          if (protectedRpc && services.length)
            throw unsupported(
              procedure,
              "Protected procedures cannot also bind server services yet",
            );
          const positions = services.map((service) => servicePosition(service, procedure));
          if (rpc.defectSchema.ast !== Schema.Defect().ast)
            throw unsupported(procedure, "Custom defect codecs are unsupported");
          const success = codec(rpc.successSchema.ast, `${procedure}.success`, false, registry);
          const error = codec(rpc.errorSchema.ast, `${procedure}.error`, false, registry);
          const fn = binding.fn;
          if (
            !IRType.same(fn.output, witnessOf(success)) ||
            !IRType.same(fn instanceof EffectFn ? fn.error : NeverType, witnessOf(error))
          )
            throw unsupported(
              procedure,
              "Handler success/error witnesses disagree with RPC schemas",
            );
          const payload = rpc.payloadSchema.ast;
          const offset = (protectedRpc ? 1 : 0) + services.length;
          // A handler taking exactly the payload's composite type receives it whole; otherwise a
          // Struct payload is projected into handler arguments by field name.
          const whole =
            binding.fields.length === 0 &&
            fn.input.length === offset + 1 &&
            (SchemaAST.isObjects(payload) || SchemaAST.isUnion(payload)) &&
            fn.input[offset].layout !== undefined;
          let inputs: readonly {
            readonly name: string;
            readonly codec: Codec;
            readonly range?: ReturnType<typeof u64RangeOf>;
          }[];
          if (SchemaAST.isObjects(payload) && !whole) {
            if (
              payload.encoding ||
              payload.checks ||
              payload.context ||
              payload.annotations ||
              payload.indexSignatures.length ||
              payload.encodingChecks
            )
              throw unsupported(
                `${procedure}.payload`,
                "Only plain flat required Struct payloads are supported",
              );
            const fields = payload.propertySignatures;
            if (
              fields.some((field) => typeof field.name !== "string" || !wellFormed(field.name)) ||
              binding.fields.length !== fields.length ||
              new Set(binding.fields).size !== fields.length
            )
              throw unsupported(
                `${procedure}.payload`,
                "Supply every payload field exactly once in handler argument order",
              );
            inputs = binding.fields.map((name) => {
              const field = fields.find((field) => field.name === name);
              if (!field) throw unsupported(procedure, `Unknown payload field ${name}`);
              return {
                name,
                codec: codec(field.type, `${procedure}.payload.${name}`, true, registry),
                range: u64RangeOf(field.type),
              };
            });
          } else {
            const kind = codec(payload, `${procedure}.payload`, true, registry);
            if (binding.fields.length)
              throw unsupported(procedure, "Scalar payload bindings have no named fields");
            inputs =
              kind === "unit" && fn.input.length === (protectedRpc ? 1 : 0) + services.length
                ? []
                : [{ name: "", codec: kind, range: u64RangeOf(payload) }];
          }
          if (inputs.some((input) => input.range !== undefined)) ranges = true;
          if (
            (protectedRpc && !IRType.same(fn.input[0], U64Type)) ||
            services.some((service, i) => !IRType.same(fn.input[i], service.type)) ||
            fn.input.length !== inputs.length + offset ||
            inputs.some(
              (input, i) =>
                input.codec === "never" ||
                !IRType.same(fn.input[i + offset], witnessOf(input.codec)),
            )
          )
            throw unsupported(procedure, "Handler argument witnesses disagree with payload fields");
          const name = `handler_${index}`;
          functions[name] = fn;
          const isRecord = SchemaAST.isObjects(payload) && !whole;
          const args = inputs.map((input) =>
            Rs.try_(
              isScalar(input.codec)
                ? callLocal(
                    input.range ? "u64_range_arg" : `${input.codec}_arg`,
                    isRecord
                      ? Rs.try_(callLocal("field", local("payload"), Rs.stringLiteral(input.name)))
                      : local("payload"),
                    isRecord ? Rs.some(Rs.stringLiteral(input.name)) : Rs.none(),
                    ...(input.range
                      ? [Rs.litU64(input.range.minimum), Rs.litU64(input.range.maximum)]
                      : []),
                  )
                : callLocal(
                    `decode_${codecName(input.codec.type)}`,
                    isRecord
                      ? Rs.try_(callLocal("field", local("payload"), Rs.stringLiteral(input.name)))
                      : local("payload"),
                    isRecord
                      ? Rs.some(
                          Rs.verbatimExpr(
                            `&Path { parent: None, name: ${Rs.stringLiteral(input.name).text}, index: false }`,
                          ),
                        )
                      : Rs.none(),
                  ),
            ),
          );
          const statements = isRecord
            ? [
                Rs.stmt(
                  Rs.if_(
                    payload.propertySignatures.length === 0
                      ? Rs.dotCall(local("payload"), Rs.ident("is_null"), [])
                      : Rs.prefix("!", Rs.dotCall(local("payload"), Rs.ident("is_object"), [])),
                    Rs.inlineStmtBlock(
                      Rs.stmt(
                        Rs.return_(
                          Rs.err(
                            Rs.dotCall(
                              Rs.stringLiteral(
                                payload.propertySignatures.length === 0
                                  ? "Expected object | array"
                                  : "Expected object",
                              ),
                              Rs.ident("to_string"),
                              [],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ]
            : inputs.length === 0
              ? [Rs.stmt(Rs.try_(callLocal("unit_arg", local("payload"), Rs.none())))]
              : [];
          const inputIndices = new Map(inputs.map((input, index) => [input.name, index]));
          const validationOrder = isRecord
            ? payload.propertySignatures.map((field) => {
                const index = inputIndices.get(String(field.name));
                if (index === undefined)
                  throw unsupported(procedure, "Missing handler argument for payload field");
                return index;
              })
            : inputs.map((_input, index) => index);
          validationOrder.forEach((index) =>
            statements.push(Rs.let_(Rs.ident(`arg_${index}`), undefined, args[index])),
          );
          if (protectedRpc && auth) {
            statements.push(
              Rs.exprStmt(
                Rs.letElse(
                  Rs.variantPat([Rs.ident("Some")], [Rs.identPat(Rs.ident("principal"))]),
                  callLocal("authenticate", local("headers"), local("message"), local("state")),
                  Rs.block([
                    Rs.stmt(
                      Rs.return_(
                        Rs.ok(
                          callLocal(
                            "failure",
                            Rs.pathCall([Rs.ident("Value")], Rs.ident("String"), [
                              Rs.dotCall(Rs.stringLiteral(auth.denied), Rs.ident("to_string"), []),
                            ]),
                          ),
                        ),
                      ),
                    ),
                  ]),
                ),
              ),
            );
            statements.push(
              Rs.assign(
                Rs.field(local("context"), Rs.ident("principal")),
                Rs.some(local("principal")),
              ),
            );
          }
          const asynchronous = fn instanceof EffectFn && isAsyncComputation(fn.body);
          positions.forEach((position, i) =>
            statements.push(
              Rs.verbatimStmt(
                `let service_${i} = SERVICES.get().expect("services are published before serving").${position};`,
              ),
            ),
          );
          const arguments_ = (protectedRpc ? [local("principal")] : [])
            .concat(positions.map((_position, i) => local(`service_${i}`)))
            .concat(inputs.map((_input, i) => local(`arg_${i}`)));
          if (asynchronous)
            statements.push(
              Rs.verbatimStmt(
                "let mut execution = execution_context(cancellation.clone(), context);",
              ),
            );
          const compiledCall = Rs.pathCall(
            [Rs.ident("reffect_generated")],
            Rs.ident(`r_${name}`),
            (asynchronous ? [Rs.mutRefExpr(local("execution"))] : []).concat(arguments_),
          );
          const call = asynchronous
            ? Rs.await(compiledCall)
            : callLocal(
                "in_context",
                local("context"),
                Rs.closureTyped([], undefined, compiledCall),
              );
          const result =
            fn instanceof EffectFn
              ? Rs.match_(call, [
                  {
                    pat: Rs.variantPat([Rs.ident("Ok")], [Rs.identPat(Rs.ident("value"))]),
                    body: callLocal("success", encode(success, local("value"))),
                  },
                  {
                    pat: asynchronous
                      ? Rs.pat("Err(reffect_generated::AsyncError::Fail(error))")
                      : Rs.variantPat([Rs.ident("Err")], [Rs.identPat(Rs.ident("error"))]),
                    body:
                      error === "never"
                        ? Rs.unreachableMatch(local("error"))
                        : callLocal("failure", encode(error, local("error"))),
                  },
                  ...(asynchronous
                    ? [
                        {
                          pat: Rs.pat("Err(reffect_generated::AsyncError::Interrupted)"),
                          body: callLocal("interrupted"),
                        },
                      ]
                    : []),
                ])
              : callLocal("success", encode(success, call));
          return { pat: Rs.stringPat(rpc._tag), body: Rs.block(statements, Rs.ok(result)) };
        });
        if (auth && protectedCount === 0) throw unsupported("auth", "Bearer adapter is unused");
        if (layer)
          functions.launch = EffectFn.make([], NeverType, layer.error, () =>
            StaticLayer.provide(layer, (context) =>
              launch(serverServices.map((service) => context.get(service))),
            ),
          );
        return {
          path,
          auth,
          ranges,
          composites: Array.from(registry.values()),
          program: Program.make(functions),
          arms,
          layered: layer !== undefined,
          services: serverServices.map((service) => service.id),
          asynchronous: Object.values(functions).some(
            (fn) => fn instanceof EffectFn && isAsyncComputation(fn.body),
          ),
          hasSynchronousEffects: Object.values(functions).some(
            (fn) => fn instanceof EffectFn && !isAsyncComputation(fn.body),
          ),
        };
      },
      catch: (cause) =>
        cause instanceof CompileError ? cause : unsupported("group", String(cause)),
    });
    const core = yield* Compile.run(
      Compile.make(prepared.program).pipe(
        Compile.withTarget(prepared.asynchronous ? Rust.tokio : Rust.std),
        Compile.withSourceArtifacts(SourceArtifacts.None),
        Compile.withFailureFrames(options.failureFrames ?? FailureFrames.Bounded),
      ),
    );
    // This checked scalar HTTP profile only composes the selected Tokio core dependency.
    // Refuse new core crate requirements until manifest composition supports them explicitly.
    if (core.explanation.crates.some((crate) => crate !== "tokio@1.53.1"))
      return yield* unsupported(
        "crates",
        "HTTP manifest composition does not support selected core crates",
      );
    const clear =
      prepared.hasSynchronousEffects && !FailureFrames.isNone(core.failureFrames)
        ? [
            Rs.letDiscard(
              Rs.unitType(),
              Rs.pathCall([Rs.ident("reffect_generated")], Rs.ident("clear_last_frames"), []),
            ),
          ]
        : [];
    const dispatch = (prepared.asynchronous ? Rs.asyncFnItem : Rs.fnItem)(
      Rs.ident("dispatch"),
      [
        { name: Rs.ident("tag"), type: Rs.refType(Rs.strType()) },
        { name: Rs.ident("payload"), type: Rs.refType(Rs.namedType("Value")) },
        { name: Rs.ident("headers"), type: Rs.refType(Rs.namedType("HeaderMap")) },
        { name: Rs.ident("message"), type: Rs.refType(Rs.namedType("Value")) },
        { name: Rs.ident("state"), type: Rs.refType(Rs.namedType("RuntimeState")) },
        {
          name: Rs.ident("context"),
          type: Rs.mutRefType(
            prepared.asynchronous
              ? Rs.verbatimType("RequestContext<'_>")
              : Rs.namedType("RequestContext"),
          ),
        },
        ...(prepared.asynchronous
          ? [
              {
                name: Rs.ident("cancellation"),
                type: Rs.refType(
                  Rs.genericType(
                    Rs.pathType([
                      Rs.ident("tokio"),
                      Rs.ident("sync"),
                      Rs.ident("watch"),
                      Rs.ident("Receiver"),
                    ]),
                    [Rs.boolType()],
                  ),
                ),
              },
            ]
          : []),
      ],
      Rs.resultType(Rs.namedType("Value"), Rs.stringType()),
      Rs.block(
        [],
        Rs.match_(
          local("tag"),
          prepared.arms.concat([
            {
              pat: Rs.wildcardPat(),
              body: Rs.err(
                Rs.macroCall(Rs.ident("format"), [
                  Rs.stringLiteral("Unknown request tag: {}"),
                  local("tag"),
                ]),
              ),
            },
          ]),
        ),
      ),
    );
    const hasLogs = core.explanation.analysis.effects.includes(SyncEffects.Log);
    const contextRuntime = hasLogs
      ? String.raw`
fn in_context<T>(context: &RequestContext, f: impl FnOnce() -> T) -> T {
    let metadata = json!({"id":context.id, "tag":context.tag, "principal":context.principal.map(|p| p.to_string())});
    reffect_generated::with_log_context(metadata.to_string(), f)
}`
      : "fn in_context<T>(_context: &RequestContext, f: impl FnOnce() -> T) -> T { f() }";
    const executionRuntime = prepared.asynchronous
      ? `
fn execution_context(cancellation: tokio::sync::watch::Receiver<bool>, context: &RequestContext) -> reffect_generated::AsyncContext {
    let mut execution = reffect_generated::AsyncContext::new(cancellation);
    ${hasLogs ? 'execution.set_request(json!({"id":context.id, "tag":context.tag, "principal":context.principal.map(|p| p.to_string())}).to_string());' : "let _ = context;"}
    execution
}
fn interrupted() -> Value { json!({"_tag":"Failure", "cause":[{"_tag":"Interrupt"}]}) }
`
      : "";
    const authRuntime = prepared.auth
      ? rpcAuthRuntime
      : "#[derive(Clone)] struct RuntimeState; fn load_state() -> Result<RuntimeState, &'static str> { Ok(RuntimeState) }";
    const main = Rs.itemsText(
      [
        Rs.constItem(Rs.ident("RPC_PATH"), Rs.strRefType(), Rs.stringLiteral(prepared.path)),
        Rs.constItem(Rs.ident("MAX_BODY"), Rs.usizeType(), Rs.litInt(65536)),
        Rs.constItem(Rs.ident("MAX_BATCH"), Rs.usizeType(), Rs.litInt(64)),
        ...(prepared.auth
          ? [
              Rs.constItem(
                Rs.ident("CREDENTIALS_ENV"),
                Rs.strRefType(),
                Rs.stringLiteral(prepared.auth.credentialsEnv),
              ),
            ]
          : []),
        ...(clear.length
          ? [Rs.fnItem(Rs.ident("clear_frames"), [], Rs.unitType(), Rs.block(clear))]
          : []),
        dispatch,
        ...(prepared.composites.length
          ? [Rs.verbatimItem(compositeCodecs(prepared.composites))]
          : []),
        Rs.verbatimItem(contextRuntime),
        ...(executionRuntime ? [Rs.verbatimItem(executionRuntime)] : []),
        Rs.verbatimItem(authRuntime),
        Rs.verbatimItem(
          rpcRuntime(
            clear.length ? Rs.stmt(callLocal("clear_frames")) : undefined,
            prepared.asynchronous,
            prepared.ranges,
            prepared.layered,
          ),
        ),
      ],
      "\n",
    ).text;
    return Object.freeze({
      sourceArtifacts: SourceArtifacts.None,
      failureFrames: core.failureFrames,
      explanation: core.explanation,
      stages: Object.freeze(core.stages.concat("rpc-http")),
      files: Object.freeze({
        "Cargo.toml":
          core.files["Cargo.toml"].split("\n[dependencies]")[0] +
          '\n[dependencies]\naxum = { version = "=0.8.9", default-features = false, features = ["http1", "tokio", "json"] }\ntokio = { version = "=1.53.1", features = ["macros", "rt", "net", "time", "sync"] }\nserde_json = { version = "=1.0.151", features = ["float_roundtrip"] }\n'.replace(
            '["macros", "rt", "net", "time", "sync"]',
            prepared.layered
              ? '["macros", "rt", "net", "time", "sync", "signal"]'
              : prepared.asynchronous
                ? '["macros", "rt", "net", "time", "sync"]'
                : '["macros", "rt", "net"]',
          ) +
          (prepared.asynchronous ? 'http-body = "=1.0.1"\n' : "") +
          (prepared.auth ? 'subtle = { version = "=2.6.1", default-features = false }\n' : ""),
        "src/lib.rs": core.files["src/lib.rs"],
        "src/main.rs": main,
      }),
      runtime: Object.freeze({
        id: "rust/axum-unary-json@1",
        crates: Object.freeze(
          ["axum@0.8.9", "tokio@1.53.1", "serde_json@1.0.151"].concat(
            prepared.auth ? ["subtle@2.6.1"] : [],
            prepared.asynchronous ? ["http-body@1.0.1"] : [],
          ),
        ),
        handlerProfile: prepared.asynchronous ? "suspended-scalars" : "synchronous-scalars",
        services: Object.freeze(prepared.services),
        auth: prepared.auth
          ? Object.freeze({
              middleware: prepared.auth.middleware.key,
              principalService: prepared.auth.principal.key,
              credentialsEnv: prepared.auth.credentialsEnv,
            })
          : undefined,
      }),
    });
  });

/** Generate a native unary JSON/HTTP server for the checked sync/async scalar profiles. */
export const NativeRpc = Object.freeze({
  U64Json,
  StringJson,
  bind,
  bindPrincipal,
  bindServices,
  bearer: RpcBearer.make,
  compile,
});

/** Generated serde_json decoders/encoders for contract composites, with official messages. */
const compositeCodecs = (composites: readonly Composite[]): string => {
  const rustType = (type: IRType<unknown>): string => {
    const item = arrayItem(type);
    if (item) return `Vec<${rustType(item)}>`;
    if (type.layout) return `reffect_generated::${type.native.type}`;
    return IRType.same(type, U64Type)
      ? "u64"
      : IRType.same(type, BoolType)
        ? "bool"
        : IRType.same(type, StringType)
          ? "String"
          : "()";
  };
  const decodeField = (codec: Codec, value: string, path: string): string =>
    isScalar(codec)
      ? `${codec === "never" ? "never" : codec}_in(${value}, ${path})`
      : `decode_${codecName(codec.type)}(${value}, ${path})`;
  const encodeField = (codec: Codec, value: string): string =>
    isScalar(codec)
      ? codec === "u64"
        ? `Value::String(${value}.to_string())`
        : codec === "bool"
          ? `Value::Bool(${value})`
          : codec === "string"
            ? `Value::String(${value}.clone())`
            : "Value::Null"
      : `encode_${codecName(codec.type)}(&${value})`;
  const structBody = (
    type: IRType<unknown>,
    tag: string | undefined,
    fields: Composite["fields"],
  ): { readonly decode: string; readonly encode: string } => {
    const layout = structLayout(type, tag)!;
    const caseType =
      tag === undefined ? type : unionCases(type)!.find((c) => structLayout(c)?.tag === tag)!;
    const names = rustFieldNames(layout);
    const decode = fields
      .map(
        (field, i) =>
          `    let child_${i} = Path { parent: path, name: ${Rs.stringLiteral(field.name).text}, index: false };\n` +
          `    let f${i} = match object.get(${Rs.stringLiteral(field.name).text}) { Some(value) => ${decodeField(field.codec, "value", `Some(&child_${i})`)}?, None => return Err(at("Missing key", Some(&child_${i}))) };\n`,
      )
      .join("");
    const build = `${rustType(caseType)} { ${fields.map((_, i) => `${names[i]}: f${i}, `).join("")}}`;
    const encode =
      (tag === undefined
        ? ""
        : `    map.insert("_tag".to_string(), Value::String(${Rs.stringLiteral(tag).text}.to_string()));\n`) +
      fields
        .map(
          (field, i) =>
            `    map.insert(${Rs.stringLiteral(field.name).text}.to_string(), ${encodeField(field.codec, `value.${names[i]}`)});\n`,
        )
        .join("");
    return { decode: decode + `    Ok(${build})\n`, encode };
  };
  const items = composites.map((shape) => {
    const name = codecName(shape.type);
    const expected = Rs.stringLiteral(shape.expected).text;
    if (shape.item !== undefined)
      return (
        `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<${rustType(shape.type)}, String> {\n` +
        `    let Some(items) = value.as_array() else { return Err(at(${expected}, path)) };\n` +
        `    let mut out = Vec::with_capacity(items.len());\n` +
        `    for (i, item) in items.iter().enumerate() {\n        let index = i.to_string();\n        let child = Path { parent: path, name: &index, index: true };\n        out.push(${decodeField(shape.item, "item", "Some(&child)")}?);\n    }\n    Ok(out)\n}\n` +
        `fn encode_${name}(value: &${rustType(shape.type)}) -> Value {\n    Value::Array(value.iter().map(|item| ${encodeField(shape.item, "(*item)")}).collect())\n}\n`
      );
    if (shape.cases.length === 0) {
      const body = structBody(shape.type, undefined, shape.fields);
      // An empty Struct also accepts arrays, as the pinned decoder does.
      const object =
        shape.fields.length === 0
          ? `if !(value.is_object() || value.is_array()) { return Err(at(${expected}, path)) }\n    let empty = serde_json::Map::new();\n    let object = value.as_object().unwrap_or(&empty);\n`
          : `let Some(object) = value.as_object() else { return Err(at(${expected}, path)) };\n`;
      return (
        `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<${rustType(shape.type)}, String> {\n    ${object}${body.decode}}\n` +
        `fn encode_${name}(value: &${rustType(shape.type)}) -> Value {\n    let mut map = serde_json::Map::new();\n${body.encode}    Value::Object(map)\n}\n`
      );
    }
    const variants = shape.cases.map((c, i) => {
      const body = structBody(shape.type, c.tag, c.fields);
      const variant = `${rustType(shape.type)}::${rustVariantName(c.tag, i)}`;
      return {
        decode: `        Some(${Rs.stringLiteral(c.tag).text}) => {\n${body.decode.replace(/^ {4}Ok\((.*)\)\n$/m, `    Ok(${variant}($1))\n`)}        }\n`,
        encode: `        ${variant}(value) => {\n            let mut map = serde_json::Map::new();\n${body.encode}            Value::Object(map)\n        }\n`,
      };
    });
    return (
      `fn decode_${name}(value: &Value, path: Option<&Path>) -> Result<${rustType(shape.type)}, String> {\n    let empty = serde_json::Map::new();\n    let object = value.as_object().unwrap_or(&empty);\n    match value.as_object().and_then(|o| o.get("_tag")).and_then(Value::as_str) {\n${variants.map((v) => v.decode).join("")}        _ => Err(at(${expected}, path)),\n    }\n}\n` +
      `fn encode_${name}(value: &${rustType(shape.type)}) -> Value {\n    match value {\n${variants.map((v) => v.encode).join("")}    }\n}\n`
    );
  });
  return `struct Path<'a> { parent: Option<&'a Path<'a>>, name: &'a str, index: bool }
fn at(message: &str, path: Option<&Path>) -> String {
    let mut names = Vec::new();
    let mut current = path;
    while let Some(segment) = current { names.push(segment); current = segment.parent; }
    if names.is_empty() { return message.to_string(); }
    names.reverse();
    // Array indexes print unquoted, keys as JSON strings, as the pinned formatter does.
    let segments: String = names.iter().map(|segment| if segment.index { format!("[{}]", segment.name) } else { format!("[{}]", serde_json::to_string(segment.name).unwrap()) }).collect();
    format!("{}\\n  at {}", message, segments)
}
fn u64_in(value: &Value, path: Option<&Path>) -> Result<u64, String> { u64_arg(value, None).map_err(|message| at(&message, path)) }
fn bool_in(value: &Value, path: Option<&Path>) -> Result<bool, String> { bool_arg(value, None).map_err(|message| at(&message, path)) }
fn string_in(value: &Value, path: Option<&Path>) -> Result<String, String> { string_arg(value, None).map_err(|message| at(&message, path)) }
fn unit_in(value: &Value, path: Option<&Path>) -> Result<(), String> { unit_arg(value, None).map_err(|message| at(&message, path)) }
${items.join("")}`;
};
