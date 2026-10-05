/**
 * The todo list's first screen, rendered by the native server (milestone 9, M9-4). The page reads
 * the list through the server's own engine, renders the browser app's own R view (`screen` in
 * `web/app.ts`, #14) for a Ready list with an empty draft, and hands the exchanges to the app's
 * `init` in its Flags, so the browser adopts the HTML and starts without fetching.
 */
import { NativeRemote, NativeRpc, R } from "../../packages/reffect/src/index.ts";
import { PageSchema } from "../../packages/reffect/src/ssr-page.ts";
import { planPage } from "../../packages/reffect/src/remote-resume.ts";
import { BUILD_ID, Data, ViewModel, initial, list, screenDocument } from "./web/app.ts";

const Flags = R.Struct({ remote: R.Unknown });

/** What the page reads: its one view, the list's first page. */
export const plan = planPage(Data, initial, { todos: list });
// The view's Page, its items decoded by the list's own selection (#6).
const Views = NativeRemote.pageViews(plan);

const Page = NativeRpc.witness(PageSchema);
/** The page reads the exchanges it carries and the list it shows (#13). */
const PageRequest = R.Struct({ remote: R.Unknown, views: Views });
export const page = R.fn([PageRequest], Page, (request) => {
  const remote = R.Struct.get(request, "remote");
  const todos = request.pipe(R.Struct.get("views"), R.Struct.get("todos"), R.Struct.get("items"));
  return R.Html.renderToString(
    {
      init: () =>
        ViewModel.make({
          draft: R.String.literal(""),
          status: R.String.literal("Ready"),
          todos,
        }),
      view: screenDocument,
    },
    { buildId: BUILD_ID, flags: Flags.make({ remote }) },
  );
});
