// A 6502 assembler, small enough to read in one sitting.
//
// It exists so that the programs this site runs are *source* rather than a
// column of hand-typed hex with a comment beside it. A comment can drift from
// the byte it describes and nothing will ever say so; an assembled listing
// cannot, because the bytes are computed from the text on screen.
//
// The opcode table is not retyped here. It is inverted out of `disasm.js`, so
// the assembler and the disassembler are the same table read in two directions
// -- which is what makes the round trip in `_asm-test.html` evidence rather
// than a tautology. If a mnemonic assembles, it disassembles to the same line.
//
// Undocumented opcodes are absent for the same reason they are absent there:
// the chip executes them and this simulator will show exactly what they do, but
// giving them a mnemonic would imply a canonical meaning they do not have.

import { OPCODES } from './disasm.js';

/** How many operand bytes each addressing mode takes. */
export const MODE_SIZE = {
  imp: 0, acc: 0,
  imm: 1, zp: 1, zpx: 1, zpy: 1, izx: 1, izy: 1, rel: 1,
  abs: 2, abx: 2, aby: 2, ind: 2,
};

// mnemonic -> { mode: opcode }, built once from the shared table.
const FORMS = new Map();
for (const [op, [mnemonic, mode]] of Object.entries(OPCODES)) {
  if (!FORMS.has(mnemonic)) FORMS.set(mnemonic, {});
  FORMS.get(mnemonic)[mode] = Number(op);
}

export class AsmError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.line = line || 0;
    this.detail = message;
  }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/**
 * A deliberately small expression language: hex, binary, decimal, character
 * literals, labels, `*` for the current address, `<`/`>` for the low and high
 * byte, and `+`/`-` between terms.
 *
 * `resolve` returns null for a symbol that is not yet known, which is how pass
 * one distinguishes "this is zero page" from "this might be, once I have read
 * the rest of the file".
 */
function evaluate(expr, labels, pc, lineNo) {
  const text = expr.trim();
  if (!text) throw new AsmError('expected a value', lineNo);

  let pick = null;
  let body = text;
  if (body[0] === '<' || body[0] === '>') {
    pick = body[0];
    body = body.slice(1).trim();
  }

  // Split on + and - while keeping the operators.
  const parts = body.split(/([+-])/).map((s) => s.trim()).filter((s) => s !== '');
  let total = 0;
  let sign = 1;
  let known = true;
  for (const part of parts) {
    if (part === '+') { sign = 1; continue; }
    if (part === '-') { sign = -1; continue; }
    const v = term(part, labels, pc, lineNo);
    if (v === null) { known = false; continue; }
    total += sign * v;
  }
  if (!known) return null;
  if (pick === '<') return total & 0xff;
  if (pick === '>') return (total >> 8) & 0xff;
  return total;
}

function term(t, labels, pc, lineNo) {
  if (t === '*') return pc;
  if (t[0] === '$') {
    if (!/^\$[0-9a-fA-F]+$/.test(t)) throw new AsmError(`bad hex value ${t}`, lineNo);
    return parseInt(t.slice(1), 16);
  }
  if (t[0] === '%') {
    if (!/^%[01]+$/.test(t)) throw new AsmError(`bad binary value ${t}`, lineNo);
    return parseInt(t.slice(1), 2);
  }
  if (/^'.'$/.test(t)) return t.charCodeAt(1);
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (/^[A-Za-z_][\w]*$/.test(t)) {
    return labels.has(t) ? labels.get(t) : null;
  }
  throw new AsmError(`cannot read ${t}`, lineNo);
}

// ---------------------------------------------------------------------------
// One line
// ---------------------------------------------------------------------------

const BRANCHES = new Set(['BPL', 'BMI', 'BVC', 'BVS', 'BCC', 'BCS', 'BNE', 'BEQ']);

/** Strip a trailing comment, respecting quotes so `.byte "a;b"` survives. */
function splitComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ';') return [raw.slice(0, i), raw.slice(i + 1).trim()];
  }
  return [raw, ''];
}

