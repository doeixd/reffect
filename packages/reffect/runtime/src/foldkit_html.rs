use super::foldkit_ssr;

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Element,
    Text,
    Empty,
}
/// A serialized fragment, or the first serialization failure in document order. Children are
/// shared, not copied, and the document is written once when rendered (#34): copying each
/// child's markup into its parent cost O(size x depth).
#[derive(Clone, Debug, PartialEq)]
pub struct Html(std::sync::Arc<Node>);
#[derive(Debug, PartialEq)]
struct Node {
    kind: Kind,
    /// The opening tag, or a text's escaped content; its own attributes end at `own_end`.
    head: String,
    own_end: usize,
    children: Vec<Html>,
    /// The closing tag, if any.
    tail: String,
    /// The serialized length of the whole fragment.
    len: usize,
    error: Option<String>,
}
impl Drop for Node {
    /// Unlinks a deep tree with a stack: the derived drop would recurse once per level.
    fn drop(&mut self) {
        let mut pending = std::mem::take(&mut self.children);
        while let Some(child) = pending.pop() {
            if let Ok(mut node) = std::sync::Arc::try_unwrap(child.0) {
                pending.append(&mut node.children);
            }
        }
    }
}
fn leaf(kind: Kind, head: String, error: Option<String>) -> Html {
    Html(std::sync::Arc::new(Node {
        kind,
        len: head.len(),
        head,
        own_end: 0,
        children: Vec::new(),
        tail: String::new(),
        error,
    }))
}
pub enum Prop<'a> {
    Text(&'a str),
    Url(&'a str),
    Flag(bool),
    /// A textarea's controlled `value`, serialized as its text content.
    Content(&'a str),
}

pub fn empty() -> Html {
    leaf(Kind::Empty, String::new(), None)
}
pub fn text(value: &str) -> Html {
    let mut markup = String::new();
    let error = foldkit_ssr::escape_text(value, &mut markup).err();
    leaf(Kind::Text, markup, error)
}

/// JS `\s`, which `\s+` splits class strings on.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
/// A canonical array index, which JS objects order first, ascending.
fn array_index(key: &str) -> Option<u32> {
    if key == "0" {
        return Some(0);
    }
    if key.is_empty() || key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}
/// `classObjectFor` then the class module: tokens as object keys, joined by a space.
fn class_value(value: &str) -> Option<String> {
    let mut indexed: Vec<(u32, &str)> = Vec::new();
    let mut named: Vec<&str> = Vec::new();
    // A set, as object keys are: a linear search per token was O(n^2) (#34).
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for token in value.split(js_space) {
        // An empty token is skipped; __proto__ is the object's prototype setter, not a key.
        if token.is_empty() || token == "__proto__" || !seen.insert(token) {
            continue;
        }
        match array_index(token) {
            Some(index) => indexed.push((index, token)),
            None => named.push(token),
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    let tokens: Vec<&str> = indexed.into_iter().map(|(_, t)| t).chain(named).collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" "))
    }
}
/// `sanitizeUrl`: a javascript: or vbscript: scheme, read past control characters, becomes "".
fn sanitize_url(value: &str) -> &str {
    let stripped: String = value
        .chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
        .collect();
    let rest = stripped.trim_start_matches(js_space);
    let scheme_end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-'))
        .unwrap_or(rest.len());
    let scheme = &rest[..scheme_end];
    let starts_alpha = scheme
        .chars()
        .next()
        .map(|c| c.is_ascii_alphabetic())
        .unwrap_or(false);
    if starts_alpha
        && rest[scheme_end..]
            .trim_start_matches(js_space)
            .starts_with(':')
    {
        let lower = scheme.to_ascii_lowercase();
        if lower == "javascript" || lower == "vbscript" {
            return "";
        }
    }
    value
}
fn attribute(out: &mut String, name: &str, value: &str, error: &mut Option<String>) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    if let Err(message) = foldkit_ssr::escape_attribute(value, out) {
        error.get_or_insert(message);
    }
    out.push('"');
}
/// One element: data attributes, class, reflected props, then (later) root markers and its key.
pub fn element(
    tag: &str,
    is_void: bool,
    data: &[(&str, &str)],
    class: Option<&str>,
    props: &[(&str, Prop)],
    key: Option<&str>,
    children: &[Html],
) -> Html {
    let mut markup = String::new();
    let mut error: Option<String> = None;
    markup.push('<');
    markup.push_str(tag);
    for (name, value) in data {
        attribute(&mut markup, name, value, &mut error);
    }
    if let Some(value) = class.and_then(class_value) {
        attribute(&mut markup, "class", &value, &mut error);
    }
    // A textarea's controlled value is its content, which replaces its (empty) children.
    let mut content: Option<Html> = None;
    for (name, prop) in props {
        match prop {
            Prop::Text(value) => attribute(&mut markup, name, value, &mut error),
            Prop::Url(value) => attribute(&mut markup, name, sanitize_url(value), &mut error),
            Prop::Flag(true) => attribute(&mut markup, name, "", &mut error),
            Prop::Flag(false) => {}
            Prop::Content(value) => content = Some(text(value)),
        }
    }
    let content = content.map(|text| vec![text]);
    let children = content.as_deref().unwrap_or(children);
    let own_end = markup.len();
    if let Some(key) = key {
        markup.push_str(" data-foldkit-key=\"");
        markup.push_str(&foldkit_ssr::string_key_marker(key));
        markup.push('"');
    }
    markup.push('>');
    // The HTML parser drops one newline right after `<pre>` or `<textarea>`, so content that
    // starts with one gets another (serialize.js `leadingTextOf`): the first nonempty text,
    // unless an element comes first.
    if tag == "pre" || tag == "textarea" {
        let leading = children
            .iter()
            .find(|child| child.0.kind == Kind::Element || !child.0.head.is_empty());
        if leading.is_some_and(|child| child.0.kind == Kind::Text && child.0.head.starts_with('\n'))
        {
            markup.push('\n');
        }
    }
    let mut tail = String::new();
    let mut len = markup.len();
    let children = if is_void {
        Vec::new()
    } else {
        for child in children {
            if error.is_none() {
                if let Some(message) = &child.0.error {
                    error = Some(message.clone());
                }
            }
            len += child.0.len;
        }
        tail.push_str("</");
        tail.push_str(tag);
        tail.push('>');
        len += tail.len();
        children.to_vec()
    };
    Html(std::sync::Arc::new(Node {
        kind: Kind::Element,
        head: markup,
        own_end,
        children,
        tail,
        len,
        error,
    }))
}
/// A fragment's markup in document order, into `out`; an explicit stack, as views nest deeply.
fn write(root: &Html, out: &mut String) {
    enum Step<'a> {
        Open(&'a Html),
        Close(&'a str),
    }
    let mut stack = vec![Step::Open(root)];
    while let Some(step) = stack.pop() {
        match step {
            Step::Open(html) => {
                out.push_str(&html.0.head);
                stack.push(Step::Close(&html.0.tail));
                for child in html.0.children.iter().rev() {
                    stack.push(Step::Open(child));
                }
            }
            Step::Close(tail) => out.push_str(tail),
        }
    }
}
/// Text as `escapeText` writes it, or its NUL refusal; the page title goes through it.
pub fn escape_text(value: &str) -> Result<String, String> {
    let mut out = String::new();
    foldkit_ssr::escape_text(value, &mut out).map(|()| out)
}
pub fn root_kind(body: &Html) -> String {
    match body.0.kind {
        Kind::Element => "Element",
        Kind::Text => "Text",
        Kind::Empty => "Empty",
    }
    .to_string()
}
/// The first serialization failure of a render: the body's, else a runtime/build id's.
pub fn failure(body: &Html, runtime_id: &str, build_id: &str) -> Option<String> {
    // Checked without writing the document, which render_html then writes once (#34).
    stamp(body, runtime_id, build_id)
        .err()
        .map(|(_, message)| message)
}
pub fn render_html(body: &Html, runtime_id: &str, build_id: &str) -> String {
    render(body, runtime_id, build_id).unwrap_or_default()
}
/// `renderToString` for a hydratable render: the root stamped, or why it cannot be.
pub fn render(
    body: &Html,
    runtime_id: &str,
    build_id: &str,
) -> Result<String, (&'static str, String)> {
    let stamp = stamp(body, runtime_id, build_id)?;
    let root = &body.0;
    let mut html = String::with_capacity(root.len + stamp.len());
    html.push_str(&root.head[..root.own_end]);
    html.push_str(&stamp);
    html.push_str(&root.head[root.own_end..]);
    for child in &root.children {
        write(child, &mut html);
    }
    html.push_str(&root.tail);
    Ok(html)
}
/// The root markers a hydratable render stamps on its element, or why it cannot render.
fn stamp(body: &Html, runtime_id: &str, build_id: &str) -> Result<String, (&'static str, String)> {
    match body.0.kind {
        Kind::Empty => return Err(("InvalidHydrationRoot", "Empty".to_string())),
        Kind::Text => return Err(("InvalidHydrationRoot", "Text".to_string())),
        Kind::Element => {}
    }
    if let Some(message) = &body.0.error {
        return Err(("SerializationError", message.clone()));
    }
    let mut stamp = String::new();
    let mut error = None;
    attribute(&mut stamp, "data-foldkit-app", runtime_id, &mut error);
    attribute(&mut stamp, "data-foldkit-build", build_id, &mut error);
    match error {
        Some(message) => Err(("SerializationError", message)),
        None => Ok(stamp),
    }
}
