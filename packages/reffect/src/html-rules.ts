/**
 * Authoring rules of the `R.Html` profile that need no compiler (#14): `html.ts` checks them while
 * a view is built, in the browser as on the server.
 */

/** Attributes the profile refuses on an element because Foldkit's builder rejects most values. */
export const refusedOn = (tag: string, attribute: string): boolean =>
  attribute === "Value" && tag !== "button" && tag !== "input";
