/**
 * The pinned upstream SSR example loaded as its own build loads it (milestone 8B step 3): Vite,
 * with `@foldkit/ui` mapped to the vendored source and the build id the Foldkit Vite plugin would
 * compile into Foldkit, so `renderToString` and `Runtime.hydrate` find it as they do upstream.
 */
import { resolve } from "node:path";
import { createServer } from "vite-plus";

export const UPSTREAM_SSR = resolve("tests/fixtures/upstream-ssr");
export const UPSTREAM_BUILD_ID = "ssr-8b";

export const upstreamSsrVite = () =>
  createServer({
    root: UPSTREAM_SSR,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false },
    resolve: { alias: { "@foldkit/ui": resolve(UPSTREAM_SSR, "foldkit-ui/index.ts") } },
    ssr: { noExternal: ["foldkit"] },
    plugins: [
      {
        // What @foldkit/vite-plugin does: compile the build id into Foldkit.
        name: "reffect-foldkit-build-id",
        transform(code, id) {
          if (!id.replaceAll("\\", "/").includes("/foldkit/dist/buildToken.js")) return undefined;
          return code.replace("foldkitBuildIdPlaceholder()", JSON.stringify(UPSTREAM_BUILD_ID));
        },
      },
    ],
  });
