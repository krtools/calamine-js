//! Shared core for the calamine JS bindings (`crates/wasm`, `crates/native`).
//!
//! Everything binding-agnostic lives here so the two engines cannot drift:
//! JSON serialization (including the `{"d": serial}` date tagging the TS
//! client relies on), the push-mode sheet streamer, the resumable pull
//! cursor, and the workbook state machine. Errors are plain `String`s;
//! callbacks are plain closures — each binding maps them to its own types.
use std::io::{Read, Seek};

pub use calamine;
use calamine::{Data, DataRef, Reader, Xlsx};

/// Batch sink for push-mode streaming.
pub type Emit<'e> = &'e mut dyn FnMut(&str) -> Result<(), String>;

/* ---------------- opening ---------------- */

pub fn open_bytes(data: Vec<u8>) -> Result<Xlsx<std::io::Cursor<Vec<u8>>>, String> {
    Xlsx::new(std::io::Cursor::new(data)).map_err(|e| format!("open failed: {e}"))
}

pub fn open_bytes_ref(data: &[u8]) -> Result<Xlsx<std::io::Cursor<&[u8]>>, String> {
    Xlsx::new(std::io::Cursor::new(data)).map_err(|e| format!("open failed: {e}"))
}

pub fn open_path(path: &str) -> Result<Xlsx<std::io::BufReader<std::fs::File>>, String> {
    calamine::open_workbook(path).map_err(|e| format!("open failed: {e}"))
}

fn sheet_name<RS: Read + Seek>(wb: &Xlsx<RS>, index: u32) -> Result<String, String> {
    wb.sheet_names()
        .get(index as usize)
        .cloned()
        .ok_or_else(|| format!("no sheet at index {index}"))
}

/* ---------------- JSON serialization ---------------- */

pub fn escape_json(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn json_value(cell: &Data, out: &mut String) {
    match cell {
        Data::Empty => out.push_str("null"),
        Data::Float(f) => out.push_str(&format!("{f}")),
        Data::Int(i) => out.push_str(&format!("{i}")),
        Data::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        // date-typed cells are tagged so the JS client can decode them
        Data::DateTime(dt) => out.push_str(&format!("{{\"d\":{}}}", dt.as_f64())),
        Data::String(s) => escape_json(s, out),
        other => escape_json(&format!("{other}"), out),
    }
}

fn json_value_ref(cell: &DataRef, out: &mut String) {
    match cell {
        DataRef::Empty => out.push_str("null"),
        DataRef::Float(f) => out.push_str(&format!("{f}")),
        DataRef::Int(i) => out.push_str(&format!("{i}")),
        DataRef::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        DataRef::String(s) => escape_json(s, out),
        DataRef::SharedString(s) => escape_json(s, out),
        DataRef::DateTime(dt) => out.push_str(&format!("{{\"d\":{}}}", dt.as_f64())),
        DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => escape_json(s, out),
        DataRef::Error(e) => escape_json(&format!("{e:?}"), out),
    }
}

pub fn meta_json<RS: Read + Seek>(wb: &Xlsx<RS>) -> String {
    let mut out = String::from("{\"sheets\":[");
    for (i, name) in wb.sheet_names().iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"name\":");
        escape_json(name, &mut out);
        out.push_str(&format!(",\"index\":{i}}}"));
    }
    out.push_str("]}");
    out
}

/* ---------------- one-shot helpers ---------------- */

pub struct CellStats {
    pub rows: u32,
    pub cells: u64,
    pub non_empty: u64,
    pub float_sum: f64,
    pub str_len: u64,
}

