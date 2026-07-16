/** Races calamine-wasm exactly as a consumer gets it out of the box: the
 * default worker-backed client, default options (10k-row batches, pull-window
 * 2, rows crossing to the main thread as structured clone). All row folding
 * happens here on the main thread — the transport cost of every batch is
 * deliberately included in calamine's numbers. */
import { openWorkbook } from "@krllc/calamine-wasm";
import { createFold } from "./checksum";
import type { ProgressFn, RunResult } from "./types";

export async function listSheets(file: File): Promise<string[]> {
  const wb = openWorkbook(file);
  try {
    const meta = await wb.meta();
    return meta.sheets.map((s) => s.name);
  } finally {
    await wb.close();
  }
}

export async function runCalamine(
  file: File,
  sheet: string,
  onProgress: ProgressFn,
  signal: AbortSignal,
): Promise<RunResult> {
  const fold = createFold();
  const t0 = performance.now();
  let firstRowMs: number | null = null;
  let rowsSoFar = 0;

  const emit = (state: "running" | "done" | "error", extra?: Partial<Parameters<ProgressFn>[0]>): void =>
    onProgress({
      state,
      phase: state === "running" ? (rowsSoFar === 0 ? "opening workbook" : "streaming rows") : "",
      rowsSoFar,
      elapsedMs: performance.now() - t0,
      firstRowMs,
      result: null,
      error: null,
      ...extra,
    });

  emit("running");
  const wb = openWorkbook(file, { signal });
  try {
    for await (const batch of wb.sheet<unknown[]>(sheet)) {
      if (firstRowMs === null && batch.rows.length > 0) firstRowMs = performance.now() - t0;
      for (const row of batch.rows) fold.row(row);
      rowsSoFar += batch.rows.length;
      emit("running");
    }
    const totalMs = performance.now() - t0;
    const result: RunResult = {
      engine: "calamine",
      totalMs,
      firstRowMs: firstRowMs ?? totalMs,
      verification: fold.summary(),
    };
    emit("done", { result, elapsedMs: totalMs });
    return result;
  } finally {
    await wb.close();
  }
}
