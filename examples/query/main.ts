import { Effect, FileSystem, Schema } from "effect";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Entity, Expr, Order, Query, evaluate } from "foldkit-entity";
import { Foldkit } from "reffect";

const Post = Entity.define(
  "Post",
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    rank: Schema.Number,
  }),
);
const search = Query.from(Post).pipe(
  Query.where(Expr.contains(Post.fields.title, Expr.input("search", Schema.String))),
  Query.orderBy(Order.desc(Post.fields.rank), Order.asc(Post.fields.id)),
);
const rows = [
  { id: "a", title: "Intro to Effect", rank: 1 },
  { id: "b", title: "EFFECT in Rust", rank: 2 },
  { id: "c", title: "Other", rank: 3 },
];
const input = { search: "effect" };

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-query-example-" });
      const { artifact, directory } = yield* Foldkit.build({ Search: search }, `${temp}/crate`);
      const native = yield* Foldkit.run(artifact, directory, "Search", input, rows, "release");
      const reference = evaluate(search, input, rows);
      if (native.length !== reference.length || native.some((row, i) => row !== reference[i]))
        return yield* Effect.fail(new Error("Query reference/native results differ"));
      yield* Effect.log("Foldkit reference/native parity", { ids: native.map((r) => r.id) });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
