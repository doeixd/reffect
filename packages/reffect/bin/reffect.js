#!/usr/bin/env node
// The package ships TypeScript sources that use parameter properties, which Node runs only with
// --experimental-transform-types (CLI-007); this launcher goes once it ships compiled JavaScript.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const main = fileURLToPath(new URL("../src/cli-main.ts", import.meta.url));
const child = spawn(
  process.execPath,
  [
    "--experimental-transform-types",
    "--disable-warning=ExperimentalWarning",
    main,
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
// Ctrl-C reaches the child through the terminal, so the launcher only waits for it; a SIGTERM
// sent to the launcher alone is passed on.
const onInterrupt = () => {};
const onTerminate = () => child.kill("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
child.on("exit", (code, signal) => {
  if (signal) {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
