# Foldkit SSR and SSG

[Roadmap](../PLAN.md) · [Documentation index](README.md)

This document preserves a design discussion from the original PLAN.md. APIs and package names are proposals, not implemented guarantees. Original citation placeholders are retained; verify external API and protocol claims against the installed dependencies before implementation.

## Contents

- [What actually has to compile](#what-actually-has-to-compile)
- [We'd need a native-compatible Foldkit view profile initially](#wed-need-a-native-compatible-foldkit-view-profile-initially)
- [Better: Foldkit integration should itself expose compiler semantics](#better-foldkit-integration-should-itself-expose-compiler-semantics)
- [And it should preserve Foldkit's existing hydration protocol exactly](#and-it-should-preserve-foldkits-existing-hydration-protocol-exactly)
- [Native `init` is particularly straightforward](#native-init-is-particularly-straightforward)
- [Routing also maps nicely](#routing-also-maps-nicely)
- [This combines beautifully with Effect RPC](#this-combines-beautifully-with-effect-rpc)
- [The really interesting next step is SSR data loading](#the-really-interesting-next-step-is-ssr-data-loading)
- [Foldkit Remote is particularly relevant](#foldkit-remote-is-particularly-relevant)
- [Native rendering could avoid even constructing a VDOM](#native-rendering-could-avoid-even-constructing-a-vdom)
- [And then stream HTML directly to Hyper](#and-then-stream-html-directly-to-hyper)
- [SSG becomes almost free too](#ssg-becomes-almost-free-too)
- [I would probably make this a dedicated target/module](#i-would-probably-make-this-a-dedicated-targetmodule)
- [I actually think Foldkit exposes a broader opportunity](#i-actually-think-foldkit-exposes-a-broader-opportunity)

---

Yes. I think **Foldkit SSR could be the second major showcase after RPC**, and it fits the compiler architecture unusually well.

The crucial point is that we would not build a new client renderer. The browser would still run normal Foldkit. We'd replace only the **server half**:

```text
Today

Request
  ↓
JS Foldkit renderToString
  ↓
HTML + Flags + hydration markers
  ↓
Browser
  ↓
normal Runtime.hydrate()


With effect-native

Request
  ↓
compiled Rust Foldkit renderer
  ↓
THE SAME HTML + Flags + hydration markers
  ↓
Browser
  ↓
normal Runtime.hydrate()
```

Current Foldkit SSR already has exactly the separation we need: `renderToString` resolves `init`, runs the pure `view`, and emits HTML; the browser reruns the same `init` from serialized Flags and hydrates the result. Foldkit explicitly does **not** run `update`, subscriptions, or managed resources during SSR. :chatgpt-content-reference{index="0"}

That makes the native target surprisingly small.

## What actually has to compile

For SSR, basically:

```text
Request
  ↓
flagsForRequest
  ↓
Flags
  ↓
init
  ↓
Model
  ↓
view
  ↓
Document / Html tree
  ↓
HTML serializer
```

Plus routing if the application uses it.

Not:

```text
update
Commands
Subscriptions
ManagedResources
browser events
DOM patching
Snabbdom diffing
Mounts
```

Those remain browser-side JavaScript.

That is a _massive_ reduction in scope.

### Foldkit's view model is already compiler-friendly

Current Foldkit views are pure functions receiving a Model and an `HtmlBuilder`, returning a `Document`:

```ts
export const view = (
  model: Model,
  h: HtmlBuilder<Message>
): Document => ({
  title: ...,
  body: h.div(...)
})
```

and the current `Html` representation is a virtual node or `null`. The public site describes the architecture as one immutable Model plus pure rendering, and current examples use explicit `h.div`, `h.Class`, etc. rather than arbitrary direct DOM mutation. :chatgpt-content-reference{index="1"}

That is nearly ideal for us.

Instead of server-side:

```text
HtmlBuilder
   ↓
Snabbdom VNode
   ↓
JS serializer
```

the native compiled `HtmlBuilder` produces:

```text
Html IR
   ↓
Rust serializer
```

For example:

```ts
h.div([h.Class("user")], [h.h1([], [model.name]), h.p([], ["Welcome!"])]);
```

could become:

```text
Element {
  tag: Div,
  attributes: [
    Class("user")
  ],
  children: [
    Element {
      tag: H1,
      children: [
        Text(Field(Model, name))
      ]
    },
    Element {
      tag: P,
      children: [
        Text("Welcome!")
      ]
    }
  ]
}
```

Rust can render that straight to the HTTP response.

---

## We'd need a native-compatible Foldkit view profile initially

This is the one caveat.

An existing Foldkit view is still arbitrary TypeScript:

```ts
const title = `Hello ${model.name}`

if (model.admin) {
  ...
}
```

Our initial IR-first compiler can't magically understand ordinary template literals or JS `if`.

So the first version would require the **server-reachable parts** of a Foldkit application to obey the native subset.

For example:

```ts
const view = C.fn(
  Model,
  Foldkit.Document(Message),

  (model, h) =>
    C.Match.value(model.route).pipe(
      C.Match.tag("Home", () => ({
        title: "Home",
        body: h.div(
          [h.Class("page")],
          [
            h.h1([], [
              C.String.concat(
                "Hello ",
                model.name
              )
            ])
          ]
        )
      })),

      ...
    )
)
```

Not gorgeous yet, but it proves the architecture.

Later, the source transform we already discussed could make ordinary Foldkit code compile:

```ts
const view = (model, h) => ({
  title: `Hello ${model.name}`,
  body: model.loggedIn ? dashboard(model, h) : login(h),
});
```

into exactly the same IR.

The Rust renderer wouldn't change.

---

# Better: Foldkit integration should itself expose compiler semantics

I wouldn't make application developers manually assemble HTML IR.

We could provide:

```ts
import { Foldkit } from "effect-native/foldkit";
```

and Foldkit's builder gets a native implementation.

Something like:

```ts
const NativeApp = Foldkit.application({
  Model,
  Flags,
  init,
  view,
  routing,
});
```

where those pieces are compiled-compatible.

Then:

```ts
const server = Foldkit.ssr(NativeApp, {
  flagsForRequest,
});
```

produces a native HTTP-capable program.

Or ideally we can adapt existing Foldkit program declarations:

```ts
const app = makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  routing,
});

export default Foldkit.native(app, {
  flagsForRequest,
});
```

The compiler only traverses the server-reachable graph:

```text
Model ────────────✓
Flags ────────────✓
routing ──────────✓
init ─────────────✓
view ─────────────✓

update ───────────ignored
subscriptions ────ignored
managedResources ─ignored
Commands ─────────ignored
```

That's probably the cleanest API long-term.

---

# And it should preserve Foldkit's existing hydration protocol exactly

This is important.

We don't invent:

```text
effect-native hydration
```

The native server must emit the same handoff the JS Foldkit renderer emits.

Current Foldkit's SSR/Vite integration stamps server HTML with a deployment build ID and the client verifies that ID before adopting the server DOM. If the build IDs differ, hydration is refused. :chatgpt-content-reference{index="2"}

So native rendering needs to reproduce things like:

```html
<div data-foldkit-app="..." data-foldkit-build="...">...</div>
```

and the serialized Flags payload.

It also needs the exact same:

```text
key markers
view identity markers
head metadata
canonical URL
language
text direction
hydration identifiers
```

that the current renderer expects.

This gives us another beautiful differential test:

```text
same Flags
same application

JS Foldkit renderToString
        ↓
      HTML A

Rust Foldkit renderer
        ↓
      HTML B

compare semantic/expected output
```

Then:

```text
Rust-generated HTML
        ↓
stock Runtime.hydrate()
        ↓
must hydrate successfully
```

That last test is the real compatibility proof.

---

# Native `init` is particularly straightforward

Suppose:

```ts
init: flags => ({
  model: {
    route: ...,
    user: flags.user
  },
  command: ...
})
```

SSR only cares about the initial Model.

Commands don't execute server-side today; current Foldkit's model is that the browser hydrates and the normal client runtime proceeds afterward. :chatgpt-content-reference{index="3"}

So native compilation can conceptually extract:

```text
Init<Flags, Model>
```

and generate:

```rust
fn init(flags: Flags) -> Model
```

potentially ignoring the Command portion for the SSR phase while preserving whatever handoff semantics Foldkit requires.

That is incredibly cheap.

---

# Routing also maps nicely

Foldkit already has type-safe bidirectional routing. :chatgpt-content-reference{index="4"}

A native SSR server gets:

```text
Request URL
     ↓
compiled route parser
     ↓
Route enum
```

A route such as:

```text
/users/:id
```

could compile to:

```rust
enum Route {
    Home,
    User { id: UserId },
    Settings,
}
```

Then `init` gets the typed Route.

There's no need for a separate Axum routing model for page routes.

We could have:

```text
Axum fallback page handler
        ↓
Foldkit route parser
        ↓
Foldkit SSR
```

while RPC/API routes are registered separately.

---

# This combines beautifully with Effect RPC

Now the whole server architecture starts looking really compelling:

```text
                    Rust binary
                        │
             ┌──────────┴──────────┐
             │                     │
             ▼                     ▼
       /rpc/* requests         page requests
             │                     │
             ▼                     ▼
      Effect Native RPC       Foldkit Native SSR
             │                     │
             │               Flags → init → view
             │                     │
             ▼                     ▼
        compiled Effects          HTML
             │                     │
             └──────────┬──────────┘
                        │
                    Axum/Hyper
                        │
                        ▼
                     Browser
                  ┌─────┴─────┐
                  ▼           ▼
           RpcClient      Foldkit.hydrate
```

One binary can therefore serve:

```text
HTML pages
JS/CSS/static assets
Effect RPC
streaming RPC
WebSockets
```

with the browser still being ordinary TypeScript Foldkit + Effect.

---

# The really interesting next step is SSR data loading

Current Foldkit SSR's basic model is intentionally simple: request → Flags → init → view. The render host is described as a page renderer rather than a data API. :chatgpt-content-reference{index="5"}

But your Foldkit-Plus work has already been heading toward:

```text
single-flight
server data loading
remote data
resumability
streaming
CMS
```

This native compiler could make that substantially more interesting.

Imagine server rendering:

```text
Request
   ↓
Route
   ↓
server load plan
   ↓
Effect.all([
  User.get(...),
  Posts.list(...),
  Permissions.get(...)
])
   ↓
Model / resumable state
   ↓
view
```

where all the server work compiles to native Rust/Tokio.

That gives you:

```text
parallel data fetching
no Node/V8
SQLx/database calls
native HTTP clients
Effect cancellation
Scope
single-flight caches
```

before rendering Foldkit HTML.

---

# Foldkit Remote is particularly relevant

Current `foldkit-remote` already describes a server-rendering resume mechanism where only data actually read by active Surfaces crosses the page boundary; the browser resumes that state rather than redundantly fetching it. :chatgpt-content-reference{index="6"}

That is almost tailor-made for a compiled server.

Conceptually:

```text
Native server
   │
   ├─ execute remote queries
   │
   ├─ render view
   │
   ├─ know exactly which data view used
   │
   └─ emit minimal resume payload
          ↓
       Browser
          ↓
   Foldkit Remote resumes
          ↓
 no duplicate initial fetching
```

And because Schema describes all that data, native encoding could eventually use:

```text
JSON initially
SchemaBinary later
```

rather than bespoke serialization.

---

# Native rendering could avoid even constructing a VDOM

There's another optimization opportunity.

The obvious first Rust implementation is:

```text
view
  ↓
Html IR tree
  ↓
serialize HTML
```

But since server rendering is one-shot, we don't need a VDOM for diffing.

Eventually:

```ts
h.div(...)
```

could compile into **streaming write operations**:

```rust
writer.open("div");
writer.attr("class", "user");

writer.open("h1");
writer.text(user.name);
writer.close("h1");

writer.close("div");
```

Or directly:

```text
WriteStatic("<div class=\"user\"><h1>")
WriteEscaped(user.name)
WriteStatic("</h1></div>")
```

Then adjacent constants can be folded:

```text
HTML IR
   ↓
static-string folding
   ↓
small sequence of dynamic writes
```

For:

```ts
h.div([h.Class("user")], [h.span([], ["Hello "]), h.strong([], [model.name])]);
```

the compiler could generate approximately:

```rust
write!(
    out,
    "<div class=\"user\"><span>Hello </span><strong>"
);

escape_html(&mut out, &model.name);

write!(
    out,
    "</strong></div>"
);
```

No VNode allocations.

No generic renderer.

No JS object graph.

That's potentially **very fast SSR**.

---

# And then stream HTML directly to Hyper

Once the basic string renderer works, we don't necessarily need:

```text
render complete page to giant String
       ↓
send response
```

We can eventually do:

```text
view renderer
     ↓
HTML chunks
     ↓
Hyper response body
     ↓
browser
```

Static fragments could be emitted immediately.

Dynamic portions can stream as they're resolved if Foldkit eventually gains a server-side suspense/data-boundary concept.

Even without suspense, this lowers peak allocations.

---

# SSG becomes almost free too

Because Foldkit already treats SSG and SSR as the same renderer invoked at different times. :chatgpt-content-reference{index="7"}

So:

```ts
Compile.make("website").pipe(
  Compile.withProgram(
    Foldkit.ssg(app, {
      routes,
    }),
  ),
  Compile.run,
);
```

could generate static HTML with the native renderer.

Or compile a tiny build executable that renders routes.

The same compiled view engine handles:

```text
SSG
SSR
```

with only the delivery policy changing.

---

# I would probably make this a dedicated target/module

Maybe:

```ts
import { Foldkit } from "effect-native/foldkit";
```

with:

```ts
Foldkit.ssr(...)
Foldkit.ssg(...)
```

used from the normal compiler API:

```ts
const server = Native.program({
  http: Foldkit.ssr(app, {
    flagsForRequest,
  }),

  rpc: Rpc.handlers(Api, handlers),
});

const build = Compile.make("my-app").pipe(
  Compile.withProgram(server),
  Compile.withTarget(Rust.binary()),
  Compile.run,
);
```

Then CLI:

```bash
effect-native build src/server.native.ts
```

No special hidden Foldkit compiler.

It's merely another Effect Native library producing the same Program IR.

---

## I actually think Foldkit exposes a broader opportunity

Effect RPC demonstrates:

> **Effect computations authored in TypeScript can execute natively.**

Foldkit SSR demonstrates:

> **A TypeScript UI/view program can execute natively too.**

And because the Foldkit browser runtime stays JavaScript, we don't need to solve native DOM rendering.

The division is almost perfect:

```text
SERVER
────────────────────────────
Rust

routing
Flags
init
data loading
RPC
SQL
view → HTML
Schema serialization


BROWSER
────────────────────────────
TypeScript / Foldkit

hydrate
DOM patching
update
Messages
Commands
Subscriptions
ManagedResources
navigation
```

The shared seam is:

```text
Schema + Model + view semantics
+
Foldkit hydration protocol
```

That is much, much more tractable than attempting to compile an entire frontend framework to Rust.

I would put **native Foldkit SSR immediately after native unary RPC on the roadmap**. A particularly compelling early demo would be one project where the generated Rust binary serves the Foldkit HTML _and_ implements its Effect RPC backend, while the unchanged browser bundle hydrates the page and calls that backend. That would showcase almost the whole thesis in a very concrete web app.
