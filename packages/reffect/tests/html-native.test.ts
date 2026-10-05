import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { HttpEffect } from "effect/http";
import { ChildProcess } from "effect/process";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { NodeServices } from "@effect/platform-node";
import { defineMessageUnion } from "foldkit/message";
import { expect, test } from "vite-plus/test";
import { CargoApi, IRType, NativeRpc, R, Reference } from "../src/index.ts";
import type { Expr, Value } from "../src/index.ts";
import { nativeTestBudget } from "./native-test-budget.ts";

// Milestone 8A step 3: R views rendered natively answer as upstream renderToString, which is the
// reference of R.Html.renderToString. The views run in a NativeRpc server and in the official
// RpcServer; responses must be byte-equal.
const H = R.Html;
const RenderedSchema = Schema.Struct({ html: Schema.String, title: Schema.String });
const RenderErrorSchema = Schema.Union([
  Schema.TaggedStruct("InvalidHydrationRoot", { rootKind: Schema.String }),
  Schema.TaggedStruct("SerializationError", { message: Schema.String }),
  Schema.TaggedStruct("FlagsEncodeError", { message: Schema.String }),
]);
const PageSchema = Schema.Union([
  Schema.TaggedStruct("Success", { success: RenderedSchema }),
  Schema.TaggedStruct("Failure", { failure: RenderErrorSchema }),
]);
const Page = R.Result(H.Rendered, H.RenderError);
const TodoSchema = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.Boolean });
const Todos = NativeRpc.witness(Schema.Array(TodoSchema));
const Strings = NativeRpc.witness(Schema.Array(Schema.String));

const render = (body: Expr<Value<typeof H.Node>>, title: Expr<string> = R.String.literal("t")) =>
  H.renderToString(H.Document.make({ title, body }), { buildId: "build-1" });

