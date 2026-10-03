/**
 * The todo domain, shared by the browser client and both servers: ordinary Foldkit Entity,
 * Query and Mutation declarations, with nothing native-specific in them.
 */
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Entity, Order } from "foldkit-entity";
import { Mutation, Query, Remote } from "foldkit-remote";
import { Surface } from "foldkit-surface";

export const Todo = Entity.define(
  "Todo",
  Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean }),
);
export const Todos = Query.define("Todos", {}, () =>
  Query.from(Todo).pipe(Query.orderBy(Order.asc(Todo.fields.title))),
);
export const AddTodo = Mutation.make("AddTodo", {
  Input: { id: Schema.String, title: Schema.String },
  Output: { id: Schema.String },
});
// The server reads the stored todo and flips it, so the client sends only which one.
export const ToggleTodo = Mutation.make("ToggleTodo", {
  Input: { id: Schema.String },
  Output: {},
});
export const DeleteTodo = Mutation.make("DeleteTodo", {
  Input: { id: Schema.String },
  Output: {},
});

const Model = Schema.Struct({ remote: Remote.Model });
export type Model = typeof Model.Type;
const App = Surface.application({ Model, Message: defineMessageUnion({ ...Remote.messages }) });
export const Data = Remote.make({
  model: App.model.remote,
  entities: [Todo],
  queries: [Todos],
  mutations: [AddTodo, ToggleTodo, DeleteTodo],
});
export const initial: Model = { remote: Remote.initial };
export const rows = {
  Todo: [
    { id: "t1", title: "Write the domain", done: true },
    { id: "t2", title: "Compile it natively", done: false },
  ],
};
