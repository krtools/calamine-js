# AGENTS.md — calamine-js

Context for AI agents (and humans) working in this repo. Read this plus
`packages/calamine-wasm/DESIGN.md` (design rationale + measurements) before
changing anything structural.

## What this is

Fast xlsx parsing for JS built on the Rust `calamine` crate. Two npm packages
from one Rust core:

- **`@krllc/calamine-wasm`** — WASM build + a streaming, worker-first TS
  client (`packages/calamine-wasm/src-js/`). The primary, publish-anywhere
  package. Entry: `openWorkbook()` in `src-js/client.ts`.
- **`@krllc/calamine-native`** — NAPI addon, path-based (file I/O in Rust).
  Optional fast engine behind the same client (`engine: "native"`).
  Lower publishing priority; current-platform builds only (no prebuild CI yet).

Born from the `../excelperf` benchmark harness (separate repo/dir), which
consumes these packages via `file:` deps and holds the SheetJS comparison.

## The one invariant that matters

**Both engines must produce byte-identical wire output** (JSON batches,
`{"d": <excel serial>}` date tags, meta JSON). The TS client treats engines as
interchangeable. That's why `crates/core` exists — all serialization, the pull
cursor, and the workbook state machine live there; `crates/wasm` and
`crates/native` are ~120-line shims that only map errors (`String` → JsError /
napi::Error) and callbacks. **Never implement parsing/serialization logic in a
shim.** Push mode (`stream_sheet`) is deliberately built on the same
cell-source + row-assembler as the pull cursor so the two modes can't diverge
either.

## Layout

```
crates/core      calamine-json-core: open_*, meta_json, count_cells,
                 read_sheet_json, stream_sheet (push), WorkbookCore
                 (state machine: Idle <-> Streaming{SheetCursor})
crates/wasm      wasm-bindgen shim -> WasmWorkbook + free fns
crates/native    napi shim -> Workbook + free fns (+ SheetStats object)
packages/calamine-wasm
  src-js/client.ts        public API (openWorkbook/readAll), transports,
                          pull-window flow control, AsyncQueue
  src-js/worker-core.ts   handler shared by both workers AND inline mode
  src-js/worker-browser.ts / worker-node.ts   thin entries
  src-js/protocol.ts      wire messages (sequential, no correlation ids)
  src-js/rows.ts          header/columns/dates transforms (RowTransformer)
  test/client-test.ts     14 Node tests (tsx)
  test/client.browser.test.ts  6 real-browser tests (vitest+playwright)
  test/fixtures/sms-small.xlsx checked-in fixture (10,240-row Messages +
                          500-row Contacts, deterministic)
  demo.html               zero-bundler browser demo (serve the package dir)
packages/calamine-native  index.js/.d.ts + scripts/build.mjs (cargo + copy)
```

## Build & test

```sh
npm install                # workspace root
npm run build              # native (current platform) + wasm both targets + tsc
npm test                   # = test:all in calamine-wasm: Node then browser
# granular (run in packages/calamine-wasm):
npm run build:wasm         # wasm-pack, out-dir points back into the package
npm run build:client       # tsc -> dist/
npm test / npm run test:browser
```

Needs: Rust + `rustup target add wasm32-unknown-unknown`, Node 20+ (dev is on
24), Playwright Chromium (`npx playwright install chromium`, one-time).
`pkg/`, `dist/`, `*.node`, `target/` are gitignored build outputs — always
rebuild after touching Rust; TS tests run against `dist/`, so `build:client`
after touching `src-js/`.

## Core design facts (violate these knowingly or not at all)

- **Pull cursor, not push, is how the client streams.** Client sends
  `sheetOpen`, then keeps a window of `pull` messages in flight (default 2,
  `backpressure: N` option). Bounded memory needs **no SharedArrayBuffer and
  no COOP/COEP** — that's the whole point; an earlier SAB/Atomics design was
  built, measured, and deleted (see DESIGN.md). Do not reintroduce isolation
  requirements.
- **One sheet streams at a time per workbook** — a Rust type invariant:
  `open_sheet` MOVES the workbook into the cursor (ouroboros self-ref struct);
  `close_sheet`/exhaustion moves it back. sharedStrings parse once per
  workbook. `meta()` is cached at construction so it works mid-stream.
