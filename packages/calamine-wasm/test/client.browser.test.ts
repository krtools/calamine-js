/// <reference types="vite/client" />
/** Real-browser tests (vitest browser mode, headless Chromium via Playwright).
 * Exercises exactly what Node tests can't: module-worker URL resolution
 * through Vite, wasm init() fetch, real File/Blob sources, structured clone
 * across a real Worker, buffer transfer semantics, and SharedArrayBuffer
 * backpressure under cross-origin isolation. */
import { expect, test } from "vitest";
import { openWorkbook, readAll } from "../dist/client.js";
// @ts-expect-error vite ?url asset import
import xlsxUrl from "./fixtures/sms-small.xlsx?url";

const MESSAGES_ROWS = 10_240;
const CONTACTS_ROWS = 500;
const HEADERS = ["id", "ts", "from", "to", "direction", "status", "segments", "message"];

async function fixtureBytes(): Promise<ArrayBuffer> {
  const res = await fetch(xlsxUrl);
  expect(res.ok).toBe(true);
  return res.arrayBuffer();
}

async function fixtureFile(): Promise<File> {
  return new File([await fixtureBytes()], "sms-small.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

test("File source -> module worker -> streamed batches", { timeout: 30_000 }, async () => {
  const wb = openWorkbook(await fixtureFile()); // browser default: worker
  try {
    const meta = await wb.meta();
    expect(meta.sheets.map((s) => s.name)).toEqual(["Messages", "Contacts"]);

    let rows = 0;
    let batches = 0;
    for await (const b of wb.sheet("Messages", { batchSize: 2048 })) {
      expect(b.sheet.name).toBe("Messages");
      rows += b.rows.length;
      batches++;
    }
    expect(rows).toBe(MESSAGES_ROWS);
    expect(batches).toBe(Math.ceil(MESSAGES_ROWS / 2048));

    // second sheet from the same handle
    const contacts = await wb.sheet("Contacts").collect();
    expect(contacts.length).toBe(CONTACTS_ROWS);
  } finally {
    await wb.close();
  }
});

test("projection pushdown + header objects", { timeout: 30_000 }, async () => {
  const wb = openWorkbook(await fixtureFile());
  try {
    const rows = await wb
      .sheet<{ id: number; message: string }>("Messages", { header: HEADERS, columns: ["id", "message"] })
      .collect();
    expect(rows.length).toBe(MESSAGES_ROWS);
    expect(Object.keys(rows[0])).toEqual(["id", "message"]);
    expect(rows[0].id).toBe(1);
    expect(typeof rows[0].message).toBe("string");
  } finally {
    await wb.close();
  }
});

test("pull-window backpressure WITHOUT cross-origin isolation", { timeout: 60_000 }, async () => {
  // the whole point of the pull cursor: bounded memory on a plain static host
  expect(crossOriginIsolated).toBe(false);
  expect(typeof SharedArrayBuffer).toBe("undefined");
  const WINDOW = 2;
  const wb = openWorkbook(await fixtureFile());
  try {
    let rows = 0;
    for await (const b of wb.sheet("Messages", { batchSize: 256, backpressure: WINDOW })) {
      rows += b.rows.length;
      await new Promise((r) => setTimeout(r, 2)); // slow consumer
    }
    expect(rows).toBe(MESSAGES_ROWS);
    const highWater = (wb as unknown as { _lastQueue: { highWater: number } })._lastQueue.highWater;
    expect(highWater).toBeLessThanOrEqual(WINDOW);
  } finally {
    await wb.close();
  }
});

test("ArrayBuffer source is transferred (detached), as documented", { timeout: 30_000 }, async () => {
  const buf = await fixtureBytes();
  const wb = openWorkbook(buf);
  try {
    await wb.meta();
    expect(buf.byteLength).toBe(0); // zero-copy transfer detached the buffer
  } finally {
    await wb.close();
  }
});

test("readAll runs inline (wasm init on this thread, no worker)", { timeout: 30_000 }, async () => {
  const bytes = new Uint8Array(await fixtureBytes()).slice(); // keep a copy semantics simple
  const rows = await readAll(bytes, { sheet: "Contacts" });
  expect(rows.length).toBe(CONTACTS_ROWS);
});

test("early break mid-sheet keeps the workbook usable", { timeout: 30_000 }, async () => {
  const wb = openWorkbook(await fixtureFile());
  try {
    for await (const b of wb.sheet("Messages", { batchSize: 256 })) {
      void b;
      break;
    }
    const contacts = await wb.sheet("Contacts").collect();
    expect(contacts.length).toBe(CONTACTS_ROWS);
  } finally {
    await wb.close();
  }
});
