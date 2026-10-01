import { Schema } from "effect";
import { R, type Computation } from "../../../src/index.ts";

let failure: Computation<bigint, bigint> = R.Effect.fail(R.U64.literal(9n));
for (let i = 0; i < 128; i++) failure = R.Effect.map(failure, () => R.U64.literal(1n));
export const costFn = R.fn([R.Bool], R.U64, R.U64, (flag) =>
  R.Match.bool(flag, R.Effect.succeed(R.U64.literal(7n)), failure),
);
export const layoutProbe = (enabled: boolean): string => `
pub fn measured_other_layouts() -> [usize; 6] {
    [std::mem::size_of::<Result<bool, bool>>(),
     std::mem::size_of::<${enabled ? "Result<bool, (bool, Box<FrameTrail>)>" : "Result<bool, bool>"}>(),
     std::mem::size_of::<Result<(), ()>>(),
     std::mem::size_of::<${enabled ? "Result<(), ((), Box<FrameTrail>)>" : "Result<(), ()>"}>(),
     std::mem::size_of::<Result<u64, std::convert::Infallible>>(),
     std::mem::size_of::<${enabled ? "Result<u64, (std::convert::Infallible, Box<FrameTrail>)>" : "Result<u64, std::convert::Infallible>"}>()]
}

pub fn measured_helper_layout() -> (usize, usize) {
    (std::mem::size_of_val(&h_cost_0(true)),
     ${enabled ? "std::mem::size_of::<FrameTrail>()" : "0"})
}
`;

/** Measurements exclude printing, frame observation and CLI argument parsing. */
export const costMain = (enabled: boolean): string => `
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
struct Counting;
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
// Forward the allocator contract unchanged; counters do not allocate or call generated code.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(size, Ordering::Relaxed);
        unsafe { System.realloc(ptr, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Counting = Counting;
fn main() {
    let n: usize = std::env::args().nth(1).unwrap_or_else(|| "1000".into()).parse().unwrap();
    // Warm the synchronous TLS before measuring to isolate invocation costs.
    assert_eq!(reffect_generated::r_cost(false), Err(9));
    ${enabled ? "reffect_generated::clear_last_frames();" : ""}
    let mut results = [(0usize, 0usize, 0u128); 2];
    for (index, flag) in [true, false].into_iter().enumerate() {
        ALLOCS.store(0, Ordering::Relaxed);
        BYTES.store(0, Ordering::Relaxed);
        let start = std::time::Instant::now();
        for _ in 0..n {
            let value = reffect_generated::r_cost(std::hint::black_box(flag));
            assert_eq!(std::hint::black_box(value), if flag { Ok(7) } else { Err(9) });
        }
        results[index] = (ALLOCS.load(Ordering::Relaxed), BYTES.load(Ordering::Relaxed), start.elapsed().as_nanos());
    }
    let (frames, omitted, drained) = ${
      enabled
        ? `{
        let (frames, omitted) = reffect_generated::take_last_frames();
        let second = reffect_generated::take_last_frames();
        (frames.len(), omitted, second.0.is_empty() && second.1 == 0)
    }`
        : "(0usize, 0usize, true)"
    };
    let other = reffect_generated::measured_other_layouts();
    let (helper_bytes, trail_bytes) = reffect_generated::measured_helper_layout();
    println!("{}", format!(r#"{{"iterations":{},"scalar_bytes":{},"plain_result_bytes":{},"legacy_result_bytes":{},"inline_result_bytes":{},"helper_bytes":{},"trail_bytes":{},"success_allocs":{},"success_bytes":{},"success_ns":{},"failure_allocs":{},"failure_bytes":{},"failure_ns":{},"frames":{},"omitted":{},"drained":{},"bool_plain_bytes":{},"bool_helper_bytes":{},"unit_plain_bytes":{},"unit_helper_bytes":{},"never_plain_bytes":{},"never_helper_bytes":{}}}"#,
        n, std::mem::size_of::<u64>(), std::mem::size_of::<Result<u64, u64>>(),
        std::mem::size_of::<Result<u64, (u64, Vec<&'static str>)>>(),
        std::mem::size_of::<Result<u64, (u64, [&'static str; 32], usize, usize)>>(),
        helper_bytes, trail_bytes, results[0].0, results[0].1, results[0].2,
        results[1].0, results[1].1, results[1].2, frames, omitted, drained, other[0], other[1], other[2], other[3], other[4], other[5]));
}
`;

export const CostRecord = Schema.Struct({
  iterations: Schema.Number,
  scalar_bytes: Schema.Number,
  plain_result_bytes: Schema.Number,
  legacy_result_bytes: Schema.Number,
  inline_result_bytes: Schema.Number,
  helper_bytes: Schema.Number,
  trail_bytes: Schema.Number,
  success_allocs: Schema.Number,
  success_bytes: Schema.Number,
  success_ns: Schema.Number,
  failure_allocs: Schema.Number,
  failure_bytes: Schema.Number,
  failure_ns: Schema.Number,
  frames: Schema.Number,
  omitted: Schema.Number,
  drained: Schema.Boolean,
  bool_plain_bytes: Schema.Number,
  bool_helper_bytes: Schema.Number,
  unit_plain_bytes: Schema.Number,
  unit_helper_bytes: Schema.Number,
  never_plain_bytes: Schema.Number,
  never_helper_bytes: Schema.Number,
});
