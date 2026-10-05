import { Effect, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import type { Document, HtmlBuilder } from "foldkit/html";
import { renderToString } from "foldkit/experimental/server";
import { expect, test } from "vite-plus/test";
import { CompileError, Expr, R, Reference } from "../src/index.ts";
import type { Value } from "../src/index.ts";

// SSR-009 step 2: an R view, run by the reference and handed to Foldkit as a view, renders through
// upstream renderToString exactly as the same view written against Foldkit's `h` does.
const H = R.Html;
const Todo = R.Struct({ id: R.String, title: R.String, done: R.Bool });
const Model = R.Struct({ heading: R.String, todos: R.Array(Todo) });
type Model = Value<typeof Model>;
const Message = defineMessageUnion({
  ClickedToggle: { id: Schema.String },
  SubmittedDraft: {},
});
type Message = typeof Message.Type;

// The view body is build-time TypeScript, so the page below can reuse it.
const viewBody = (model: Expr<Model>) =>
  H.Document.make({
    title: R.Struct.get(model, "heading"),
    body: H.main(
      [H.Class("app")],
      [
        H.h1([], [R.Struct.get(model, "heading")]),
        H.ul(
          [H.Id("todos")],
          R.Array.map(R.Struct.get(model, "todos"), (todo) =>
            H.li(
              [
                H.Key(R.Struct.get(todo, "id")),
                H.Class("item"),
                H.DataAttribute("todo-id", R.Struct.get(todo, "id")),
              ],
              [
                H.input([H.Type("checkbox"), H.Checked(R.Struct.get(todo, "done"))]),
                H.span(
                  [
                    H.Title(R.Struct.get(todo, "title")),
                    H.OnClick(H.message(Message.ClickedToggle, { id: R.Struct.get(todo, "id") })),
                  ],
                  [R.Struct.get(todo, "title")],
                ),
              ],
            ),
          ),
        ),
        H.empty,
        "Footer & <text>",
        H.a([H.Href('/about?x=1&y="2"')], ["About"]),
        H.form([H.OnSubmit(H.message(Message.SubmittedDraft, {}))], [H.button([], ["Add"])]),
      ],
    ),
  });
const view = R.fn([Model], H.Document, viewBody);

/** The same view written directly against Foldkit's builder. */
const handWritten = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.heading,
  body: h.main(
    [h.Class("app")],
    [
      h.h1([], [model.heading]),
      h.ul(
        [h.Id("todos")],
        model.todos.map((todo) =>
          h.li(
            [h.Key(todo.id), h.Class("item"), h.DataAttribute("todo-id", todo.id)],
            [
              h.input([h.Type("checkbox"), h.Checked(todo.done)]),
              h.span(
                [h.Title(todo.title), h.OnClick(Message.ClickedToggle({ id: todo.id }))],
                [todo.title],
              ),
            ],
          ),
        ),
      ),
      h.empty,
      "Footer & <text>",
      h.a([h.Href('/about?x=1&y="2"')], ["About"]),
      h.form([h.OnSubmit(Message.SubmittedDraft())], [h.button([], ["Add"])]),
    ],
  ),
});

const models: ReadonlyArray<Model> = [
  { heading: "Todos", todos: [] },
  {
    heading: `Café "&" <ünïcode> 😀`,
    todos: [
      { id: "t1", title: "Write the domain", done: true },
      { id: "t2", title: 'a&b<c>"d"\r', done: false },
    ],
  },
];

const render = (viewOf: (model: Model, h: HtmlBuilder<Message>) => Document, model: Model) =>
  Effect.runPromise(renderToString({ init: () => ({ model }), view: viewOf }, { buildId: "b" }));

test("an R view renders through renderToString as the hand-written Foldkit view", async () => {
  const fromR = H.toFoldkitView(view);
  for (const model of models) {
    const expected = await render(handWritten, model);
    expect(await render(fromR, model)).toEqual(expected);
  }
  // The comparison is not vacuous: keys, data attributes, booleans and escaping are all there.
  const rich = await render(fromR, models[1]!);
  expect(rich.html).toContain('data-foldkit-key="');
  expect(rich.html).toContain('data-todo-id="t2"');
  expect(rich.html).toContain('checked=""');
  expect(rich.html).toContain("a&amp;b&lt;c&gt;");
});