const Message = defineMessageUnion({ Toggled: { id: Schema.String } });
const todos = R.fn([R.String, Todos], Page, (heading, items) =>
  render(
    H.main(
      [H.Class("app"), H.Id("root")],
      [
        H.h1([], [heading]),
        H.ul(
          [],
          R.Array.map(items, (todo) =>
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
        H.empty,
        "tail & <text>",
      ],
    ),
    heading,
  ),
);
// Every admitted element with every admitted attribute: only the reflected props survive.
const tags = [
  "a",
  "article",
  "aside",
  "button",
  "div",
  "em",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "header",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "span",
  "strong",
  "textarea",
  "ul",
] as const;
const voidTags = ["br", "hr", "input"] as const;
const everything = R.fn([R.String, R.Bool], Page, (value, flag) => {
  const common = [
    H.DataAttribute("x", value),
    H.Class(value),
    H.Id(value),
    H.Title(value),
    H.Href(value),
    H.Type(value),
    H.Name(value),
    H.Placeholder(value),
    H.For(value),
    H.Checked(flag),
    H.Disabled(flag),
    H.Selected(flag),
    H.Autofocus(flag),
    H.AriaDisabled(flag),
    H.Tabindex(-1),
  ];
  return render(
    H.div(
      [],
      [
        ...tags.map((tag) =>
          H[tag](tag === "button" ? [...common, H.Value(value)] : common, [value]),
        ),
        ...voidTags.map((tag) => H[tag](tag === "input" ? [...common, H.Value(value)] : common)),
      ],
    ),
  );
});
const links = R.fn([Strings], Page, (hrefs) =>
  render(
    H.nav(
      [],
      R.Array.map(hrefs, (href) => H.a([H.Href(href)], [href])),
    ),
  ),
);
const classes = R.fn([Strings], Page, (names) =>
  render(
    H.div(
      [],
      R.Array.map(names, (name) => H.span([H.Class(name)], [])),
    ),
  ),
);
// 8B: the HTML parser drops one newline after <pre> and <textarea>, so content starting with one
// gets another; a textarea's Value is its content.
const forms = R.fn([R.String], Page, (text) =>
  render(
    H.div(
      [],
      [
        H.pre([], [text]),
        H.pre([], [H.span([], []), text]),
        H.pre([], ["", text]),
        H.textarea([H.Value(text), H.Name("n")]),
        H.textarea([], [text]),
        H.textarea([H.Value(R.String.concat(R.String.literal("\n"), text))]),
      ],
    ),
  ),
);
const nulInText = R.fn([R.String], Page, (text) => render(H.p([], [text])));
const nulInAttribute = R.fn([R.String], Page, (text) =>
  render(H.p([H.Title(text)], [H.span([], [text])])),
);
const textBody = R.fn([R.String], Page, (text) => render(H.text(text)));
const emptyBody = R.fn([R.String], Page, () => render(H.empty));

const Group = RpcGroup.make(
  Rpc.make("Todos", {
    payload: { heading: Schema.String, todos: Schema.Array(TodoSchema) },
    success: PageSchema,
  }),
  Rpc.make("Everything", {
    payload: { value: Schema.String, flag: Schema.Boolean },
    success: PageSchema,
  }),
  Rpc.make("Links", { payload: { hrefs: Schema.Array(Schema.String) }, success: PageSchema }),
  Rpc.make("Classes", { payload: { names: Schema.Array(Schema.String) }, success: PageSchema }),
  Rpc.make("Forms", { payload: { text: Schema.String }, success: PageSchema }),
  Rpc.make("NulInText", { payload: { text: Schema.String }, success: PageSchema }),
  Rpc.make("NulInAttribute", { payload: { text: Schema.String }, success: PageSchema }),
  Rpc.make("TextBody", { payload: { text: Schema.String }, success: PageSchema }),
  Rpc.make("EmptyBody", { payload: { text: Schema.String }, success: PageSchema }),
);
const bindings = {
  Todos: NativeRpc.bind(todos, ["heading", "todos"]),
  Everything: NativeRpc.bind(everything, ["value", "flag"]),
  Links: NativeRpc.bind(links, ["hrefs"]),
  Classes: NativeRpc.bind(classes, ["names"]),
  Forms: NativeRpc.bind(forms, ["text"]),
  NulInText: NativeRpc.bind(nulInText, ["text"]),
  NulInAttribute: NativeRpc.bind(nulInAttribute, ["text"]),
  TextBody: NativeRpc.bind(textBody, ["text"]),
  EmptyBody: NativeRpc.bind(emptyBody, ["text"]),
};
const oracle = Effect.gen(function* () {
  const run = <A>(effect: Effect.Effect<A, { readonly _tag: "CompileError" }>) =>
    effect.pipe(Effect.catchTag("CompileError", Effect.die));
  const handlers = Group.toLayer({
    Todos: ({ heading, todos: items }) => run(Reference.run(todos, [heading, items])),
    Everything: ({ value, flag }) => run(Reference.run(everything, [value, flag])),
    Links: ({ hrefs }) => run(Reference.run(links, [hrefs])),
    Classes: ({ names }) => run(Reference.run(classes, [names])),
    Forms: ({ text }) => run(Reference.run(forms, [text])),
    NulInText: ({ text }) => run(Reference.run(nulInText, [text])),
    NulInAttribute: ({ text }) => run(Reference.run(nulInAttribute, [text])),
    TextBody: ({ text }) => run(Reference.run(textBody, [text])),
    EmptyBody: ({ text }) => run(Reference.run(emptyBody, [text])),
  });
  const http = yield* RpcServer.toHttpEffect(Group, { disableTracing: true }).pipe(
    Effect.provide([handlers, RpcSerialization.layerJson]),
  );
  return HttpEffect.toWebHandler(http);
});

const request = (tag: string, payload: unknown) =>
  JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] });
