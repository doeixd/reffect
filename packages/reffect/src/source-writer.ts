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

/**
 * UTF-8 length without encoding: what `TextEncoder` writes, a lone surrogate counting as its
 * three-byte replacement character.
 */
const byteLength = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

type Attribution = Omit<RelativeRange, "start" | "end">;
interface Pending {
  readonly fragment: Fragment;
  readonly start: number;
  readonly close: boolean;
}
/**
 * A rope (#32): composing fragments links them, and the text, the byte lengths and the shifted
 * ranges are each computed once, when read. Copying the text and every range at each nesting
 * level made full source maps cost about four times as much as none.
 */
class Fragment implements MappedFragment {
  private textCache: string | undefined;
  private bytesCache: number | undefined;
  private rangesCache: readonly RelativeRange[] | undefined;
  /** Whether any range lies inside; an unmapped fragment is never measured. */
  readonly mapped: boolean;
  constructor(
    /** A leaf's text, with the ranges it already holds relative to itself. */
    private readonly leaf:
      | { readonly text: string; readonly ranges: readonly RelativeRange[] }
      | undefined,
    private readonly parts: readonly Fragment[],
    /** The range this fragment is attributed to as a whole. */
    private readonly own: Attribution | undefined,
  ) {
    this.mapped =
      own !== undefined ||
      (leaf !== undefined && leaf.ranges.length > 0) ||
      parts.some((part) => part.mapped);
  }
  get text(): string {
    if (this.textCache !== undefined) return this.textCache;
    const out: string[] = [];
    const pending: Fragment[] = [this];
    while (pending.length) {
      const fragment = pending.pop()!;
      if (fragment.textCache !== undefined) out.push(fragment.textCache);
      else if (fragment.leaf !== undefined) out.push(fragment.leaf.text);
      else for (let i = fragment.parts.length - 1; i >= 0; i--) pending.push(fragment.parts[i]);
    }
    this.textCache = out.join("");
    return this.textCache;
  }
  get bytes(): number {
    if (this.bytesCache === undefined)
      this.bytesCache =
        this.leaf !== undefined
          ? byteLength(this.leaf.text)
          : this.parts.reduce((total, part) => total + part.bytes, 0);
    return this.bytesCache;
  }
  get ranges(): readonly RelativeRange[] {
    if (this.rangesCache !== undefined) return this.rangesCache;
    const ranges: RelativeRange[] = [];
    // Inner ranges precede the range around them, as composition has always ordered them.
    const pending: Pending[] = [{ fragment: this, start: 0, close: false }];
    while (pending.length) {
      const { fragment, start, close } = pending.pop()!;
      if (close) {
        ranges.push(Object.freeze({ ...fragment.own!, start, end: start + fragment.bytes }));
        continue;
      }
      if (!fragment.mapped) continue;
      if (fragment.own) pending.push({ fragment, start, close: true });
      if (fragment.leaf !== undefined)
        for (const range of fragment.leaf.ranges)
          ranges.push(
            Object.freeze({ ...range, start: range.start + start, end: range.end + start }),
          );
      const children: Pending[] = [];
      let offset = start;
      let last = fragment.parts.length - 1;
      while (last >= 0 && !fragment.parts[last].mapped) last--;
      for (let i = 0; i <= last; i++) {
        const part = fragment.parts[i];
        if (part.mapped) children.push({ fragment: part, start: offset, close: false });
        if (i < last) offset += part.bytes;
      }
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
    this.rangesCache = Object.freeze(ranges);
    return this.rangesCache;
  }
}
const noRanges: readonly RelativeRange[] = Object.freeze([]);
const asFragment = (part: string | MappedFragment): Fragment =>
  part instanceof Fragment
    ? part
    : typeof part === "string"
      ? new Fragment({ text: part, ranges: noRanges }, [], undefined)
      : new Fragment({ text: part.text, ranges: part.ranges }, [], undefined);

/** Plain generated text with no authored attribution. */
export const textFragment = (text: string): MappedFragment =>
  new Fragment({ text, ranges: noRanges }, [], undefined);

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
  const fragment = asFragment(inner);
  if (fragment.bytes === 0) return inner;
  return new Fragment(undefined, [fragment], {
    origin,
    ...(occurrence === undefined ? {} : { occurrence }),
    role: role ?? (occurrence === undefined ? "definition" : "use"),
  });
};

/** Concatenates fragments, shifting each part's ranges into the result. */
export const joinFragments = (parts: ReadonlyArray<string | MappedFragment>): MappedFragment =>
  new Fragment(undefined, parts.map(asFragment), undefined);

/**
 * A file range, its keys in sorted order: the build digest serializes records sorted, and a
 * record already in order needs no copy there (#32).
 */
const generatedRange = (
  file: string,
  start: number,
  end: number,
  origin: string,
  occurrence: string | undefined,
  role: GeneratedRange["role"] | undefined,
): GeneratedRange =>
  Object.freeze({
    end,
    file,
    ...(occurrence === undefined ? {} : { occurrence }),
    origin,
    role: role ?? (occurrence === undefined ? "definition" : "use"),
    start,
  });
/** Counts final UTF-8 bytes while writing; gaps have no authored attribution. */
export class SourceWriter {
  private readonly chunks: string[] = [];
  private offset = 0;
  private readonly mappings: GeneratedRange[] = [];
  constructor(
    readonly file: string,
    readonly trackRanges = true,
  ) {}
  write(text: string): void {
    const first = text.charCodeAt(0),
      last = text.charCodeAt(text.length - 1);
    if ((first >= 0xdc00 && first <= 0xdfff) || (last >= 0xd800 && last <= 0xdbff))
      throw new TypeError("Source writer chunks must not split surrogate pairs");
    this.chunks.push(text);
    if (this.trackRanges) this.offset += byteLength(text);
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
      this.mappings.push(generatedRange(this.file, start, this.offset, origin, occurrence, role));
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
        generatedRange(this.file, start, end, range.origin, range.occurrence, range.role),
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
