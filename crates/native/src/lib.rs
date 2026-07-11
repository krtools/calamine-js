//! NAPI shim over calamine-json-core. Path-based: file I/O happens in Rust,
//! so file bytes never enter JS memory.
use calamine_json_core as core;
use napi::bindgen_prelude::*;
use napi::{Env, JsFunction};
use napi_derive::napi;

type FileWb = core::calamine::Xlsx<std::io::BufReader<std::fs::File>>;

fn napi_err(e: String) -> Error {
    Error::from_reason(e)
}

fn napi_emit<'e>(
    env: &'e Env,
    callback: &'e JsFunction,
) -> impl FnMut(&str) -> std::result::Result<(), String> + 'e {
    move |batch: &str| {
        let js = env.create_string(batch).map_err(|e| e.to_string())?;
        callback
            .call(None, &[js])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[napi(object)]
pub struct SheetStats {
    pub rows: u32,
    pub cells: u32,
    pub non_empty: u32,
    pub float_sum: f64,
    pub str_len: u32,
}

/// Persistent workbook handle mirroring the WASM `WasmWorkbook`. Used by the
/// client API's `engine: "native"` mode.
#[napi]
pub struct Workbook {
    inner: core::WorkbookCore<std::io::BufReader<std::fs::File>>,
}

#[napi]
impl Workbook {
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let wb: FileWb = core::open_path(&path).map_err(napi_err)?;
        Ok(Workbook {
            inner: core::WorkbookCore::new(wb),
        })
    }

    /// JSON: {"sheets":[{"name":"...","index":0}, ...]} (cached)
    #[napi]
    pub fn meta(&self) -> String {
        self.inner.meta().to_string()
    }

    /// Push API: stream a whole sheet through `callback` in one call.
    #[napi]
    pub fn stream_sheet(
        &mut self,
        env: Env,
        index: u32,
        batch_size: u32,
        columns: Option<Vec<u32>>,
        callback: JsFunction,
    ) -> Result<()> {
        let mut emit = napi_emit(&env, &callback);
        self.inner
            .stream_sheet(index, batch_size, columns, &mut emit)
            .map_err(napi_err)
    }

    /// Pull API: open a cursor on sheet `index` (one at a time per workbook).
    #[napi]
    pub fn open_sheet(&mut self, index: u32, columns: Option<Vec<u32>>) -> Result<()> {
        self.inner.open_sheet(index, columns).map_err(napi_err)
    }

    /// Next batch as JSON, or null once exhausted (cursor auto-closes).
    #[napi]
    pub fn next_batch(&mut self, batch_size: u32) -> Result<Option<String>> {
        self.inner.next_batch(batch_size).map_err(napi_err)
    }

    /// Dismantle the cursor and return the workbook to idle. Idempotent.
    #[napi]
    pub fn close_sheet(&mut self) {
        self.inner.close_sheet();
    }
}

/// Parse sheet 0 fully; return summary stats. Measures pure parse cost.
#[napi]
pub fn count_cells(path: String) -> Result<SheetStats> {
    let mut wb = core::open_path(&path).map_err(napi_err)?;
    let s = core::count_cells(&mut wb).map_err(napi_err)?;
    Ok(SheetStats {
        rows: s.rows,
        cells: s.cells as u32,
        non_empty: s.non_empty as u32,
        float_sum: s.float_sum,
        str_len: s.str_len as u32,
    })
}

/// Whole sheet as one JSON array-of-arrays string.
#[napi]
pub fn read_sheet_json(path: String, sheet_index: u32) -> Result<String> {
    let mut wb = core::open_path(&path).map_err(napi_err)?;
    core::read_sheet_json(&mut wb, sheet_index).map_err(napi_err)
}

/// One-shot push-mode streaming read.
#[napi]
pub fn read_sheet_stream(
    env: Env,
    path: String,
    sheet_index: u32,
    batch_size: u32,
    callback: JsFunction,
) -> Result<()> {
    let mut wb = core::open_path(&path).map_err(napi_err)?;
    let mut emit = napi_emit(&env, &callback);
    core::stream_sheet(&mut wb, sheet_index, batch_size, None, &mut emit).map_err(napi_err)
}
