/**
 * Where a streaming procedure's chunks go in the reference (STREAM-006): each chunk's elements,
 * already JSON-encoded as the wire carries them. Natively the RPC host owns this channel.
 */
import { Context } from "effect";
import type { Effect } from "effect";

export interface StreamSinkApi {
  readonly emit: (values: ReadonlyArray<unknown>) => Effect.Effect<void>;
}
export class StreamSinkHost extends Context.Service<StreamSinkHost, StreamSinkApi>()(
  "reffect/StreamSinkHost",
) {}
