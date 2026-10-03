/** Audited std-only service scaffold, selected by actual context reachability. */
export interface RuntimeServiceUsage {
  readonly clock: boolean;
  readonly random: boolean;
}
export const runtimeServiceFields = (usage: RuntimeServiceUsage): string =>
  `${usage.clock ? "clock: ClockDriver," : ""}${usage.random ? "random: RandomDriver," : ""}`;
export const runtimeServiceInitializers = (usage: RuntimeServiceUsage): string =>
  `${usage.clock ? "clock: ClockDriver::Live," : ""}${usage.random ? "random: RandomDriver { values: Vec::new(), cursor: 0 }," : ""}`;
export const runtimeServiceMethods = (usage: RuntimeServiceUsage): string => `
${
  usage.clock
    ? `
    /// Configures explicit computation reads; logger timestamps and Sleep remain live.
    pub fn set_clock_stable(&mut self, value: f64) {
        validate_clock_millis(value);
        self.clock = ClockDriver::Stable(value);
    }
    pub fn set_clock_script(&mut self, values: Vec<f64>) {
        for &value in &values { validate_clock_millis(value); }
        self.clock = ClockDriver::Scripted { values, cursor: 0 };
    }
    fn clock_millis(&mut self) -> f64 { self.clock.read() }
`
    : ""
}
${
  usage.random
    ? `
    /// Trusted host injection; never a request-payload parameter.
    pub fn set_random_script(&mut self, values: Vec<f64>) {
        for &value in &values {
            assert!(value.is_finite() && value >= 0.0 && value < 1.0, "Invalid scripted Random draw: expected finite [0, 1)");
        }
        self.random = RandomDriver { values, cursor: 0 };
    }
    fn random_next(&mut self) -> f64 { self.random.draw() }
`
    : ""
}
`;
export const runtimeServicesPrelude = (
  liveClock: boolean,
  injectedClock: boolean,
  random: boolean,
  sync: RuntimeServiceUsage,
): string => `
${
  liveClock || injectedClock
    ? `
/// Signed wall milliseconds, checked before converting the integer to f64.
fn live_clock_millis() -> f64 {
    const SAFE: u128 = 9_007_199_254_740_991;
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => {
            let millis = duration.as_millis();
            assert!(millis <= SAFE, "Live Clock milliseconds exceed safe integer representation");
            millis as f64
        }
        Err(error) => {
            let nanos = error.duration().as_nanos();
            let millis = nanos / 1_000_000 + u128::from(nanos % 1_000_000 != 0);
            assert!(millis <= SAFE, "Live Clock milliseconds precede safe integer representation");
            -(millis as f64)
        }
    }
}
`
    : ""
}
${
  injectedClock
    ? `
fn validate_clock_millis(value: f64) {
    assert!(value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0,
        "Invalid injected Clock milliseconds: expected a finite signed safe integer");
}
enum ClockDriver {
    Live,
    Stable(f64),
    Scripted { values: Vec<f64>, cursor: usize },
}
impl ClockDriver {
    fn read(&mut self) -> f64 {
        match self {
            Self::Live => live_clock_millis(),
            Self::Stable(value) => *value,
            Self::Scripted { values, cursor } => {
                let value = *values.get(*cursor).expect("Scripted Clock exhausted: trusted host configuration fault");
                *cursor += 1;
                value
            }
        }
    }
}
`
    : ""
}
${
  random
    ? `
struct RandomDriver { values: Vec<f64>, cursor: usize }
impl RandomDriver {
    fn draw(&mut self) -> f64 {
        let value = *self.values.get(self.cursor).expect("Scripted Random exhausted or unconfigured: trusted host configuration fault");
        self.cursor += 1;
        value
    }
}
`
    : ""
}
${
  sync.clock || sync.random
    ? `
/// Owned invocation-local services for synchronous generated computations.
pub struct SyncContext { ${runtimeServiceFields(sync)} }
impl SyncContext {
    pub fn new() -> Self { Self { ${runtimeServiceInitializers(sync)} } }
    ${runtimeServiceMethods(sync)}
}
impl Default for SyncContext { fn default() -> Self { Self::new() } }
`
    : ""
}
`;
