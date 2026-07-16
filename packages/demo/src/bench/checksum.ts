/** Order-sensitive FNV-1a fold over normalized cells, shared by both engines
 * so their outputs can be compared cell-for-cell.
 *
 * Normalization contract (must hold for BOTH engines):
 * - rows are arrays of cells; empty cells are null/undefined/array holes and
 *   are skipped (counted only via `rows`/`nonEmpty`)
 * - numbers fold as their canonical JS string (identical f64 -> identical
 *   string); dates stay raw Excel serial numbers on both sides
 *   (calamine default `dates: "serial"`, SheetJS `raw: true` without
 *   `cellDates`)
 * - the column index folds with each non-empty cell so sparse rows can't
 *   collide */
import type { Verification } from "./types";

export interface Fold {
  row(cells: unknown[]): void;
  summary(): Verification;
}

export function createFold(): Fold {
  let h = 0x811c9dc5;
  let rows = 0;
  let nonEmpty = 0;

  const foldStr = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };

  return {
    row(cells: unknown[]): void {
      rows++;
      for (let c = 0; c < cells.length; c++) {
        const v = cells[c];
        if (v === null || v === undefined) continue;
        nonEmpty++;
        foldStr(`${c}:${typeof v === "string" ? v : String(v)}|`);
      }
    },
    summary(): Verification {
      return { rows, nonEmpty, checksum: h >>> 0 };
    },
  };
}
