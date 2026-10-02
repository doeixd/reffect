/**
 * The `foldkit-remote` 0.9.0 wire contract (`src/wire.ts`, published `dist/index.mjs`), vendored so
 * reffect can compile it before foldkit-plus publishes on Effect 4.0.0 (NR-007).
 *
 * Changes from upstream:
 * - Import paths use Effect 4.0.0 (`effect/rpc`).
 * - TaggedError classes gain their TypeScript self type parameter.
 * - `relationLevel(7)` is unrolled into `level` applications, which build the identical schema
 *   with precise types.
 * Doc comments are trimmed. The schemas themselves are unchanged.
 *
 * MIT License, Copyright (c) 2026 Patrick Glenn (https://github.com/doeixd/foldkit-plus,
 * packages/remote). Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), to deal in the
 * Software without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions: The
 * above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
 * ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const REMOTE_PROTOCOL_VERSION = 4;
export class RemoteReadError extends Schema.TaggedError<RemoteReadError>()("RemoteReadError", {
  message: Schema.String,
}) {}
export class RemoteMutationError extends Schema.TaggedError<RemoteMutationError>()(
  "RemoteMutationError",
  { message: Schema.String },
) {}
export class RemoteLiveError extends Schema.TaggedError<RemoteLiveError>()("RemoteLiveError", {
  message: Schema.String,
}) {}
export class RemoteProtocolError extends Schema.TaggedError<RemoteProtocolError>()(
  "RemoteProtocolError",
  { message: Schema.String, expected: Schema.Number, received: Schema.Number },
) {}
export const PageSize = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const WindowSchema = Schema.Struct({
  first: Schema.optional(PageSize),
  last: Schema.optional(PageSize),
  after: Schema.optional(Schema.String),
  before: Schema.optional(Schema.String),
});
export const MAX_FIELDS_PER_REQUEST = 256;
export const MAX_RELATION_DEPTH = 8;
export const Fields = Schema.Array(Schema.String).check(Schema.isMaxLength(256));
const slice = {
  entity: Schema.String,
  fields: Fields,
  windows: Schema.optional(Schema.Record(Schema.String, WindowSchema)),
};
const level0 = Schema.Struct({ ...slice, relations: Schema.optionalKey(Schema.Never) });
const level = <S extends Schema.Top>(inner: S) =>
  Schema.Struct({ ...slice, relations: Schema.optional(Schema.Record(Schema.String, inner)) });
// Upstream: relationLevel(7), where relationLevel(depth) wraps relationLevel(depth - 1).
export const RelationRequest = level(level(level(level(level(level(level(level0)))))));
export const ReadRequest = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  fields: Fields,
  windows: Schema.optional(Schema.Record(Schema.String, WindowSchema)),
  relations: Schema.optional(Schema.Record(Schema.String, RelationRequest)),
});
export const ReadBatch = Schema.Struct({
  version: Schema.Number,
  requests: Schema.Array(ReadRequest),
});
export const NormalizedEntity = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  values: Schema.Record(Schema.String, Schema.Unknown),
});
export const SettledFields = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  fields: Schema.Array(Schema.String),
});
export const ReadBatchResult = Schema.Struct({
  entities: Schema.Array(NormalizedEntity),
  settled: Schema.Array(SettledFields),
});
export const MutationRequest = Schema.Struct({
  requestId: Schema.String,
  mutation: Schema.String,
  input: Schema.Unknown,
});
export const LiveEdge = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  key: Schema.String,
});
export const ConnectionChangeSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Insert"),
    connection: Schema.String,
    position: Schema.Union([Schema.Literal("prepend"), Schema.Literal("append")]),
    edge: LiveEdge,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Remove"),
    connection: Schema.String,
    edge: LiveEdge,
  }),
]);
export const MutationResult = Schema.Struct({
  output: Schema.Unknown,
  entities: Schema.Array(NormalizedEntity),
  connections: Schema.optional(Schema.Array(ConnectionChangeSchema)),
  deleted: Schema.optional(
    Schema.Array(Schema.Struct({ entity: Schema.String, id: Schema.String })),
  ),
});
export const LiveRequirement = Schema.Struct({
  version: Schema.Number,
  requirements: Schema.Array(ReadRequest),
  after: Schema.Number,
});
export const LiveChange = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("EntityPatched"),
    cursor: Schema.Number,
    entity: Schema.String,
    id: Schema.String,
    values: Schema.Record(Schema.String, Schema.Unknown),
    changed: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("EntityDeleted"),
    cursor: Schema.Number,
    entity: Schema.String,
    id: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ConnectionInsert"),
    cursor: Schema.Number,
    connection: Schema.String,
    position: Schema.Union([Schema.Literal("prepend"), Schema.Literal("append")]),
    edge: LiveEdge,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ConnectionRemove"),
    cursor: Schema.Number,
    connection: Schema.String,
    edge: LiveEdge,
  }),
  Schema.Struct({
    _tag: Schema.Literal("ConnectionInvalidate"),
    cursor: Schema.Number,
    connection: Schema.String,
  }),
]);
export const Read = Rpc.make("FoldkitRemoteRead", {
  payload: ReadBatch,
  success: ReadBatchResult,
  error: Schema.Union([RemoteReadError, RemoteProtocolError]),
});
export const Mutate = Rpc.make("FoldkitRemoteMutate", {
  payload: MutationRequest,
  success: MutationResult,
  error: RemoteMutationError,
});
export const Live = Rpc.make("FoldkitRemoteLive", {
  payload: LiveRequirement,
  success: LiveChange,
  error: Schema.Union([RemoteLiveError, RemoteProtocolError]),
  stream: true,
});
export class RemoteQueryError extends Schema.TaggedError<RemoteQueryError>()("RemoteQueryError", {
  message: Schema.String,
}) {}
export const WireBoundary = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Terminal") }),
  Schema.Struct({ _tag: Schema.Literal("Cursor"), cursor: Schema.String }),
  Schema.Struct({ _tag: Schema.Literal("Unknown") }),
]);
export const QueryRequest = Schema.Struct({
  query: Schema.String,
  input: Schema.Unknown,
  window: WindowSchema,
  select: Schema.optional(RelationRequest),
});
export const QueryEdge = Schema.Struct({
  entity: Schema.String,
  id: Schema.String,
  key: Schema.String,
});
export const QueryResult = Schema.Struct({
  edges: Schema.Array(QueryEdge),
  start: WireBoundary,
  end: WireBoundary,
  entities: Schema.optional(Schema.Array(NormalizedEntity)),
  settled: Schema.optional(Schema.Array(SettledFields)),
});
export const QueryRpc = Rpc.make("FoldkitRemoteQuery", {
  payload: QueryRequest,
  success: QueryResult,
  error: RemoteQueryError,
});
export const RemoteRpc = RpcGroup.make(Read, Mutate, QueryRpc, Live);
