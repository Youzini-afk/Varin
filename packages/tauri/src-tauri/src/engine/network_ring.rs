//! Monotonic stream cursors over a bounded shared ring. No CEF or OS dependency.
#[derive(Default)]
pub struct Window {
    pub available: u64,
    consumed: u64,
    announced: u64,
}
impl Window {
    pub fn acknowledge(&mut self, consumed: u64) -> Result<(), &'static str> {
        if consumed < self.consumed || consumed > self.available {
            return Err("Network read cursor is outside committed data");
        }
        self.consumed = consumed;
        Ok(())
    }
    /// At most one unread cursor notification per request. A final flush must
    /// be emitted before complete so no data event follows a terminal receipt.
    pub fn notification(&mut self, final_flush: bool) -> Option<u64> {
        if self.available <= self.announced || (!final_flush && self.consumed < self.announced) {
            return None;
        }
        self.announced = self.available;
        Some(self.available)
    }
    pub fn full(&self, capacity: u64) -> bool {
        self.available - self.consumed >= capacity
    }
    pub fn write_span(&self, capacity: u64, desired: usize) -> (u64, usize) {
        let offset = self.available % capacity;
        let count = (capacity - (self.available - self.consumed))
            .min(capacity - offset)
            .min(desired as u64);
        (offset, count as usize)
    }
    pub fn commit(&mut self, count: usize) {
        self.available += count as u64;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coalesces_tiny_chunks_until_the_announced_cursor_is_consumed() {
        let mut window = Window::default();
        window.commit(1);
        assert_eq!(window.notification(false), Some(1));
        for _ in 0..10_000 {
            window.commit(1);
            assert_eq!(window.notification(false), None);
        }
        window.acknowledge(1).unwrap();
        assert_eq!(window.notification(false), Some(10_001));
        window.commit(7);
        assert_eq!(window.notification(false), None);
        assert_eq!(window.notification(true), Some(10_008));
        window.acknowledge(10_008).unwrap();
        assert_eq!(window.notification(false), None);
        assert_eq!(window.notification(true), None);
    }
    #[test]
    fn never_overwrites_unacknowledged_data() {
        let mut window = Window::default();
        assert_eq!(window.write_span(8, 12), (0, 8));
        window.commit(8);
        assert!(window.full(8));
        assert_eq!(window.write_span(8, 12), (0, 0));
        window.acknowledge(3).unwrap();
        assert_eq!(window.write_span(8, 12), (0, 3));
    }
    #[test]
    fn splits_at_physical_end_without_changing_logical_cursor() {
        let mut window = Window::default();
        window.commit(6);
        window.acknowledge(6).unwrap();
        assert_eq!(window.write_span(8, 7), (6, 2));
        window.commit(2);
        assert_eq!(window.write_span(8, 5), (0, 5));
    }
    #[test]
    fn ack_is_monotonic_bounded_and_idempotent() {
        let mut window = Window::default();
        window.commit(7);
        assert!(window.acknowledge(8).is_err());
        window.acknowledge(5).unwrap();
        window.acknowledge(5).unwrap();
        assert!(window.acknowledge(4).is_err());
        assert_eq!(window.write_span(8, 9), (7, 1));
    }
    #[test]
    fn slow_reader_receives_exact_bytes_across_thousands_of_wraps() {
        let mut window = Window::default();
        let mut ring = [0_u8; 17];
        let input: Vec<u8> = (0..100_003).map(|i| (i % 251) as u8).collect();
        let mut written = 0;
        let mut consumed = 0;
        let mut output = Vec::new();
        while consumed < input.len() {
            let (offset, count) = window.write_span(17, input.len() - written);
            ring[offset as usize..offset as usize + count]
                .copy_from_slice(&input[written..written + count]);
            window.commit(count);
            written += count;
            let count = ((window.available as usize - consumed).min(3)).min(17 - consumed % 17);
            output.extend_from_slice(&ring[consumed % 17..consumed % 17 + count]);
            consumed += count;
            window.acknowledge(consumed as u64).unwrap();
        }
        assert_eq!(input, output);
        assert_eq!(ring.len(), 17);
    }
}
