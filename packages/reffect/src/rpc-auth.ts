import { Context, Schema, SchemaAST } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { fail } from "./kernel.ts";

/** Checked native adapter for one middleware providing a scalar principal service. */
export class RpcBearer {
  private constructor(
    readonly middleware: RpcMiddleware.AnyServiceWithProps,
    readonly principal: Context.Key<unknown, bigint>,
    readonly credentialsEnv: string,
    readonly denied: string,
    readonly denialAst: SchemaAST.AST,
  ) {
    Object.freeze(this);
  }

  /** Configure runtime credentials; no credential values belong in compiler inputs. */
  static make<Id, Name extends string, P, E extends Schema.Top, CE, Client extends boolean>(
    this: void,
    middleware: RpcMiddleware.ServiceClass<Id, Name, P, E, CE, never, Client>,
    principal: Context.Service<NoInfer<P>, bigint>,
    options: { readonly credentialsEnv: string },
  ): RpcBearer {
    const ast = middleware.error.ast;
    if (
      middleware[RpcMiddleware.TypeId] !== RpcMiddleware.TypeId ||
      !SchemaAST.isLiteral(ast) ||
      typeof ast.literal !== "string" ||
      ast.checks ||
      ast.encoding ||
      ast.context ||
      ast.annotations ||
      !/^[\x20-\x7e]{1,128}$/.test(ast.literal) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(options.credentialsEnv)
    ) {
      throw fail(
        "RPC_UNSUPPORTED",
        "rpc",
        "auth",
        "Bearer adapters require a plain ASCII string-literal error and an uppercase environment variable name",
      );
    }
    return new RpcBearer(middleware, principal, options.credentialsEnv, ast.literal, ast);
  }
}
