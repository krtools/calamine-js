/** Node worker entry (worker_threads). */
import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createWorkerHandler } from "./worker-core.js";
import type { MainToWorker } from "./protocol.js";

const port = parentPort;
if (!port) throw new Error("worker-node.js must be run as a worker thread");

const require_ = createRequire(import.meta.url);

const handler = createWorkerHandler(
  {
    loadWasm: async () => require_("../pkg/node/calamine_wasm.js"),
    readFile: (path) => readFileSync(path),
    loadNative: async (modulePath) => require_(modulePath),
  },
  (msg) => port.postMessage(msg),
);

// The worker never self-terminates: `close` just frees the current workbook
// (so the worker can be reused for the next `open` — see openSession), and
// the CLIENT owns teardown via transport.terminate() (Workbook.close for
// openWorkbook, WorkbookSession.dispose for a warm session).
port.on("message", async (msg: MainToWorker) => {
  await handler(msg);
});
