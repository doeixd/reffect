import { Effect, Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import type { Document, HtmlBuilder } from "foldkit/html";
import { renderToString } from "foldkit/experimental/server";
import { expect, test } from "vite-plus/test";
import { CompileError, R, Reference } from "../src/index.ts";
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

const view = R.fn([Model], H.Document, (model) =>
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
  }),
);

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

test("the profile refuses what it does not admit", () => {
  expect(() => H.div([H.Class("a"), H.Class("b")])).toThrow(CompileError);
  expect(() => H.DataAttribute("Bad Key", "x")).toThrow(CompileError);
});
