import type { EngineId, EngineProgress } from "../bench/types";

const nf = new Intl.NumberFormat("en-US");

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

const META: Record<EngineId, { title: string; sub: string }> = {
  calamine: {
    title: "calamine-wasm",
    sub: "default client — streams batches out of its worker as it parses",
  },
  sheetjs: {
    title: "SheetJS",
    sub: "dedicated worker, dense mode — rows stay in-worker, summary only",
  },
};

export function EngineCard({
  engine,
  progress,
  liveElapsedMs,
  winner,
}: {
  engine: EngineId;
  progress: EngineProgress;
  /** wall-clock elapsed driven by the App ticker while running */
  liveElapsedMs: number;
  winner: boolean;
}) {
  const { state, phase, rowsSoFar, firstRowMs, result, error } = progress;
  const running = state === "running";
  const elapsed = running ? liveElapsedMs : progress.elapsedMs;
  const rows = state === "done" ? (result?.verification.rows ?? rowsSoFar) : rowsSoFar;
  const rowsPerSec = state === "done" && result ? result.verification.rows / (result.totalMs / 1000) : null;

  const chip =
    state === "done" ? (
      <span className="chip done">✓ done{winner ? " · winner" : ""}</span>
    ) : state === "error" ? (
      <span className="chip error">✕ failed</span>
    ) : running ? (
      <span className="chip">{fmtMs(elapsed)}</span>
    ) : (
      <span className="chip">idle</span>
    );

  return (
    <section className={`card ${engine}${winner ? " winner" : ""}`} aria-label={META[engine].title}>
      <div className="head">
        <div>
          <div className="name">{META[engine].title}</div>
          <div className="sub">{META[engine].sub}</div>
        </div>
        {chip}
      </div>

      <div className="hero">
        {state === "idle" ? "—" : nf.format(rows)}
        <span className="unit">rows{running && engine === "sheetjs" ? " (nothing until parse completes)" : ""}</span>
      </div>
      <div className="phase">{running ? `${phase}…` : " "}</div>

      <div className="track" role="presentation">
        {state !== "idle" && (
          <div className={`fill ${running ? "running" : state === "error" ? "error" : ""}`} />
        )}
      </div>

      <div className="tiles">
        <div className="tile">
          <div className="label">total time</div>
          <div className="value">{state === "done" && result ? fmtMs(result.totalMs) : running ? fmtMs(elapsed) : "—"}</div>
        </div>
        <div className="tile">
          <div className="label">first row after</div>
          <div className="value">
            {state === "done" && result ? fmtMs(result.firstRowMs) : firstRowMs !== null ? fmtMs(firstRowMs) : "—"}
            {state === "done" && engine === "sheetjs" ? <small> (= total)</small> : null}
          </div>
        </div>
        <div className="tile">
          <div className="label">throughput</div>
          <div className="value">
            {rowsPerSec !== null ? nf.format(Math.round(rowsPerSec)) : "—"}
            <small> rows/s</small>
          </div>
        </div>
      </div>

      {state === "error" && <div className="error-detail">✕ {error}</div>}
    </section>
  );
}
