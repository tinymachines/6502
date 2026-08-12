//! What the CPU talks to.
//!
//! The reference wired the simulator directly to a global array and hooked I/O
//! by `eval`-ing strings out of a table. This is the same capability as a trait,
//! which also lets a front end map devices, trap on regions, or serve ROM.

/// A device (or whole memory map) attached to the 6502's bus.
pub trait Bus {
    fn read(&mut self, addr: u16) -> u8;
    fn write(&mut self, addr: u16, value: u8);

    /// Return an opaque token that [`Bus::rollback`] can later restore to.
    ///
    /// Returning `None` (the default) means this bus cannot be rewound, and
    /// time travel will be limited to the chip state. A bus backed by plain RAM
    /// can implement this in O(1) by journalling writes.
    fn checkpoint(&mut self) -> Option<Vec<u8>> {
        None
    }

    /// Undo every write made since `token` was issued. Returns false if the
    /// token is not restorable (too old, or rewind unsupported).
    fn rollback(&mut self, _token: &[u8]) -> bool {
        false
    }
}

/// 64 KiB of flat RAM with an undo journal.
///
/// The journal records the *previous* value of every write, so rewinding is
/// O(writes since the checkpoint) rather than O(address space) -- checkpoints
/// are just a cursor, which is what makes per-half-cycle history affordable.
pub struct FlatMemory {
    cells: Box<[u8; 65536]>,
    journal: Vec<(u16, u8)>,
    journalling: bool,
}

impl Default for FlatMemory {
    fn default() -> Self {
        Self::new()
    }
}

impl FlatMemory {
    pub fn new() -> Self {
        FlatMemory {
            cells: Box::new([0u8; 65536]),
            journal: Vec::new(),
            journalling: true,
        }
    }

    /// Load bytes at `addr` without journalling, for setting up initial state.
    pub fn load(&mut self, addr: u16, bytes: &[u8]) {
        for (i, &b) in bytes.iter().enumerate() {
            self.cells[addr.wrapping_add(i as u16) as usize] = b;
        }
    }

    /// Set the reset vector at `$FFFC/$FFFD`.
    pub fn set_reset_vector(&mut self, addr: u16) {
        self.cells[0xfffc] = addr as u8;
        self.cells[0xfffd] = (addr >> 8) as u8;
    }

    /// Read without going through the bus (no journalling, no side effects).
    pub fn peek(&self, addr: u16) -> u8 {
        self.cells[addr as usize]
    }

    pub fn set_journalling(&mut self, on: bool) {
        self.journalling = on;
    }

    pub fn journal_len(&self) -> usize {
        self.journal.len()
    }

    /// Drop history older than the current point.
    pub fn clear_journal(&mut self) {
        self.journal.clear();
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.cells[..]
    }
}

impl Bus for FlatMemory {
    #[inline]
    fn read(&mut self, addr: u16) -> u8 {
        self.cells[addr as usize]
    }

    #[inline]
    fn write(&mut self, addr: u16, value: u8) {
        if self.journalling {
            self.journal.push((addr, self.cells[addr as usize]));
        }
        self.cells[addr as usize] = value;
    }

    fn checkpoint(&mut self) -> Option<Vec<u8>> {
        self.journalling.then(|| (self.journal.len() as u64).to_le_bytes().to_vec())
    }

    fn rollback(&mut self, token: &[u8]) -> bool {
        let Ok(bytes) = <[u8; 8]>::try_from(token) else {
            return false;
        };
        let target = u64::from_le_bytes(bytes) as usize;
        if target > self.journal.len() {
            return false; // checkpoint is in the future, or journal was cleared
        }
        while self.journal.len() > target {
            let (addr, old) = self.journal.pop().expect("len checked above");
            self.cells[addr as usize] = old;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_rewinds_writes() {
        let mut m = FlatMemory::new();
        m.load(0x10, &[0xaa]);
        let cp = m.checkpoint().expect("journalling is on");
        m.write(0x10, 0x01);
        m.write(0x10, 0x02);
        m.write(0x20, 0x03);
        assert_eq!(m.peek(0x10), 0x02);
        assert!(m.rollback(&cp));
        assert_eq!(m.peek(0x10), 0xaa);
        assert_eq!(m.peek(0x20), 0x00);
    }

    #[test]
    fn rollback_rejects_a_future_checkpoint() {
        let mut m = FlatMemory::new();
        m.write(0, 1);
        let cp = m.checkpoint().unwrap();
        m.clear_journal();
        assert!(!m.rollback(&cp));
    }
}
