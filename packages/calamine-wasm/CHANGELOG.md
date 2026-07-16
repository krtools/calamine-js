# Changelog

All notable changes to `@krllc/calamine-wasm`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). Update this file in the same commit as every
version bump; tag releases `calamine-wasm-vX.Y.Z`.

## [Unreleased]

## [0.2.0] - 2026-07-15

### Added

- `openSession()`: keeps one worker (and its compiled WASM module) warm across
  a sequence of workbooks — for file queues, where per-file `openWorkbook()`
  would re-spawn a worker and recompile the module each time. One workbook
  open at a time per session; `wb.close()` frees the workbook but keeps the
  worker; `session.dispose()` terminates the worker and reclaims the WASM
  heap. A workbook that fails to parse resets the worker instead of killing
  the session.

## [0.1.0] - 2026-07-14

Initial release.

### Added

- `openWorkbook()` / `readAll()`: streaming, worker-first client for Node and
  browsers over the Rust `calamine` xlsx parser compiled to WebAssembly.
  Browser parses in a disposable module worker (teardown reclaims the WASM
  memory high-water mark); Node runs files < 8 MB inline and larger ones in a
  `worker_threads` worker (`worker: "always" | "never" | "auto"`).
- Pull-cursor streaming with bounded memory by default: the client keeps a
  small window of batch requests in flight (`backpressure`, default 2 =
  double-buffered) — no SharedArrayBuffer, no COOP/COEP required.
- Row transforms: `header` ("first-row" / explicit names), `columns`
  projection — pushed down into Rust when resolvable to indices up front —
  and `dates` ("serial" default, "date" for JS Dates).
- `wire: "rows" | "json"` batch delivery (default keeps the browser main
  thread idle; "json" trades main-thread CPU for ~8–11% throughput).
- Sources: `File` / `Blob` (O(1) handles), `ArrayBuffer` / `Uint8Array`
  (transferred — zero copy, caller's buffer detached), file paths (Node).
- `engine: "native"`: the calamine NAPI addon behind the identical API
  (Node + path sources only).
- Raw WASM API via `/node` (CJS) and `/web` (ESM) subpaths.
- Fixed: `pkg/` was excluded from the npm tarball (wasm-pack's generated
  `.gitignore` defeated the `files` whitelist); scoped-package publish
  config; keywords and engines metadata.

[Unreleased]: https://github.com/krtools/calamine-js/compare/calamine-wasm-v0.2.0...HEAD
[0.2.0]: https://github.com/krtools/calamine-js/compare/calamine-wasm-v0.1.0...calamine-wasm-v0.2.0
[0.1.0]: https://github.com/krtools/calamine-js/releases/tag/calamine-wasm-v0.1.0
