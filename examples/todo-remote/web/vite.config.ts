import { defineConfig } from "vite-plus";

const native = `http://127.0.0.1:${process.env.TODO_REMOTE_PORT ?? "8787"}`;

// The browser talks to its own origin. Vite forwards `/rpc` and page navigations to the native
// server (`main.ts --serve`, port 8787 by default), which renders the first screen; it serves the
// client modules itself.
export default defineConfig({
  // The RPC serialization the native server was compiled with: NDJSON, or SchemaBinary when it
  // was started with --binary (TODO_REMOTE_RPC=schema-binary).
  // Its transport: HTTP, or one WebSocket session when started with --websocket.
  define: {
    __TODO_REMOTE_RPC__: JSON.stringify(process.env.TODO_REMOTE_RPC ?? "ndjson"),
    __TODO_REMOTE_TRANSPORT__: JSON.stringify(process.env.TODO_REMOTE_TRANSPORT ?? "http"),
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      // A WebSocket server takes its session's upgrade at /rpc.
      "/rpc": { target: native, ws: true },
      // Sign-in and sign-out of a server started with --auth (#4).
      "/session": native,
      "/": {
        target: native,
        bypass: (request) =>
          request.headers.accept?.includes("text/html") ? undefined : request.url,
      },
    },
  },
});
