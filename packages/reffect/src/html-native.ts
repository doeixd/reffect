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

/** The props each admitted element reflects, as `renderToString` keeps them (probed upstream). */
const REFLECTED: Readonly<Record<string, ReadonlyArray<string> | "all">> = {
  Id: "all",
  Title: "all",
  Href: ["a"],
  Type: ["a", "button", "li", "ol", "ul", "input"],
  Name: ["a", "button", "form", "input"],
  Placeholder: ["input"],
  For: ["label"],
  Value: ["button", "input"],
  Checked: ["input"],
  Disabled: ["button", "input"],
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
    else if (attribute.name === "Key") keyArg = arg;
    else if (attribute.name === "Class") classArg = arg;
    else if (!reflects(shape.tag, attribute.name)) continue;
    else if (attribute.name === "Checked" || attribute.name === "Disabled")
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
