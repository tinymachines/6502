## Summary

Assert the halfshot export invariants in CI. All are cheap and catch the class of bug found
in the v1 export (a declared rail that toggled).

## Invariants

- [ ] Every node named in `rails` has zero entries in any `up` / `down` list
- [ ] Replaying `up` / `down` from frame 0 `levels` produces no violations — a node in `up`
      was 0, a node in `down` was 1
- [ ] `frames[i].h == i`; `ph` alternates 1, 2; `clk0 == (i % 2)`
- [ ] `len(frame.open) == len(controls)` on every frame
- [ ] Padding bits past node 1725 are zero
- [ ] Frame count is even and the last frame is φ2
- [ ] `contested_groups == 0` and `nonconvergent_settles == 0` (already in the suite)

## Notes

The delta-replay check is the strong one — on the v2 export it passes across 51,892
transitions on 828 distinct nodes, and it would have caught the 657 regression immediately
had it also been paired with the rail check.

## Acceptance criteria

- [ ] Validator runs on every export in CI
- [ ] Failures are assertion errors, not warnings
