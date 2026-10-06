/** Inline leases for the checked generated timer profile (STIM-001–006). */
export const semaphoreTimerRuntime = (registrations: number): string => `
#[derive(Clone, Copy)]
struct ScanTimer { deadline: tokio::time::Instant, ticket: usize, granted: bool }
struct ScanTimers<const N: usize> { entries: [Option<ScanTimer>; N], registrations: usize }
#[derive(Clone, Copy)]
struct ScanTimerReady { task: usize, ticket: usize }
impl<const N: usize> ScanTasks<N> {
    fn register_timer(&self, task: usize, milliseconds: u64) -> ScanTimerLease<'_, N> {
        assert!(task != 0 && task < N && milliseconds > 0, "Checked positive child timer");
        let mut timers = self.timers.lock().expect("Scan timer bank");
        assert!(timers.entries[task].is_none(), "One live timer per task");
        assert!(timers.registrations < ${registrations}, "Checked timer registration bound");
        timers.registrations += 1;
        let ticket = timers.registrations;
        timers.entries[task] = Some(ScanTimer {
            deadline: tokio::time::Instant::now() + std::time::Duration::from_millis(milliseconds),
            ticket, granted: false,
        });
        ScanTimerLease { bank: self, task, ticket }
    }
    fn timer_wave<const K: usize>(&self, slots: [usize; K], now: tokio::time::Instant)
        -> [Option<ScanTimerReady>; K] {
        let timers = self.timers.lock().expect("Scan timer bank");
        let mut wave = [None; K];
        let mut count = 0;
        for task in slots {
            if let Some(timer) = timers.entries[task] {
                if !timer.granted && timer.deadline <= now {
                    let ready = ScanTimerReady { task, ticket: timer.ticket };
                    let mut index = count;
                    while index > 0 && wave[index - 1].is_some_and(|previous: ScanTimerReady| previous.ticket > ready.ticket) {
                        wave[index] = wave[index - 1];
                        index -= 1;
                    }
                    wave[index] = Some(ready);
                    count += 1;
                }
            }
        }
        wave
    }
    fn next_timer_deadline<const K: usize>(&self, slots: [usize; K]) -> Option<tokio::time::Instant> {
        let timers = self.timers.lock().expect("Scan timer bank");
        slots.into_iter().filter_map(|task| timers.entries[task])
            .filter(|timer| !timer.granted).map(|timer| timer.deadline).min()
    }
    fn grant_timer(&self, ready: ScanTimerReady) -> bool {
        let mut timers = self.timers.lock().expect("Scan timer bank");
        if let Some(timer) = &mut timers.entries[ready.task] {
            if timer.ticket == ready.ticket && !timer.granted {
                timer.granted = true;
                return true;
            }
        }
        false
    }
}
struct ScanTimerLease<'a, const N: usize> { bank: &'a ScanTasks<N>, task: usize, ticket: usize }
impl<const N: usize> ScanTimerLease<'_, N> {
    fn granted(&self) -> bool {
        self.bank.timers.lock().expect("Scan timer bank").entries[self.task]
            .is_some_and(|timer| timer.ticket == self.ticket && timer.granted)
    }
}
impl<const N: usize> Drop for ScanTimerLease<'_, N> {
    fn drop(&mut self) {
        let mut timers = self.bank.timers.lock().expect("Scan timer bank");
        if timers.entries[self.task].is_some_and(|timer| timer.ticket == self.ticket) {
            timers.entries[self.task] = None;
        }
    }
}
`;
