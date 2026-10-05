/**
 * The `R.Html` IR (SSR-009/010): the Html witness, its operations and shapes, the reference's
 * Foldkit adapter, and the render primitives. Kept apart from the authoring surface (`html.ts`) so
 * the planner and lowering can recognise these operations without importing NativeRpc.
 */
import { Effect, Result, Schema } from "effect";
import type { Document, Html as FoldkitHtml, HtmlBuilder } from "foldkit/html";
import { renderToString as upstreamRenderToString } from "foldkit/experimental/server";
import {
  BoolType,
  Expr,
  IRType,
  NumberType,
  Operation,
  SemanticRef,
  StringType,
  Targets,
  Traits,
  UnknownType,
} from "./kernel.ts";
import type { AnyOperation } from "./kernel.ts";
import { ArrayIR, Struct, TaggedUnion, UndefinedOr } from "./records.ts";

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
export type AttributeValue =
  | { readonly name: StringAttribute; readonly value: string }
  | { readonly name: BooleanAttribute; readonly value: boolean }
  | { readonly name: NumberAttribute; readonly value: number }
  | { readonly name: "DataAttribute"; readonly key: string; readonly value: string }
  | { readonly name: EventAttribute; readonly message: unknown }
  | { readonly name: ValueEventAttribute; readonly toMessage: (value: string) => unknown };

export const HtmlCapability = SemanticRef.capability("reffect/capability/foldkit-html@1");
const isHtmlValue = (value: unknown): value is HtmlValue =>
  typeof value === "object" && value !== null && "_tag" in value;
/** A Foldkit view fragment. Natively a serialized fragment (SSR-003). */
export const HtmlType: IRType<HtmlValue> = IRType.make(
  SemanticRef.type("reffect/foldkit-html@1"),
  Schema.declare(isHtmlValue),
  { target: Targets.RustStd, type: "crate::foldkit_html::Html" },
).pipe(IRType.withTraits([Traits.Cloneable]));
export const HtmlArray = ArrayIR(HtmlType);