/// Parse sheet 0 fully (via Range) and summarize. Measures pure parse cost.
pub fn count_cells<RS: Read + Seek>(wb: &mut Xlsx<RS>) -> Result<CellStats, String> {
    let range = wb
        .worksheet_range_at(0)
        .ok_or_else(|| "no sheets".to_string())?
        .map_err(|e| format!("range failed: {e}"))?;
    let mut s = CellStats {
        rows: range.height() as u32,
        cells: 0,
        non_empty: 0,
        float_sum: 0.0,
        str_len: 0,
    };
    for row in range.rows() {
        for cell in row {
            s.cells += 1;
            match cell {
                Data::Empty => {}
                Data::Float(f) => {
                    s.non_empty += 1;
                    s.float_sum += f;
                }
                Data::Int(i) => {
                    s.non_empty += 1;
                    s.float_sum += *i as f64;
                }
                Data::String(t) => {
                    s.non_empty += 1;
                    s.str_len += t.len() as u64;
                }
                _ => s.non_empty += 1,
            }
        }
    }
    Ok(s)
}

/// Whole sheet as one JSON array-of-arrays string (giant-string path).
pub fn read_sheet_json<RS: Read + Seek>(
    wb: &mut Xlsx<RS>,
    sheet_index: u32,
) -> Result<String, String> {
    let range = wb
        .worksheet_range_at(sheet_index as usize)
        .ok_or_else(|| format!("no sheet at index {sheet_index}"))?
        .map_err(|e| format!("range failed: {e}"))?;
    let mut out = String::with_capacity(range.height() * 256);
    out.push('[');
    for (ri, row) in range.rows().enumerate() {
        if ri > 0 {
            out.push(',');
        }
        out.push('[');
        for (ci, cell) in row.iter().enumerate() {
            if ci > 0 {
                out.push(',');
            }
            json_value(cell, &mut out);
        }
        out.push(']');
    }
    out.push(']');
    Ok(out)
}

/* ---------------- cell source (type-erased reader) ----------------
 * calamine does not export its cell-reader type, so it is captured in a
 * boxed closure. Yields (row, slot_or_col, serialized fragment): in projected
 * mode the second field is the output slot and the fragment is None for
 * unselected cells (row marker only — never serialized); in dense mode it is
 * the column and the fragment is always Some. */

/// (row, slot_or_col, serialized fragment)
type CellItem = (u32, u32, Option<String>);
type CellResult = Result<Option<CellItem>, String>;
type CellFn<'a> = Box<dyn FnMut() -> CellResult + 'a>;

fn make_cell_fn<'a, RS: Read + Seek>(
    wb: &'a mut Xlsx<RS>,
    name: &str,
    columns: Option<Vec<u32>>,
) -> Result<CellFn<'a>, String> {
    let mut reader = wb
        .worksheet_cells_reader(name)
        .map_err(|e| format!("reader failed: {e}"))?;
    let slot_of: Option<std::collections::HashMap<u32, u32>> = columns.map(|sel| {
        sel.iter()
            .enumerate()
            .map(|(i, &c)| (c, i as u32))
            .collect()
    });
    Ok(Box::new(move || match reader.next_cell() {
        Err(e) => Err(format!("cell read failed: {e}")),
        Ok(None) => Ok(None),
        Ok(Some(cell)) => {
            let (r, c) = cell.get_position();
            match &slot_of {
                Some(map) => match map.get(&c) {
                    Some(&slot) => {
                        let mut s = String::new();
                        json_value_ref(cell.get_value(), &mut s);
                        Ok(Some((r, slot, Some(s))))
                    }
                    None => Ok(Some((r, 0, None))),
                },
                None => {
                    let mut s = String::new();
                    json_value_ref(cell.get_value(), &mut s);
                    Ok(Some((r, c, Some(s))))
                }
            }
        }
    }))
}

/* ---------------- resumable row/batch assembly ---------------- */

struct RowState {
    projected: bool,
    row_buf: String,
    row_cells: u32,
    slots: Vec<String>, // empty string = null sentinel
    cur_row: u32,
    started: bool,
    pending: Option<(u32, u32, Option<String>)>,
    finished: bool,
}