test("events construct the app's own Messages in the reference", async () => {
  const document = await Effect.runPromise(Reference.run(view, [models[1]!]));
  const messages: unknown[] = [];
  const collect = (value: typeof document.body): void => {
    if (value._tag !== "Element") return;
    for (const attribute of value.attributes)
      if ("message" in attribute) messages.push(attribute.message);
    value.children.forEach(collect);
  };
  collect(document.body);
  expect(messages).toEqual([
    Message.ClickedToggle({ id: "t1" }),
    Message.ClickedToggle({ id: "t2" }),
    Message.SubmittedDraft(),
  ]);
});

test("Message fields are checked against the variant's own schema", () => {
  const Wide = defineMessageUnion({ Picked: { id: Schema.String, count: Schema.Number } });
  const id = R.String.literal("x");
  expect(() => H.message(Wide.Picked, { id, count: R.Number.literal(1) })).not.toThrow();
  // @ts-expect-error count is missing
  expect(() => H.message(Wide.Picked, { id })).toThrow(CompileError);
  // @ts-expect-error count is a Number
  expect(() => H.message(Wide.Picked, { id, count: id })).toThrow(CompileError);
});

test("OnInput fills one String field of its Message with the input's value (#14)", async () => {
  const Edit = defineMessageUnion({
    Typed: { id: Schema.String, value: Schema.String },
    Counted: { count: Schema.Number },
  });
  const field = R.fn([R.String], H.Document, (id) =>
    H.Document.make({
      title: R.String.literal("t"),
      body: H.input([H.Id(id), H.OnInput(Edit.Typed, "value", { id })]),
    }),
  );
  const document = await Effect.runPromise(Reference.run(field, ["d1"]));
  const input = document.body._tag === "Element" ? document.body.attributes[1] : undefined;
  if (!input || !("toMessage" in input)) throw new Error("Missing OnInput attribute");
  expect(input.toMessage("hello")).toEqual(Edit.Typed({ id: "d1", value: "hello" }));
  // The value fills a String field; Counted's count is a Number.
  expect(() => H.OnInput(Edit.Counted, "count")).toThrow(CompileError);
  // No trace in server HTML: todo-remote-page renders its draft input natively equal to upstream.
});

test("the profile refuses what it does not admit", () => {
  expect(() => H.div([H.Class("a"), H.Class("b")])).toThrow(CompileError);
  expect(() => H.DataAttribute("Bad Key", "x")).toThrow(CompileError);
});

// renderToString in R: its reference is upstream renderToString, and its outcome is typed.
const page = R.fn([Model], R.Result(H.Rendered, H.RenderError), (model) =>
  H.renderToString(viewBody(model), { buildId: "b" }),
);
const titleOnly = R.fn([R.String], R.Result(H.Rendered, H.RenderError), (text) =>
  H.renderToString(H.Document.make({ title: text, body: H.text(text) }), { buildId: "b" }),
);
const emptyBody = R.fn([R.String], R.Result(H.Rendered, H.RenderError), (text) =>
  H.renderToString(H.Document.make({ title: text, body: H.empty }), { buildId: "b" }),
);
const nulInside = R.fn([R.String], R.Result(H.Rendered, H.RenderError), (text) =>
  H.renderToString(H.Document.make({ title: R.String.literal("t"), body: H.p([], [text]) }), {
    buildId: "b",
  }),
);

