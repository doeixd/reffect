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
/** Attributes the profile refuses on an element because Foldkit's builder rejects most values. */
export const refusedOn = (tag: string, attribute: string): boolean =>
  attribute === "Value" && tag !== "button" && tag !== "input";

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

export const htmlRuntime =
  String.raw`${ssrSerializeRuntime}
#[allow(dead_code)]
pub mod foldkit_html {
    use super::foldkit_ssr;

    #[derive(Clone, Debug, PartialEq)]
    enum Kind { Element, Text, Empty }
    /// A serialized fragment, or the first serialization failure in document order.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Html { markup: String, kind: Kind, own_end: usize, error: Option<String> }
    pub enum Prop<'a> { Text(&'a str), Url(&'a str), Flag(bool) }

    pub fn empty() -> Html { Html { markup: String::new(), kind: Kind::Empty, own_end: 0, error: None } }
    pub fn text(value: &str) -> Html {
        let mut markup = String::new();
        let error = foldkit_ssr::escape_text(value, &mut markup).err();
        Html { markup, kind: Kind::Text, own_end: 0, error }
    }

    /// JS ` +
  "`\\s`" +
  String.raw`, which ` +
  "`\\s+`" +
  String.raw` splits class strings on.
    fn js_space(c: char) -> bool {
        matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    }
    /// A canonical array index, which JS objects order first, ascending.
    fn array_index(key: &str) -> Option<u32> {
        if key == "0" { return Some(0); }
        if key.is_empty() || key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) { return None; }
        key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
    }
    /// ` +
  "`classObjectFor`" +
  String.raw` then the class module: tokens as object keys, joined by a space.
    fn class_value(value: &str) -> Option<String> {
        let mut indexed: Vec<(u32, &str)> = Vec::new();
        let mut named: Vec<&str> = Vec::new();
        for token in value.split(js_space) {
            // An empty token is skipped; __proto__ is the object's prototype setter, not a key.
            if token.is_empty() || token == "__proto__" || indexed.iter().any(|(_, t)| *t == token) || named.contains(&token) { continue; }
            match array_index(token) { Some(index) => indexed.push((index, token)), None => named.push(token) }
        }
        indexed.sort_by_key(|(index, _)| *index);
        let tokens: Vec<&str> = indexed.into_iter().map(|(_, t)| t).chain(named).collect();
        if tokens.is_empty() { None } else { Some(tokens.join(" ")) }
    }
    /// ` +
  "`sanitizeUrl`" +
  String.raw`: a javascript: or vbscript: scheme, read past control characters, becomes "".
    fn sanitize_url(value: &str) -> &str {
        let stripped: String = value.chars().filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')).collect();
        let rest = stripped.trim_start_matches(js_space);
        let scheme_end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-')).unwrap_or(rest.len());
        let scheme = &rest[..scheme_end];
        let starts_alpha = scheme.chars().next().map(|c| c.is_ascii_alphabetic()).unwrap_or(false);
        if starts_alpha && rest[scheme_end..].trim_start_matches(js_space).starts_with(':') {
            let lower = scheme.to_ascii_lowercase();
            if lower == "javascript" || lower == "vbscript" { return ""; }
        }
        value
    }
    fn attribute(out: &mut String, name: &str, value: &str, error: &mut Option<String>) {
        out.push(' ');
        out.push_str(name);
        out.push_str("=\"");
        if let Err(message) = foldkit_ssr::escape_attribute(value, out) { error.get_or_insert(message); }
        out.push('"');
    }
    /// One element: data attributes, class, reflected props, then (later) root markers and its key.
    pub fn element(tag: &str, is_void: bool, data: &[(&str, &str)], class: Option<&str>, props: &[(&str, Prop)], key: Option<&str>, children: &[Html]) -> Html {
        let mut markup = String::new();
        let mut error: Option<String> = None;
        markup.push('<');
        markup.push_str(tag);
        for (name, value) in data { attribute(&mut markup, name, value, &mut error); }
        if let Some(value) = class.and_then(class_value) { attribute(&mut markup, "class", &value, &mut error); }
        for (name, prop) in props {
            match prop {
                Prop::Text(value) => attribute(&mut markup, name, value, &mut error),
                Prop::Url(value) => attribute(&mut markup, name, sanitize_url(value), &mut error),
                Prop::Flag(true) => attribute(&mut markup, name, "", &mut error),
                Prop::Flag(false) => {}
            }
        }
        let own_end = markup.len();
        if let Some(key) = key {
            markup.push_str(" data-foldkit-key=\"");
            markup.push_str(&foldkit_ssr::string_key_marker(key));
            markup.push('"');
        }
        markup.push('>');
        if !is_void {
            for child in children {
                if error.is_none() { if let Some(message) = &child.error { error = Some(message.clone()); } }
                markup.push_str(&child.markup);
            }
            markup.push_str("</");
            markup.push_str(tag);
            markup.push('>');
        }
        Html { markup, kind: Kind::Element, own_end, error }
    }
    /// Text as ` +
  "`escapeText`" +
  String.raw` writes it, or its NUL refusal; the page title goes through it.
    pub fn escape_text(value: &str) -> Result<String, String> {
        let mut out = String::new();
        foldkit_ssr::escape_text(value, &mut out).map(|()| out)
    }
    pub fn root_kind(body: &Html) -> String {
        match body.kind { Kind::Element => "Element", Kind::Text => "Text", Kind::Empty => "Empty" }.to_string()
    }
    /// The first serialization failure of a render: the body's, else a runtime/build id's.
    pub fn failure(body: &Html, runtime_id: &str, build_id: &str) -> Option<String> {
        render(body, runtime_id, build_id).err().map(|(_, message)| message)
    }
    pub fn render_html(body: &Html, runtime_id: &str, build_id: &str) -> String {
        render(body, runtime_id, build_id).unwrap_or_default()
    }
    /// ` +
  "`renderToString`" +
  String.raw` for a hydratable render: the root stamped, or why it cannot be.
    pub fn render(body: &Html, runtime_id: &str, build_id: &str) -> Result<String, (&'static str, String)> {
        match body.kind {
            Kind::Empty => return Err(("InvalidHydrationRoot", "Empty".to_string())),
            Kind::Text => return Err(("InvalidHydrationRoot", "Text".to_string())),
            Kind::Element => {}
        }
        if let Some(message) = &body.error { return Err(("SerializationError", message.clone())); }
        let mut stamp = String::new();
        let mut error = None;
        attribute(&mut stamp, "data-foldkit-app", runtime_id, &mut error);
        attribute(&mut stamp, "data-foldkit-build", build_id, &mut error);
        if let Some(message) = error { return Err(("SerializationError", message)); }
        let mut html = String::with_capacity(body.markup.len() + stamp.len());
        html.push_str(&body.markup[..body.own_end]);
        html.push_str(&stamp);
        html.push_str(&body.markup[body.own_end..]);
        Ok(html)
    }
}
`;

