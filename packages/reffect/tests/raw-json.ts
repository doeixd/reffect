/** Test helpers for comparing raw JSON response text, where key order is observable. */
// JSON.parse moves index keys first, hiding byte order, so this reader keeps object keys exactly
// as written. Scalars are parsed: number formatting is parse-equal only (NUM-004).
export type Raw = unknown;
interface RawObject {
  readonly keys: readonly (readonly [string, Raw])[];
}
const isRawObject = (raw: Raw): raw is RawObject =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) && "keys" in raw;
export const readRaw = (text: string): Raw => {
  let i = 0;
  const space = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  const string = (): string => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): Raw => {
    space();
    if (text[i] === "{") {
      i++;
      const keys: (readonly [string, Raw])[] = [];
      space();
      while (text[i] !== "}") {
        space();
        const key = string();
        space();
        i++;
        keys.push([key, value()]);
        space();
        if (text[i] === ",") i++;
        space();
      }
      i++;
      return { keys };
    }
    if (text[i] === "[") {
      i++;
      const items: Raw[] = [];
      space();
      while (text[i] !== "]") {
        items.push(value());
        space();
        if (text[i] === ",") i++;
        space();
      }
      i++;
      return items;
    }
    const start = i;
    if (text[i] === '"') string();
    else while (i < text.length && !/[,}\]\s]/.test(text[i])) i++;
    return JSON.parse(text.slice(start, i));
  };
  return value();
};
// The success value of the single response message, with its raw key order.
export const successValue = (body: string): Raw => {
  const field = (raw: Raw, name: string) =>
    isRawObject(raw) ? raw.keys.find(([key]) => key === name)?.[1] : undefined;
  const messages = readRaw(body);
  const exit = field(Array.isArray(messages) ? messages[0] : undefined, "exit");
  return field(exit, "value");
};
