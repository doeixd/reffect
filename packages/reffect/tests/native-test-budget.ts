// Windows taskkill can stall for roughly a minute after each nonzero process exit.
// Keep real failure assertions and scoped cleanup; allow a bounded budget for those calls.
export const nativeTestBudget = (processFailures: number): number =>
  120000 + (process.platform === "win32" ? processFailures * 65000 : 0);
