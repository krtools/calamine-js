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

port.on("message", async (msg: MainToWorker) => {
  await handler(msg);
  if (msg.op === "close") port.close();
});
