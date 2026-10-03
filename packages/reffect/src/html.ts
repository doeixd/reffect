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
import type { Document, Html as FoldkitHtml, HtmlBuilder } from "foldkit/html";
import {
  BoolType,
  Expr,
  IRType,
  Operation,
  SemanticRef,
  StringType,
  Targets,
  Traits,
  fail,
} from "./kernel.ts";
import type { AnyOperation, Fn } from "./kernel.ts";
import { ArrayIR, Struct } from "./records.ts";
import { Reference } from "./reference.ts";
import { NativeRpc } from "./native-rpc.ts";

/** The reference value of an `Html` expression: what the view describes, before Foldkit sees it. */
export type HtmlValue =
  | {
      readonly _tag: "Element";
      readonly tag: string;
      readonly attributes: ReadonlyArray<AttributeValue>;
      readonly children: ReadonlyArray<HtmlValue>;
    }
  | { readonly _tag: "Text"; readonly text: string }
  | { readonly _tag: "Empty" };
type AttributeValue =
  | { readonly name: StringAttribute; readonly value: string }
  | { readonly name: BooleanAttribute; readonly value: boolean }
  | { readonly name: "DataAttribute"; readonly key: string; readonly value: string }
  | { readonly name: EventAttribute; readonly message: unknown };

const HtmlCapability = SemanticRef.capability("reffect/capability/foldkit-html@1");
const isHtmlValue = (value: unknown): value is HtmlValue =>
  typeof value === "object" && value !== null && "_tag" in value;
/** A Foldkit view fragment. Natively a serialized fragment (SSR-003). */
export const HtmlType: IRType<HtmlValue> = IRType.make(
  SemanticRef.type("reffect/foldkit-html@1"),
  Schema.declare(isHtmlValue),
  { target: Targets.RustStd, type: "crate::foldkit_html::Html" },
).pipe(IRType.withTraits([Traits.Cloneable]));
const HtmlArray = ArrayIR(HtmlType);

/** Attributes the 8A profile admits (SSR-002), by the value Foldkit's constructor takes. */
const STRING_ATTRIBUTES = [
  "Key",
  "Class",
  "Id",
  "Href",
  "Title",
  "Type",
  "Name",
  "Placeholder",
  "For",
  "Value",
] as const;
const BOOLEAN_ATTRIBUTES = ["Checked", "Disabled"] as const;
/** Event attributes take a Message; they leave no trace in server HTML (SSR-010). */
const EVENT_ATTRIBUTES = ["OnClick", "OnDoubleClick", "OnSubmit"] as const;
type StringAttribute = (typeof STRING_ATTRIBUTES)[number];
type BooleanAttribute = (typeof BOOLEAN_ATTRIBUTES)[number];
type EventAttribute = (typeof EVENT_ATTRIBUTES)[number];

/** A variant of a `defineMessageUnion` Message: a tagged struct schema that constructs itself. */
export type MessageVariant = Schema.Top &
  ((value: never) => { readonly _tag: string }) & { readonly fields: Schema.Struct.Fields };
type MessageFields<V extends MessageVariant> = {
  readonly [K in Exclude<keyof Schema.Schema.Type<V>, "_tag">]: Expr<Schema.Schema.Type<V>[K]>;
};
/** A Message to construct when an event fires: the app's variant and its fields as R values. */
export interface MessageExpr {
  readonly variant: MessageVariant;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly value: Expr<unknown> }>;
}
const variantIds = new WeakMap<MessageVariant, number>();
let nextVariantId = 0;
const variantId = (variant: MessageVariant): number => {
  const known = variantIds.get(variant);
  if (known !== undefined) return known;
  nextVariantId += 1;
  variantIds.set(variant, nextVariantId);
  return nextVariantId;
};
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

/** One child as authored: an Html expression, a String expression, or literal text. */
export type Child = Expr<HtmlValue> | Expr<string> | string;
/** Children: a list, or one mapped `Array<Html>` (Foldkit views pass `items.map(...)`). */
export type Children = ReadonlyArray<Child> | Expr<ReadonlyArray<HtmlValue>>;

const TextOperation = Operation.make(
  SemanticRef.operation("reffect/foldkit-html.text@1"),
  [StringType],
  HtmlType,
  (text): HtmlValue => ({ _tag: "Text", text }),
).pipe(Operation.withCapabilities([HtmlCapability]));
const EmptyOperation = Operation.make(
  SemanticRef.operation("reffect/foldkit-html.empty@1"),
  [],
  HtmlType,
  (): HtmlValue => ({ _tag: "Empty" }),
).pipe(Operation.withCapabilities([HtmlCapability]));

