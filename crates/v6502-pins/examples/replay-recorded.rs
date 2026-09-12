//! Rung 0 runs another machine's program: a `.pins` record (the NES
//! console's, from the bench's `trace` example) replayed through the
//! switch-level chip on a bus that answers from the record itself
//! (`v6502_sim::recorded`), the pins compared frame for frame.
//!
//!     cargo run --release -p v6502-pins --example replay-recorded -- <name.pins> [half-cycles]
//!
//! The `.stim` the header names must sit beside the file: a console run
//! has interrupts and DMA holds in it, and a record replayed free of them
//! is a different program, so a missing stimulus is refused rather than
//! run without. Prints agreement over the half-cycles run, or the first
//! half-cycle that differs and the instruction that was executing there,
//! by the record's own last opcode fetch. Exit 0 on agreement, 1 on a
//! difference or a refusal, 2 on a record it will not run.
//!
//! `MUTATE=1` flips bit 0 of the byte of the first write the record shows
//! after the tenth of its length, which the chip cannot know about: the
//! run must be refused at exactly that half-cycle. The proof the bus is
//! the path and not a bystander.
//!
//! Rung 0 runs at about thirty thousand half-cycles a second, so a NES
//! frame is two seconds; give the count to stop early.

use std::path::Path;

use v6502_pins::{line, parse_stim, parse_trace};
use v6502_sim::pins::{run_recorded, rung0_recorded, Replayed};
use v6502_sim::recorded::instruction_at;

fn main() {
    let path = std::env::args().nth(1).expect("a .pins file");
    let path = Path::new(&path);
    let text = std::fs::read_to_string(path).expect("read the record");
    let mut trace = parse_trace(&text).unwrap_or_else(|e| {
        eprintln!("REFUSED: {}: {e}", path.display());
        std::process::exit(2)
    });
    if trace.header.stim.is_empty() {
        eprintln!("REFUSED: {} names no stimulus file; a console run is not free of interrupts and holds", path.display());
        std::process::exit(2);
    }
    let stim_path = path.parent().unwrap_or(Path::new(".")).join(&trace.header.stim);
    let stim_text = std::fs::read_to_string(&stim_path).unwrap_or_else(|e| {
        eprintln!("REFUSED: the record names {} and it is not beside it: {e}", trace.header.stim);
        std::process::exit(2)
    });
    let stim = parse_stim(&stim_text).unwrap_or_else(|e| {
        eprintln!("REFUSED: {}: {e}", stim_path.display());
        std::process::exit(2)
    });
    let steps: u64 = std::env::args().nth(2).and_then(|a| a.parse().ok()).unwrap_or(trace.header.half_cycles);

    let mut mutated_at = None;
    if std::env::var_os("MUTATE").is_some() {
        let from = trace.frames.len() / 10;
        let k = trace.frames[from..].iter().position(|f| !f.rw && f.clk0).map(|i| i + from).expect("a write in the record");
        trace.frames[k].db ^= 1;
        mutated_at = Some(trace.frames[k].h);
        eprintln!("MUTATE=1: flipped db bit 0 of the write at h={} ({})", trace.frames[k].h, line(&trace.frames[k]));
    }

    // An experiment knob, not a rule: RDY_RISE_SHIFT=n drives every rise of
    // RDY n half-cycles later than the record shows, in the stimulus and in
    // the record's own input field alike, so the comparison still asks the
    // inputs. The console's record is the 2A03 rung's internal hold
    // reported as a pin level; where the bare die resumes a cycle before
    // the record does, this asks whether the level or the die is early.
    let mut stim = stim;
    if let Some(n) = std::env::var("RDY_RISE_SHIFT").ok().and_then(|v| v.parse::<u64>().ok()) {
        let mut rises = 0;
        let mut h = 1;
        while h < trace.frames.len() {
            if !trace.frames[h - 1].rdy && trace.frames[h].rdy {
                for k in h..(h + n as usize).min(trace.frames.len()) {
                    trace.frames[k].rdy = false;
                }
                rises += 1;
                h += n as usize;
            }
            h += 1;
        }
        let mut prev = true;
        for st in stim.iter_mut() {
            if !prev && st.rdy {
                st.h += n;
            }
            prev = st.rdy;
        }
        eprintln!("RDY_RISE_SHIFT={n}: {rises} rises of RDY driven {n} half-cycle(s) later");
    }
    let frames = trace.frames.clone();
    let mut cpu = rung0_recorded(trace.frames, &trace.header.loads, trace.header.reset_vector);
    let t = std::time::Instant::now();
    let outcome = run_recorded(&mut cpu, steps, &stim);
    let dt = t.elapsed().as_secs_f64();
    let describe = |h: u64| match instruction_at(&frames, h) {
        Some((pc, op)) => format!("the instruction executing was the opcode {op:02x} fetched at {pc:04x}"),
        None => "no opcode fetch precedes it in the record".to_string(),
    };
    match outcome {
        Replayed::Agrees { steps, held_reads } => {
            println!(
                "{}: rung 0 agrees with the record over {steps} half-cycles ({:.0} half-cycles/s), {} reads and {} writes held to it, {held_reads} reads answered under RDY low",
                trace.header.name,
                steps as f64 / dt,
                cpu.bus.reads,
                cpu.bus.writes
            );
            if mutated_at.is_some() {
                eprintln!("MUTATE=1 and the run AGREED: the bus is not on the path");
                std::process::exit(1);
            }
        }
        Replayed::Refused(r, got) => {
            println!("{}: the bus refused at {r}\n  chip {}\n  {}", trace.header.name, line(got.last().unwrap()), describe(r.h));
            if let Some(m) = mutated_at {
                if m == r.h {
                    println!("MUTATE=1: refused at the mutated half-cycle, as it must");
                } else {
                    println!("MUTATE=1: refused at h={} but the mutation was at h={m}", r.h);
                }
            }
            std::process::exit(1);
        }
        Replayed::Differs { h, field, expected, got, .. } => {
            println!(
                "{}: rung 0 differs from the record at h={h} in {field}\n  record {}\n  chip   {}\n  {}",
                trace.header.name,
                line(&expected),
                line(&got),
                describe(h)
            );
            std::process::exit(1);
        }
    }
}
