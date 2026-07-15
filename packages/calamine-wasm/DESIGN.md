# Design notes — `@krllc/calamine-wasm`

Decision record for the client API and its Rust core. Usage lives in
README.md; this file explains *why* things are the way they are, with the
measurements that decided each call. (Supersedes the original PROPOSAL.md.)

Benchmarks below: 96 MB SMS-style xlsx, 1.02M rows × 8 cols, one
mostly-unique free-text column (huge sharedStrings table), fresh process per
run, Windows / Node 24. Reproduce with `../src/client-bench.ts`.

## Core decisions

**One abstraction: the workbook handle.** `openWorkbook` → `sheet()` /
`events()` / `meta()` / `close()`. A single-sheet sugar (`parseXlsx`) was
designed and cut — it added no capability over `openWorkbook`, and a second
entry point muddied the model. `readAll` survives as the explicitly
small-file escape hatch.

**Worker-by-default in the browser.** Two reasons: the main thread never
blocks, and — the one that matters for memory — WASM linear memory never
shrinks, so the only way to reclaim the high-water mark is to discard the
instance. Terminating the worker on `close()`/dispose does that
deterministically. Node runs files < 8 MB inline (worker startup isn't worth
it) and workers above.

**Warm-worker sessions (`openSession`).** The 1:1 worker↔workbook rule above
buys deterministic reclamation but costs a worker spawn + module compile per
file — wasteful for a queue. `openSession()` is the opt-in escape hatch: one
worker stays warm across many `open`/`close` cycles (the module compiles once),
and `dispose()` terminates it to reclaim at the end. It's purely additive —
the core already supported it (the worker's `close` op frees the workbook but
never terminated; only the entry wrappers self-closed and the client called
`terminate()`), so the change was to (a) stop the entries self-terminating and
let the client own teardown, (b) reset the cursor flag on `close` so an
abandoned stream can't leak into the next workbook, and (c) let a session lend
its transport to successive `WorkbookImpl`s whose `close()` frees-but-keeps.
One workbook streams at a time per session (one WASM instance); N sessions give
N-way concurrency. `openWorkbook` is unchanged — a session is strictly opt-in.

**Sheets stream via a pull cursor, not a push callback.** The original
design streamed a whole sheet through one synchronous wasm call, which made
flow control impossible without `Atomics.wait` on a SharedArrayBuffer — and
SAB requires cross-origin isolation (COOP/COEP), a real deployment cost for
apps with credentialed cross-origin embeds or popup auth. Replaced by a
Rust-side cursor (`openSheet` / `nextBatch` / `closeSheet`): the client keeps
a small window of pull requests in flight (default 2, `backpressure: N`), so
the parser can never run more than N unprocessed batches ahead. Flow control
rides the ordinary message protocol — **bounded memory is the default on any
host, no isolation required** (the browser test asserts bounded behavior with
`crossOriginIsolated === false`).

Measurements that validated the switch:
- Throughput cost of pull round-trips: 7.7 s vs 7.5 s push (+3%).
- Slow consumer (100 ms/batch): pull default → 554 MB peak, queue high-water
  1. Old unbounded push default → 834 MB, 55 batches queued. Old SAB
  version → 586 MB but only under COOP/COEP.
- `backpressure: 1` (strict lockstep) costs ~40% wall time vs the default 2:
  parse and consume stop overlapping. 2 = double buffering is the sweet spot.

**Cursor ownership model.** calamine's cell reader borrows the workbook, and
the reader type isn't exported (private module), so the cursor holds the
workbook plus a *type-erased boxed closure* capturing the reader, tied
together with `ouroboros`. `openSheet` MOVES the workbook into the cursor;
`closeSheet`/exhaustion moves it back (`into_heads`). Consequences, all
deliberate:
- sharedStrings parse exactly once per workbook, not per sheet;
- one sheet streams at a time — a Rust invariant, matching what a single
  worker could do anyway;
- abandoning an iteration mid-sheet (loop `break`) dismantles just the
  cursor; the workbook handle stays usable;
- `meta()` is cached at construction so it works while a cursor holds the
  workbook.
- The resumable batch assembler stashes the row-boundary cell (pre-serialized)
  between `nextBatch` calls — a row is only known complete when a cell from
  the next row arrives.

**Batches cross the boundary as parsed rows (structured clone), JSON in the
worker.** `wire: "json"` (string across, parse on consumer thread) measured
8–11% *faster* end-to-end because parsing pipelines across threads — but the
default optimizes for an idle browser main thread, which is the point of the
worker architecture. The knob exists for Node/throughput use.

**Projection pushdown.** `columns` that resolve to indices up front (numeric,
or names against known headers) are pushed into Rust — dropped columns are
never serialized. Names + `header: "first-row"` can't push down (names
unknown until row 1) and fall back to client-side projection. Dropping the
SMS text column measured 592 → 491 MB and −0.9 s.

**Buffer transfer.** `ArrayBuffer`/whole-buffer `Uint8Array` sources are
transferred (zero copy, source detached — documented and tested); `File`/
`Blob` handles are O(1) to post; Node paths are read inside the worker.

## Declined alternatives (with reasons)

- **Columnar batches (Float64Array wire format)** — measured as not
  warranted: the entire serialize+parse boundary is ~1–2 s of a ~7 s run even
  on an all-numeric corpus (< ~15% ceiling there, < ~10% on the string-heavy
  SMS corpus), against a breaking batch-shape change. Revisit only if
  numeric-heavy files become the dominant workload.
- **SAB/Atomics backpressure** — implemented, measured, then deleted in favor
  of the pull cursor (see above). Kept working knowledge: the semaphore
  worked, but demanded COOP/COEP, which conflicts with credentialed
  cross-origin embeds and popup auth flows.
- **Parallel sheet parsing** — one worker per sheet would duplicate file
  bytes + sharedStrings per worker; with one dominant sheet (the target
  workload) that trade is a loss.
- **`parseXlsx` single-sheet sugar** — cut, see core decisions.

## Engines

`engine: "native"` runs the calamine NAPI addon (`../calamine-native`)
behind the identical client API and protocol (Node + path sources only).
Fastest option (6.6 s vs 7.7 s wasm on the corpus) and no file bytes in
memory — the file is read from disk in Rust. The addon mirrors the wasm
crate's handle: same state machine, same pull cursor.

## Known limits / future work

- **Input can't stream**: xlsx is a zip with its central directory at the
  end; the full file bytes must be available for random access. In WASM that
  means bytes in linear memory. **Windowed Blob reading** (a `Read + Seek`
  shim over `FileReaderSync` in a worker, holding only a sliding window)
  would remove that floor for 100 MB+ browser files — designed, not built.
- The sharedStrings table is held in full for the duration of a parse
  (format requirement — cells reference it randomly). High-uniqueness string
  columns set the memory floor no streaming can remove.
- Error granularity: a malformed cell fails the whole iteration; per-cell
  in-band `{ error }` values were considered and not needed yet.
- Only the first workbook-level concern (sheets) is exposed: no styles,
  formulas, or merged-region semantics beyond what calamine surfaces.
