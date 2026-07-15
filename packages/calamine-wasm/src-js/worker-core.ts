/** Message handler shared by the browser and Node workers (and the inline,
 * no-worker mode). Owns one workbook handle per connection. */
import type { MainToWorker, WorkerToMain } from "./protocol.js";

export interface WorkbookHandle {
  meta(): string;
  openSheet(index: number, columns: number[] | undefined): void;
  /** JSON array-of-arrays, or null/undefined once the sheet is exhausted */
  nextBatch(batchSize: number): string | null | undefined;
  closeSheet(): void;
  free?(): void;
}

export interface WasmApi {
  WasmWorkbook: new (data: Uint8Array) => WorkbookHandle;
}

export interface NativeApi {
  Workbook: new (path: string) => WorkbookHandle;
}

export interface HandlerDeps {
  loadWasm: (wasmUrl?: string) => Promise<WasmApi>;
  /** Node only: resolve path sources */
  readFile?: (path: string) => Uint8Array;
  /** Node only: load the NAPI addon for engine: "native" */
  loadNative?: (modulePath: string) => Promise<NativeApi>;
}

export function createWorkerHandler(
  deps: HandlerDeps,
  post: (msg: WorkerToMain) => void,
): (msg: MainToWorker) => Promise<void> {
  let wb: WorkbookHandle | null = null;
  let streaming = false;

  return async (msg) => {
    try {
      switch (msg.op) {
        case "open": {
          const src = msg.src;
          if (msg.engine === "native") {
            if (!deps.loadNative || !msg.nativeModulePath) throw new Error("native engine is not available here");
            if (typeof src !== "string") throw new Error("native engine requires a file-path source");
            const api = await deps.loadNative(msg.nativeModulePath);
            wb = new api.Workbook(src);
          } else {
            const api = await deps.loadWasm(msg.wasmUrl);
            let bytes: Uint8Array;
            if (typeof src === "string") {
              if (!deps.readFile) throw new Error("file-path sources are only supported in Node");
              bytes = deps.readFile(src);
            } else if (src instanceof Uint8Array) {
              bytes = src;
            } else if (src instanceof ArrayBuffer) {
              bytes = new Uint8Array(src);
            } else {
              // Blob (includes File)
              bytes = new Uint8Array(await src.arrayBuffer());
            }
            wb = new api.WasmWorkbook(bytes);
          }
          post({ ev: "ready" });
          break;
        }
        case "meta": {
          if (!wb) throw new Error("workbook not open");
          post({ ev: "meta", meta: JSON.parse(wb.meta()) });
          break;
        }
        case "sheetOpen": {
          if (!wb) throw new Error("workbook not open");
          wb.openSheet(msg.sheet, msg.columns);
          streaming = true;
          post({ ev: "sheetOpened" });
          break;
        }
        case "pull": {
          if (!wb) throw new Error("workbook not open");
          // over-pulls past EOF are inherent to the client's pull window —
          // a pull with no open cursor just means "no more data"
          if (!streaming) {
            post({ ev: "sheetEnd" });
            break;
          }
          const json = wb.nextBatch(msg.batchSize);
          if (json === null || json === undefined) {
            streaming = false; // cursor auto-closed in Rust
            post({ ev: "sheetEnd" });
          } else if (msg.wire === "json") {
            post({ ev: "batch", json });
          } else {
            post({ ev: "batch", rows: JSON.parse(json) as unknown[][] });
          }
          break;
        }
        case "sheetClose": {
          wb?.closeSheet();
          streaming = false;
          break;
        }
        case "close": {
          // Free the workbook but keep the worker (and its compiled WASM)
          // alive — a session reuses it for the next `open`. Reset the
          // cursor flag so a workbook abandoned mid-stream can't leak stale
          // streaming state into the next one.
          wb?.free?.();
          wb = null;
          streaming = false;
          break;
        }
      }
    } catch (e) {
      post({ ev: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };
}