test("R.Html.renderToString answers as upstream renderToString", async () => {
  for (const model of models) {
    const expected = await render(handWritten, model);
    expect(await Effect.runPromise(Reference.run(page, [model]))).toEqual({
      _tag: "Success",
      success: { html: expected.html, title: expected.title },
    });
  }
  expect(await Effect.runPromise(Reference.run(titleOnly, ["x"]))).toEqual({
    _tag: "Failure",
    failure: { _tag: "InvalidHydrationRoot", rootKind: "Text" },
  });
  expect(await Effect.runPromise(Reference.run(emptyBody, ["x"]))).toEqual({
    _tag: "Failure",
    failure: { _tag: "InvalidHydrationRoot", rootKind: "Empty" },
  });
  expect(await Effect.runPromise(Reference.run(nulInside, ["a\u0000b"]))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "SerializationError", message: expect.stringContaining("NUL") },
  });
  expect(() =>
    H.renderToString(H.Document.make({ title: R.String.literal("t"), body: H.empty }), {
      buildId: "",
    }),
  ).toThrow(CompileError);
});

test("reserved hydration marker names are refused, as upstream refuses them (#22)", async () => {
  for (const key of [
    "foldkit-app",
    "foldkit-build",
    "foldkit-flags",
    "foldkit-key",
    "foldkit-identity",
  ]) {
    // Upstream fails the render once the view authors the marker.
    const upstream = await Effect.runPromise(
      renderToString(
        {
          init: () => ({ model: {} }),
          view: (_model: object, h: HtmlBuilder<never>): Document => ({
            title: "t",
            body: h.div([h.DataAttribute(key, "x")], []),
          }),
        },
        { buildId: "b" },
      ).pipe(Effect.flip),
    );
    expect(String(upstream.cause), key).toContain("reserved");
    expect(() => H.DataAttribute(key, "x"), key).toThrow(CompileError);
    expect(() => H.DataAttribute(key, "x"), key).toThrow(`data-${key}`);
  }
  // Other foldkit-looking keys stay available.
  expect(H.DataAttribute("foldkit-note", "x").name).toBe("DataAttribute");
});

test("Value outside button and input is refused rather than silently dropped (#24)", async () => {
  // Upstream writes li's value as a number and refuses a non-numeric one; the profile refuses both.
  const upstream = await Effect.runPromise(
    renderToString(
      {
        init: () => ({ model: {} }),
        view: (_model: object, h: HtmlBuilder<never>): Document => ({
          title: "t",
          body: h.ul([], [h.li([h.Value("3")], [])]),
        }),
      },
      { buildId: "b" },
    ),
  );
  expect(upstream.html).toContain('<li value="3">');
  expect(() => H.li([H.Value("3")], [])).toThrow(CompileError);
  expect(() => H.p([H.Value("x")], [])).toThrow("Value");
  expect(() => H.input([H.Value("x")])).not.toThrow();
  expect(() => H.button([H.Value("x")], [])).not.toThrow();
});

test("nesting the HTML parser would rearrange is refused exactly where upstream refuses it (#23)", async () => {
  const builders = {
    a: H.a,
    button: H.button,
    div: H.div,
    form: H.form,
    h1: H.h1,
    h2: H.h2,
    li: H.li,
    p: H.p,
    span: H.span,
    ul: H.ul,
  };
  type Shape = readonly [keyof typeof builders, ReadonlyArray<Shape>];
  const cases: ReadonlyArray<Shape> = [
    ["p", [["div", []]]],
    ["p", [["span", [["div", []]]]]],
    ["p", [["button", [["div", []]]]]],
    ["p", [["span", []]]],
    ["a", [["a", []]]],
    ["a", [["span", [["a", []]]]]],
    ["form", [["div", [["form", []]]]]],
    ["button", [["button", []]]],
    ["h1", [["h2", []]]],
    ["h1", [["span", [["h2", []]]]]],
    ["li", [["li", []]]],
    ["li", [["span", [["li", []]]]]],
    ["li", [["div", [["li", []]]]]],
    ["li", [["ul", [["li", []]]]]],
    [
      "div",
      [
        ["p", []],
        ["div", []],
      ],
    ],
  ];
  const native = ([tag, children]: Shape): Expr<Value<typeof H.Node>> =>
    builders[tag]([], children.map(native));
  for (const shape of cases) {
    const upstream = await Effect.runPromise(
      renderToString(
        {
          init: () => ({ model: {} }),
          view: (_model: object, h: HtmlBuilder<never>): Document => {
            const upstreamBuilders = {
              a: h.a,
              button: h.button,
              div: h.div,
              form: h.form,
              h1: h.h1,
              h2: h.h2,
              li: h.li,
              p: h.p,
              span: h.span,
              ul: h.ul,
            };
            const build = ([tag, children]: Shape): ReturnType<HtmlBuilder<never>["div"]> =>
              upstreamBuilders[tag]([], children.map(build));
            return { title: "t", body: h.main([], [build(shape)]) };
          },
        },
        { buildId: "b" },
      ).pipe(Effect.result),
    );
    const refused = (() => {
      try {
        native(shape);
        return false;
      } catch (error) {
        if (error instanceof CompileError) return true;
        throw error;
      }
    })();
    expect(refused, JSON.stringify(shape)).toBe(upstream._tag === "Failure");
  }
  // Reached through a mapped list or a branch, the nesting is refused as well.
  const items = R.Array.make(R.String.literal("x"));
  expect(() =>
    H.p(
      [],
      R.Array.map(items, () => H.div([], [])),
    ),
  ).toThrow("may contain <div>");
  expect(() =>
    H.li([], [R.Match.bool(R.Bool.literal(true), H.span([], []), H.li([], []))]),
  ).toThrow(CompileError);
});

