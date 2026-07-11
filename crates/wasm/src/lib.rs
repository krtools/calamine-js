//! wasm-bindgen shim over calamine-json-core. WASM is sandboxed with no
//! filesystem — callers pass file bytes as a Uint8Array (fs in Node,
//! File/Blob.arrayBuffer() in the browser).
use calamine_json_core as core;
use wasm_bindgen::prelude::*;

type WbBytes = core::calamine::Xlsx<std::io::Cursor<Vec<u8>>>;

fn js_err(e: String) -> JsError {
    JsError::new(&e)
}

fn js_emit<'e>(callback: &'e js_sys::Function) -> impl FnMut(&str) -> Result<(), String> + 'e {
    move |batch: &str| {
        callback
            .call1(&JsValue::NULL, &JsValue::from_str(batch))
            .map(|_| ())
            .map_err(|_| "callback threw".to_string())
    }
}

/// Persistent workbook handle: sharedStrings parse once; sheets stream via
/// push (`streamSheet`) or the pull cursor (`openSheet`/`nextBatch`/
/// `closeSheet`). Call `free()` when done (the JS client wraps this).
#[wasm_bindgen]
pub struct WasmWorkbook {
    inner: core::WorkbookCore<std::io::Cursor<Vec<u8>>>,
}

#[wasm_bindgen]
impl WasmWorkbook {
    #[wasm_bindgen(constructor)]
    pub fn new(data: Vec<u8>) -> Result<WasmWorkbook, JsError> {
        let wb: WbBytes = core::open_bytes(data).map_err(js_err)?;
        Ok(WasmWorkbook {
            inner: core::WorkbookCore::new(wb),
        })
    }

    /// JSON: {"sheets":[{"name":"...","index":0}, ...]} (cached)
    pub fn meta(&self) -> String {
        self.inner.meta().to_string()
    }

    /// Push API: stream a whole sheet through `callback` in one call.
    #[wasm_bindgen(js_name = streamSheet)]
    pub fn stream_sheet(
        &mut self,
        index: u32,
        batch_size: u32,
        columns: Option<Vec<u32>>,
        callback: &js_sys::Function,
    ) -> Result<(), JsError> {
        let mut emit = js_emit(callback);
        self.inner
            .stream_sheet(index, batch_size, columns, &mut emit)
            .map_err(js_err)
    }

    /// Pull API: open a cursor on sheet `index` (one at a time per workbook).
    #[wasm_bindgen(js_name = openSheet)]
    pub fn open_sheet(&mut self, index: u32, columns: Option<Vec<u32>>) -> Result<(), JsError> {
        self.inner.open_sheet(index, columns).map_err(js_err)
    }

    /// Next batch as JSON, or undefined once exhausted (cursor auto-closes).
    #[wasm_bindgen(js_name = nextBatch)]
    pub fn next_batch(&mut self, batch_size: u32) -> Result<Option<String>, JsError> {
        self.inner.next_batch(batch_size).map_err(js_err)
    }

    /// Dismantle the cursor and return the workbook to idle. Idempotent.
    #[wasm_bindgen(js_name = closeSheet)]
    pub fn close_sheet(&mut self) {
        self.inner.close_sheet();
    }
}

/// Parse sheet 0 fully; return stats as JSON:
/// {rows, cells, nonEmpty, floatSum, strLen}. Measures pure parse cost.
#[wasm_bindgen(js_name = countCells)]
pub fn count_cells(data: &[u8]) -> Result<String, JsError> {
    let mut wb = core::open_bytes_ref(data).map_err(js_err)?;
    let s = core::count_cells(&mut wb).map_err(js_err)?;
    Ok(format!(
        r#"{{"rows":{},"cells":{},"nonEmpty":{},"floatSum":{},"strLen":{}}}"#,
        s.rows, s.cells, s.non_empty, s.float_sum, s.str_len
    ))
}

/// Whole sheet as one JSON array-of-arrays string — prefer streaming for
/// large files.
#[wasm_bindgen(js_name = readSheetJson)]
pub fn read_sheet_json(data: &[u8], sheet_index: u32) -> Result<String, JsError> {
    let mut wb = core::open_bytes_ref(data).map_err(js_err)?;
    core::read_sheet_json(&mut wb, sheet_index).map_err(js_err)
}

/// One-shot push-mode streaming read.
#[wasm_bindgen(js_name = readSheetStream)]
pub fn read_sheet_stream(
    data: &[u8],
    sheet_index: u32,
    batch_size: u32,
    callback: &js_sys::Function,
) -> Result<(), JsError> {
    let mut wb = core::open_bytes_ref(data).map_err(js_err)?;
    let mut emit = js_emit(callback);
    core::stream_sheet(&mut wb, sheet_index, batch_size, None, &mut emit).map_err(js_err)
}
