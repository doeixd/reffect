import { Context, Schema, SchemaAST } from "effect";
import { RpcMiddleware } from "effect/rpc";
import { fail } from "./kernel.ts";

/**
 * The session cookie a bearer adapter also accepts (#4, docs/research/cookie-sessions.md): one of
 * the same configured tokens, in a `__Host-` cookie set by a native login endpoint, as Effect's
 * `HttpApiSecurity.apiKey({ in: "cookie" })` with `securitySetCookie`.
 */
export interface SessionCookie {
  /** The cookie name; `__Host-` pins it to the exact origin. Default `__Host-reffect-session`. */
  readonly cookie: string;
  /** Login (POST) and logout (DELETE) path. Default `/session`. */
  readonly path: string;
  /** Seconds the cookie lives; a browser-session cookie when absent. */
  readonly maxAge: number | undefined;
}
const COOKIE_NAME = /^__Host-[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const SESSION_PATH = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
// Browsers cap cookie lifetimes at 400 days (RFC 6265bis).
const MAX_AGE_LIMIT = 400 * 24 * 60 * 60;

/** Checked native adapter for one middleware providing a scalar principal service. */
export class RpcBearer {
  private constructor(
    readonly middleware: RpcMiddleware.AnyServiceWithProps,
    readonly principal: Context.Key<unknown, bigint>,
    readonly credentialsEnv: string,
    readonly denied: string,
    readonly denialAst: SchemaAST.AST,
    readonly session: SessionCookie | undefined,
  ) {
    Object.freeze(this);
  }

  /** Configure runtime credentials; no credential values belong in compiler inputs. */
  static make<Id, Name extends string, P, E extends Schema.Top, CE, Client extends boolean>(
    this: void,
    middleware: RpcMiddleware.ServiceClass<Id, Name, P, E, CE, never, Client>,
    principal: Context.Service<NoInfer<P>, bigint>,
    options: {
      readonly credentialsEnv: string;
      /** Also accept the token in a session cookie (#4); see `SessionCookie`. */
      readonly session?: true | Partial<SessionCookie>;
    },
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
    const requested = options.session === true ? {} : options.session;
    const session: SessionCookie | undefined =
      requested === undefined
        ? undefined
        : {
            cookie: requested.cookie ?? "__Host-reffect-session",
            path: requested.path ?? "/session",
            maxAge: requested.maxAge,
          };
    if (
      session &&
      (!COOKIE_NAME.test(session.cookie) ||
        !SESSION_PATH.test(session.path) ||
        (session.maxAge !== undefined &&
          (!Number.isSafeInteger(session.maxAge) ||
            session.maxAge < 1 ||
            session.maxAge > MAX_AGE_LIMIT)))
    )
      throw fail(
        "RPC_UNSUPPORTED",
        "rpc",
        "auth.session",
        "A session cookie is named __Host-<token>, its path is an absolute path of plain segments, and its maxAge is 1 second to 400 days",
      );
    return new RpcBearer(
      middleware,
      principal,
      options.credentialsEnv,
      ast.literal,
      ast,
      session === undefined ? undefined : Object.freeze(session),
    );
  }
}
