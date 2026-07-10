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

(globalThis as unknown as { onmessage: (e: MessageEvent<MainToWorker>) => void }).onmessage = async (e) => {
  await handler(e.data);
  if (e.data.op === "close") (globalThis as unknown as { close(): void }).close();
};
