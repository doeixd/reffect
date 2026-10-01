import type { GeneratedRange } from "./source-artifact.ts";

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
  get text(): string {
    return this.chunks.join("");
  }
  get ranges(): readonly GeneratedRange[] {
    return Object.freeze([...this.mappings]);
  }
}