/** What an element operation builds: its tag and its attributes' names, in authored order. */
export interface ElementShape {
  readonly tag: string;
  readonly attributes: ReadonlyArray<
    | { readonly name: StringAttribute | BooleanAttribute }
    | { readonly name: "DataAttribute"; readonly key: string }
    /** Its Message's field values are reference-only arguments: native rendering erases them. */
    | {
        readonly name: EventAttribute;
        readonly variant: MessageVariant;
        readonly fields: ReadonlyArray<{ readonly name: string; readonly type: IRType<unknown> }>;
      }
  >;
  readonly isVoid: boolean;
}
const elementShapes = new WeakMap<AnyOperation, ElementShape>();
const elementOperations = new Map<string, AnyOperation>();
/** The shape an element operation was interned for, if it is one. */
export const elementShapeOf = (operation: AnyOperation): ElementShape | undefined =>
  elementShapes.get(operation);
export const isHtmlTextOperation = (operation: AnyOperation): boolean =>
  operation === TextOperation;
export const isHtmlEmptyOperation = (operation: AnyOperation): boolean =>
  operation === EmptyOperation;

const shapeKey = (shape: ElementShape): string =>
  `${shape.tag}(${shape.attributes
    .map((attribute) =>
      "key" in attribute
        ? `data:${attribute.key}`
        : "variant" in attribute
          ? `${attribute.name}:${variantId(attribute.variant)}{${attribute.fields.map((field) => field.name).join(",")}}`
          : attribute.name,
    )
    .join(",")})`;
/** One interned operation per element shape: attribute values, then the children array. */
const elementOperation = (shape: ElementShape): AnyOperation => {
  const key = shapeKey(shape);
  const known = elementOperations.get(key);
  if (known) return known;
  const inputs: IRType<unknown>[] = shape.attributes.flatMap((attribute) =>
    "variant" in attribute
      ? attribute.fields.map((field) => field.type)
      : [attribute.name === "Checked" || attribute.name === "Disabled" ? BoolType : StringType],
  );
  inputs.push(HtmlArray);
  const operation = Operation.make(
    SemanticRef.operation(`reffect/foldkit-html.element@1/${key}`),
    inputs,
    HtmlType,
    (...args: ReadonlyArray<unknown>): HtmlValue => {
      let next = 0;
      const attributes = shape.attributes.map((attribute): AttributeValue => {
        if ("variant" in attribute) {
          const fields = Object.fromEntries(
            attribute.fields.map((field) => [field.name, args[next++]]),
          );
          return {
            name: attribute.name,
            message: Reflect.apply(attribute.variant, undefined, [fields]),
          };
        }
        const value = args[next++];
        if ("key" in attribute)
          return { name: "DataAttribute", key: attribute.key, value: String(value) };
        if (attribute.name === "Checked" || attribute.name === "Disabled")
          return { name: attribute.name, value: value === true };
        return { name: attribute.name, value: String(value) };
      });
      return {
        _tag: "Element",
        tag: shape.tag,
        attributes,
        children: (args[next] as ReadonlyArray<HtmlValue>).filter(
          (child) => child._tag !== "Empty",
        ),
      };
    },
  ).pipe(Operation.withCapabilities([HtmlCapability]));
  elementShapes.set(operation, shape);
  elementOperations.set(key, operation);
  return operation;
};

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

/** `{ title, body }` as a view returns it; lang, dir and canonical wait for the profile. */
export const DocumentType = Struct({ title: StringType, body: HtmlType });

/** The Foldkit VNode an Html value describes, built with the runtime's own `h`. */
const toFoldkit = <Message>(value: HtmlValue, h: HtmlBuilder<Message>): FoldkitHtml | string => {
  if (value._tag === "Text") return value.text;
  if (value._tag === "Empty") return h.empty;
  const attributes = value.attributes.map((attribute) =>
    "message" in attribute
      ? h[attribute.name](attribute.message as Message)
      : "key" in attribute
        ? h.DataAttribute(attribute.key, attribute.value)
        : attribute.name === "Checked" || attribute.name === "Disabled"
          ? h[attribute.name](attribute.value === true)
          : h[attribute.name](String(attribute.value)),
  );
  const build = Reflect.get(h, value.tag) as (
    attributes: ReadonlyArray<unknown>,
    children?: ReadonlyArray<FoldkitHtml | string>,
  ) => FoldkitHtml;
  return build(
    attributes,
    value.children.map((child) => toFoldkit(child, h)),
  );
};

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
    return { name: "DataAttribute", key, value: stringValue(value, "Html.DataAttribute") };
  },
  text: (value: Expr<string> | string): Expr<HtmlValue> => childExpr(value, "Html.text"),
  empty: Expr.apply(EmptyOperation),
  Document: DocumentType,
  /** The Html witness (`Type` is Foldkit's `type` attribute). */
  Node: HtmlType,
  toFoldkitView,
});