function parseLine(raw, lineNo) {
  const [codePart, comment] = splitComment(raw);
  let code = codePart.trim();
  const out = { n: lineNo, text: raw.replace(/\s+$/, ''), comment, label: null,
                mnemonic: null, operand: '', directive: null };
  if (!code) return out;

  // A label either carries a colon or sits in the first column. Without that
  // rule an indented `LDA $10` would read its mnemonic as a label, and a
  // first-column `LDA` would too -- so a bare first-column word that *is* a
  // mnemonic stays a mnemonic.
  const lab = /^([A-Za-z_][\w]*)(:?)\s*/.exec(code);
  if (lab) {
    const isLabel = lab[2] === ':'
      || (!/^\s/.test(codePart) && !FORMS.has(lab[1].toUpperCase()));
    if (isLabel) {
      out.label = lab[1];
      code = code.slice(lab[0].length).trim();
    }
  }
  if (!code) return out;

  if (code[0] === '.') {
    const m = /^(\.[A-Za-z]+)\s*(.*)$/.exec(code);
    if (!m) throw new AsmError(`cannot read directive ${code}`, lineNo);
    out.directive = m[1].toLowerCase();
    out.operand = m[2].trim();
    return out;
  }

  const m = /^([A-Za-z]{3})\b\s*(.*)$/.exec(code);
  if (!m) throw new AsmError(`cannot read ${code}`, lineNo);
  out.mnemonic = m[1].toUpperCase();
  out.operand = m[2].trim();
  if (!FORMS.has(out.mnemonic)) {
    throw new AsmError(`${out.mnemonic} is not a documented 6502 instruction`, lineNo);
  }
  return out;
}

/**
 * Which addressing mode an operand's *syntax* allows, and the expression in it.
 *
 * Syntax alone cannot separate zero page from absolute -- `$10` and `label` look
 * identical -- so this returns the pair and the caller decides on the value.
 */
function readOperand(operand, lineNo) {
  const o = operand.trim();
  if (o === '') return { kinds: ['imp'], expr: '' };
  if (/^[Aa]$/.test(o)) return { kinds: ['acc'], expr: '' };
  if (o[0] === '#') return { kinds: ['imm'], expr: o.slice(1) };

  let m = /^\(\s*(.+?)\s*,\s*[Xx]\s*\)$/.exec(o);
  if (m) return { kinds: ['izx'], expr: m[1] };
  m = /^\(\s*(.+?)\s*\)\s*,\s*[Yy]$/.exec(o);
  if (m) return { kinds: ['izy'], expr: m[1] };
  m = /^\(\s*(.+?)\s*\)$/.exec(o);
  if (m) return { kinds: ['ind'], expr: m[1] };
  m = /^(.+?)\s*,\s*[Xx]$/.exec(o);
  if (m) return { kinds: ['zpx', 'abx'], expr: m[1] };
  m = /^(.+?)\s*,\s*[Yy]$/.exec(o);
  if (m) return { kinds: ['zpy', 'aby'], expr: m[1] };
  return { kinds: ['zp', 'abs', 'rel'], expr: o };
}

