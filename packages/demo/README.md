# calamine-demo

Browser demo that races `@krllc/calamine-wasm` against SheetJS on **your own
xlsx file** — bring-your-own-data, nothing uploaded, everything in-tab.

```sh
npm run dev        # vite dev server
npm run build      # static build -> dist/
npm run test:e2e   # build + headless-Chromium smoke race on the library fixture
```

## Methodology (kept deliberately generous to SheetJS)

- Both engines parse in workers. SheetJS gets a dedicated worker with dense
  mode + raw values, and its rows never leave that worker — only a summary
  crosses back. calamine runs its default out-of-the-box client, and its
  timings include cloning every batch to the main thread.
- Both engines fold the same normalized per-cell checksum (see
  `src/bench/checksum.ts`); the "outputs match" badge means they demonstrably
  did the same work. Row counts/checksums can legitimately differ on files
  with blank rows or formulas (different semantics, not a bug) — the UI says
  so rather than hiding it.
- Headline metrics: total time, time-to-first-row (SheetJS's is its total by
  construction — nothing is available until the parse finishes), throughput,
  and an rAF jank meter proving the main thread stayed responsive.
- Memory deltas use `measureUserAgentSpecificMemory()`, which requires
  cross-origin isolation — the vite server sends COOP/COEP **only** to unlock
  that measurement API. The parser itself never needs isolation; on hosts
  that can't set headers (GitHub Pages) the demo just omits memory numbers.

## Build notes

- `xlsx` is pinned to SheetJS's own CDN tarball — the npm registry package is
  frozen at 0.18.5 and benchmarking a stale build would be a fairness bug.
- `vite.config.ts` marks `node:*` imports external in both the main and
  worker bundles: the library's client keeps Node-only dynamic imports behind
  runtime `isNode` guards, which dev-mode Vite tolerates but production
  Rollup tries to resolve.
