## Summary

`/api` serves no `Content-Encoding` even when the client sends `Accept-Encoding: gzip, br`.
Enabling gzip is one nginx line and is the largest available transport win by a wide margin.

## Evidence

```
$ curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip, br' \
    https://6502.tinymachines.ai/api/v1/meta | grep -i 'content-encoding'
(no output)
```

Measured on a 300-half-cycle traced run, 25 watched nodes:

| Payload | Raw | gzip -6 | Ratio |
| --- | ---: | ---: | ---: |
| Request (machine + args) | 3,815 B | 1,360 B | 2.8× |
| Response, `format: rows` | 29,504 B | 4,613 B | **6.4×** |
| Response, `format: objects` | 235,805 B | 10,231 B | **23.0×** |
| `machine.state` hex alone | 2,308 B | 1,079 B | 2.1× |

Projected in rows form: 2,000 half-cycles ≈ 170 KB → ~4 KB; 10,000 (`max_traced`) ≈ 850 KB
→ ~12 KB.

## Fix

nginx already fronts the API:

```nginx
gzip on;
gzip_types application/json;
gzip_min_length 512;
```

## Follow-on: the `rows` size claim changes

Compression alters the case for `rows`. Raw it is **8.0×** smaller than `objects`; gzipped,
only **2.2×** — repeated key names compress to nearly nothing. `rows` remains worth having
(it parses faster and allocates far less in the browser), but after gzip the argument is CPU
and memory rather than bytes. The `TraceRows` description currently sells it purely on size
and should be adjusted once compression is on. See #4.

## Acceptance criteria

- [ ] `Content-Encoding: gzip` present on JSON responses when requested
- [ ] `Vary: Accept-Encoding` set
- [ ] `TraceRows` description revisited (see #4)