test("textarea owns its content one way, and Tabindex is an integer the browser holds (8B)", async () => {
  // Upstream's builder throws on both owners; the profile refuses while authoring.
  const upstream = (body: (h: HtmlBuilder<never>) => ReturnType<HtmlBuilder<never>["div"]>) =>
    Effect.runPromise(
      renderToString(
        {
          init: () => ({ model: {} }),
          view: (_model: object, h: HtmlBuilder<never>): Document => ({
            title: "t",
            body: body(h),
          }),
        },
        { buildId: "b" },
      ),
    );
  // @ts-expect-error Foldkit's types forbid it too
  await expect(upstream((h) => h.textarea([h.Value("v")], ["child"]))).rejects.toThrow(
    "controlled value and children",
  );
  expect(() => H.textarea([H.Value("v")], ["child"])).toThrow("one owner");
  expect(() => H.textarea([], [H.span([], [])])).toThrow("text only");
  expect(() => H.textarea([H.Value("v")])).not.toThrow();
  // Upstream refuses a tabIndex the browser would read differently.
  await expect(upstream((h) => h.div([h.Tabindex(1.5)], []))).rejects.toThrow("tabIndex");
  for (const value of [1.5, Number.NaN, 2 ** 31, -(2 ** 31) - 1])
    expect(() => H.Tabindex(value)).toThrow("long range");
  expect(() => H.div([H.Tabindex(-(2 ** 31))], [])).not.toThrow();
});

test("select holds options and option text, as the controlled selection reads them (8B)", () => {
  expect(() => H.select([], [H.option([], ["a"]), H.option([H.Value("b")], ["b"])])).not.toThrow();
  expect(() => H.select([], ["text"])).toThrow("<option> elements only");
  expect(() => H.select([], [H.div([], [])])).toThrow("<option> elements only");
  expect(() => H.select([], [H.select([], [])])).toThrow("<option> elements only");
  expect(() => H.option([], [H.span([], [])])).toThrow("text only");
  expect(() => H.p([H.Value("x")], [])).toThrow("Value");
  expect(() => H.select([H.Value("x")], [])).not.toThrow();
});

test("InnerHTML is a markup-free literal that owns its element's content (8B)", () => {
  expect(() => H.pre([H.InnerHTML("\nleading")])).not.toThrow();
  expect(() => H.InnerHTML("<b>x</b>")).toThrow("without markup");
  expect(() => H.div([H.InnerHTML("x")], ["child"])).toThrow("whole content");
  expect(() => H.textarea([H.InnerHTML("x")])).toThrow("whole content");
  expect(() => H.option([H.InnerHTML("x")])).toThrow("whole content");
  expect(() => H.input([H.InnerHTML("x")])).toThrow("whole content");
});
