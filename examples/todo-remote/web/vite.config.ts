import { defineConfig } from "vite-plus";

const native = `http://127.0.0.1:${process.env.TODO_REMOTE_PORT ?? "8787"}`;

// The browser talks to its own origin. Vite forwards `/rpc` and page navigations to the native
// server (`main.ts --serve`, port 8787 by default), which renders the first screen; it serves the
// client modules itself.
export default defineConfig({
  server: {
    host: "127.0.0.1",
    proxy: {
      "/rpc": native,
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
