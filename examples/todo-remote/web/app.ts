/**
 * The todo list as an ordinary Foldkit application: Remote in the Model, a list read made active
 * while the app runs, and the three mutations started from `update`. The server renders its first
 * screen and hands over the Remote exchanges it read, which `init` replays, so the client starts
 * with the list instead of fetching it. Nothing in it knows that the server is native.
 */
import { Effect, Exit, Match, Option, Schema } from "effect";
import * as Command from "foldkit/command";
import type { Document, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import * as Subscription from "foldkit/subscription";
import type * as Update from "foldkit/update";
import { Entity } from "foldkit-entity";
import { Remote, type RemoteClient } from "foldkit-remote";
import { Projection, Surface } from "foldkit-surface";
import { RemoteResume, replay } from "../../../packages/reffect/src/remote-resume.ts";
import { R } from "../../../packages/reffect/src/authoring.ts";
import type { Expr, Value } from "../../../packages/reffect/src/kernel.ts";
import { AddTodo, DeleteTodo, Todo, Todos, ToggleTodo } from "../domain.ts";

/** The deployment the server's render and this client share. */
export const BUILD_ID = "todo-remote-1";
/** What the server's render hands over: the Remote exchanges it read. */
export const Flags = Schema.Struct({ remote: RemoteResume });
export type Flags = typeof Flags.Type;

export const Model = Schema.Struct({
  remote: Remote.Model,
  draft: Schema.String,
  // New ids are `${session}-${created}`: unique per tab without randomness in `update`. The
  // session arrives from a Command after start, so a server render never needs one.
  session: Schema.String,
  created: Schema.Number,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  GotRemoteMessage: { message: Remote.Message },
  ChangedDraft: { value: Schema.String },
  SubmittedDraft: {},
  ClickedToggle: { id: Schema.String },
  ClickedDelete: { id: Schema.String },
  GotSession: { session: Schema.String },
});
export type Message = typeof Message.Type;

const App = Surface.application({ Model, Message });
export const Data = Remote.make({
  model: App.model.remote,
  entities: [Todo],
  queries: [Todos],
  mutations: [AddTodo, ToggleTodo, DeleteTodo],
});
const foldData = Remote.fold(Data, (message) => Message.GotRemoteMessage({ message }));

export const list = Data.query(
  Todos,
  {},
  {
    select: Entity.select(Todo, { id: true, title: true, done: true }),
    // The server renders this list, so it reads a bounded page.
    first: 50,
  },
);
// The list is on screen whenever the app runs, so its read is always active.
const todos = Data.active("Todos", () => Option.some(list));
// Every todo on screen also follows changes made elsewhere. Foldkit subscribes live only for
// `Data.live` reads, so there is one per item; their patches update the entity store the list
// reads, so the list re-renders.
const followed = Entity.select(Todo, { title: true, done: true });
const liveTodos = Data.active("LiveTodos", (model: Model) =>
  Match.value(list.read(model)).pipe(
    Match.tag("Ready", ({ value }) =>
      value.items.length === 0
        ? Option.none()
        : Option.some(
            Projection.struct(
              Object.fromEntries(
                value.items.map((todo) => [todo.id, Data.live(followed, todo.id)]),
              ),
            ),
          ),
    ),
    Match.orElse(() => Option.none()),
  ),
);

export const initial: Model = { remote: Remote.initial, draft: "", session: "", created: 0 };
const MakeSession = Command.define("MakeSession", {
  messages: [Message.GotSession],
  execute: Effect.sync(() => Message.GotSession({ session: crypto.randomUUID().slice(0, 8) })),
});
/**
 * Replays the server's exchanges through `Data.satisfy`, as the server's own read did, so the
 * first render matches the server's. Should a request be missing, the app starts empty and its
 * read entry fetches as usual.
 */
export const init = (flags: Flags): Update.Return<Model, Message, RemoteClient> => {
  const resumed = Effect.runSyncExit(
    Data.satisfy(initial, { todos }, { now: () => flags.remote.now }).pipe(
      Effect.provide(replay(flags.remote.exchanges)),
    ),
  );
  return {
    model: Exit.isSuccess(resumed) ? resumed.value : initial,
    commands: [MakeSession()],
  };
};

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message, RemoteClient> =>
  Message.match(message, {
    GotRemoteMessage: ({ message }) => foldData(model, message),
    ChangedDraft: ({ value }) => ({ model: { ...model, draft: value } }),
    GotSession: ({ session }) => ({ model: { ...model, session } }),
    SubmittedDraft: () => {
      const title = model.draft.trim();
      if (title === "" || model.session === "") return { model };
      const id = `${model.session}-${model.created + 1}`;
      const started = foldData.mutate(model, AddTodo, { id, title });
      return {
        model: { ...started.model, draft: "", created: model.created + 1 },
        commands: [started.command],
      };
    },
    ClickedToggle: ({ id }) => {
      const started = foldData.mutate(model, ToggleTodo, { id });
      return { model: started.model, commands: [started.command] };
    },
    ClickedDelete: ({ id }) => {
      const started = foldData.mutate(model, DeleteTodo, { id });
      return { model: started.model, commands: [started.command] };
    },
  });

export const subscriptions = Subscription.make<Model, Message, RemoteClient>()(() =>
  foldData.subscriptions({ todos, liveTodos }),
);

/**
 * The app's one view, in R (#14): the browser runs it through `R.Html.toFoldkitView`, and the
 * native server renders the same function for the first screen (`page.ts`). It reads a small view
 * model: the draft, the list read's state, and the todos when it is Ready.
 */
const H = R.Html;
const TodoView = R.Struct({ id: R.String, title: R.String, done: R.Bool });
export const ViewModel = R.Struct({ draft: R.String, status: R.String, todos: R.Array(TodoView) });
export const screenDocument = (screen: Expr<Value<typeof ViewModel>>) => {
  const todos = R.Struct.get(screen, "todos");
  const status = R.Struct.get(screen, "status");
  return H.Document.make({
    title: R.String.literal("Native Remote todos"),
    body: H.main(
      [],
      [
        H.h1([], ["Todos"]),
        H.form(
          [H.OnSubmit(H.message(Message.SubmittedDraft, {}))],
          [
            H.input([
              H.Id("draft"),
              H.Value(R.Struct.get(screen, "draft")),
              H.Placeholder("What needs doing?"),
              H.OnInput(Message.ChangedDraft, "value"),
            ]),
            H.button([H.Type("submit")], ["Add"]),
          ],
        ),
        R.Match.bool(
          R.String.eq(status, R.String.literal("Ready")),
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
                    H.input([
                      H.Type("checkbox"),
                      H.Checked(done),
                      H.OnClick(H.message(Message.ClickedToggle, { id })),
                    ]),
                    H.span([], [R.Struct.get(todo, "title")]),
                    H.button([H.OnClick(H.message(Message.ClickedDelete, { id }))], ["Delete"]),
                  ],
                );
              }),
            ),
          ),
          H.p([H.Class("status")], [status]),
        ),
        H.p([H.Class("note")], ["Served by a native Rust Foldkit Remote server."]),
      ],
    ),
  });
};
export const screen = R.fn([ViewModel], H.Document, screenDocument);
const screenView = R.Html.toFoldkitView(screen);
/** The view model of a Model: what the R view reads of it. */
const viewModel = (model: Model): Value<typeof ViewModel> => {
  const read = list.read(model);
  return {
    draft: model.draft,
    status: read._tag,
    todos: read._tag === "Ready" ? read.value.items : [],
  };
};
export const view = (model: Model, h: HtmlBuilder<Message>): Document =>
  screenView(viewModel(model), h);
