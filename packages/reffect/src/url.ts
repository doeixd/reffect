/**
 * `R.Url`: what a page reads of its URL (docs/research/ssr-data.md, "Page inputs from the URL").
 * The operations mirror the Web URL API on an absolute URL, and are total: a string that is not a
 * URL has the empty path and no search parameters, in the reference and natively alike.
 * Natively they run on the `url` crate, which implements the same WHATWG URL Standard.
 */
import { dual } from "effect/Function";
import { Capabilities, Expr, Operation, SemanticRef, StringType } from "./kernel.ts";
import { UndefinedOr } from "./records.ts";

const parse = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

/** `new URL(url).pathname`, or `""` when `url` is not a URL. */
export const UrlPathname = Operation.make(
  SemanticRef.operation("reffect/url.pathname@1"),
  [StringType] as const,
  StringType,
  (url) => parse(url)?.pathname ?? "",
).pipe(Operation.withCapabilities([Capabilities.String]));

/**
 * `new URL(url).searchParams.get(name) ?? undefined`: the first parameter named `name`, decoded as
 * application/x-www-form-urlencoded (`+` as a space, invalid UTF-8 as U+FFFD).
 */
export const UrlSearchParam = Operation.make(
  SemanticRef.operation("reffect/url.search-param@1"),
  [StringType, StringType] as const,
  UndefinedOr(StringType),
  (url, name) => parse(url)?.searchParams.get(name) ?? undefined,
).pipe(Operation.withCapabilities([Capabilities.String]));

const text = (value: Expr<string> | string): Expr<string> =>
  typeof value === "string" ? Expr.literal(StringType, value) : value;

export const UrlIR = Object.freeze({
  /** `new URL(url).pathname`; the empty string for a string that is not a URL. */
  pathname: (url: Expr<string>): Expr<string> => Expr.apply(UrlPathname, url),
  /** `new URL(url).searchParams.get(name) ?? undefined`. */
  searchParam: dual(2, (url: Expr<string>, name: Expr<string> | string): Expr<string | undefined> =>
    Expr.apply(UrlSearchParam, url, text(name)),
  ) as {
    (name: Expr<string> | string): (url: Expr<string>) => Expr<string | undefined>;
    (url: Expr<string>, name: Expr<string> | string): Expr<string | undefined>;
  },
});
