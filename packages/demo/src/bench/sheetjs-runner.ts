/** Main-thread wrapper around the SheetJS worker. SheetJS cannot stream, so
 * progress is limited to phase changes; rowsSoFar stays 0 until the end —
 * that is the honest shape of its delivery, not a display bug. */
import type { ProgressFn, RunResult } from "./types";
import type { SheetJsResponse } from "./sheetjs.worker";

export function runSheetJs(
  file: File,
  sheet: string,
  onProgress: ProgressFn,
  signal: AbortSignal,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const worker = new Worker(new URL("./sheetjs.worker.ts", import.meta.url), { type: "module" });
    const t0 = performance.now();
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      worker.terminate();
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (message: string): void =>
      finish(() => {
        onProgress({
          state: "error",
          phase: "",
          rowsSoFar: 0,
          elapsedMs: performance.now() - t0,
          firstRowMs: null,
          result: null,
          error: message,
        });
        reject(new Error(message));
      });
    const onAbort = (): void => fail("aborted");
    signal.addEventListener("abort", onAbort, { once: true });

    worker.onerror = (e) => fail(e.message || "worker crashed (likely out of memory)");
    worker.onmessage = (e: MessageEvent<SheetJsResponse>) => {
      const msg = e.data;
      if (msg.ev === "phase") {
        onProgress({
          state: "running",
          phase: msg.phase,
          rowsSoFar: 0,
          elapsedMs: msg.elapsedMs,
          firstRowMs: null,
          result: null,
          error: null,
        });
      } else if (msg.ev === "done") {
        const result: RunResult = {
          engine: "sheetjs",
          totalMs: msg.totalMs,
          // nothing is available to the app until the whole parse finishes
          firstRowMs: msg.totalMs,
          verification: msg.verification,
        };
        finish(() => {
          onProgress({
            state: "done",
            phase: "",
            rowsSoFar: msg.verification.rows,
            elapsedMs: msg.totalMs,
            firstRowMs: msg.totalMs,
            result,
            error: null,
          });
          resolve(result);
        });
      } else {
        fail(msg.message);
      }
    };

    worker.postMessage({ file, sheet });
  });
}
