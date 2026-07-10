/** @krllc/calamine-wasm/client — ergonomic, worker-first API over the WASM build.
 *
 * const wb = openWorkbook(file);            // File | Blob | ArrayBuffer | Uint8Array | path (Node)
 * for await (const batch of wb.sheet("Messages", { header: "first-row" })) { ... }
 * await wb.close();                          // or `await using wb = openWorkbook(...)`
 *
 * Browser: parsing runs in a module worker; closing terminates it, which is
 * what actually releases the WASM memory high-water mark.
 * Node: files < 8 MB parse inline, larger ones in a worker_threads worker
 * (override with worker: "always" | "never"). engine: "native" runs the
 * calamine NAPI addon behind the same API (Node + path sources only).
 */
import type { MainToWorker, OpenSource, SheetInfo, WorkbookMeta, WorkerToMain } from "./protocol.js";
import { RowTransformer, type SheetOptions } from "./rows.js";

export type { SheetInfo, WorkbookMeta } from "./protocol.js";
export type { SheetOptions } from "./rows.js";

// Runtime may predate the explicit-resource-management symbols
(Symbol as { asyncDispose?: symbol }).asyncDispose ??= Symbol.for("Symbol.asyncDispose");

export type Source = Blob | ArrayBuffer | Uint8Array | string;

export interface WorkbookOptions {
  signal?: AbortSignal;
  /** default "auto": browser -> worker, Node -> worker for files >= 8 MB */
  worker?: "always" | "never" | "auto";
  /** explicit URL for calamine_wasm_bg.wasm (bundler edge cases, browser only) */
  wasmUrl?: string;
  /** "native" runs the calamine NAPI addon (Node + path sources only) */
  engine?: "wasm" | "native";
  /** module specifier/path for the native addon, e.g. require.resolve("calamine-native") */
  nativeModulePath?: string;
}

export type ParseOptions = WorkbookOptions & SheetOptions & { sheet?: number | string };

export interface Batch<T> {
  sheet: SheetInfo;
  rows: T[];
  index: number;
  firstRow: number;
}

export interface Parse<T> extends AsyncIterable<Batch<T>> {
  rows(): AsyncIterable<T>;
  collect(): Promise<T[]>;
}

export type WorkbookEvent =
  | { type: "sheetStart"; sheet: SheetInfo }
  | { type: "rows"; sheet: SheetInfo; rows: unknown[][]; firstRow: number }
  | { type: "sheetEnd"; sheet: SheetInfo; rowCount: number };

export interface Workbook extends AsyncDisposable {
  meta(): Promise<WorkbookMeta>;
  sheet<T = unknown[]>(id?: number | string, opts?: SheetOptions): Parse<T>;
  events(opts?: { sheets?: (number | string)[] | "all" } & SheetOptions): AsyncIterable<WorkbookEvent>;
  close(): Promise<void>;
}

export function openWorkbook(source: Source, opts: WorkbookOptions = {}): Workbook {
  return new WorkbookImpl(source, opts);
}

/** Small-file convenience: parse one sheet fully into memory, no worker. */
export async function readAll<T = unknown[]>(source: Source, opts: ParseOptions = {}): Promise<T[]> {
  const wb = openWorkbook(source, { ...opts, worker: "never" });
  try {
    return await wb.sheet<T>(opts.sheet ?? 0, opts).collect();
  } finally {
    await wb.close();
  }
}

/* ------------------------------------------------------------------ */

// window check guards against browser environments that shim `process`
const isNode = typeof window === "undefined" && typeof process !== "undefined" && !!process.versions?.node;
const NODE_INLINE_LIMIT = 8 * 1024 * 1024;

interface Transport {
  post(msg: MainToWorker, transfer?: ArrayBuffer[]): void;
  terminate(): void | Promise<unknown>;
  readonly isWorker: boolean;
}