const hrefs = [
  "/ok",
  "https://e.com/?a=1&b=2",
  "mailto:a@b.c",
  "javascript:alert(1)",
  " JaVaScRiPt:x",
  "java\tscript:x",
  " javascript:x",
  "﻿vbscript:x",
  "javascript\u0001:x",
  "javascript :x",
  "1javascript:x",
  "data:text/html,<b>",
];
const classNames = [
  "",
  "a b",
  "  a   b  ",
  "b 2 a 1 2",
  "__proto__ x",
  "a b",
  "x　y​z",
  "0 01 4294967295 4294967294",
];
const corpus: ReadonlyArray<readonly [string, string]> = [
  ["todos empty", request("Todos", { heading: "Todos", todos: [] })],
  [
    "todos",
    request("Todos", {
      heading: `Café "&" <ünïcode> 😀\r`,
      todos: [
        { id: "t1", title: "Write the domain", done: true },
        { id: "2", title: 'a&b<c>"d"\r\n', done: false },
      ],
    }),
  ],
  ["everything", request("Everything", { value: "v", flag: true })],
  ["everything off", request("Everything", { value: "v", flag: false })],
  ["everything escaped", request("Everything", { value: `x"<&>\r`, flag: true })],
  ["links", request("Links", { hrefs })],
  ["classes", request("Classes", { names: classNames })],
  ...["plain", "\nleading", "\n\nboth", "", "\r\nx", "a\u0000b", "<&>"].map(
    (text) => [`forms ${JSON.stringify(text)}`, request("Forms", { text })] as const,
  ),
  ["nul in text", request("NulInText", { text: "a\u0000b" })],
  ["nul in attribute", request("NulInAttribute", { text: "a\u0000b" })],
  ["no nul", request("NulInText", { text: "fine" })],
  ["text body", request("TextBody", { text: "x" })],
  ["empty body", request("EmptyBody", { text: "x" })],
];

test("a rendered page's Result is the contract's success witness", () => {
  expect(IRType.same(Page, NativeRpc.witness(PageSchema))).toBe(true);
});

test(
  "native R views render as upstream renderToString",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const official = yield* oracle;
          const fs = yield* FileSystem.FileSystem;
          const parent = yield* fs.makeTempDirectoryScoped({ prefix: "reffect-html-native-" });
          const artifact = yield* NativeRpc.compile(Group, bindings);
          const directory = yield* CargoApi.write(artifact, `${parent}/crate`);
          yield* CargoApi.fetch(directory);
          yield* CargoApi.build(directory, "debug");
          const child = yield* ChildProcess.make(
            `${directory}/target/debug/reffect_generated${process.platform === "win32" ? ".exe" : ""}`,
            ["--port", "0"],
          );
          yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
          const ready = yield* Stream.runHead(
            Stream.splitLines(Stream.decodeText(child.stdout)),
          ).pipe(Effect.timeout("10 seconds"));
          if (!Option.isSome(ready)) throw new Error("Missing ready record");
          const { address } = Schema.decodeUnknownSync(
            Schema.Struct({
              schema: Schema.Literal("reffect.rpc.ready@1"),
              address: Schema.String,
            }),
          )(JSON.parse(ready.value));
          const answers = new Map<string, string>();
          for (const [label, body] of corpus) {
            const native = yield* Effect.promise(() =>
              fetch(`http://${address}/rpc`, { method: "POST", body }).then((r) => r.text()),
            );
            const expected = yield* Effect.promise(() =>
              official(new Request("http://reffect.test/rpc", { method: "POST", body })).then((r) =>
                r.text(),
              ),
            );
            answers.set(label, expected);
            expect(native, label).toBe(expected);
          }
          // What was compared really exercised each rule.
          expect(answers.get("links")).toContain('href=\\"\\"');
          expect(answers.get("todos")).toContain("data-foldkit-key");
          expect(answers.get("everything")).toContain('checked=\\"\\"');
          expect(answers.get("nul in text")).toContain("text content contains a NUL");
          expect(answers.get("nul in attribute")).toContain("attribute value contains a NUL");
          expect(answers.get("text body")).toContain("InvalidHydrationRoot");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
  },
  nativeTestBudget(0) + 300000,
);
