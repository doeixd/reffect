import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: { entry: ["src/index.ts"], dts: true, tsconfig: "./tsconfig.build.json" },
  // Every native test runs a cargo build that already uses all cores; more workers only
  // oversubscribe the CPU until native suites hit their time budgets.
  test: { testTimeout: 120000, maxWorkers: 4 },
});