- **Over-pulls past EOF are normal** (inherent to the window): the worker
  answers `sheetEnd` for a pull with no open cursor rather than erroring.
- **Early `break` from a sheet iteration keeps the workbook usable**
  (dismantles the cursor only). Closing the workbook terminates the worker —
  in the browser that's what actually releases WASM memory (linear memory
  never shrinks; disposable workers are the reclamation strategy).
- **Projection pushdown**: `columns` resolving to indices up front (numeric,
  or names against `header: string[]`) go into Rust — dropped columns are
  never serialized. Names + `header: "first-row"` fall back to JS-side
  projection (headers unknown until row 1). If pushdown applies, the
  RowTransformer must NOT re-project (client adjusts `txOpts`).
- **Wire format**: default `"rows"` (worker JSON.parses, structured clone out)
  keeps the browser main thread idle; `wire: "json"` is ~8–11% faster overall
  (parse pipelines across threads) — a Node/throughput knob, not the default.
- **Buffer transfer**: `ArrayBuffer`/whole-buffer `Uint8Array` sources are
  transferred (detached!) to the worker; documented and tested. Blob/File are
  O(1) handles; Node paths are read inside the worker.
- Cells reference sharedStrings randomly → the table is held in full for the
  parse; high-uniqueness text columns set the memory floor. Input can't
  stream (zip central directory is at EOF). "Windowed Blob reading via
  FileReaderSync" is the designed-but-unbuilt fix (DESIGN.md).
- Real-world sheet order is meaningless (index 0 is often a tiny metadata
  sheet) — examples/tests should select sheets by name or via `meta()`.

## Hard-won gotchas

- calamine does **not** export `XlsxCellReader` (private module) — the cursor
  captures the reader in a type-erased `Box<dyn FnMut>` closure. Don't try to
  name the type.
- ouroboros: use `try_build_or_recover()` so the workbook survives a failed
  cursor build; struct literals can't be `match` scrutinees (bind first).
- napi prelude shadows `Result` — write `std::result::Result<_, String>`
  explicitly in helper signatures or `?` conversions break confusingly.
- wasm-bindgen `Option<String>` returns `undefined`; napi returns `null` —
  worker-core checks both.
- TS 7 (Go-based tsc) requires explicit `rootDir`.
- vitest 4: browser provider is a factory import from
  `@vitest/browser-playwright`, not the string `"playwright"`.
- wasm-pack regenerates `pkg/*/package.json`; `pkg/web` needs
  `"type": "module"` (wasm-pack includes it — don't delete those files).
- `isNode` detection must check `typeof window === "undefined"` too (browser
  test environments may shim `process`).
- The vitest server deliberately sends **no** COOP/COEP headers and the
  backpressure browser test asserts `crossOriginIsolated === false` — that's
  a feature guarantee, not an oversight.
- The wasm free functions borrow bytes (`Cursor<&[u8]>`, zero copy);
  `WasmWorkbook` owns them (`Vec<u8>`, one copy from JS). Keep it that way.

## Perf reference (96 MB SMS-style xlsx, 1.02M rows, huge sharedStrings; see DESIGN.md)

- client (worker, pull): ~7.7 s / ~600 MB; `engine: "native"`: ~6.6 s
- slow consumer (100 ms/batch): high-water 1 batch, ~554 MB (bounded by default)
- SheetJS same file: ~18 s / ~3 GB — the raison d'être
- Regression rule of thumb: streaming-mode changes should stay within ~10% of
  these. Benchmark via `../excelperf`: `npx tsx src/bench.ts <file>` (all
  modes, fresh process each, checksum-verified between engines) and
  `npx tsx src/client-bench.ts <file> engine=native columns=0,7 slowMs=100 ...`

## Publishing state / TODO

- `@krllc/calamine-wasm`: publishable from any machine (`prepack` rebuilds).
  Before first publish: per-package LICENSE copies, `repository` field once
  the GitHub URL exists.
- `@krllc/calamine-native`: current-platform only; a napi-rs GitHub Actions
  prebuild matrix (platform sub-packages via optionalDependencies) is the
  known path when it becomes a priority.
- Version packages independently (changesets or manual); the client's
  `engine: "native"` contract is `WorkbookHandle` in `worker-core.ts` — keep
  it in lockstep across both engines in the same PR.
