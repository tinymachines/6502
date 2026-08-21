## Summary

Two small corrections to the `TraceRows` description.

## 1. The compression figures do not state what is being divided

The description cites 3.7× and 7.5×. Measuring three plausible boundaries:

| Case | Doc says | Full response | Minus `machine` | Trace payload only |
| --- | --- | ---: | ---: | ---: |
| 45 hc / 2 watched | 3.7× | 2.4× | **3.8×** | 4.1× |
| 133 hc / 22 watched | 7.5× | 6.4× | **8.2×** | 8.8× |

The figures match *response minus `machine`*, which is the right boundary — the machine is
identical in both formats and would only dilute the ratio. Four words would remove the
ambiguity, and the claim is now specific enough that people will check it.

## 2. Revisit the size argument once gzip is on (see #2)

Raw, `rows` is 8.0× smaller than `objects`. Gzipped, 2.2× — repeated key names compress to
almost nothing. `rows` is still clearly worth having, but the reason becomes parse speed and
browser allocation rather than bytes on the wire. The description currently sells it purely
on size.

## Acceptance criteria

- [ ] Measurement boundary stated ("measured on the response excluding `machine`")
- [ ] Size claim re-measured and reworded after gzip lands