impl RowState {
    fn new(projected_len: Option<usize>) -> Self {
        RowState {
            projected: projected_len.is_some(),
            row_buf: String::with_capacity(256),
            row_cells: 0,
            slots: vec![String::new(); projected_len.unwrap_or(0)],
            cur_row: 0,
            started: false,
            pending: None,
            finished: false,
        }
    }

    fn flush_row(&mut self, batch: &mut String, batch_rows: &mut u32) {
        if *batch_rows > 0 {
            batch.push(',');
        }
        batch.push('[');
        if self.projected {
            for i in 0..self.slots.len() {
                if i > 0 {
                    batch.push(',');
                }
                if self.slots[i].is_empty() {
                    batch.push_str("null");
                } else {
                    batch.push_str(&self.slots[i]);
                    self.slots[i].clear();
                }
            }
        } else {
            batch.push_str(&self.row_buf);
            self.row_buf.clear();
            self.row_cells = 0;
        }
        batch.push(']');
        *batch_rows += 1;
    }

    fn add_cell(&mut self, slot_or_col: u32, frag: Option<String>) {
        if self.projected {
            if let Some(f) = frag {
                self.slots[slot_or_col as usize] = f;
            }
        } else if let Some(f) = frag {
            while self.row_cells < slot_or_col {
                if self.row_cells > 0 {
                    self.row_buf.push(',');
                }
                self.row_buf.push_str("null");
                self.row_cells += 1;
            }
            if self.row_cells > 0 {
                self.row_buf.push(',');
            }
            self.row_buf.push_str(&f);
            self.row_cells += 1;
        }
    }

    /// Assemble up to `batch_size` rows; Ok(None) once the sheet is exhausted.
    /// Resumable: the row-boundary cell that ends a batch is stashed
    /// (pre-serialized) in `pending` for the next call.
    fn next_batch(
        &mut self,
        batch_size: u32,
        cells: &mut dyn FnMut() -> CellResult,
    ) -> Result<Option<String>, String> {
        if self.finished {
            return Ok(None);
        }
        let mut batch = String::with_capacity(batch_size as usize * 64);
        let mut batch_rows: u32 = 0;
        loop {
            let item = match self.pending.take() {
                Some(p) => Some(p),
                None => cells()?,
            };
            let Some((r, sc, frag)) = item else {
                self.finished = true;
                if self.started {
                    self.flush_row(&mut batch, &mut batch_rows);
                    self.started = false;
                }
                break;
            };
            if !self.started {
                self.started = true;
                self.cur_row = r;
            }
            while self.cur_row < r {
                self.flush_row(&mut batch, &mut batch_rows);
                self.cur_row += 1;
                if batch_rows >= batch_size {
                    self.pending = Some((r, sc, frag));
                    return Ok(Some(format!("[{batch}]")));
                }
            }
            self.add_cell(sc, frag);
        }
        if batch_rows > 0 {
            Ok(Some(format!("[{batch}]")))
        } else {
            Ok(None)
        }
    }
}

/* ---------------- pull cursor + workbook state machine ---------------- */

#[ouroboros::self_referencing]
struct SheetCursor<RS: Read + Seek + 'static> {
    wb: Xlsx<RS>,
    #[borrows(mut wb)]
    #[not_covariant]
    cells: CellFn<'this>,
}

enum WbState<RS: Read + Seek + 'static> {
    /// transient placeholder during transitions
    Vacant,
    Idle(Xlsx<RS>),
    Streaming {
        cursor: SheetCursor<RS>,
        rows: RowState,
    },
}

/// Binding-agnostic workbook handle: sharedStrings parse once (construction),
/// sheets stream via push (`stream_sheet`) or the pull cursor
/// (`open_sheet` / `next_batch` / `close_sheet`). Opening a sheet MOVES the
/// workbook into the cursor; closing moves it back — one sheet at a time is
/// a type-level invariant.
pub struct WorkbookCore<RS: Read + Seek + 'static> {
    state: WbState<RS>,
    meta_json: String,
}

