import type { GeneratedRange } from "./source-artifact.ts";

/** A byte range relative to the start of the fragment that contains it. */
export interface RelativeRange {
  readonly start: number;
  readonly end: number;
  readonly origin: string;
  readonly occurrence?: string;
  readonly role?: GeneratedRange["role"];
}
/**
 * Rendered source plus the authored ranges inside it, relative to the fragment.
 * Composition shifts ranges; only `SourceWriter.writeFragment` turns them into
 * absolute file coordinates.
 */
export interface MappedFragment {
  readonly text: string;
  readonly ranges: readonly RelativeRange[];
}

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** Plain generated text with no authored attribution. */
export const textFragment = (text: string): MappedFragment =>
  Object.freeze({ text, ranges: Object.freeze([]) });

/**
 * Attributes `inner` to `origin`. An undefined origin leaves the fragment
 * unmapped, mirroring `SourceWriter.mapped`.
 */
export const mapFragment = (
  origin: string | undefined,
  occurrence: string | undefined,
  inner: MappedFragment,
  role?: GeneratedRange["role"],
): MappedFragment => {
  if (origin === undefined) return inner;
  const end = byteLength(inner.text);
  if (end === 0) return inner;
  const range: RelativeRange = Object.freeze({
    start: 0,
    end,
    origin,
    ...(occurrence === undefined ? {} : { occurrence }),
    role: role ?? (occurrence === undefined ? "definition" : "use"),
  });
  return Object.freeze({ text: inner.text, ranges: Object.freeze([...inner.ranges, range]) });
};

/** Concatenates fragments, shifting each part's ranges into the result. */
export const joinFragments = (parts: ReadonlyArray<string | MappedFragment>): MappedFragment => {
  const chunks = parts.map((part) => (typeof part === "string" ? textFragment(part) : part));
  const text = chunks.map((chunk) => chunk.text).join("");
  // Nothing to attribute: skip UTF-8 measurement entirely so artifact-off
  // compilation never touches the encoder.
  if (!chunks.some((chunk) => chunk.ranges.length > 0))
    return Object.freeze({ text, ranges: Object.freeze([]) });
  const ranges: RelativeRange[] = [];
  let base = 0;
  for (const chunk of chunks) {
    for (const range of chunk.ranges)
      ranges.push(
        Object.freeze({
          ...range,
          start: range.start + base,
          end: range.end + base,
        }),
      );
    base += byteLength(chunk.text);
  }
  return Object.freeze({ text, ranges: Object.freeze(ranges) });
};

/** Counts final UTF-8 bytes while writing; gaps have no authored attribution. */
export class SourceWriter {
  private readonly chunks: string[] = [];
  private offset = 0;
  private readonly mappings: GeneratedRange[] = [];
  private readonly encoder: TextEncoder | undefined;
  constructor(
    readonly file: string,
    readonly trackRanges = true,
  ) {
    this.encoder = trackRanges ? new TextEncoder() : undefined;
  }
  write(text: string): void {
    const first = text.charCodeAt(0),
      last = text.charCodeAt(text.length - 1);
    if ((first >= 0xdc00 && first <= 0xdfff) || (last >= 0xd800 && last <= 0xdbff))
      throw new TypeError("Source writer chunks must not split surrogate pairs");
    this.chunks.push(text);
    if (this.encoder) this.offset += this.encoder.encode(text).length;
  }
  mapped(
    origin: string | undefined,
    occurrence: string | undefined,
    write: () => void,
    role?: GeneratedRange["role"],
  ): void {
    if (!this.trackRanges || origin === undefined) {
      write();
      return;
    }
    const start = this.offset;
    write();
    if (start < this.offset)
      this.mappings.push(
        Object.freeze({
          file: this.file,
          start,
          end: this.offset,
          origin,
          ...(occurrence === undefined ? {} : { occurrence }),
          role: role ?? (occurrence === undefined ? "definition" : "use"),
        }),
      );
  }
  /** Writes a composed fragment and turns its relative ranges into file ranges. */
  writeFragment(fragment: MappedFragment): void {
    const base = this.offset;
    this.write(fragment.text);
    if (!this.trackRanges) return;
    for (const range of fragment.ranges) {
      const start = base + range.start;
      const end = base + range.end;
      if (start >= end) continue;
      this.mappings.push(
        Object.freeze({
          file: this.file,
          start,
          end,
          origin: range.origin,
          ...(range.occurrence === undefined ? {} : { occurrence: range.occurrence }),
          role: range.role ?? (range.occurrence === undefined ? "definition" : "use"),
        }),
      );
    }
  }
  get text(): string {
    return this.chunks.join("");
  }
  get ranges(): readonly GeneratedRange[] {
    return Object.freeze([...this.mappings]);
  }
}
