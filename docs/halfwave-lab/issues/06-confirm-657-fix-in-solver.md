## Summary

The node 657 (`vcc`) rail fix is confirmed present in the halfshot export, but the artifacts
cannot tell whether it landed in the **solver's group resolution** or in the **serializer**.
Confirm it is the former, and add an assertion so it stays that way.

## Background

In the v1 export, node 657 — declared `vcc` in `rails` — toggled 80 times (40 down, 40 up),
going low during φ2 of most opcode-fetch cycles. `vss` (558) was correctly pinned throughout.
In v2 both rails have zero toggles.

## Why it is not yet settled

Diffing reconstructed node histories between the two exports, **657 was the only node whose
state changed** — 40 frames, exactly the down-events. Nothing downstream moved. That is
consistent with two different stories:

- **(a)** the solver already fed a high into every transistor on that group and only the
  reported level was wrong — a correct, localised fix; or
- **(b)** the serializer now clamps 657 to 1, masking a resolution bug that happens not to be
  sampled during those half-cycles.

The two exports also came from different runs, which weakens the diff further.

## To settle it

1. Export before and after the fix from an **identical run** — same program, same seed, same
   half-cycle count. If 657 is still the only delta, story (a) holds.
2. Regardless of the answer, put the invariant in the solver: assert `Drive::Vcc` wins its
   group on every settle, so a future change to group resolution fails loudly instead of
   being papered over on write-out.

## Acceptance criteria

- [ ] Same-run before/after pair produced and diffed
- [ ] Solver-side assertion that rail nodes resolve to their declared level every settle
- [ ] No clamping of rail values in the export path