impl<RS: Read + Seek + 'static> WorkbookCore<RS> {
    pub fn new(wb: Xlsx<RS>) -> Self {
        let meta_json = meta_json(&wb);
        WorkbookCore {
            state: WbState::Idle(wb),
            meta_json,
        }
    }

    /// Cached — usable even while a sheet is streaming.
    pub fn meta(&self) -> &str {
        &self.meta_json
    }

    /// Push API: stream a whole sheet through `emit` in one call.
    pub fn stream_sheet(
        &mut self,
        index: u32,
        batch_size: u32,
        columns: Option<Vec<u32>>,
        emit: Emit,
    ) -> Result<(), String> {
        match &mut self.state {
            WbState::Idle(wb) => stream_sheet(wb, index, batch_size, columns, emit),
            _ => Err("a sheet stream is already open".into()),
        }
    }

    /// Pull API: open a cursor on sheet `index`.
    pub fn open_sheet(&mut self, index: u32, columns: Option<Vec<u32>>) -> Result<(), String> {
        let state = std::mem::replace(&mut self.state, WbState::Vacant);
        let wb = match state {
            WbState::Idle(wb) => wb,
            other => {
                self.state = other;
                return Err("a sheet stream is already open".into());
            }
        };
        let name = match sheet_name(&wb, index) {
            Ok(n) => n,
            Err(e) => {
                self.state = WbState::Idle(wb);
                return Err(e);
            }
        };
        let projected_len = columns.as_ref().map(|c| c.len());
        let built = SheetCursorTryBuilder {
            wb,
            cells_builder: |wb| make_cell_fn(wb, &name, columns),
        }
        .try_build_or_recover();
        match built {
            Ok(cursor) => {
                self.state = WbState::Streaming {
                    cursor,
                    rows: RowState::new(projected_len),
                };
                Ok(())
            }
            Err((e, heads)) => {
                self.state = WbState::Idle(heads.wb);
                Err(e)
            }
        }
    }

    /// Next batch as JSON, or None once exhausted (the cursor auto-closes and
    /// the handle is reusable).
    pub fn next_batch(&mut self, batch_size: u32) -> Result<Option<String>, String> {
        let out = match &mut self.state {
            WbState::Streaming { cursor, rows } => {
                cursor.with_cells_mut(|cells| rows.next_batch(batch_size, &mut **cells))?
            }
            _ => return Err("no sheet stream is open".into()),
        };
        if out.is_none() {
            self.close_sheet();
        }
        Ok(out)
    }

    /// Dismantle the cursor (early abandon or after exhaustion) and return
    /// the workbook to the idle, reusable state. Idempotent.
    pub fn close_sheet(&mut self) {
        if matches!(self.state, WbState::Streaming { .. }) {
            let state = std::mem::replace(&mut self.state, WbState::Vacant);
            if let WbState::Streaming { cursor, .. } = state {
                self.state = WbState::Idle(cursor.into_heads().wb);
            }
        }
    }
}

/// Push-mode streaming over any workbook (also used by the one-shot APIs).
/// Built on the same cell source + row assembly as the pull cursor, so both
/// modes produce identical output.
pub fn stream_sheet<RS: Read + Seek>(
    wb: &mut Xlsx<RS>,
    index: u32,
    batch_size: u32,
    columns: Option<Vec<u32>>,
    emit: Emit,
) -> Result<(), String> {
    let name = sheet_name(wb, index)?;
    let projected_len = columns.as_ref().map(|c| c.len());
    let mut cells = make_cell_fn(wb, &name, columns)?;
    let mut rows = RowState::new(projected_len);
    while let Some(batch) = rows.next_batch(batch_size, &mut *cells)? {
        emit(&batch)?;
    }
    Ok(())
}
