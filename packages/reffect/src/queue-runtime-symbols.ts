export type QueueRuntimeFamily = "Default" | "Fallible";

const defaultSymbols = Object.freeze({
  QueueRequest: "QueueRequest",
  QueueResponse: "QueueResponse",
  QueueRequestPhase: "QueueRequestPhase",
  QueueRequestSlot: "QueueRequestSlot",
  QueueBridge: "QueueBridge",
  QueueTask: "QueueTask",
  QueueRequestFuture: "QueueRequestFuture",
  QueueBoundary: "QueueBoundary",
  QueueDriver: "QueueDriver",
  QueueCleanupMask: "QueueCleanupMask",
});

type QueueRuntimeSymbols = Readonly<Record<keyof typeof defaultSymbols, string>>;

const fallibleSymbols = Object.freeze({
  QueueRequest: "FallibleQueueRequest",
  QueueResponse: "FallibleQueueResponse",
  QueueRequestPhase: "FallibleQueueRequestPhase",
  QueueRequestSlot: "FallibleQueueRequestSlot",
  QueueBridge: "FallibleQueueBridge",
  QueueTask: "FallibleQueueTask",
  QueueRequestFuture: "FallibleQueueRequestFuture",
  QueueBoundary: "FallibleQueueBoundary",
  QueueDriver: "FallibleQueueDriver",
  QueueCleanupMask: "FallibleQueueCleanupMask",
} satisfies QueueRuntimeSymbols);

export const queueRuntimeSymbols = (family: QueueRuntimeFamily = "Default"): QueueRuntimeSymbols =>
  family === "Fallible" ? fallibleSymbols : defaultSymbols;

const fallibleReplacements = new Map(Object.entries(fallibleSymbols));

/** Fixed owned-template specialization, never a rewrite of authored Rust source. */
export const specializeQueueRuntime = (source: string, family: QueueRuntimeFamily): string =>
  family === "Default"
    ? source
    : source.replace(
        /\b[A-Za-z_][A-Za-z0-9_]*\b/g,
        (identifier) => fallibleReplacements.get(identifier) ?? identifier,
      );
