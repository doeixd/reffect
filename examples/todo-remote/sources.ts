/**
 * The mutation sources, authored in R: what `RemoteServer.memory`'s `mutations` would be in
 * JavaScript, compiled into the native server.
 */
import { NativeRemote, R } from "../../packages/reffect/src/index.ts";
import { AddTodo, DeleteTodo, ToggleTodo, Todo, Todos } from "./domain.ts";

const text = (value: string) => R.literal(R.String, value);
const todoRef = (id: ReturnType<typeof text>) =>
  NativeRemote.Ref.make({ entity: text("Todo"), id });
// The one list the client shows; `Todos` has no input.
const allTodos = NativeRemote.connection(Todos, R.Struct({}).make({}));
const NewTodo = R.Struct({ title: R.String, done: R.Bool });
const Done = R.Struct({ done: R.Bool });

export const addTodo = NativeRemote.mutation(AddTodo, ({ input }) => {
  const id = R.Struct.get(input, "id");
  const title = R.Struct.get(input, "title");
  const values = NewTodo.make({ title, done: R.Bool.literal(false) });
  return R.Match.bool(
    R.String.eq(title, text("")),
    R.Effect.fail(NativeRemote.ServerError.make({ message: text("A todo needs a title") })),
    R.Effect.flatMap(R.RemoteStore.write("Todo", id, values), () =>
      R.Effect.succeed(
        NativeRemote.outcome(AddTodo).make({
          output: R.Struct({ id: R.String }).make({ id }),
          entities: R.Array.make(NativeRemote.patch(Todo, id, values)),
          connections: R.Array.make(NativeRemote.append(allTodos, todoRef(id))),
        }),
      ),
    ),
  );
});

export const toggleTodo = NativeRemote.mutation(ToggleTodo, ({ input }) => {
  const id = R.Struct.get(input, "id");
  const values = Done.make({ done: R.Struct.get(input, "done") });
  return R.Effect.flatMap(R.RemoteStore.write("Todo", id, values), () =>
    R.Effect.succeed(
      NativeRemote.outcome(ToggleTodo).make({
        output: R.Struct({}).make({}),
        entities: R.Array.make(NativeRemote.patch(Todo, id, values)),
      }),
    ),
  );
});

export const deleteTodo = NativeRemote.mutation(DeleteTodo, ({ input }) => {
  const id = R.Struct.get(input, "id");
  return R.Effect.flatMap(R.RemoteStore.remove("Todo", id), () =>
    R.Effect.succeed(
      NativeRemote.outcome(DeleteTodo).make({
        output: R.Struct({}).make({}),
        connections: R.Array.make(NativeRemote.remove(allTodos, todoRef(id))),
        deleted: R.Array.make(todoRef(id)),
      }),
    ),
  );
});

export const mutations = [addTodo, toggleTodo, deleteTodo];