/** `JSON.stringify` for decoded JSON: serde's string escaping matches JS, and numbers are JS text. */
export const jsonTextRuntime = String.raw`
#[allow(dead_code)]
pub mod foldkit_json {
    /// What JSON.parse(JSON.stringify(value)) gives: numbers are written shortest and parsed
    /// back exactly, so only -0 changes, into 0.
    pub fn round_trip(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Number(number) if number.as_f64() == Some(0.0) => serde_json::Value::from(0u64),
            serde_json::Value::Array(items) => serde_json::Value::Array(items.iter().map(round_trip).collect()),
            serde_json::Value::Object(map) => serde_json::Value::Object(map.iter().map(|(key, item)| (key.clone(), round_trip(item))).collect()),
            other => other.clone(),
        }
    }
    pub fn json_text(value: &serde_json::Value) -> String {
        let mut out = String::new();
        write(value, &mut out);
        out
    }
    fn write(value: &serde_json::Value, out: &mut String) {
        match value {
            serde_json::Value::Null => out.push_str("null"),
            serde_json::Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
            serde_json::Value::Number(number) => match (number.as_i64(), number.as_u64(), number.as_f64()) {
                (Some(i), _, _) => out.push_str(&i.to_string()),
                (_, Some(u), _) => out.push_str(&u.to_string()),
                (_, _, Some(x)) => out.push_str(ryu_js::Buffer::new().format(x)),
                _ => out.push_str("null"),
            },
            serde_json::Value::String(text) => out.push_str(&serde_json::to_string(text).unwrap()),
            serde_json::Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() { if i > 0 { out.push(','); } write(item, out); }
                out.push(']');
            }
            serde_json::Value::Object(map) => {
                out.push('{');
                for (i, (key, item)) in map.iter().enumerate() {
                    if i > 0 { out.push(','); }
                    out.push_str(&serde_json::to_string(key).unwrap());
                    out.push(':');
                    write(item, out);
                }
                out.push('}');
            }
        }
    }
}
`;
