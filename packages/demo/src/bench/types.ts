export type EngineId = "calamine" | "sheetjs";

/** Output fingerprint used to prove both engines did the same work. */
export interface Verification {
  rows: number;
  nonEmpty: number;
  checksum: number;
}

export interface RunResult {
  engine: EngineId;
  totalMs: number;
  /** ms until the first row was available to application code.
   * SheetJS delivers nothing until the full parse completes, so its
   * firstRowMs === totalMs by construction. */
  firstRowMs: number;
  verification: Verification;
}

export interface EngineProgress {
  state: "idle" | "running" | "done" | "error";
  /** human-readable phase, e.g. "streaming rows" / "parsing workbook" */
  phase: string;
  rowsSoFar: number;
  elapsedMs: number;
  firstRowMs: number | null;
  result: RunResult | null;
  error: string | null;
}

export const IDLE_PROGRESS: EngineProgress = {
  state: "idle",
  phase: "",
  rowsSoFar: 0,
  elapsedMs: 0,
  firstRowMs: null,
  result: null,
  error: null,
};

export type ProgressFn = (p: EngineProgress) => void;
