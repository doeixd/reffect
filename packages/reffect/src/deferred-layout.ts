/** NLAY-001: internal native build policy, separate from structural IR receipts. */
export const generatedDeferredFutureLayoutPointers = 2560;

// Return a value-bearing const: optimized builds can erase an unused unit const.
// Borrow the actual returned future rather than introducing a by-value helper copy.
export const generatedDeferredFutureLayoutPrelude = `#[inline(always)]
fn assert_deferred_future_layout<F: std::future::Future>(_: &F) -> usize {
    const {
        assert!(std::mem::size_of::<F>() <= ${generatedDeferredFutureLayoutPointers} * std::mem::size_of::<usize>(), "REFFECT_DEFERRED_FUTURE_LAYOUT");
        std::mem::size_of::<F>()
    }
}

`;
