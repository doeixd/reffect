/**
 * `R.Html`: Foldkit views authored in R (SSR-009). Builders mirror Foldkit's `h`: data-first
 * `R.Html.div(attributes, children)`, void elements with attributes only, and attribute
 * constructors named as Foldkit's. Html values are operations over a dedicated witness:
 *
 * - the reference evaluates them to a plain description, which `toFoldkitView` turns into real
 *   Foldkit VNodes with the runtime's own `h`, so the browser and upstream `renderToString` run
 *   the same view;
 * - native lowering (milestone 8A step 3) appends to a serialized fragment instead.
 *
 * Only the bounded 8A profile (SSR-002) is admitted.
 */
import { Effect, Schema } from "effect";
import type { Document, HtmlBuilder } from "foldkit/html";
import { BoolType, EqString, Expr, IRType, NumberType, StringType, fail } from "./kernel.ts";
import { ConcatString } from "./kernel.ts";
import { SchemaIR } from "./schema-json.ts";
import type { Fn } from "./kernel.ts";
import { Struct, UndefinedOr } from "./records.ts";
import { OptionIR } from "./option.ts";
import { ResultIR } from "./result.ts";
import type { ResultValue } from "./result.ts";
import { Reference } from "./reference.ts";
import { NativeRpc } from "./native-rpc.ts";
import {
  BOOLEAN_ATTRIBUTES,
  DocumentType,
  EVENT_ATTRIBUTES,
  EmptyOperation,
  HtmlArray,
  HtmlType,
  RenderErrorType,
  RenderFailureOperation,
  RenderOperation,
  RenderedType,
  JsonRoundTripOperation,
  JsonTextOperation,
  RootKindOperation,
  STRING_ATTRIBUTES,
  TextOperation,
  elementOperation,
  toFoldkit,
} from "./html-ir.ts";
import type {
  BooleanAttribute,
  ElementShape,
  EventAttribute,
  HtmlValue,
  MessageFields,
  MessageVariant,
  StringAttribute,
} from "./html-ir.ts";
export {
  DocumentType,
  HtmlType,
  RenderErrorType,
  RenderedType,
  elementShapeOf,
} from "./html-ir.ts";
export type { ElementShape, HtmlValue, MessageVariant } from "./html-ir.ts";

/** A Message to construct when an event fires: the app's variant and its fields as R values. */
export interface MessageExpr {
  readonly variant: MessageVariant;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly value: Expr<unknown> }>;
}
/**
 * `R.Html.message(Message.ClickedToggle, { id })`: each field is checked against the variant's
 * own schema, so the whole Message union never needs an R witness (SSR-010).
 */
const message = <V extends MessageVariant>(variant: V, fields: MessageFields<V>): MessageExpr => {
  const entries: ReadonlyArray<readonly [string, Expr<unknown>]> = Object.entries(fields);
  for (const [name, value] of entries) {
    const schema = variant.fields[name];
    if (name === "_tag" || !Schema.isSchema(schema))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        `Html.message.${name}`,
        "Not a field of this Message",
      );
    if (!IRType.same(value.type, NativeRpc.witness(schema)))
      throw fail(
        "TYPE_MISMATCH",
        "authoring",
        `Html.message.${name}`,
        "The value's witness differs from the field's schema",
      );
  }
  const missing = Object.keys(variant.fields).filter(
    (name) => name !== "_tag" && !entries.some(([given]) => given === name),
  );
  if (missing.length)
    throw fail(
      "TYPE_MISMATCH",
      "authoring",
      "Html.message",
      `Missing fields: ${missing.join(", ")}`,
    );
  return Object.freeze({
    variant,
    fields: Object.freeze(entries.map(([name, value]) => Object.freeze({ name, value }))),
  });
};

/** An attribute as authored: its Foldkit constructor and the R expression it is given. */
export type Attribute =
  | { readonly name: StringAttribute; readonly value: Expr<string> }
  | { readonly name: BooleanAttribute; readonly value: Expr<boolean> }
  | { readonly name: "DataAttribute"; readonly key: string; readonly value: Expr<string> }
  | { readonly name: EventAttribute; readonly message: MessageExpr };
const stringValue = (value: Expr<string> | string, at: string): Expr<string> => {
  const expr = typeof value === "string" ? Expr.literal(StringType, value) : value;
  if (!IRType.same(expr.type, StringType))
    throw fail("TYPE_MISMATCH", "authoring", at, "This attribute takes a String");
  return expr;
};
const booleanValue = (value: Expr<boolean> | boolean, at: string): Expr<boolean> => {
  const expr = typeof value === "boolean" ? Expr.literal(BoolType, value) : value;
  if (!IRType.same(expr.type, BoolType))
    throw fail("TYPE_MISMATCH", "authoring", at, "This attribute takes a Boolean");
  return expr;
};
const stringAttribute =
  (name: StringAttribute) =>
  (value: Expr<string> | string): Attribute => ({
    name,
    value: stringValue(value, `Html.${name}`),
  });
