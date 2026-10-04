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

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const items = Match.value(list.read(model)).pipe(
    Match.tag("Ready", ({ value }) =>
      value.items.length === 0
        ? [h.p([h.Class("empty")], ["Nothing to do."])]
        : [
            h.ul(
              [h.Id("todos")],
              value.items.map((todo) => {
                const id = todo.id;
                return h.li(
                  [h.Class(todo.done ? "done" : "open"), h.DataAttribute("id", id)],
                  [
                    h.input([
                      h.Type("checkbox"),
                      h.Checked(todo.done),
                      h.OnClick(Message.ClickedToggle({ id })),
                    ]),
                    h.span([], [todo.title]),
                    h.button([h.OnClick(Message.ClickedDelete({ id }))], ["Delete"]),
                  ],
                );
              }),
            ),
          ],
    ),
    Match.orElse((other) => [h.p([h.Class("status")], [other._tag])]),
  );
  return {
    title: "Native Remote todos",
    body: h.main(
      [],
      [
        h.h1([], ["Todos"]),
        h.form(
          [h.OnSubmit(Message.SubmittedDraft())],
          [
            h.input([
              h.Id("draft"),
              h.Value(model.draft),
              h.Placeholder("What needs doing?"),
              h.OnInput((value) => Message.ChangedDraft({ value })),
            ]),
            h.button([h.Type("submit")], ["Add"]),
          ],
        ),
        ...items,
        h.p([h.Class("note")], ["Served by a native Rust Foldkit Remote server."]),
      ],
    ),
  };
};
