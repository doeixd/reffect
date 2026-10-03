/**
 * The todo view of the SSR tests: one R view that the native server renders, upstream
 * `renderToString` renders through the reference, and the stock Foldkit client hydrates.
 */
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { NativeRpc, R } from "../../src/index.ts";
import type { Expr, Value } from "../../src/index.ts";

const H = R.Html;
export const BUILD_ID = "build-1";
export const TodoSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.Boolean,
});
export const ModelSchema = Schema.Struct({
  heading: Schema.String,
  todos: Schema.Array(TodoSchema),
});
export const Model = NativeRpc.witness(ModelSchema);
export type Model = typeof ModelSchema.Type;
export const Message = defineMessageUnion({ Toggled: { id: Schema.String } });
export type Message = typeof Message.Type;

/** `RenderedApplication`'s fields, or the render error, as the RPC contract carries them. */
export const PageSchema = Schema.Union([
  Schema.TaggedStruct("Success", {
    success: Schema.Struct({ html: Schema.String, title: Schema.String }),
  }),
  Schema.TaggedStruct("Failure", {
    failure: Schema.Union([
      Schema.TaggedStruct("InvalidHydrationRoot", { rootKind: Schema.String }),
      Schema.TaggedStruct("SerializationError", { message: Schema.String }),
    ]),
  }),
]);
export const Page = R.Result(H.Rendered, H.RenderError);

/** The document of a model: a heading and a keyed list whose items toggle on click. */
export const todoDocument = (model: Expr<Value<typeof Model>>) =>
  H.Document.make({
    title: R.Struct.get(model, "heading"),
    body: H.main(
      [H.Class("app"), H.Id("root")],
      [
        H.h1([], [R.Struct.get(model, "heading")]),
        H.ul(
          [],
          R.Array.map(R.Struct.get(model, "todos"), (todo) =>
            H.li(
              [
                H.Key(R.Struct.get(todo, "id")),
                H.DataAttribute("id", R.Struct.get(todo, "id")),
                H.OnClick(H.message(Message.Toggled, { id: R.Struct.get(todo, "id") })),
              ],
              [
                H.input([H.Type("checkbox"), H.Checked(R.Struct.get(todo, "done"))]),
                H.span([H.Title(R.Struct.get(todo, "title"))], [R.Struct.get(todo, "title")]),
              ],
            ),
          ),
        ),
        "tail & <text>",
      ],
    ),
  });
export const todoView = R.fn([Model], H.Document, todoDocument);
export const todoPage = R.fn([Model], Page, (model) =>
  H.renderToString(todoDocument(model), { buildId: BUILD_ID }),
);
