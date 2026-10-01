import { Effect, FileSystem, Path, Schema } from "effect";
import { SourceLocation } from "./source.ts";
import { SourceMaps } from "./source-artifact.ts";
import type { SourceResolution } from "./source-artifact.ts";

export const NativeDiagnostic = Schema.Struct({
  message: Schema.String,
  level: Schema.String,
  code: Schema.optionalKey(Schema.String),
  spans: Schema.Array(
    Schema.Struct({
      file: Schema.String,
      start: Schema.Number,
      end: Schema.Number,
      primary: Schema.Boolean,
      label: Schema.optionalKey(Schema.String),
      mapping: Schema.Literals(["mapped", "unmapped", "stale", "missing", "invalid"]),
      authored: Schema.optionalKey(SourceLocation),
      related: Schema.Array(SourceLocation),
    }),
  ),
  raw: Schema.Unknown,
});
export type NativeDiagnostic = typeof NativeDiagnostic.Type;
const Span = Schema.Struct({
  file_name: Schema.String,
  byte_start: Schema.Number,
  byte_end: Schema.Number,
  is_primary: Schema.Boolean,
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  expansion: Schema.optionalKey(Schema.Unknown),
});
const Message = Schema.Struct({
  message: Schema.String,
  level: Schema.String,
  spans: Schema.Array(Schema.Unknown),
  children: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  code: Schema.optionalKey(Schema.NullOr(Schema.Struct({ code: Schema.String }))),
});
const Envelope = Schema.Struct({
  reason: Schema.String,
  message: Schema.optionalKey(Schema.Unknown),
});
const Expansion = Schema.Struct({ span: Schema.Unknown });
type Resolve = (file: string, start: number, end?: number) => SourceResolution;
const fallback =
  (status: SourceResolution["status"]): Resolve =>
  () => ({ status, related: [] });

/** Cargo messages are build output only; runner stdout is never parsed as JSON diagnostics. */
export const readBuildDiagnostics = Effect.fn("Cargo.diagnostics")(function* (
  stdout: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const load = Effect.gen(function* () {
    const mapPath = path.join(directory, "reffect.sources.json");
    if (!(yield* fs.exists(mapPath))) return fallback("missing");
    if ((yield* fs.stat(mapPath)).size > BigInt(16 * 1024 * 1024)) return fallback("invalid");
    const sourceJson = yield* fs.readFileString(mapPath);
    const table = yield* SourceMaps.decode(sourceJson);
    const manifestPath = path.join(directory, "reffect.build.json");
    if (yield* fs.exists(manifestPath)) {
      if ((yield* fs.stat(manifestPath)).size > BigInt(16 * 1024 * 1024))
        return fallback("invalid");
      yield* SourceMaps.verifyManifest(yield* fs.readFileString(manifestPath), sourceJson, table);
    }
    const texts: Record<string, string> = {};
    for (const file of table.generated) {
      const full = path.join(directory, file.file);
      const text = yield* Effect.gen(function* () {
        if ((yield* fs.stat(full)).size > BigInt(64 * 1024 * 1024)) return undefined;
        return yield* fs.readFileString(full);
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (text !== undefined) texts[file.file] = text;
    }
    return yield* SourceMaps.resolver(table, texts);
  }).pipe(Effect.catch(() => Effect.succeed(fallback("invalid"))));
  const resolve = yield* load;
  const diagnostics: NativeDiagnostic[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length > 1024 * 1024) continue;
    let raw: unknown;
    try {
      const envelope = Schema.decodeUnknownSync(Envelope)(JSON.parse(line));
      if (envelope.reason !== "compiler-message" || envelope.message === undefined) continue;
      raw = envelope.message;
    } catch {
      continue;
    }
    let message: typeof Message.Type;
    try {
      message = Schema.decodeUnknownSync(Message)(raw);
    } catch {
      continue;
    }
    const spans: NativeDiagnostic["spans"][number][] = [];
    const collectSpan = (input: unknown, depth: number) => {
      if (depth > 32 || spans.length >= 10000) return;
      let span: typeof Span.Type;
      try {
        span = Schema.decodeUnknownSync(Span)(input);
      } catch {
        return;
      }
      const relative = path
        .relative(path.resolve(directory), path.resolve(directory, span.file_name))
        .replaceAll("\\", "/");
      const resolution = resolve(relative, span.byte_start, span.byte_end);
      spans.push({
        file: span.file_name,
        start: span.byte_start,
        end: span.byte_end,
        primary: span.is_primary,
        ...(span.label === undefined || span.label === null ? {} : { label: span.label }),
        mapping: resolution.status,
        ...(resolution.primary ? { authored: resolution.primary } : {}),
        related: resolution.related,
      });
      if (span.expansion) {
        try {
          collectSpan(Schema.decodeUnknownSync(Expansion)(span.expansion).span, depth + 1);
        } catch {
          /* Preserve unknown expansion data in raw. */
        }
      }
    };
    const collectMessage = (input: typeof Message.Type, depth: number) => {
      if (depth > 32) return;
      input.spans.forEach((span) => collectSpan(span, 0));
      for (const child of input.children ?? []) {
        try {
          collectMessage(Schema.decodeUnknownSync(Message)(child), depth + 1);
        } catch {
          /* Raw retains future message fields. */
        }
      }
    };
    collectMessage(message, 0);
    diagnostics.push({
      message: message.message,
      level: message.level,
      ...(message.code ? { code: message.code.code } : {}),
      spans,
      raw,
    });
  }
  return diagnostics;
});
