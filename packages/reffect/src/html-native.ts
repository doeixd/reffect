/**
 * Native rendering of the 8A `R.Html` profile (milestone 8A step 3). A port of what foldkit
 * 0.165.0 does to the admitted attributes, measured against `renderToString` (native-ssr.md):
 *
 * - `html/index.js`: `classObjectFor` (split on JS `\s+`, object-key order) and `sanitizeUrl`
 *   for `Href`; every other admitted attribute becomes a prop, `DataAttribute` an attr.
 * - `experimental/server/serialize.js`: attrs, then class, then props in authored order, only
 *   the props an element reflects; booleans as `""` or absent; void elements; root markers after
 *   the root's own attributes and before its key marker.
 * - `experimental/server/server.js`: `InvalidHydrationRoot` before serialization; the first
 *   serialization failure in document order.
 */
import { runtimeModule } from "./runtime-module.ts";
import { ssrSerializeRuntime } from "./ssr-serialize.ts";
import type { ElementShape } from "./html.ts";
import { isBooleanAttribute } from "./html-ir.ts";

/** The props each admitted element reflects, as `renderToString` keeps them (probed upstream). */
const REFLECTED: Readonly<Record<string, ReadonlyArray<string> | "all">> = {
  Id: "all",
  Title: "all",
  Href: ["a"],
  Type: ["a", "button", "li", "ol", "ul", "input"],
  Name: ["a", "button", "form", "input", "select", "textarea"],
  Placeholder: ["input", "textarea"],
  For: ["label"],
  // A textarea's Value is its content, written by `Prop::Content` rather than reflected.
  Value: ["button", "input", "option"],
  Checked: ["input"],
  Disabled: ["button", "input", "option", "select", "textarea"],
  Selected: ["option"],
  Autofocus: "all",
  Tabindex: "all",
};
const ATTRIBUTE_NAME: Readonly<Record<string, string>> = {
  Id: "id",
  Title: "title",
  Href: "href",
  Type: "type",
  Name: "name",
  Placeholder: "placeholder",
  For: "for",
  Value: "value",
  Checked: "checked",
  Disabled: "disabled",
  Selected: "selected",
  Autofocus: "autofocus",
  Tabindex: "tabindex",
};
/** Whether `renderToString` writes this prop on this element. */
export const reflects = (tag: string, attribute: string): boolean => {
  const tags = REFLECTED[attribute];
  return tags === "all" || (tags !== undefined && tags.includes(tag));
};

const rustString = (value: string): string => JSON.stringify(value);

/**
 * The Rust call building one element of `shape`. `args` are the lowered argument expressions in
 * operation order; event Message fields are reference-only and are not evaluated here.
 */
export const elementCall = <T>(
  shape: ElementShape,
  args: ReadonlyArray<T>,
): ReadonlyArray<string | T> => {
  let next = 0;
  const data: Array<string | T> = [];
  const props: Array<string | T> = [];
  let classArg: T | undefined;
  let keyArg: T | undefined;
  for (const attribute of shape.attributes) {
    if ("variant" in attribute) {
      next += attribute.fields.length;
      continue;
    }
    const arg = args[next++]!;
    if ("key" in attribute)
      data.push(`(${rustString(`data-${attribute.key}`)}, &(`, arg, ")[..]), ");
    // A raw attribute, with the attrs in authored order: `true` or `false`, always written.
    else if (attribute.name === "AriaDisabled")
      data.push('("aria-disabled", if ', arg, ' { "true" } else { "false" }), ');
    else if (attribute.name === "Key") keyArg = arg;
    else if (attribute.name === "Class") classArg = arg;
    else if (attribute.name === "Value" && shape.tag === "textarea")
      props.push('("value", crate::foldkit_html::Prop::Content(&(', arg, ")[..])), ");
    else if (attribute.name === "Value" && shape.tag === "select")
      props.push('("value", crate::foldkit_html::Prop::Selection(&(', arg, ")[..])), ");
    else if (!reflects(shape.tag, attribute.name)) continue;
    // Authoring admits only literal integers in the browser's long range, so the text is exact.
    else if (attribute.name === "Tabindex")
      props.push(
        '("tabindex", crate::foldkit_html::Prop::Text(&((',
        arg,
        ") as i64).to_string()[..])), ",
      );
    else if (isBooleanAttribute(attribute.name))
      props.push(
        `(${rustString(ATTRIBUTE_NAME[attribute.name]!)}, crate::foldkit_html::Prop::Flag(matches!(`,
        arg,
        ", true))), ",
      );
    else if (attribute.name === "Href")
      props.push('("href", crate::foldkit_html::Prop::Url(&(', arg, ")[..])), ");
    else
      props.push(
        `(${rustString(ATTRIBUTE_NAME[attribute.name]!)}, crate::foldkit_html::Prop::Text(&(`,
        arg,
        ")[..])), ",
      );
  }
  return [
    `crate::foldkit_html::element(${rustString(shape.tag)}, ${shape.isVoid}, &[`,
    ...data,
    "], ",
    ...(classArg === undefined ? ["None"] : ["Some(&(", classArg, ")[..])"]),
    ", &[",
    ...props,
    "], ",
    ...(keyArg === undefined ? ["None"] : ["Some(&(", keyArg, ")[..])"]),
    ", &(",
    args[next]!,
    "))",
  ];
};

export const htmlRuntime = `${ssrSerializeRuntime}${runtimeModule("foldkit_html", "pub")}`;

/** `JSON.stringify` for decoded JSON: serde's string escaping matches JS, and numbers are JS text. */
export const jsonTextRuntime = runtimeModule("foldkit_json", "pub");
