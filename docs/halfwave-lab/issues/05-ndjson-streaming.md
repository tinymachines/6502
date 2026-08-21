## Summary

Offer chunked **NDJSON** streaming for long traced runs: one row per line, flushed as the
solver produces them.

## Why this and not websockets

Measured round trip for a 300-half-cycle traced run: **130–260 ms total**, TTFB 130–190 ms,
body transfer under 5 ms, connection setup ~30–40 ms. Latency is server compute plus RTT —
transport framing is not the cost. A consumer that batches (as it should) then scrubs
client-side has no per-step round trip to eliminate at all.

The deeper objection to a socket: it invites server-side session state, and statelessness is
the property that makes this API distinctive. It is what allows handing someone a machine
mid-instruction, and it is the precondition for permalinking a chip in a URL.

NDJSON keeps all of that. Nothing about statelessness changes: the final `machine` still
comes back at the end and the client still owns it. `curl` still works unchanged.

## Where it helps

At `max_traced: 10000` a rows response is ~850 KB raw (~12 KB gzipped). Streaming lets a
client render progressively instead of waiting on one large body.

## Acceptance criteria

- [ ] `Accept: application/x-ndjson` (or `format: "ndjson"`) streams rows as produced
- [ ] Final line carries the resulting `machine` and `completed`
- [ ] Works with `curl` with no special flags
- [ ] Explicitly **not** websockets; statelessness preserved
