import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { expect } from "vite-plus/test";
import type { makeHarness } from "./harness.ts";

const Case = Schema.Struct({
  name: Schema.String,
  request: Schema.Unknown,
  response: Schema.Unknown,
});
export const unaryCases = Schema.decodeUnknownSync(Schema.Array(Case))(
  JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")),
);

/** The native HTTP test can reuse these fixed vectors through makeHarness(globalThis.fetch, url). */
export const replayUnaryCorpus = (harness: ReturnType<typeof makeHarness>) =>
  Effect.forEach(
    unaryCases,
    (fixture) =>
      Effect.promise(async () => {
        const response = await harness.post(JSON.stringify(fixture.request), {
          "content-type": "application/json",
        });
        expect(response.status, fixture.name).toBe(200);
        expect(response.headers.get("content-type"), fixture.name).toBe("application/json");
        expect(await response.json(), fixture.name).toEqual(fixture.response);
      }),
    { discard: true },
  );
