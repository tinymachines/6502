//! Snapshot and restore: the whole machine as a value.
//!
//! The keyframed rewind in `history.rs` already proves the point this module
//! turns into an interface: the chip's entire mutable state is the four
//! bitsets of [`ChipState`], and copying them into an engine -- any engine
//! built on the same netlist, including one in a different process on a
//! different day -- resumes the simulation bit for bit. `tests/state.rs`
//! asserts exactly that, over every node at every half-cycle.
//!
//! What travels: the four bitsets, the half-cycle counter, and the last
//! opcode fetch (which is bookkeeping for disassembly, not silicon). Memory
//! is the bus's problem and travels beside it.
//!
//! The wire encoding is lowercase hex of the bitset's bytes, bit `i` of the
//! set in byte `i / 8` at position `i % 8` (LSB first), zero-padded to the
//! full width -- the same convention the halfshot export uses for node
//! levels, with the node numbering being visual6502's own. Node bitsets are
//! 1725 bits in 216 bytes; the transistor set is 3510 bits in 439 bytes.

use halfphi::engine::ChipState;

use crate::bus::Bus;
use crate::cpu::{Cpu, Fetch};

/// Everything the chip is, as a value: enough to resume in a fresh process.
#[derive(Clone, Debug)]
pub struct MachineState {
    pub half_cycle: u64,
    pub last_fetch: Option<Fetch>,
    pub chip: ChipState,
}

/// Take a snapshot. Cheap: four bitset clones.
pub fn snapshot<B: Bus>(cpu: &Cpu<B>) -> MachineState {
    MachineState {
        half_cycle: cpu.half_cycle(),
        last_fetch: cpu.last_fetch(),
        chip: cpu.engine().state().clone(),
    }
}

/// Restore a snapshot into any CPU built on the same netlist. The engine's
/// scratch buffers need nothing: they are rebuilt by the next settle.
pub fn restore<B: Bus>(cpu: &mut Cpu<B>, st: &MachineState) {
    cpu.engine_mut().state_mut().copy_from(&st.chip);
    cpu.set_half_cycle(st.half_cycle);
    cpu.set_last_fetch(st.last_fetch);
}

// -- hex codec ------------------------------------------------------------

/// Bits to lowercase hex, LSB-first within each byte, padded to the width.
pub fn bits_to_hex(bits: &halfphi::netlist::BitSet) -> String {
    let nbytes = bits.len().div_ceil(8);
    let mut out = String::with_capacity(nbytes * 2);
    for byte in 0..nbytes {
        let mut b = 0u8;
        for bit in 0..8 {
            let i = byte * 8 + bit;
            if i < bits.len() && bits.get(i) {
                b |= 1 << bit;
            }
        }
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Hex back to bits. Refuses the wrong length, an odd length, a non-hex
/// character, and a set bit in the padding past `len` -- a blob that decodes
/// to the wrong chip is worse than one that is refused.
pub fn hex_to_bits(hex: &str, len: usize) -> Result<halfphi::netlist::BitSet, String> {
    let nbytes = len.div_ceil(8);
    if hex.len() != nbytes * 2 {
        return Err(format!("expected {} hex chars for {} bits, got {}", nbytes * 2, len, hex.len()));
    }
    let mut bits = halfphi::netlist::BitSet::new(len);
    for byte in 0..nbytes {
        let pair = &hex[byte * 2..byte * 2 + 2];
        let b = u8::from_str_radix(pair, 16).map_err(|_| format!("bad hex at byte {byte}: {pair:?}"))?;
        for bit in 0..8 {
            let i = byte * 8 + bit;
            let v = b >> bit & 1 != 0;
            if i >= len {
                if v {
                    return Err(format!("set bit {i} in padding past {len}"));
                }
                continue;
            }
            bits.put(i, v);
        }
    }
    Ok(bits)
}

impl MachineState {
    /// The four bitsets as hex, in the wire order:
    /// `value pullup pulldown trans_on`.
    pub fn chip_hex(&self) -> [String; 4] {
        [
            bits_to_hex(&self.chip.value),
            bits_to_hex(&self.chip.pullup),
            bits_to_hex(&self.chip.pulldown),
            bits_to_hex(&self.chip.trans_on),
        ]
    }

    /// Rebuild from the wire fields. `nodes` and `transistors` are the
    /// netlist's counts, which fix every blob's expected length. Eight
    /// arguments because the wire has eight fields; bundling them into a
    /// struct would only move the same list somewhere less checkable.
    #[allow(clippy::too_many_arguments)]
    pub fn from_hex(
        nodes: usize,
        transistors: usize,
        value: &str,
        pullup: &str,
        pulldown: &str,
        trans_on: &str,
        half_cycle: u64,
        last_fetch: Option<Fetch>,
    ) -> Result<Self, String> {
        Ok(MachineState {
            half_cycle,
            last_fetch,
            chip: ChipState {
                value: hex_to_bits(value, nodes).map_err(|e| format!("value: {e}"))?,
                pullup: hex_to_bits(pullup, nodes).map_err(|e| format!("pullup: {e}"))?,
                pulldown: hex_to_bits(pulldown, nodes).map_err(|e| format!("pulldown: {e}"))?,
                trans_on: hex_to_bits(trans_on, transistors).map_err(|e| format!("trans_on: {e}"))?,
            },
        })
    }
}
