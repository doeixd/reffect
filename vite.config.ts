import { defineConfig } from "vite-plus";

export default defineConfig({
  // The pinned upstream source 8B transforms stays byte for byte as published.
  fmt: { ignorePatterns: ["packages/reffect/tests/fixtures/upstream-ssr/**"] },
  lint: {
    ignorePatterns: ["packages/reffect/tests/fixtures/upstream-ssr/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
