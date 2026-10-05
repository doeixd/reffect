/**
 * The todo list's first screen, rendered by the native server (milestone 9, M9-4). The page reads
 * the list through the server's own engine, renders the browser app's Ready view in R, and hands
 * the exchanges to the app's `init` in its Flags, so the browser adopts the HTML and starts
 * without fetching.
 *
 * The view mirrors `web/app.ts`'s for a Ready list; `page.test` compares the two renders byte for
 * byte. Event handlers render nothing on a server, so the mirror leaves them to the browser view.
 */
import { NativeRpc, R } from "../../packages/reffect/src/index.ts";
import type { Expr, Value } from "../../packages/reffect/src/index.ts";
import { PageSchema } from "../../packages/reffect/src/ssr-page.ts";
import { planPage } from "../../packages/reffect/src/remote-resume.ts";
import { BUILD_ID, Data, initial, list } from "./web/app.ts";

const H = R.Html;
const Todo = R.Struct({ id: R.String, title: R.String, done: R.Bool });
const Views = R.Struct({ todos: R.Remote.Page(Todo) });
const Flags = R.Struct({ remote: R.Unknown });
const ViewModel = R.Struct({ todos: R.Array(Todo) });

/** `web/app.ts`'s view of a Ready list with an empty draft. */
const view = (model: Expr<Value<typeof ViewModel>>) => {
  const todos = R.Struct.get(model, "todos");
  return H.Document.make({
    title: R.String.literal("Native Remote todos"),
    body: H.main(
      [],
      [
        H.h1([], ["Todos"]),
        H.form(
          [],
          [
            H.input([H.Id("draft"), H.Value(""), H.Placeholder("What needs doing?")]),
            H.button([H.Type("submit")], ["Add"]),
          ],
        ),
        R.Match.bool(
          R.Array.isArrayEmpty(todos),
          H.p([H.Class("empty")], ["Nothing to do."]),
          H.ul(
            [H.Id("todos")],
            R.Array.map(todos, (todo) => {
              const id = R.Struct.get(todo, "id");
              const done = R.Struct.get(todo, "done");
              return H.li(
                [
                  H.Class(R.Match.bool(done, R.String.literal("done"), R.String.literal("open"))),
                  H.DataAttribute("id", id),
                ],
                [
                  H.input([H.Type("checkbox"), H.Checked(done)]),
                  H.span([], [R.Struct.get(todo, "title")]),
                  H.button([], ["Delete"]),
                ],
              );
            }),
          ),
        ),
        H.p([H.Class("note")], ["Served by a native Rust Foldkit Remote server."]),
      ],
    ),
  });
};

/** What the page reads: its one view, the list's first page. */
export const plan = planPage({ todos: Data.prefetch(initial, list) });

const Page = NativeRpc.witness(PageSchema);
/** The page reads the exchanges it carries and the list it shows (#13). */
const PageRequest = R.Struct({ remote: R.Unknown, views: Views });
export const page = R.fn([PageRequest], Page, (request) => {
  const remote = R.Struct.get(request, "remote");
  const todos = request.pipe(R.Struct.get("views"), R.Struct.get("todos"), R.Struct.get("items"));
  return H.renderToString(
    { init: () => ViewModel.make({ todos }), view },
    { buildId: BUILD_ID, flags: Flags.make({ remote }) },
  );
});