const booleanAttribute =
  (name: BooleanAttribute) =>
  (value: Expr<boolean> | boolean): Attribute => ({
    name,
    value: booleanValue(value, `Html.${name}`),
  });
const DATA_KEY = /^[a-z][a-z0-9-]*$/;
/** Upstream's `RESERVED_HANDOFF_ATTRIBUTES` (foldkit 0.165.0): only the server stamps these. */
const RESERVED_DATA_KEYS: ReadonlySet<string> = new Set([
  "foldkit-app",
  "foldkit-build",
  "foldkit-flags",
  "foldkit-key",
  "foldkit-identity",
]);

/** One child as authored: an Html expression, a String expression, or literal text. */
export type Child = Expr<HtmlValue> | Expr<string> | string;
/** Children: a list, or one mapped `Array<Html>` (Foldkit views pass `items.map(...)`). */
export type Children = ReadonlyArray<Child> | Expr<ReadonlyArray<HtmlValue>>;

const childExpr = (child: Child, at: string): Expr<HtmlValue> => {
  if (typeof child === "string") return Expr.apply(TextOperation, Expr.literal(StringType, child));
  if (IRType.same(child.type, StringType)) return Expr.apply(TextOperation, child as Expr<string>);
  if (IRType.same(child.type, HtmlType)) return child as Expr<HtmlValue>;
  throw fail("TYPE_MISMATCH", "authoring", at, "Children are Html, String or text");
};
const childrenExpr = (children: Children, at: string): Expr<ReadonlyArray<HtmlValue>> => {
  if (children instanceof Expr) {
    if (!IRType.same(children.type, HtmlArray))
      throw fail("TYPE_MISMATCH", "authoring", at, "Mapped children are an Array<Html>");
    return children;
  }
  return Expr.arrayMake(
    HtmlArray,
    children.map((child, i) => childExpr(child, `${at}[${i}]`)),
  );
};
const element =
  (tag: string, isVoid: boolean) =>
  (attributes: ReadonlyArray<Attribute>, children: Children = []): Expr<HtmlValue> => {
    const at = `Html.${tag}`;
    const seen = new Set<string>();
    for (const attribute of attributes) {
      const name = "key" in attribute ? `data-${attribute.key}` : attribute.name;
      // Foldkit keeps the last value but the first position; the profile refuses the ambiguity.
      if (seen.has(name))
        throw fail("DUPLICATE_ATTRIBUTE", "authoring", at, `${name} is given twice`);
      seen.add(name);
    }
    const shape: ElementShape = Object.freeze({
      tag,
      isVoid,
      attributes: Object.freeze(
        attributes.map((attribute) =>
          "key" in attribute
            ? Object.freeze({ name: attribute.name, key: attribute.key })
            : "message" in attribute
              ? Object.freeze({
                  name: attribute.name,
                  variant: attribute.message.variant,
                  fields: Object.freeze(
                    attribute.message.fields.map((field) =>
                      Object.freeze({ name: field.name, type: field.value.type }),
                    ),
                  ),
                })
              : Object.freeze({ name: attribute.name }),
        ),
      ),
    });
    const values: Expr<unknown>[] = attributes.flatMap((attribute) =>
      "message" in attribute
        ? attribute.message.fields.map((field) => field.value)
        : [attribute.value],
    );
    return Expr.apply(
      elementOperation(shape),
      ...values,
      isVoid ? Expr.arrayMake(HtmlArray, []) : childrenExpr(children, `${at}.children`),
    ) as Expr<HtmlValue>;
  };

/** Elements of the 8A profile: ordinary HTML elements, and the void ones it needs. */
const ELEMENTS = [
  "a",
  "article",
  "aside",
  "button",
  "div",
  "em",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "header",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "span",
  "strong",
  "ul",
] as const;
const VOID_ELEMENTS = ["br", "hr", "input"] as const;
type Element = (attributes: ReadonlyArray<Attribute>, children?: Children) => Expr<HtmlValue>;
type VoidElement = (attributes: ReadonlyArray<Attribute>) => Expr<HtmlValue>;

/**
 * A Foldkit `view` from an R view: the reference evaluates the R function and builds VNodes with
 * the `h` Foldkit passes, so the browser and upstream `renderToString` render this exact view.
 */
