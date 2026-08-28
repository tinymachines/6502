//! The rows packer against the object form it stands in for.
//!
//! Every column is derived here a second time from `observe()`, `internals()`
//! and the node levels, then compared with the row as JSON text. Nothing in
//! this file is shared with `rows.rs` beyond the column list, which is the
//! claim under test.

use v6502_sim::rows::{cols_json, push_row, COLS};
use v6502_sim::{boot, Hidden, Phase, ReadWrite, StoreData};

// A JSON array of numbers and one trailing string, split by hand.
fn split(row: &str) -> Vec<String> {
    assert!(row.starts_with('[') && row.ends_with(']'), "{row}");
    row[1..row.len() - 1].split(',').map(|s| s.trim_matches('"').to_string()).collect()
}

#[test]
fn cols_are_the_thirty_four_the_service_publishes() {
    assert_eq!(COLS.len(), 34);
    assert_eq!(COLS[0], "half_cycle");
    assert_eq!(COLS[33], "watch");
    assert_eq!(cols_json(), format!("[{}]", COLS.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(",")));
}

#[test]
fn every_column_matches_the_object_form_at_every_half_cycle() {
    // ADC with a store, so the internal buses and the SD states move.
    let cpu_program = [0xa9, 0x41, 0x69, 0x01, 0x85, 0x20, 0x4c, 0x00, 0x02];
    let mut cpu = boot(0x0200, &cpu_program);
    let nl = cpu.engine().netlist().clone();
    let names = ["sync", "dpc23_SBAC", "clk0"];
    let watch: Vec<_> = names.iter().map(|n| nl.node(n).unwrap()).collect();

    let mut fetched = false;
    for _ in 0..80 {
        cpu.half_step();
        let mut row = String::new();
        push_row(&mut row, &cpu, &watch);
        let cells = split(&row);
        assert_eq!(cells.len(), COLS.len(), "{row}");
        let cell = |name: &str| -> i64 {
            let i = COLS.iter().position(|c| *c == name).unwrap();
            cells[i].parse().unwrap_or_else(|_| panic!("{name} = {:?}", cells[i]))
        };
        let o = cpu.observe();
        let i = cpu.internals().unwrap();
        assert_eq!(cell("half_cycle"), o.half_cycle as i64);
        assert_eq!(cell("cycle"), o.cycle as i64);
        assert_eq!(cell("clk0"), o.clk0 as i64);
        assert_eq!(cell("phase"), if o.phase == Phase::Phi1 { 1 } else { 2 });
        assert_eq!(cell("addr"), o.bus.addr as i64);
        assert_eq!(cell("data"), o.bus.data as i64);
        assert_eq!(cell("rw"), if o.bus.rw == ReadWrite::Read { 0 } else { 1 });
        assert_eq!(cell("sync"), o.bus.sync as i64);
        for (name, v) in [
            ("pc", o.regs.pc as i64),
            ("a", o.regs.a as i64),
            ("x", o.regs.x as i64),
            ("y", o.regs.y as i64),
            ("s", o.regs.s as i64),
            ("p", o.regs.p as i64),
            ("ir", o.regs.ir as i64),
            ("alu", i.alu as i64),
            ("alua", i.alua as i64),
            ("alub", i.alub as i64),
            ("sb", i.sb as i64),
            ("idb", i.idb as i64),
            ("idl", i.idl as i64),
            ("dor", i.dor as i64),
            ("adl", i.adl as i64),
            ("adh", i.adh as i64),
            ("abl", i.abl as i64),
            ("abh", i.abh as i64),
            ("pclp", i.pclp as i64),
            ("pchp", i.pchp as i64),
        ] {
            assert_eq!(cell(name), v, "{name}");
        }
        // The bitmask decodes to the set active() names.
        let mask = cell("tstates");
        let got: Vec<String> = (0..6).filter(|b| mask >> b & 1 != 0).map(|b| format!("T{b}")).collect();
        let want: Vec<String> = o.timing.active().split('+').filter(|s| !s.is_empty()).map(String::from).collect();
        assert_eq!(got, want);
        assert_eq!(
            cell("hidden"),
            match o.timing.hidden {
                Hidden::None => 0,
                Hidden::T1 => 1,
                Hidden::Vec0 => 2,
                Hidden::T6 => 3,
            }
        );
        assert_eq!(
            cell("store_data"),
            match o.timing.store_data {
                StoreData::None => 0,
                StoreData::Sd1 => 1,
                StoreData::Sd2 => 2,
            }
        );
        match cpu.last_fetch() {
            Some(f) => {
                fetched = true;
                assert_eq!(cell("fetch_addr"), f.addr as i64);
                assert_eq!(cell("fetch_opcode"), f.opcode as i64);
            }
            None => {
                assert_eq!(cell("fetch_addr"), -1);
                assert_eq!(cell("fetch_opcode"), -1);
            }
        }
        // Three names fit in one byte; bit i is name i.
        let whex = &cells[33];
        assert_eq!(whex.len(), 2, "{whex}");
        let wbyte = u8::from_str_radix(whex, 16).unwrap();
        for (bit, &n) in watch.iter().enumerate() {
            assert_eq!(wbyte >> bit & 1 == 1, cpu.engine().is_high(n), "{}", names[bit]);
        }
    }
    assert!(fetched, "the program never fetched, so the fetch columns were never exercised");
}

#[test]
fn watch_is_fixed_width_and_little_endian_past_eight_names() {
    let mut cpu = boot(0x0200, &[0xea, 0x4c, 0x00, 0x02]);
    let nl = cpu.engine().netlist().clone();
    // Nine names: two bytes, the ninth in the low bit of the second.
    let names: Vec<String> = (0..8).map(|b| format!("a{b}")).chain(["sync".to_string()]).collect();
    let watch: Vec<_> = names.iter().map(|n| nl.node(n).unwrap()).collect();
    cpu.half_step();
    let mut row = String::new();
    push_row(&mut row, &cpu, &watch);
    let cells = split(&row);
    let whex = &cells[33];
    assert_eq!(whex.len(), 4, "{whex}");
    let lo = u8::from_str_radix(&whex[..2], 16).unwrap();
    let hi = u8::from_str_radix(&whex[2..], 16).unwrap();
    assert_eq!(lo, cpu.registers().a, "byte 0 is a0..a7, LSB first: the accumulator itself");
    assert_eq!(hi & 1 == 1, cpu.sync());
    assert_eq!(hi >> 1, 0);
    // No watches: an empty string, not "00".
    let mut row = String::new();
    push_row(&mut row, &cpu, &[]);
    assert!(row.ends_with(",\"\"]"), "{row}");
}
