# @krllc/calamine-wasm

[calamine](https://crates.io/crates/calamine) (Rust xlsx/xls/ods reader) compiled
to WebAssembly, with a streaming, worker-first TypeScript client for Node.js and
browsers. ~430 KB .wasm (~213 KB brotli over the wire), no native build step for
consumers.

Designed for memory-aggressive parsing: rows stream out in batches and are
dropped as you consume them; in the browser the parse runs in a disposable
worker whose teardown releases the WASM memory high-water mark.

Why things are built this way — decisions, measurements, declined
alternatives — is recorded in [DESIGN.md](./DESIGN.md).

## Client API (`@krllc/calamine-wasm/client` — also the default export)

```ts
import { openWorkbook } from "@krllc/calamine-wasm/client";

await using wb = openWorkbook(file);        // File | Blob | ArrayBuffer | Uint8Array | path (Node)

const meta = await wb.meta();               // { sheets: [{ name, index }] }

for await (const batch of wb.sheet<Sms>("Messages", {
  header: "first-row",                      // rows become objects keyed by row 1
  columns: ["id", "ts", "from", "message"], // project columns (names or indices)
  dates: "date",                            // date-formatted cells -> JS Date
  batchSize: 10_000,
})) {
  await db.messages.bulkPut(batch.rows);    // batch dropped after this — memory stays flat
}
// `await using` closes the workbook: worker terminated, WASM memory reclaimed
```

- **`openWorkbook(source, opts)`** — file decode + sharedStrings parse happen
  once; stream any number of sheets from the handle (sequentially).
- **`wb.sheet(id?, opts?)`** — `AsyncIterable<Batch<T>>` for one sheet, plus
  `.rows()` (flattened) and `.collect()` (everything in memory — small sheets only).
- **`wb.events(opts?)`** — SAX-style `sheetStart` / `rows` / `sheetEnd` events
  across all (or selected) sheets, tagged with their sheet.
- **`readAll(source, opts?)`** — one-shot convenience for small files (no worker).

Workbook options: `worker: "always" | "never" | "auto"` (browser defaults to a
worker; Node uses one for files ≥ 8 MB), `signal` (AbortSignal), `wasmUrl`
(explicit .wasm URL for bundler edge cases), and `engine: "native"` +
`nativeModulePath` to run the calamine NAPI addon behind the identical API
(Node + path sources only; ~20% faster, no file bytes in memory).

Sheet options beyond the basics:

- **`columns`** — when the set resolves to indices up front (numeric, or names
  against known headers), projection is **pushed into Rust**: dropped columns
  are never serialized or sent. Names + `header: "first-row"` falls back to
  client-side projection.
- **`backpressure: N`** — pull-window size (default 2). Sheets stream via a
  pull cursor: the client requests batches one message at a time with N in
  flight, so the parser can never run more than N unprocessed batches ahead.
  Bounded memory is therefore the DEFAULT, on any host — no SharedArrayBuffer,
  no COOP/COEP, works on GitHub Pages. N=1 is strict lockstep (no
  parse/consume overlap, ~40% slower with a slow consumer); the default 2
  double-buffers. Measured on a 96 MB file with a 100 ms/batch consumer:
  queue high-water 1, 554 MB peak (the old unbounded push mode hit 834 MB).
- **`wire: "json"`** — send the JSON string and parse on the consumer thread
  instead of parsing in the worker. ~8–11% faster end-to-end (the parse
  pipelines across threads) at the cost of consumer-thread CPU; default stays
  `"rows"` to keep the browser main thread idle.

Behavior worth knowing:

- `ArrayBuffer` / whole-buffer `Uint8Array` sources are **transferred** to the
  worker (zero copy — the caller's buffer is detached). Pass a copy to keep it.
  `File`/`Blob` handles are free to send; Node paths are read inside the worker.
- Breaking out of a sheet iteration mid-stream just dismantles that sheet's
  cursor — the workbook handle stays fully usable for other sheets or a
  restart of the same one.
- One sheet streams at a time per workbook (the cursor owns the workbook
  while open; sharedStrings are still parsed only once per workbook).

## Raw WASM API (`/node`, `/web` subpaths)

For benchmarks and power users. WASM has no filesystem — pass bytes as `Uint8Array`.

```ts
new WasmWorkbook(bytes)                 // persistent handle
  .meta(): string                       // JSON {"sheets":[...]} (cached)
  .streamSheet(index, batchSize, columns?, cb)  // push: whole sheet in one call
  .openSheet(index, columns?)           // pull cursor (one at a time)
  .nextBatch(batchSize): string | undefined     // undefined = exhausted (auto-closes)
  .closeSheet()                         // early abandon; handle stays usable
  .free()

countCells(bytes): string               // parse stats JSON (sheet 0)
readSheetJson(bytes, sheetIndex): string
readSheetStream(bytes, sheetIndex, batchSize, cb): void
```

Date-formatted cells are emitted as `{"d": <excel serial>}` in the JSON;
the client decodes them (`dates` option).

Browser (`/web`) requires init: `import init, {...} from "@krllc/calamine-wasm/web"; await init();`
`demo.html` is a zero-bundler example — serve this folder (`npx serve .`) and open it.

## Building

Requires Rust (`rustup target add wasm32-unknown-unknown`), wasm-pack, and tsc:

```sh
npm run build         # wasm (pkg/node CJS + pkg/web ESM) + client (dist/)
npm test              # Node client tests (needs ../data/sms-small.xlsx)
npm run test:browser  # real-browser tests: headless Chromium via vitest browser mode
npm run test:all      # both
```

The browser suite (`test/client.browser.test.ts`) covers what Node can't:
module-worker resolution through Vite, the wasm `init()` fetch, real
`File`/`Blob` sources, ArrayBuffer transfer/detach semantics, inline (no-worker)
init on the main thread, and pull-window backpressure verified bounded
**without** cross-origin isolation (the vitest server deliberately sends no
COOP/COEP and the test asserts `crossOriginIsolated === false`). The fixture is
a copy of `../data/sms-small.xlsx` in `test/fixtures/` — refresh it after
regenerating test data.

## Performance

Measured on a 96 MB xlsx (1.02M rows, one mostly-unique text column, i.e.
a huge sharedStrings table), fresh process, vs SheetJS `xlsx` 0.20.3:

| | time | peak RSS |
|---|---|---|
| client (worker + streamed batches) | 8.0 s | 586 MB |
| raw `readSheetStream`, same thread | 6.9 s | 539 MB |
| SheetJS read + sheet_to_json | 18.3 s | 2,980 MB |

The parse itself never materializes the sheet on the Rust side (calamine's
cell reader), and the whole-file bytes are the memory floor — xlsx is a zip
with its central directory at the end, so input can't stream.