const toFoldkitView =
  <Model>(
    view: Fn<readonly [IRType<Model>], { readonly title: string; readonly body: HtmlValue }>,
  ) =>
  <Message>(model: Model, h: HtmlBuilder<Message>): Document => {
    const document = Effect.runSync(Reference.run(view, [model]));
    const body = toFoldkit(document.body, h);
    // Foldkit's Document body is an element or nothing; text has no Foldkit form.
    if (typeof body === "string")
      throw fail("INVALID_DOCUMENT", "reference", "Html.Document.body", "The body is an element");
    return { title: document.title, body };
  };

/** Whether a witness holds a Number, whose `-0` the Flags JSON round trip would normalize. */
const holdsNumber = (type: IRType<unknown>): boolean =>
  IRType.same(type, NumberType) ||
  (type.layout !== undefined &&
    (type.layout._tag === "Struct"
      ? type.layout.fields.some((field) => holdsNumber(field.type))
      : type.layout._tag === "Union"
        ? type.layout.cases.some(holdsNumber)
        : type.layout._tag === "Array" || type.layout._tag === "UndefinedOr"
          ? holdsNumber(type.layout.item)
          : type.layout._tag === "Record"
            ? holdsNumber(type.layout.value)
            : false));
/**
 * Upstream's Flags payload: `<script type="application/json" data-foldkit-flags="…">` holding
 * `JSON.stringify` of the encoded Flags with every `<` escaped. Upstream hands `init` the decoded
 * round trip of that text; without Numbers it is the value itself, so the document form, whose
 * view was built from the original Flags, refuses them.
 */
const flagsPayload = (
  flags: Expr<unknown>,
  runtimeId: string,
  refuseNumbers: boolean,
): Expr<string> => {
  if (refuseNumbers && holdsNumber(flags.type))
    throw fail(
      "UNSUPPORTED_FLAGS",
      "authoring",
      "Html.renderToString.flags",
      "Flags holding Numbers need renderToString({ init, view }, { flags }): the JSON round trip init reads turns -0 into 0",
    );
  const text = Expr.apply(
    JsonTextOperation,
    SchemaIR.encodeSync(SchemaIR.toCodecJson(flags.type))(flags),
  );
  const escapedId = runtimeId
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
  return Expr.apply(
    ConcatString,
    Expr.apply(
      ConcatString,
      Expr.literal(
        StringType,
        `<script type="application/json" data-foldkit-flags="${escapedId}">`,
      ),
      StringType.replaceAll(text, "<", "\\u003c"),
    ),
    Expr.literal(StringType, "</script>"),
  );
};
type DocumentValue = { readonly title: string; readonly body: HtmlValue };
type RenderResult = ResultValue<
  { readonly html: string; readonly title: string },
  Schema.Schema.Type<typeof RenderErrorType.schema>
>;
/** An application as upstream's `renderToString` takes it: `init` from Flags, then `view`. */
export interface Program<Flags, Model> {
  readonly init: (flags: Expr<Flags>) => Expr<Model>;
  readonly view: (model: Expr<Model>) => Expr<DocumentValue>;
}
/**
 * `renderToString` of a document, or of a program and its Flags. A program's `init` reads what
 * upstream's reads: the Flags decoded from their JSON round trip (`FlagsEncodeError` if that
 * fails), so Flags may hold Numbers. A document was built from the original Flags, so its Flags
 * may not.
 */
function renderToString(
  document: Expr<DocumentValue>,
  options: {
    readonly buildId: string;
    readonly runtimeId?: string;
    /** The Flags `init` was given, carried to the client in the Flags payload (M9-1). */
    readonly flags?: Expr<unknown>;
  },
): Expr<RenderResult>;
function renderToString<Flags, Model>(
  program: Program<Flags, Model>,
  options: { readonly buildId: string; readonly runtimeId?: string; readonly flags: Expr<Flags> },
): Expr<RenderResult>;
function renderToString(
  source: Expr<DocumentValue> | Program<unknown, unknown>,
  options: {
    readonly buildId: string;
    readonly runtimeId?: string;
    readonly flags?: Expr<unknown>;
  },
): Expr<RenderResult> {
  const runtimeId = options.runtimeId ?? "app";
  if (runtimeId === "")
    throw fail("INVALID_RUNTIME_ID", "authoring", "Html.renderToString", "runtimeId is nonempty");
  if (options.buildId === "")
    throw fail(
      "MISSING_BUILD_ID",
      "authoring",
      "Html.renderToString",
      "A hydratable render needs a buildId",
    );
  if (!(source instanceof Expr)) {
    const flags = options.flags;
    if (flags === undefined)
      throw fail(
        "MISSING_FLAGS",
        "authoring",
        "Html.renderToString",
        "A program renders from Flags",
      );
    const codec = SchemaIR.toCodecJson(flags.type);
    const hydrationFlags = SchemaIR.decodeUnknownOption(codec)(
      Expr.apply(JsonRoundTripOperation, SchemaIR.encodeSync(codec)(flags)),
    );
    const flagsScript = flagsPayload(flags, runtimeId, false);
    return OptionIR.match(hydrationFlags, {
      onNone: () =>
        ResultIR.fail(
          RenderErrorType.cases.FlagsEncodeError.make({
            message: Expr.literal(StringType, "The Flags do not decode from their JSON round trip"),
          }),
          RenderedType,
        ),
      onSome: (decoded) =>
        renderDocument(source.view(source.init(decoded)), runtimeId, options.buildId, flagsScript),
    });
  }
  const flagsScript =
    options.flags === undefined ? undefined : flagsPayload(options.flags, runtimeId, true);
  return renderDocument(source, runtimeId, options.buildId, flagsScript);
}
/**
 * The hydratable render of a document: `InvalidHydrationRoot` when the body is not an
 * element, then `SerializationError` (a NUL), else the stamped `html` and the `title`. The
 * reference of each step is upstream `renderToString` itself; natively it is the ported
 * serializer (SSR-003).
 */
