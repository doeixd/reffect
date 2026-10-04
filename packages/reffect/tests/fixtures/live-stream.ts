/** Streaming-response helpers for the Remote Live differential tests. */
export type Post = (body: string, signal?: AbortSignal) => Promise<Response>;
export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Collects a streaming response's lines as they arrive. The official web handler answers with
 * the first chunk, so the response is not awaited before the scenario goes on.
 */
export const listen = (post: Post, body: string) => {
  const abort = new AbortController();
  const decoder = new TextDecoder();
  let text = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const reading = (async () => {
    try {
      reader = (await post(body, abort.signal)).body!.getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        text += decoder.decode(chunk.value, { stream: true });
    } catch {
      // Aborted.
    }
  })();
  return {
    lines: () => text.split("\n").filter((line) => line.length > 0),
    // Cancelling the body is the disconnect the official handler observes (STREAM-003). A
    // stream that never sent a chunk has no Response to cancel yet, so the wait is bounded.
    close: async () => {
      await reader?.cancel();
      abort.abort();
      await Promise.race([reading, pause(500)]);
    },
  };
};
/**
 * A stream's events in order, whatever Chunk lines carried them. How many queued events one
 * Chunk takes is timing (`takeAll`), on either server, so comparisons use the events (LR-10).
 */
export const events = (lines: ReadonlyArray<string>): ReadonlyArray<unknown> =>
  lines.flatMap((line) => {
    const message: {
      readonly _tag?: string;
      readonly requestId?: string;
      readonly values?: ReadonlyArray<unknown>;
    } = JSON.parse(line);
    return message._tag === "Chunk"
      ? (message.values ?? []).map((value) => ({ requestId: message.requestId, value }))
      : [message];
  });