/** The values in a `.byte` / `.word` list, expanding quoted strings. */
function listItems(operand, lineNo) {
  const items = [];
  let buf = '';
  let quote = null;
  for (let i = 0; i <= operand.length; i++) {
    const c = operand[i];
    if (c === undefined || (c === ',' && !quote)) {
      if (buf.trim()) items.push(buf.trim());
      buf = '';
      continue;
    }
    if (!quote && c === '"') { quote = c; buf += c; continue; }
    if (quote === c) { quote = null; buf += c; continue; }
    buf += c;
  }
  return items;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble `source`.
 *
 * Two passes. The first sizes every line and records where the labels land; the
 * second emits bytes now that forward references resolve.
 *
 * The one judgement call is zero page. `LDA foo` is two bytes if `foo` is below
 * $0100 and three if it is not, so the size depends on a value the first pass
 * may not know yet. The rule here is the conservative one: a mode narrows to
 * zero page only when its expression resolves during pass one. A forward
 * reference therefore assembles as absolute -- three bytes that are always
 * correct rather than two that are sometimes wrong -- and `_asm-test.html`
 * pins that both passes agree on every address.
 */
export function assemble(source, { org = 0x0200 } = {}) {
  const lines = source.split('\n').map((raw, i) => parseLine(raw, i + 1));
  const labels = new Map();

  const sizeOf = (ln, pc, pass) => {
    if (ln.directive === '.org') {
      const v = evaluate(ln.operand, labels, pc, ln.n);
      if (v === null) throw new AsmError('.org needs a value known here', ln.n);
      return { org: v, size: 0 };
    }
    if (ln.directive === '.byte' || ln.directive === '.db') {
      let n = 0;
      for (const item of listItems(ln.operand, ln.n)) {
        n += item[0] === '"' ? item.length - 2 : 1;
      }
      return { size: n };
    }
    if (ln.directive === '.word' || ln.directive === '.dw') {
      return { size: listItems(ln.operand, ln.n).length * 2 };
    }
    if (ln.directive) throw new AsmError(`unknown directive ${ln.directive}`, ln.n);
    if (!ln.mnemonic) return { size: 0 };

    const forms = FORMS.get(ln.mnemonic);
    const { kinds, expr } = readOperand(ln.operand, ln.n);
    const value = expr === '' ? null : evaluate(expr, labels, pc, ln.n);

    // Pick the mode: the first syntactically allowed one this mnemonic has,
    // preferring zero page only when the value is known and fits.
    let mode = null;
    for (const k of kinds) {
      if (!(k in forms)) continue;
      if ((k === 'zp' || k === 'zpx' || k === 'zpy')
          && !(value !== null && value >= 0 && value < 0x100)) continue;
      mode = k;
      break;
    }
    if (mode === null) {
      const shown = ln.operand || '(no operand)';
      throw new AsmError(
        `${ln.mnemonic} has no addressing mode matching ${shown}`, ln.n);
    }
    return { size: 1 + MODE_SIZE[mode], mode, opcode: forms[mode], value, expr };
  };

  // -- pass one: addresses --------------------------------------------------
  let pc = org;
  let start = org;
  let seenOrg = false;
  for (const ln of lines) {
    if (ln.label) labels.set(ln.label, pc);
    const s = sizeOf(ln, pc, 1);
    if (s.org !== undefined) {
      if (!seenOrg) { start = s.org; seenOrg = true; }
      // A label on the .org line names the new address, not the old one.
      if (ln.label) labels.set(ln.label, s.org);
      pc = s.org;
      continue;
    }
    ln.sizedAt = pc;
    pc += s.size;
  }

  // -- pass two: bytes ------------------------------------------------------
  const image = new Map();   // address -> byte
  let lo = null;
  let hi = null;
  const put = (addr, byte) => {
    image.set(addr, byte & 0xff);
    lo = lo === null ? addr : Math.min(lo, addr);
    hi = hi === null ? addr : Math.max(hi, addr);
  };

  pc = start;
  for (const ln of lines) {
    ln.bytes = [];
    if (ln.directive === '.org') {
      pc = evaluate(ln.operand, labels, pc, ln.n);
      ln.addr = pc;
      ln.gap = true;
      continue;
    }
    ln.addr = pc;
    if (ln.directive === '.byte' || ln.directive === '.db') {
      for (const item of listItems(ln.operand, ln.n)) {
        if (item[0] === '"') {
          for (const ch of item.slice(1, -1)) ln.bytes.push(ch.charCodeAt(0) & 0xff);
        } else {
          const v = evaluate(item, labels, pc, ln.n);
          if (v === null) throw new AsmError(`unknown value ${item}`, ln.n);
          ln.bytes.push(v & 0xff);
        }
      }
    } else if (ln.directive === '.word' || ln.directive === '.dw') {
      for (const item of listItems(ln.operand, ln.n)) {
        const v = evaluate(item, labels, pc, ln.n);
        if (v === null) throw new AsmError(`unknown value ${item}`, ln.n);
        ln.bytes.push(v & 0xff, (v >> 8) & 0xff);
      }
    } else if (ln.mnemonic) {
      const s = sizeOf(ln, pc, 2);
      ln.mode = s.mode;
      ln.opcode = s.opcode;
      let value = s.value;
      if (MODE_SIZE[s.mode] > 0) {
        if (value === null) {
          throw new AsmError(`${s.expr} is never defined`, ln.n);
        }
        if (s.mode === 'rel') {
          const delta = value - (pc + 2);
          if (delta < -128 || delta > 127) {
            throw new AsmError(
              `${ln.mnemonic} is ${delta} bytes away; a branch reaches -128..127`, ln.n);
          }
          value = delta & 0xff;
        } else if (MODE_SIZE[s.mode] === 1 && (value < 0 || value > 0xff)) {
          throw new AsmError(`$${value.toString(16)} does not fit in one byte`, ln.n);
        }
      }
      ln.bytes.push(s.opcode);
      if (MODE_SIZE[s.mode] === 1) ln.bytes.push(value & 0xff);
      if (MODE_SIZE[s.mode] === 2) ln.bytes.push(value & 0xff, (value >> 8) & 0xff);
    }
    // Sizes are computed twice, from the same function, and must agree -- an
    // address that moved between passes is the classic assembler bug and it
    // corrupts every branch after it silently.
    if (ln.addr !== undefined && ln.bytes.length && ln.sizedAt !== undefined
        && ln.sizedAt !== ln.addr) {
      throw new AsmError('address moved between passes', ln.n);
    }
    for (let i = 0; i < ln.bytes.length; i++) put(pc + i, ln.bytes[i]);
    pc += ln.bytes.length;
  }

  if (lo === null) throw new AsmError('nothing to assemble');

  // A gap left by .org is real memory the chip will fetch through, so it is
  // filled rather than omitted: an image with holes in it is not an image.
  const bytes = [];
  for (let a = lo; a <= hi; a++) bytes.push(image.has(a) ? image.get(a) : 0x00);

  return {
    org: lo,
    end: hi,
    bytes,
    labels,
    lines,
    // Where each line's bytes land, for a listing that wants to show a gap.
    size: bytes.length,
  };
}

/** Assemble, or throw an AsmError naming the line. Convenience for callers. */
export function assembleBytes(source, opts) {
  return assemble(source, opts).bytes;
}