const renderDocument = (
  document: Expr<DocumentValue>,
  runtimeId: string,
  buildId: string,
  flagsScript: Expr<string> | undefined,
): Expr<RenderResult> => {
  const body = Struct.get(document, "body");
  const ids = [Expr.literal(StringType, runtimeId), Expr.literal(StringType, buildId)] as const;
  const kind = Expr.apply(RootKindOperation, body);

  return Expr.match(
    Expr.apply(EqString, kind, Expr.literal(StringType, "Element")),
    UndefinedOr.match(Expr.apply(RenderFailureOperation, body, ...ids), {
      onUndefined: () =>
        ResultIR.succeed(
          RenderedType.make({
            html:
              flagsScript === undefined
                ? Expr.apply(RenderOperation, body, ...ids)
                : Expr.apply(ConcatString, Expr.apply(RenderOperation, body, ...ids), flagsScript),
            title: Struct.get(document, "title"),
          }),
          RenderErrorType,
        ),
      onDefined: (message) =>
        ResultIR.fail(RenderErrorType.cases.SerializationError.make({ message }), RenderedType),
    }),
    ResultIR.fail(
      RenderErrorType.cases.InvalidHydrationRoot.make({ rootKind: kind }),
      RenderedType,
    ),
  );
};

export const HtmlIR = Object.freeze({
  ...(Object.fromEntries(ELEMENTS.map((tag) => [tag, element(tag, false)])) as Record<
    (typeof ELEMENTS)[number],
    Element
  >),
  ...(Object.fromEntries(VOID_ELEMENTS.map((tag) => [tag, element(tag, true)])) as Record<
    (typeof VOID_ELEMENTS)[number],
    VoidElement
  >),
  ...(Object.fromEntries(STRING_ATTRIBUTES.map((name) => [name, stringAttribute(name)])) as Record<
    StringAttribute,
    (value: Expr<string> | string) => Attribute
  >),
  ...(Object.fromEntries(
    BOOLEAN_ATTRIBUTES.map((name) => [name, booleanAttribute(name)]),
  ) as Record<BooleanAttribute, (value: Expr<boolean> | boolean) => Attribute>),
  ...(Object.fromEntries(
    EVENT_ATTRIBUTES.map((name) => [
      name,
      (expr: MessageExpr): Attribute => ({ name, message: expr }),
    ]),
  ) as Record<EventAttribute, (message: MessageExpr) => Attribute>),
  message,
  DataAttribute: (key: string, value: Expr<string> | string): Attribute => {
    if (!DATA_KEY.test(key))
      throw fail(
        "INVALID_ATTRIBUTE",
        "authoring",
        "Html.DataAttribute",
        "Data keys are lowercase kebab-case",
      );
    // An authored marker would precede the server's own, and browsers keep the first (#22).
    if (RESERVED_DATA_KEYS.has(key))
      throw fail(
        "RESERVED_ATTRIBUTE",
        "authoring",
        "Html.DataAttribute",
        `The view authored data-${key}, which is reserved for Foldkit's server-to-client hydration handoff. Application markup cannot own root, build, Flags, key, or identity markers. Remove the attribute.`,
      );
    return { name: "DataAttribute", key, value: stringValue(value, "Html.DataAttribute") };
  },
  text: (value: Expr<string> | string): Expr<HtmlValue> => childExpr(value, "Html.text"),
  empty: Expr.apply(EmptyOperation),
  Document: DocumentType,
  /** The Html witness (`Type` is Foldkit's `type` attribute). */
  Node: HtmlType,
  toFoldkitView,
  renderToString,
  Rendered: RenderedType,
  RenderError: RenderErrorType,
});
