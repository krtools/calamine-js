/** Browser worker entry (module worker). */
import { createWorkerHandler } from "./worker-core.js";
import type { MainToWorker } from "./protocol.js";

const handler = createWorkerHandler(
  {
    loadWasm: async (wasmUrl) => {
      const mod = (await import("../pkg/web/calamine_wasm.js")) as Record<string, unknown>;
      await (mod.default as (o?: unknown) => Promise<unknown>)(
        wasmUrl ? { module_or_path: wasmUrl } : undefined,
      );
      return mod as never;
    },
  },
  (msg) => (globalThis as unknown as Worker).postMessage(msg),
);

// The worker never self-terminates: `close` just frees the current workbook
// (so the worker can be reused for the next `open` — see openSession), and
// the CLIENT owns teardown via transport.terminate() (Workbook.close for
// openWorkbook, WorkbookSession.dispose for a warm session).
(globalThis as unknown as { onmessage: (e: MessageEvent<MainToWorker>) => void }).onmessage = async (e) => {
  await handler(e.data);
};
