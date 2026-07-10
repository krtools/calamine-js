/** Batch post-processing: header capture, column projection, date decoding. */

export interface SheetOptions {
  /** "none" (default): rows are arrays. "first-row": consume row 0 as headers,
   * rows become objects. string[]: use these headers, rows become objects. */
  header?: "none" | "first-row" | string[];
  /** Keep only these columns (indices, or names when headers are known). */
  columns?: (string | number)[];
  /** Date-formatted cells: "serial" (default) yields the raw Excel serial
   * number, "date" yields a JS Date. */
  dates?: "serial" | "date";
  /** Rows per batch (default 10_000). */
  batchSize?: number;
  /** Pull-window size: max unprocessed batches in flight (default 2 —
   * double-buffered). The parser can never run further ahead than this, on
   * any host — flow control rides the message protocol itself, no
   * SharedArrayBuffer or cross-origin isolation involved. Raise it to
   * overlap more parse/consume work; 1 = strict lockstep. */
  backpressure?: number;
  /** Batch delivery: "rows" (default) parses JSON in the worker and clones the
   * arrays; "json" sends the JSON string and parses on the consumer thread. */
  wire?: "rows" | "json";
}

/** Date-typed cells cross the boundary as {"d": <excel serial>}. */
function decodeCell(v: unknown, dates: "serial" | "date"): unknown {
  if (v !== null && typeof v === "object") {
    const d = (v as { d?: unknown }).d;
    if (typeof d === "number") {
      return dates === "date" ? new Date(Math.round((d - 25569) * 86_400_000)) : d;
    }
  }
  return v;
}

export class RowTransformer<T> {
  private headers: string[] | null;
  private colIdx: number[] | null = null;
  private readonly dates: "serial" | "date";
  private readonly wantsObjects: boolean;
  private readonly wantsFirstRow: boolean;

  constructor(private readonly opts: SheetOptions) {
    this.dates = opts.dates ?? "serial";
    this.wantsFirstRow = opts.header === "first-row";
    this.wantsObjects = this.wantsFirstRow || Array.isArray(opts.header);
    this.headers = Array.isArray(opts.header) ? opts.header : null;
    if (!this.wantsFirstRow) this.resolveColumns(); // else deferred until headers arrive
  }

  private resolveColumns(): void {
    const cols = this.opts.columns;
    if (!cols) return;
    this.colIdx = cols.map((c) => {
      if (typeof c === "number") return c;
      const i = this.headers?.indexOf(c) ?? -1;
      if (i < 0) throw new Error(`column "${c}" not found in headers${this.headers ? ` [${this.headers.join(", ")}]` : " (no headers configured)"}`);
      return i;
    });
  }

  /** Header names after projection — object keys. */
  private keys(): string[] {
    const h = this.headers!;
    return this.colIdx ? this.colIdx.map((i) => h[i] ?? `col${i}`) : h;
  }

  transform(rows: unknown[][], firstRow: number): T[] {
    if (this.wantsFirstRow && firstRow === 0 && this.headers === null) {
      const headerRow = rows[0] ?? [];
      this.headers = headerRow.map((v, i) => (v === null || v === undefined ? `col${i}` : String(v)));
      this.resolveColumns();
      rows = rows.slice(1);
    }
    const out: T[] = [];
    const keys = this.wantsObjects ? this.keys() : null;
    for (const row of rows) {
      const cells = this.colIdx ? this.colIdx.map((i) => row[i]) : row;
      if (keys) {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < keys.length; i++) obj[keys[i]] = decodeCell(cells[i], this.dates);
        out.push(obj as T);
      } else {
        out.push(cells.map((v) => decodeCell(v, this.dates)) as T);
      }
    }
    return out;
  }
}