/** Attributes the 8A profile admits (SSR-002), by the value Foldkit's constructor takes. */
export const STRING_ATTRIBUTES = [
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
export const BOOLEAN_ATTRIBUTES = [
  "Checked",
  "Disabled",
  "Selected",
  "Autofocus",
  /** A raw `aria-disabled` attribute, written `"true"` or `"false"` (8B). */
  "AriaDisabled",
] as const;
/** Number attributes; `Tabindex` is a literal integer in the browser's `long` range (8B). */
export const NUMBER_ATTRIBUTES = ["Tabindex"] as const;
export type NumberAttribute = (typeof NUMBER_ATTRIBUTES)[number];
export const isBooleanAttribute = (name: string): name is BooleanAttribute =>
  (BOOLEAN_ATTRIBUTES as ReadonlyArray<string>).includes(name);
export const isNumberAttribute = (name: string): name is NumberAttribute =>
  (NUMBER_ATTRIBUTES as ReadonlyArray<string>).includes(name);
/** Event attributes take a Message; they leave no trace in server HTML (SSR-010). */
export const EVENT_ATTRIBUTES = ["OnClick", "OnDoubleClick", "OnSubmit"] as const;
export type StringAttribute = (typeof STRING_ATTRIBUTES)[number];
export type BooleanAttribute = (typeof BOOLEAN_ATTRIBUTES)[number];
export type EventAttribute = (typeof EVENT_ATTRIBUTES)[number];
/**
 * Events whose Message takes the element's value (#14): Foldkit's `OnInput(value => Message)`.
 * In R one String field of the variant receives the value; the others are given as usual.
 */
export type ValueEventAttribute = "OnInput";

/** A variant of a `defineMessageUnion` Message: a tagged struct schema that constructs itself. */
export type MessageVariant = Schema.Top &
  ((value: never) => { readonly _tag: string }) & { readonly fields: Schema.Struct.Fields };
export type MessageFields<V extends MessageVariant> = {
  readonly [K in Exclude<keyof Schema.Schema.Type<V>, "_tag">]: Expr<Schema.Schema.Type<V>[K]>;
};
const variantIds = new WeakMap<MessageVariant, number>();
let nextVariantId = 0;
const variantId = (variant: MessageVariant): number => {
  const known = variantIds.get(variant);
  if (known !== undefined) return known;
  nextVariantId += 1;
  variantIds.set(variant, nextVariantId);
  return nextVariantId;
};

export const TextOperation = Operation.make(
  SemanticRef.operation("reffect/foldkit-html.text@1"),
  [StringType],
  HtmlType,
  (text): HtmlValue => ({ _tag: "Text", text }),
).pipe(Operation.withCapabilities([HtmlCapability]));
export const EmptyOperation = Operation.make(
  SemanticRef.operation("reffect/foldkit-html.empty@1"),
  [],
  HtmlType,
  (): HtmlValue => ({ _tag: "Empty" }),
).pipe(Operation.withCapabilities([HtmlCapability]));

/** What an element operation builds: its tag and its attributes' names, in authored order. */
export interface ElementShape {
  readonly tag: string;
  readonly attributes: ReadonlyArray<
    | { readonly name: StringAttribute | BooleanAttribute | NumberAttribute }
    | { readonly name: "DataAttribute"; readonly key: string }
    /** Its Message's field values are reference-only arguments: native rendering erases them. */
    | {
        readonly name: EventAttribute | ValueEventAttribute;
        readonly variant: MessageVariant;
        readonly fields: ReadonlyArray<{ readonly name: string; readonly type: IRType<unknown> }>;
        /** For a value event, the field the element's value fills. */
        readonly value?: string;
      }
  >;
  readonly isVoid: boolean;
}
const elementShapes = new WeakMap<AnyOperation, ElementShape>();
// Module-private (#39): an importer could otherwise set any operation as an element's.
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
          ? `${attribute.name}:${variantId(attribute.variant)}{${attribute.fields.map((field) => field.name).join(",")}}${attribute.value === undefined ? "" : `<-${attribute.value}`}`
          : attribute.name,
    )
    .join(",")})`;
/** One interned operation per element shape: attribute values, then the children array. */
export const elementOperation = (shape: ElementShape): AnyOperation => {
  const key = shapeKey(shape);
  const known = elementOperations.get(key);
  if (known) return known;
  const inputs: IRType<unknown>[] = shape.attributes.flatMap((attribute) =>
    "variant" in attribute
      ? attribute.fields.map((field) => field.type)
      : [
          isBooleanAttribute(attribute.name)
            ? BoolType
            : isNumberAttribute(attribute.name)
              ? NumberType
              : StringType,
        ],
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
          const { name, value: target, variant } = attribute;
          if (name === "OnInput") {
            // Html.OnInput always names the field the value fills.
            if (target === undefined) throw new Error("OnInput without its value field");
            return {
              name,
              toMessage: (value: string) =>
                Reflect.apply(variant, undefined, [{ ...fields, [target]: value }]),
            };
          }
          return { name, message: Reflect.apply(variant, undefined, [fields]) };
        }
        const value = args[next++];
        if ("key" in attribute)
          return { name: "DataAttribute", key: attribute.key, value: String(value) };
        if (isBooleanAttribute(attribute.name))
          return { name: attribute.name, value: value === true };
        if (isNumberAttribute(attribute.name))
          return { name: attribute.name, value: Number(value) };
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

/** `{ title, body }` as a view returns it; lang, dir and canonical wait for the profile. */
export const DocumentType = Struct({ title: StringType, body: HtmlType });

/** The Foldkit VNode an Html value describes, built with the runtime's own `h`. */
export const toFoldkit = <Message>(
  value: HtmlValue,
  h: HtmlBuilder<Message>,
): FoldkitHtml | string => {
  if (value._tag === "Text") return value.text;
  if (value._tag === "Empty") return h.empty;
  const attributes = value.attributes.map((attribute) =>
    "toMessage" in attribute
      ? h.OnInput((input) => attribute.toMessage(input) as Message)
      : "message" in attribute
        ? h[attribute.name](attribute.message as Message)
        : "key" in attribute
          ? h.DataAttribute(attribute.key, attribute.value)
          : isBooleanAttribute(attribute.name)
            ? h[attribute.name](attribute.value === true)
            : isNumberAttribute(attribute.name)
              ? h[attribute.name](Number(attribute.value))
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

/** `RenderedApplication`'s `html` and `title`; lang, dir and canonical wait for the profile. */
export const RenderedType = Struct({ html: StringType, title: StringType });
/** The render errors a valid build can still meet at run time (`server.js`), by upstream tag. */
export const RenderErrorType = TaggedUnion({
  InvalidHydrationRoot: { rootKind: StringType },
  SerializationError: { message: StringType },
  /** The Flags did not survive their JSON round trip; upstream carries the cause, R its message. */
  FlagsEncodeError: { message: StringType },
});

/** Upstream's hydratable render of `body`, the reference for the render primitives. */
const upstreamRender = (body: HtmlValue, runtimeId: string, buildId: string) =>
  Effect.runSync(
    Effect.result(
      upstreamRenderToString(
        {
          init: () => ({ model: body }),
          view: <Message>(root: HtmlValue, h: HtmlBuilder<Message>): Document => {
            const node = toFoldkit(root, h);
            return { title: "", body: typeof node === "string" ? null : node };
          },
        },
        { runtimeId, buildId },
      ),
    ),
  );
export const RootKindOperation = Operation.make(
  SemanticRef.operation("reffect/foldkit-html.root-kind@1"),
  [HtmlType],
  StringType,
  (body) => body._tag,
).pipe(Operation.withCapabilities([HtmlCapability]));
export const RenderFailureOperation = Operation.make(
  SemanticRef.operation("reffect/foldkit-html.render-failure@1"),
  [HtmlType, StringType, StringType],
  UndefinedOr(StringType),
  (body, runtimeId, buildId) => {
    const result = upstreamRender(body, runtimeId, buildId);
    if (Result.isSuccess(result)) return undefined;
    const error = result.failure;
    return error._tag === "SerializationError" && error.cause instanceof Error
      ? error.cause.message
      : String(error);
  },
).pipe(Operation.withCapabilities([HtmlCapability]));
export const RenderOperation = Operation.make(
  SemanticRef.operation("reffect/foldkit-html.render@1"),
  [HtmlType, StringType, StringType],
  StringType,
  (body, runtimeId, buildId) => {
    const result = upstreamRender(body, runtimeId, buildId);
    return Result.isSuccess(result) ? result.success.html : "";
  },
).pipe(Operation.withCapabilities([HtmlCapability]));
export const isHtmlRenderOperation = (
  operation: AnyOperation,
): "kind" | "failure" | "render" | undefined =>
  operation === RootKindOperation
    ? "kind"
    : operation === RenderFailureOperation
      ? "failure"
      : operation === RenderOperation
        ? "render"
        : undefined;

/** How native lowering renders an Html operation, or undefined for any other operation. */
export type HtmlOperationKind =
  | { readonly _tag: "Text" }
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Element"; readonly shape: ElementShape }
  | { readonly _tag: "RootKind" }
  | { readonly _tag: "RenderFailure" }
  | { readonly _tag: "Render" }
  | { readonly _tag: "JsonText" }
  | { readonly _tag: "JsonRoundTrip" };
export const htmlOperationKind = (operation: AnyOperation): HtmlOperationKind | undefined => {
  const shape = elementShapes.get(operation);
  if (shape) return { _tag: "Element", shape };
  if (operation === TextOperation) return { _tag: "Text" };
  if (operation === EmptyOperation) return { _tag: "Empty" };
  if (operation === RootKindOperation) return { _tag: "RootKind" };
  if (operation === RenderFailureOperation) return { _tag: "RenderFailure" };
  if (operation === RenderOperation) return { _tag: "Render" };
  if (operation === JsonTextOperation) return { _tag: "JsonText" };
  if (operation === JsonRoundTripOperation) return { _tag: "JsonRoundTrip" };
  return undefined;
};

/** `JSON.stringify` of decoded JSON data: the text of the Flags payload (M9-1). */
export const JsonTextOperation = Operation.make(
  SemanticRef.operation("reffect/json.stringify@1"),
  [UnknownType],
  StringType,
  (value) => JSON.stringify(value),
).pipe(Operation.withCapabilities([HtmlCapability]));

/**
 * `JSON.parse(JSON.stringify(value))` of encoded JSON data: what the hydrating client reads back
 * from the Flags payload. For `Schema.toCodecJson` output it changes only `-0` into `0`.
 */
export const JsonRoundTripOperation = Operation.make(
  SemanticRef.operation("reffect/json.round-trip@1"),
  [UnknownType],
  UnknownType,
  (value) => JSON.parse(JSON.stringify(value)),
).pipe(Operation.withCapabilities([HtmlCapability]));
