export interface SheetStats {
  rows: number;
  cells: number;
  nonEmpty: number;
  floatSum: number;
  strLen: number;
}

/** Persistent workbook handle (file opened + sharedStrings parsed once). */
export class Workbook {
  constructor(path: string);
  /** JSON: {"sheets":[{"name":"...","index":0}, ...]} (cached) */
  meta(): string;
  /** Push API: stream a whole sheet through `cb` in one call. */
  streamSheet(index: number, batchSize: number, columns: number[] | undefined | null, cb: (json: string) => void): void;
  /** Pull API: open a cursor on one sheet (one at a time per workbook). */
  openSheet(index: number, columns?: number[] | null): void;
  /** Next batch as JSON, or null once exhausted (cursor auto-closes). */
  nextBatch(batchSize: number): string | null;
  /** Dismantle the cursor and return the workbook to idle. Idempotent. */
  closeSheet(): void;
}

export function countCells(path: string): SheetStats;
export function readSheetJson(path: string, sheetIndex: number): string;
export function readSheetStream(path: string, sheetIndex: number, batchSize: number, cb: (json: string) => void): void;
