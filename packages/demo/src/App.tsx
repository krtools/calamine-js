import { useEffect, useRef, useState } from "react";
import { listSheets, runCalamine } from "./bench/calamine-runner";
import { startJankMeter, type JankReport } from "./bench/jank";
import { memoryApiAvailable, sampleMemory } from "./bench/memory";
import { runSheetJs } from "./bench/sheetjs-runner";
import { IDLE_PROGRESS, type EngineId, type EngineProgress, type RunResult } from "./bench/types";
import { DropZone } from "./ui/DropZone";
import { EngineCard, fmtMs } from "./ui/EngineCard";

type Mode = "race" | "sequential";
type Outcome = RunResult | { error: string };

interface HistoryEntry {
  id: number;
  fileName: string;
  fileMB: number;
  sheet: string;
  mode: Mode;
  calamine: Outcome;
  sheetjs: Outcome;
  jank: JankReport;
  memDeltaBytes: number | null;
}

const nf = new Intl.NumberFormat("en-US");
const isOk = (o: Outcome): o is RunResult => !("error" in o);

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<string[] | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [metaError, setMetaError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("race");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Record<EngineId, EngineProgress>>({
    calamine: IDLE_PROGRESS,
    sheetjs: IDLE_PROGRESS,
  });
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [lastJank, setLastJank] = useState<JankReport | null>(null);
  const [now, setNow] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const startedAt = useRef<Record<EngineId, number>>({ calamine: 0, sheetjs: 0 });

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, [running]);

  const onFile = async (f: File): Promise<void> => {
    setFile(f);
    setSheets(null);
    setSheet("");
    setMetaError(null);
    setProgress({ calamine: IDLE_PROGRESS, sheetjs: IDLE_PROGRESS });
    try {
      const names = await listSheets(f);
      setSheets(names);
      setSheet(names[0] ?? "");
    } catch (e) {
      setMetaError(`could not read workbook: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const run = async (): Promise<void> => {
    if (!file || !sheet || running) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setLastJank(null);
    setProgress({ calamine: IDLE_PROGRESS, sheetjs: IDLE_PROGRESS });

    const memBefore = await sampleMemory();
    const jank = startJankMeter();

    const start = (engine: EngineId): ((p: EngineProgress) => void) => {
      startedAt.current[engine] = performance.now();
      return (p) => setProgress((s) => ({ ...s, [engine]: p }));
    };
    const settle = async (engine: EngineId, fn: () => Promise<RunResult>): Promise<Outcome> => {
      try {
        return await fn();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setProgress((s) => ({
          ...s,
          [engine]: { ...s[engine], state: "error", error: message, elapsedMs: performance.now() - startedAt.current[engine] },
        }));
        return { error: message };
      }
    };

    const goCalamine = (): Promise<Outcome> => settle("calamine", () => runCalamine(file, sheet, start("calamine"), ac.signal));
    const goSheetJs = (): Promise<Outcome> => settle("sheetjs", () => runSheetJs(file, sheet, start("sheetjs"), ac.signal));

    let calamine: Outcome;
    let sheetjs: Outcome;
    if (mode === "race") {
      [calamine, sheetjs] = await Promise.all([goCalamine(), goSheetJs()]);
    } else {
      calamine = await goCalamine();
      sheetjs = await goSheetJs();
    }

    const jankReport = jank.stop();
    const memAfter = await sampleMemory();
    setLastJank(jankReport);
    setHistory((h) => [
      {
        id: h.length + 1,
        fileName: file.name,
        fileMB: file.size / (1024 * 1024),
        sheet,
        mode,
        calamine,
        sheetjs,
        jank: jankReport,
        memDeltaBytes: memBefore !== null && memAfter !== null ? memAfter - memBefore : null,
      },
      ...h,
    ]);
    setRunning(false);
    abortRef.current = null;
  };

  const cal = progress.calamine;
  const sjs = progress.sheetjs;
  const bothDone = cal.result !== null && sjs.result !== null;
  const winner: EngineId | null = bothDone
    ? cal.result!.totalMs <= sjs.result!.totalMs
      ? "calamine"
      : "sheetjs"
    : null;
  const match =
    bothDone &&
    cal.result!.verification.checksum === sjs.result!.verification.checksum &&
    cal.result!.verification.rows === sjs.result!.verification.rows;

  return (
    <div className="app">
      <header>
        <h1>calamine-wasm vs SheetJS</h1>
        <p>
          Race <a href="https://www.npmjs.com/package/@krllc/calamine-wasm">@krllc/calamine-wasm</a> (Rust
          xlsx parser in a worker, streaming) against SheetJS on <strong>your own file</strong>. Nothing is
          uploaded — everything runs in this tab.
        </p>
      </header>

      {!file ? (
        <DropZone onFile={onFile}>
          <div>
            <strong>Drop an .xlsx file</strong> or click to choose
          </div>
          <div className="hint">the bigger the file, the better the show — try 10 MB+</div>
        </DropZone>
      ) : (
        <>
          <DropZone onFile={onFile} compact>
            <strong>{file.name}</strong>
            <span className="hint">
              {(file.size / (1024 * 1024)).toFixed(1)} MB — drop another file to switch
            </span>
          </DropZone>

          <div className="controls" style={{ marginTop: 12 }}>
            {metaError ? (
              <span className="badge differ">✕ {metaError}</span>
            ) : sheets === null ? (
              <span>reading sheet list…</span>
            ) : (
              <>
                <label>
                  sheet{" "}
                  <select value={sheet} disabled={running} onChange={(e) => setSheet(e.target.value)}>
                    {sheets.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="mode" role="radiogroup" aria-label="run mode">
                  <label>
                    <input
                      type="radio"
                      name="mode"
                      checked={mode === "race"}
                      disabled={running}
                      onChange={() => setMode("race")}
                    />
                    race (simultaneous)
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="mode"
                      checked={mode === "sequential"}
                      disabled={running}
                      onChange={() => setMode("sequential")}
                    />
                    sequential
                  </label>
                </span>
                {running ? (
                  <button onClick={() => abortRef.current?.abort()}>cancel</button>
                ) : (
                  <button className="primary" onClick={run} disabled={!sheet}>
                    {history.length ? "run again" : "start the race"}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="race">
            <EngineCard
              engine="calamine"
              progress={cal}
              liveElapsedMs={now - startedAt.current.calamine}
              winner={winner === "calamine"}
            />
            <EngineCard
              engine="sheetjs"
              progress={sjs}
              liveElapsedMs={now - startedAt.current.sheetjs}
              winner={winner === "sheetjs"}
            />
          </div>

          {bothDone && (
            <div className="verdict">
              <span className="headline">
                calamine was {(sjs.result!.totalMs / cal.result!.totalMs).toFixed(1)}× faster
              </span>
              <span className="detail">
                first row {(sjs.result!.firstRowMs / cal.result!.firstRowMs).toFixed(0)}× sooner (
                {fmtMs(cal.result!.firstRowMs)} vs {fmtMs(sjs.result!.firstRowMs)})
              </span>
              <span className={`badge ${match ? "match" : "differ"}`}>
                {match
                  ? `✓ outputs match — ${nf.format(cal.result!.verification.rows)} rows, checksum ${cal.result!.verification.checksum.toString(16)}`
                  : "✕ outputs differ (row/blank-row or formula semantics — inspect before quoting numbers)"}
              </span>
              {lastJank && (
                <span className="detail">
                  main thread stayed responsive: worst frame {lastJank.worstFrameMs} ms
                </span>
              )}
            </div>
          )}
          {!bothDone && cal.result && sjs.state === "error" && (
            <div className="verdict">
              <span className="headline">
                calamine finished in {fmtMs(cal.result.totalMs)}; SheetJS failed
              </span>
              <span className="detail">{sjs.error}</span>
            </div>
          )}
        </>
      )}

      {history.length > 0 && (
        <div className="history">
          <h2>runs</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>file</th>
                  <th>MB</th>
                  <th>mode</th>
                  <th>calamine</th>
                  <th>SheetJS</th>
                  <th>speedup</th>
                  <th>first row</th>
                  <th>rows</th>
                  <th>outputs</th>
                  <th>worst frame</th>
                  {memoryApiAvailable() && <th>mem Δ</th>}
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const c = h.calamine;
                  const s = h.sheetjs;
                  const entryMatch =
                    isOk(c) && isOk(s) && c.verification.checksum === s.verification.checksum && c.verification.rows === s.verification.rows;
                  return (
                    <tr key={h.id}>
                      <td>
                        {h.fileName} · {h.sheet}
                      </td>
                      <td>{h.fileMB.toFixed(1)}</td>
                      <td>{h.mode}</td>
                      <td>{isOk(c) ? fmtMs(c.totalMs) : "failed"}</td>
                      <td>{isOk(s) ? fmtMs(s.totalMs) : "failed"}</td>
                      <td>{isOk(c) && isOk(s) ? `${(s.totalMs / c.totalMs).toFixed(1)}×` : "—"}</td>
                      <td>{isOk(c) ? fmtMs(c.firstRowMs) : "—"}</td>
                      <td>{isOk(c) ? nf.format(c.verification.rows) : "—"}</td>
                      <td>{isOk(c) && isOk(s) ? (entryMatch ? "✓ match" : "✕ differ") : "—"}</td>
                      <td>{h.jank.worstFrameMs} ms</td>
                      {memoryApiAvailable() && (
                        <td>{h.memDeltaBytes !== null ? `${(h.memDeltaBytes / (1024 * 1024)).toFixed(0)} MB` : "—"}</td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <footer className="notes">
        <p>
          Methodology: SheetJS runs in its own dedicated worker (dense mode, raw values) and is given the
          transport advantage — its rows never leave the worker, while calamine's timings include cloning
          every batch to this thread. Both engines fold identical per-cell checksums so "outputs match"
          means they did the same work.
        </p>
        <p>
          {memoryApiAvailable()
            ? "Memory deltas are best-effort agent-wide samples (workers + wasm included) taken before/after each run."
            : "Memory metrics are unavailable here: the browser's measurement API needs cross-origin isolation. The parser itself never does — that's a feature."}
        </p>
      </footer>
    </div>
  );
}