async function createWorkerTransport(onMsg: (m: WorkerToMain) => void): Promise<Transport> {
  if (isNode) {
    const { Worker } = await import("node:worker_threads");
    const w = new Worker(new URL("./worker-node.js", import.meta.url));
    w.on("message", onMsg);
    w.on("error", (e) => onMsg({ ev: "error", message: e instanceof Error ? e.message : String(e) }));
    return {
      post: (m, transfer) => w.postMessage(m, transfer),
      terminate: () => w.terminate(),
      isWorker: true,
    };
  }
  const w = new Worker(new URL("./worker-browser.js", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<WorkerToMain>) => onMsg(e.data);
  w.onerror = (e) => onMsg({ ev: "error", message: e.message || "worker error" });
  return {
    post: (m, transfer) => w.postMessage(m, transfer ?? []),
    terminate: () => w.terminate(),
    isWorker: true,
  };
}

/** No-worker mode: run the same handler in the current thread. NOTE: a whole
 * sheet's batches are produced synchronously here, so they buffer in memory —
 * fine for small files, wrong for big ones (that's what workers are for).
 * Backpressure is ignored (Atomics.wait on the calling thread would deadlock). */
async function createInlineTransport(onMsg: (m: WorkerToMain) => void): Promise<Transport> {
  const { createWorkerHandler } = await import("./worker-core.js");
  let handler: (msg: MainToWorker) => Promise<void>;
  if (isNode) {
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const require_ = createRequire(import.meta.url);
    handler = createWorkerHandler(
      {
        loadWasm: async () => require_("../pkg/node/calamine_wasm.js"),
        readFile: (p) => readFileSync(p),
        loadNative: async (modulePath) => require_(modulePath),
      },
      onMsg,
    );
  } else {
    handler = createWorkerHandler(
      {
        loadWasm: async (wasmUrl) => {
          const mod = (await import("../pkg/web/calamine_wasm.js")) as Record<string, unknown>;
          await (mod.default as (o?: unknown) => Promise<unknown>)(wasmUrl ? { module_or_path: wasmUrl } : undefined);
          return mod as never;
        },
      },
      onMsg,
    );
  }
  return { post: (m) => void handler(m), terminate: () => {}, isWorker: false };
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private done = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;
  /** max simultaneously buffered items — observability for backpressure */
  highWater = 0;

  push(v: T): void {
    this.buf.push(v);
    if (this.buf.length > this.highWater) this.highWater = this.buf.length;
    this.wake?.();
    this.wake = null;
  }

  end(err?: Error): void {
    this.done = true;
    this.error = err ?? this.error;
    this.wake?.();
    this.wake = null;
  }

  get isDone(): boolean {
    return this.done;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.buf.length) {
        yield this.buf.shift()!;
        continue;
      }
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((res) => (this.wake = res));
    }
  }
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

type RawBatch = { rows?: unknown[][]; json?: string };

class WorkbookImpl implements Workbook {
  private transport: Transport | null = null;
  private starting: Promise<void> | null = null;
  private metaCache: WorkbookMeta | null = null;
  private readyWaiter: Waiter<void> | null = null;
  private metaWaiter: Waiter<WorkbookMeta> | null = null;
  private sheetOpenWaiter: Waiter<void> | null = null;
  private activeSheet: AsyncQueue<RawBatch> | null = null;
  private failure: Error | null = null;
  private closed = false;
  /** @internal test observability: queue of the most recent sheet stream */
  _lastQueue: AsyncQueue<RawBatch> | null = null;

  constructor(
    private readonly source: Source,
    private readonly opts: WorkbookOptions,
  ) {
    opts.signal?.addEventListener("abort", () => this.fail(new Error("aborted")), { once: true });
  }

  private onMsg = (m: WorkerToMain): void => {
    switch (m.ev) {
      case "ready":
        this.readyWaiter?.resolve();
        this.readyWaiter = null;
        break;
      case "meta":
        this.metaWaiter?.resolve(m.meta);
        this.metaWaiter = null;
        break;
      case "sheetOpened":
        this.sheetOpenWaiter?.resolve();
        this.sheetOpenWaiter = null;
        break;
      case "batch":
        this.activeSheet?.push({ rows: m.rows, json: m.json });
        break;
      case "sheetEnd":
        this.activeSheet?.end();
        this.activeSheet = null;
        break;
      case "error":
        this.fail(new Error(m.message));
        break;
    }
  };

