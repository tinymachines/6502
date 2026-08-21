## Summary

Add a build identifier to halfshot export metadata so "did my fix land?" is a one-line check.

## Motivation

During review a stale export was analysed as though it were new — byte-identical to the
previous file, with every diagnostic returning the same result. Detecting that took a
byte-count comparison and a full re-run of the checks.

## Proposal

A `build` block beside `format` and `version`:

```json
"build": { "commit": "0905117", "exported": "2026-08-20T15:04:11Z", "run_id": "..." }
```

Any one of the three would be enough; all three make diff-based analysis (see #6) reliable,
since a same-run pair becomes self-evident rather than asserted.

## Acceptance criteria

- [ ] `build` block present in halfshot exports
- [ ] Includes at minimum a commit SHA or a run identifier
