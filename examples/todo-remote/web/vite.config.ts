import { defineConfig } from "vite-plus";

// The browser talks to its own origin; Vite forwards `/rpc` to the native server
// (`main.ts --serve`, port 8787 by default).
export default defineConfig({
  server: {
    host: "127.0.0.1",
    proxy: { "/rpc": `http://127.0.0.1:${process.env.TODO_REMOTE_PORT ?? "8787"}` },
  },
});
