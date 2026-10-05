/**
 * Authoring rules of the `R.Html` profile that need no compiler (#14): `html.ts` checks them while
 * a view is built, in the browser as on the server.
 */

/** Elements a `Value` is admitted on: an attribute, or a textarea's content (8B). */
const VALUE_ELEMENTS: ReadonlySet<string> = new Set([
  "button",
  "input",
  "option",
  "select",
  "textarea",
]);
/** Attributes the profile refuses on an element because Foldkit's builder rejects most values. */
export const refusedOn = (tag: string, attribute: string): boolean =>
  attribute === "Value" && !VALUE_ELEMENTS.has(tag);
