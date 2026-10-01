import { Schema } from "effect";

/** Display positions are one-based UTF-16 columns; offsets are half-open UTF-16 units. */
export const SourceLocation = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  digest: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(Schema.Number),
  end: Schema.optionalKey(Schema.Number),
  line: Schema.optionalKey(Schema.Number),
  column: Schema.optionalKey(Schema.Number),
  endLine: Schema.optionalKey(Schema.Number),
  endColumn: Schema.optionalKey(Schema.Number),
  precision: Schema.Literals(["explicit", "named", "context"]),
});
export type SourceLocation = typeof SourceLocation.Type;

/** A source snapshot; its text is never serialized implicitly into compiler artifacts. */
const lineStarts = (text: string): readonly number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) starts.push(i + 1);
  }
  return Object.freeze(starts);
};
const position = (starts: readonly number[], offset: number) => {
  let low = 0,
    high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
};
export class SourceFile {
  private readonly lines: readonly number[];
  private constructor(
    readonly path: string,
    readonly text: string,
  ) {
    this.lines = lineStarts(text);
    Object.freeze(this);
  }
  position(offset: number) {
    if (!validOffset(this.text, offset)) throw new RangeError("Invalid source offset");
    return position(this.lines, offset);
  }
  static make(this: void, path: string, text: string): SourceFile {
    const normalized = path.replaceAll("\\", "/");
    if (!safeRelativePath(normalized))
      throw new TypeError("Source path must be workspace-relative");
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (char.length === 1 && code >= 0xd800 && code <= 0xdfff)
        throw new TypeError("Source text must contain well-formed Unicode");
    }
    return new SourceFile(normalized, text);
  }
}

const hasControls = (value: string): boolean => {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
};

/** Also used for auxiliary output paths, before creating any files. */
export const safeRelativePath = (path: string): boolean =>
  path.length > 0 &&
  !hasControls(path) &&
  !/[\\:#?]/.test(path) &&
  !path.startsWith("/") &&
  path
    .split("/")
    .every(
      (part) =>
        part.length > 0 &&
        part !== "." &&
        part !== ".." &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    );

const validOffset = (text: string, offset: number) =>
  Number.isSafeInteger(offset) &&
  offset >= 0 &&
  offset <= text.length &&
  !(text.charCodeAt(offset - 1) === 13 && text.charCodeAt(offset) === 10) &&
  !(
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  );
const validName = (name: string) => {
  if (!name.trim() || name.length > 256 || hasControls(name))
    throw new TypeError(
      "Source name must be nonempty, at most 256 characters and contain no controls",
    );
  return name;
};
export class SourceSite {
  private constructor(
    readonly file: SourceFile,
    readonly start: number,
    readonly end: number,
    readonly name?: string,
  ) {
    Object.freeze(this);
  }
  static make(this: void, file: SourceFile, start: number, end: number, name?: string): SourceSite {
    if (
      !(file instanceof SourceFile) ||
      !validOffset(file.text, start) ||
      !validOffset(file.text, end) ||
      end < start
    )
      throw new RangeError("Source range must be a valid half-open UTF-16 range in its snapshot");
    return new SourceSite(file, start, end, name === undefined ? undefined : validName(name));
  }
  location(): SourceLocation {
    const start = this.file.position(this.start);
    const end = this.file.position(this.end);
    return Object.freeze({
      file: this.file.path,
      start: this.start,
      end: this.end,
      line: start.line,
      column: start.column,
      endLine: end.line,
      endColumn: end.column,
      ...(this.name === undefined ? {} : { name: this.name }),
      precision: "explicit",
    });
  }
}
export interface SourceMetadata {
  readonly definition?: SourceSite;
  readonly use?: SourceSite;
  readonly name?: string;
}
export const emptySource: SourceMetadata = Object.freeze({});
export const snapshotSource = (metadata: SourceMetadata): SourceMetadata => {
  if (
    (metadata.definition !== undefined && !(metadata.definition instanceof SourceSite)) ||
    (metadata.use !== undefined && !(metadata.use instanceof SourceSite))
  )
    throw new TypeError("Source metadata must use validated SourceSite snapshots");
  return Object.freeze({
    ...(metadata.definition === undefined ? {} : { definition: metadata.definition }),
    ...(metadata.use === undefined ? {} : { use: metadata.use }),
    ...(metadata.name === undefined ? {} : { name: validName(metadata.name) }),
  });
};
export interface SourceAware<A> {
  readonly source: SourceMetadata;
  withSource(source: SourceMetadata): A;
}
const annotate =
  (update: (source: SourceMetadata) => SourceMetadata) =>
  <A>(self: SourceAware<A>): A =>
    self.withSource(snapshotSource(update(self.source)));
/** Immutable, pipeable authoring metadata; callbacks are never re-executed. */
export const Source = Object.freeze({
  file: SourceFile.make,
  site: SourceSite.make,
  at: (site: SourceSite) => annotate((source) => ({ ...source, definition: site })),
  use: (site: SourceSite) => annotate((source) => ({ ...source, use: site })),
  named: (name: string) => annotate((source) => ({ ...source, name: validName(name) })),
});