  private fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    this.readyWaiter?.reject(e);
    this.readyWaiter = null;
    this.metaWaiter?.reject(e);
    this.metaWaiter = null;
    this.sheetOpenWaiter?.reject(e);
    this.sheetOpenWaiter = null;
    this.activeSheet?.end(e);
    this.activeSheet = null;
    void this.transport?.terminate();
    this.transport = null;
  }

  private checkUsable(): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("workbook is closed");
  }

  private async useWorker(): Promise<boolean> {
    const mode = this.opts.worker ?? "auto";
    if (mode !== "auto") return mode === "always";
    if (!isNode) return true;
    let size = Infinity;
    const src = this.source;
    if (typeof src === "string") {
      const { statSync } = await import("node:fs");
      size = statSync(src).size;
    } else if (src instanceof Uint8Array || src instanceof ArrayBuffer) {
      size = src.byteLength;
    } else if (typeof Blob !== "undefined" && src instanceof Blob) {
      size = src.size;
    }
    return size >= NODE_INLINE_LIMIT;
  }

  private start(): Promise<void> {
    this.checkUsable();
    this.starting ??= (async () => {
      const engine = this.opts.engine ?? "wasm";
      if (engine === "native") {
        if (!isNode) throw new Error("engine: \"native\" requires Node");
        if (typeof this.source !== "string") throw new Error("engine: \"native\" requires a file-path source");
        if (!this.opts.nativeModulePath) throw new Error("engine: \"native\" requires nativeModulePath");
      }
      if (typeof this.source === "string" && !isNode) throw new Error("file-path sources are only supported in Node");

      this.transport = (await this.useWorker())
        ? await createWorkerTransport(this.onMsg)
        : await createInlineTransport(this.onMsg);

      // Buffers are TRANSFERRED to the worker (zero copy, source is detached).
      // Pass a copy if the caller needs to keep the bytes.
      const src = this.source as OpenSource;
      let transfer: ArrayBuffer[] | undefined;
      if (src instanceof ArrayBuffer) transfer = [src];
      else if (src instanceof Uint8Array && src.byteOffset === 0 && src.byteLength === src.buffer.byteLength && src.buffer instanceof ArrayBuffer) {
        transfer = [src.buffer];
      }

      const ready = new Promise<void>((resolve, reject) => (this.readyWaiter = { resolve, reject }));
      this.transport.post(
        { op: "open", src, wasmUrl: this.opts.wasmUrl, engine, nativeModulePath: this.opts.nativeModulePath },
        transfer,
      );
      await ready;
    })();
    return this.starting;
  }

  async meta(): Promise<WorkbookMeta> {
    await this.start();
    if (this.metaCache) return this.metaCache;
    this.checkUsable();
    const meta = await new Promise<WorkbookMeta>((resolve, reject) => {
      this.metaWaiter = { resolve, reject };
      this.transport!.post({ op: "meta" });
    });
    this.metaCache = meta;
    return meta;
  }

  private async resolveSheet(id: number | string | undefined): Promise<SheetInfo> {
    const meta = await this.meta();
    const info = typeof id === "string" ? meta.sheets.find((s) => s.name === id) : meta.sheets[id ?? 0];
    if (!info) throw new Error(typeof id === "string" ? `no sheet named "${id}"` : `no sheet at index ${id ?? 0}`);
    return info;
  }

  /** One sheet may stream at a time (the Rust cursor owns the workbook while open). */
  private async openSheetStream(index: number, pushIdx: number[] | null): Promise<AsyncQueue<RawBatch>> {
    this.checkUsable();
    if (this.activeSheet) throw new Error("another sheet is already streaming from this workbook");
    await new Promise<void>((resolve, reject) => {
      this.sheetOpenWaiter = { resolve, reject };
      this.transport!.post({ op: "sheetOpen", sheet: index, columns: pushIdx ?? undefined });
    });
    const q = new AsyncQueue<RawBatch>();
    this.activeSheet = q;
    this._lastQueue = q;
    return q;
  }

  private pullBatch(batchSize: number, wire: "rows" | "json" | undefined): void {
    this.transport?.post({ op: "pull", batchSize, wire });
  }

  /** Early abandon: dismantle the cursor but keep the workbook usable. */
  private abandonSheet(): void {
    this.activeSheet = null;
    try {
      this.transport?.post({ op: "sheetClose" });
    } catch {
      // transport dead — nothing to abandon
    }
  }

  sheet<T = unknown[]>(id?: number | string, opts: SheetOptions = {}): Parse<T> {
    const wb = this;

    async function* batches(): AsyncGenerator<Batch<T>> {
      const info = await wb.resolveSheet(id);

      // Projection pushdown: when the column set resolves to indices up front,
      // Rust does the projection and the transformer must not re-apply it.
      let pushIdx: number[] | null = null;
      let txOpts = opts;
      if (opts.columns?.length) {
        if (opts.columns.every((c) => typeof c === "number")) {
          pushIdx = opts.columns as number[];
        } else if (Array.isArray(opts.header)) {
          const header = opts.header;
          pushIdx = opts.columns.map((c) => {
            if (typeof c === "number") return c;
            const i = header.indexOf(c);
            if (i < 0) throw new Error(`column "${c}" not found in headers [${header.join(", ")}]`);
            return i;
          });
        }
        // else: names + header:"first-row" -> projection stays client-side
        if (pushIdx) {
          txOpts = {
            ...opts,
            columns: undefined,
            header: Array.isArray(opts.header) ? pushIdx.map((i) => (opts.header as string[])[i] ?? `col${i}`) : opts.header,
          };
        }
      }

      await wb.start();
      const q = await wb.openSheetStream(info.index, pushIdx);

      // Pull window = built-in backpressure: the parser can never run more
      // than `window` unprocessed batches ahead, on any host, no isolation.
      const window = Math.max(1, opts.backpressure ?? 2);
      const batchSize = opts.batchSize ?? 10_000;
      for (let i = 0; i < window; i++) wb.pullBatch(batchSize, opts.wire);

      const tx = new RowTransformer<T>(txOpts);
      let index = 0;
      let firstRow = 0;
      let finished = false;
      try {
        for await (const raw of q) {
          const rawRows = raw.rows ?? (JSON.parse(raw.json!) as unknown[][]);
          const rows = tx.transform(rawRows, firstRow);
          const batchFirstRow = firstRow;
          firstRow += rawRows.length;
          if (rows.length > 0) {
            yield { sheet: info, rows, index: index++, firstRow: batchFirstRow };
          }
          // consumer done with this batch -> request the next one
          if (!q.isDone) wb.pullBatch(batchSize, opts.wire);
        }
        finished = true;
      } finally {
        // Early abandon just dismantles the cursor — the workbook handle
        // stays fully usable (stray in-flight batches are dropped).
        if (!finished && !wb.failure && !wb.closed) wb.abandonSheet();
      }
    }

    const iterable: Parse<T> = {
      [Symbol.asyncIterator]: () => batches()[Symbol.asyncIterator](),
      async *rows(): AsyncGenerator<T> {
        for await (const b of batches()) yield* b.rows;
      },
      async collect(): Promise<T[]> {
        const out: T[] = [];
        for await (const b of batches()) out.push(...b.rows);
        return out;
      },
    };
    return iterable;
  }

  async *events(opts: { sheets?: (number | string)[] | "all" } & SheetOptions = {}): AsyncGenerator<WorkbookEvent> {
    const meta = await this.meta();
    const wanted =
      !opts.sheets || opts.sheets === "all"
        ? meta.sheets
        : await Promise.all(opts.sheets.map((s) => this.resolveSheet(s)));
    for (const info of wanted) {
      yield { type: "sheetStart", sheet: info };
      let rowCount = 0;
      for await (const b of this.sheet<unknown[]>(info.index, opts)) {
        rowCount = b.firstRow + b.rows.length;
        yield { type: "rows", sheet: info, rows: b.rows, firstRow: b.firstRow };
      }
      yield { type: "sheetEnd", sheet: info, rowCount };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.transport) {
      try {
        this.transport.post({ op: "close" });
      } catch {
        // transport already dead — terminate below is what matters
      }
      await this.transport.terminate();
      this.transport = null;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
