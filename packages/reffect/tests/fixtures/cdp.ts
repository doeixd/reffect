/**
 * A minimal Chrome DevTools Protocol client for browser checks: headless Chrome on a profile of
 * its own, navigation with the document's status, script evaluation, and the raw event log.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

/** A minimal CDP client over Chrome's own WebSocket endpoint. */
export const chrome = async (port: number) => {
  const profile = mkdtempSync(join(tmpdir(), "reffect-cdp-"));
  const browser = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let socketUrl: string | undefined;
  for (let i = 0; i < 100 && socketUrl === undefined; i++) {
    try {
      const targets: ReadonlyArray<{ type: string; webSocketDebuggerUrl: string }> = await (
        await fetch(`http://127.0.0.1:${port}/json`)
      ).json();
      socketUrl = targets.find((target) => target.type === "page")?.webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  if (socketUrl === undefined) throw new Error("Chrome did not start");
  const socket = new WebSocket(socketUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));
  let next = 0;
  const pending = new Map<number, (result: unknown) => void>();
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === "number") pending.get(message.id)?.(message.result);
    else events.push(message);
  });
  const send = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++next;
      pending.set(id, (result) => resolve((result ?? {}) as Record<string, unknown>));
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return (result.result as { value?: unknown } | undefined)?.value;
  };
  /** Navigates and resolves with the document's status once it has loaded. */
  const navigate = async (url: string): Promise<number> => {
    const from = events.length;
    await send("Page.navigate", { url });
    for (let i = 0; i < 100; i++) {
      const loaded = events.slice(from).some((event) => event.method === "Page.loadEventFired");
      const response = events
        .slice(from)
        .find(
          (event) =>
            event.method === "Network.responseReceived" &&
            (event.params as { type?: string }).type === "Document",
        );
      if (loaded && response)
        return (response.params as { response: { status: number } }).response.status;
      await sleep(50);
    }
    throw new Error(`No document for ${url}`);
  };
  await send("Network.enable");
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    send,
    evaluate,
    navigate,
    events,
    sleep,
    // Chrome holds its profile until it has exited (Windows refuses to delete it before).
    close: async () => {
      socket.close();
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      browser.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
};
