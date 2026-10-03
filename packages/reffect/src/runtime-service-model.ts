import { Predicate } from "effect";
import { SemanticRef, fail } from "./kernel.ts";

export const ClockRequirement = SemanticRef.requirement("reffect/service/clock-millis@1");
export const RandomRequirement = SemanticRef.requirement("reffect/service/random-double@1");

/** Selects concrete native service drivers; runtime scripts remain trusted-host owned. */
export interface RuntimeServicesSelection {
  readonly clock?: "LiveMillis" | "InjectedMillis";
  readonly random?: "ScriptedRandom";
}
export interface ResolvedRuntimeServicesSelection {
  readonly clock: "LiveMillis" | "InjectedMillis";
  readonly random?: "ScriptedRandom";
}
export const defaultRuntimeServices = Object.freeze({ clock: "LiveMillis" as const });

/** Checked immutable planning configuration, distinct from operation implementations. */
export const normalizeRuntimeServicesSelection = (
  selection: RuntimeServicesSelection = defaultRuntimeServices,
): ResolvedRuntimeServicesSelection => {
  if (
    !Predicate.isObject(selection) ||
    Array.isArray(selection) ||
    Object.keys(selection).some((key) => key !== "clock" && key !== "random") ||
    (selection.clock !== undefined &&
      selection.clock !== "LiveMillis" &&
      selection.clock !== "InjectedMillis") ||
    (selection.random !== undefined && selection.random !== "ScriptedRandom")
  )
    throw fail(
      "INVALID_SERVICE_SELECTION",
      "plan",
      "runtimeServices",
      "Select LiveMillis/InjectedMillis clock and optional ScriptedRandom driver",
    );
  return Object.freeze({
    clock: selection.clock ?? "LiveMillis",
    ...(selection.random ? { random: selection.random } : {}),
  });
};
