## Summary

`TraceRows.watch` is a single JSON integer, bit *i* for `watch_names[i]`. Past **53 watched
names** the mask exceeds 2^53 and is no longer exactly representable as a float64, so every
browser consumer silently reads the wrong bits. No error is raised anywhere.

## Evidence

Watching 64 nodes (`idb0-7`, `idl0-7`, `dor0-7`, `alua0-7`, `alub0-7`, `pclp0-7`, `pchp0-7`,
`abl0-7`) over 40 half-cycles:

```
max mask       : 9368067230186766914
bit_length     : 64
> 2^53         : True
rows that fail a float64 round trip: 39 / 40
mismatches vs `format: objects`   :  0
```

The server is correct — Python integers are arbitrary precision, and `rows` agrees with
`objects` exactly. The corruption is entirely consumer-side: `JSON.parse` produces a double,
so the high bits are wrong with no signal. RFC 8259 warns that interoperable implementations
should stay inside double precision for this reason.

## Repro

```bash
curl -s https://6502.tinymachines.ai/api/v1/step \
  -H 'content-type: application/json' \
  -d '{"machine":<machine>,"half_cycles":40,"trace":true,"format":"rows",
       "watch":["idb0","idb1",...,"abl7"]}' \
| python3 -c 'import sys,json; r=json.load(sys.stdin)["trace_rows"]; \
  ci={c:i for i,c in enumerate(r["cols"])}; \
  print(sum(1 for x in r["rows"] if int(float(x[ci["watch"]])) != x[ci["watch"]]), "rows lossy")'
```

## Proposed fix

Emit `watch` as a **lowercase hex bitset**, the encoding already specified in `/v1/meta`:

> lowercase hex; bit i of a set is byte i/8, LSB first

A consumer that can read `levels` then reads `watch` with the same three lines. No precision
ceiling, fixed predictable width, scales to all 832 names.

**Measured cost.** Hex is fixed-width; integers get leading-zero compression for free, so on
sparse masks the integer is slightly shorter. On a 132-row / 25-name trace: 1056 → 1320
chars, **+264 bytes on a 13 KB file (~2%)**. Past ~53 names with dense masks hex wins
outright (64 all-ones: 20 chars as integer, 18 as hex). Under gzip the difference vanishes.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| Array of 32-bit chunks | Correct, but invents a second bitset convention alongside `levels`. |
| Integer ≤53 names, string beyond | Polymorphic field; consumers need both branches and the bug still bites whoever crosses the threshold. |
| Cap at 53, return 422 | Not a fix, but good belt-and-braces if the integer stays. Matches the padding-bit principle: a state that decodes to the wrong chip is worse than one that is rejected. |

## Regression test

```python
assert mask <= 2**53 - 1, f"watch mask {mask} is not exactly representable in float64"
```

Better as a property test over N in 1..832 watched names: build the mask, round-trip through
`float`, assert equality. That is how this was found.

## Acceptance criteria

- [ ] `watch` round-trips exactly for any watch list up to all 832 names
- [ ] Encoding stated in the `TraceRows` description
- [ ] Property test in CI over the full range of watch-list lengths
- [ ] Either a straight swap, or `watch_encoding: "hex"` alongside `cols` / `watch_names` so
      the format is self-describing
