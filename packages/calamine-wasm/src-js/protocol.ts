/** Wire protocol between the client and the (browser or Node) worker.
 * Strictly sequential: the client never sends a request while another is
 * outstanding, so responses need no correlation ids. Row accounting
 * (firstRow / rowCount) lives client-side — batches arrive in order. */

export interface SheetInfo {
  name: string;
  index: number;
}

export interface WorkbookMeta {
  sheets: SheetInfo[];
}

/** string = file path (Node worker only) */
export type OpenSource = ArrayBuffer | Uint8Array | Blob | string;

export type MainToWorker =
  | {
      op: "open";
      src: OpenSource;
      wasmUrl?: string;
      /** "native" runs the NAPI addon instead of WASM (Node + path sources only) */
      engine?: "wasm" | "native";
      nativeModulePath?: string;
    }
  | { op: "meta" }
  | {
      /** open a pull cursor on one sheet (one at a time per workbook) */
      op: "sheetOpen";
      sheet: number;
      /** projection pushdown: only these column indices are serialized in Rust */
      columns?: number[];
    }
  | {
      /** request ONE batch from the open cursor. Flow control lives here:
       * the client keeps a small window of pulls in flight, so the parser
       * can never run further ahead than the window — backpressure with no
       * SharedArrayBuffer / cross-origin isolation. */
      op: "pull";
      batchSize: number;
      /** "rows" (default): worker JSON.parses, batch crosses as structured clone.
       * "json": the JSON string crosses, client parses. */
      wire?: "rows" | "json";
    }
  | { op: "sheetClose" }
  | { op: "close" };

export type WorkerToMain =
  | { ev: "ready" }
  | { ev: "meta"; meta: WorkbookMeta }
  | { ev: "sheetOpened" }
  | { ev: "batch"; rows?: unknown[][]; json?: string }
  | { ev: "sheetEnd" }
  | { ev: "error"; message: string };
