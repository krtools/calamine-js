/// <reference lib="webworker" />
/** SheetJS runs in its own dedicated worker — the same architecture a
 * well-built app would use — and is deliberately given the transport
 * advantage: rows are folded here in-worker and only a tiny summary crosses
 * back to the main thread, while calamine's numbers include cloning every
 * batch out of its worker.
 *
 * Settings chosen to favor SheetJS: dense sheets (faster, leaner on 0.20.x),
 * raw values (no date/format post-processing). */
import { read, utils } from "xlsx";
import { createFold } from "./checksum";
import type { Verification } from "./types";

export type SheetJsRequest = { file: File; sheet: string };
export type SheetJsResponse =
  | { ev: "phase"; phase: string; elapsedMs: number }
  | { ev: "done"; totalMs: number; verification: Verification }
  | { ev: "error"; message: string };

const post = (msg: SheetJsResponse): void => self.postMessage(msg);

self.onmessage = async (e: MessageEvent<SheetJsRequest>) => {
  const { file, sheet } = e.data;
  try {
    const t0 = performance.now();
    post({ ev: "phase", phase: "reading file", elapsedMs: 0 });
    const bytes = new Uint8Array(await file.arrayBuffer());

    post({ ev: "phase", phase: "parsing workbook", elapsedMs: performance.now() - t0 });
    const wb = read(bytes, { type: "array", dense: true });
    const ws = wb.Sheets[sheet];
    if (!ws) throw new Error(`no sheet named "${sheet}"`);

    post({ ev: "phase", phase: "converting rows", elapsedMs: performance.now() - t0 });
    const rows = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });

    const fold = createFold();
    for (const row of rows) fold.row(row);

    post({ ev: "done", totalMs: performance.now() - t0, verification: fold.summary() });
  } catch (err) {
    post({ ev: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
