import { Effect, Schema, SchemaAST } from "effect";
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
  U64Type,
  UnitType,
  fail,
} from "./kernel.ts";
import type { AnyFn } from "./kernel.ts";
import { Rs } from "./rust-emit.ts";
import type { RsExpr } from "./rust-emit.ts";
import { RpcCodecs, u64RangeOf } from "./rpc-codecs.ts";
import { RpcBearer } from "./rpc-auth.ts";
import { rpcAuthRuntime } from "./rpc-auth-runtime.ts";
import { rpcRuntime } from "./rpc-runtime.ts";

const U64Json = RpcCodecs.U64Json;

type Codec = "u64" | "bool" | "unit" | "never";
const witness = { u64: U64Type, bool: BoolType, unit: UnitType, never: NeverType };
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
const codec = (ast: SchemaAST.AST, path: string, payload = false): Codec => {
  if (u64RangeOf(ast)) {
    if (!payload) throw unsupported(path, "u64Range schemas are supported for payloads only");
    return "u64";
  }
  if (ast === U64Json.ast) return "u64";
  if (ast.checks || ast.encoding || ast.context || ast.annotations)
    throw unsupported(
      path,
      "Checked, annotated, optional or transformed schemas require a supported codec",
    );
  if (SchemaAST.isBoolean(ast)) return "bool";
  if (SchemaAST.isUndefined(ast)) return "unit";
  if (SchemaAST.isNever(ast)) return "never";
  throw unsupported(path, "Only Boolean, Undefined, Never and NativeRpc.U64Json are supported");
};
const local = (name: string) => Rs.identExpr(Rs.ident(name));
const callLocal = (name: string, ...args: readonly RsExpr[]) => Rs.call(local(name), args);
const encode = (kind: Codec, value: RsExpr): RsExpr => {
  if (kind === "never") return Rs.unreachableMatch(value);
  if (kind === "unit")
    return Rs.block(
      [Rs.letDiscard(Rs.unitType(), value)],
      Rs.pathExpr(Rs.path([Rs.ident("Value"), Rs.ident("Null")])),
    );
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
          const success = codec(rpc.successSchema.ast, `${procedure}.success`);
          const error = codec(rpc.errorSchema.ast, `${procedure}.error`);
          const fn = binding.fn;
          if (
            !IRType.same(fn.output, witness[success]) ||
            !IRType.same(fn instanceof EffectFn ? fn.error : NeverType, witness[error])
          )
            throw unsupported(
              procedure,
              "Handler success/error witnesses disagree with RPC schemas",
            );
          const payload = rpc.payloadSchema.ast;
          let inputs: readonly {
            readonly name: string;
            readonly codec: Codec;
            readonly range?: ReturnType<typeof u64RangeOf>;
          }[];
          if (SchemaAST.isObjects(payload)) {
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
                codec: codec(field.type, `${procedure}.payload.${name}`, true),
                range: u64RangeOf(field.type),
              };
            });
          } else {
            const kind = codec(payload, `${procedure}.payload`, true);
            if (binding.fields.length)
              throw unsupported(procedure, "Scalar payload bindings have no named fields");
            inputs =
              kind === "unit" && fn.input.length === (protectedRpc ? 1 : 0) + services.length
                ? []
                : [{ name: "", codec: kind, range: u64RangeOf(payload) }];
          }
          if (inputs.some((input) => input.range !== undefined)) ranges = true;
          const offset = (protectedRpc ? 1 : 0) + services.length;
          if (
            (protectedRpc && !IRType.same(fn.input[0], U64Type)) ||
            services.some((service, i) => !IRType.same(fn.input[i], service.type)) ||
            fn.input.length !== inputs.length + offset ||
            inputs.some(
              (input, i) =>
                input.codec === "never" || !IRType.same(fn.input[i + offset], witness[input.codec]),
            )
          )
            throw unsupported(procedure, "Handler argument witnesses disagree with payload fields");
          const name = `handler_${index}`;
          functions[name] = fn;
          const isRecord = SchemaAST.isObjects(payload);
          const args = inputs.map((input) =>
            Rs.try_(
              callLocal(
                input.range ? "u64_range_arg" : `${input.codec}_arg`,
                isRecord
                  ? Rs.try_(callLocal("field", local("payload"), Rs.stringLiteral(input.name)))
                  : local("payload"),
                isRecord ? Rs.some(Rs.stringLiteral(input.name)) : Rs.none(),
                ...(input.range
                  ? [Rs.litU64(input.range.minimum), Rs.litU64(input.range.maximum)]
                  : []),
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
  bind,
  bindPrincipal,
  bindServices,
  bearer: RpcBearer.make,
  compile,
});
