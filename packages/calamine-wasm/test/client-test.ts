/** Node test for the client API. Run from packages/calamine-wasm/: npm test
 * Fixture: test/fixtures/sms-small.xlsx (checked in; 10,240-row Messages
 * sheet + 500-row Contacts sheet, deterministic SMS-style content). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { openWorkbook, readAll } from "../dist/client.js";

const FILE = fileURLToPath(new URL("./fixtures/sms-small.xlsx", import.meta.url));
const MESSAGES_ROWS = 10_240;
const CONTACTS_ROWS = 500;

async function testMetaAndTwoSheets(worker: "always" | "never") {
  const wb = openWorkbook(FILE, { worker });
  try {
    const meta = await wb.meta();
    assert.deepEqual(
      meta.sheets.map((s) => s.name),
      ["Messages", "Contacts"],
      "meta sheet names",
    );

    // stream the big sheet in batches, count rows
    let rows = 0;
    let batches = 0;
    for await (const b of wb.sheet("Messages", { batchSize: 1000 })) {
      assert.equal(b.sheet.name, "Messages");
      assert.equal(b.firstRow, batches * 1000);
      rows += b.rows.length;
      batches++;
    }
    assert.equal(rows, MESSAGES_ROWS, "messages row count");
    assert.equal(batches, Math.ceil(MESSAGES_ROWS / 1000), "batch count");

    // second sheet from the SAME handle (sharedStrings not re-parsed)
    const contacts = await wb.sheet("Contacts").collect();
    assert.equal(contacts.length, CONTACTS_ROWS, "contacts row count");
    assert.equal(typeof contacts[0][1], "string", "contact name is a string");
  } finally {
    await wb.close();
  }
  console.log(`  ok: meta + two sheets (worker: ${worker})`);
}

async function testHeadersColumnsObjects() {
  // generated sheet has no header row -> supply explicit headers
  const HEADERS = ["id", "ts", "from", "to", "direction", "status", "segments", "message"];
  const wb = openWorkbook(readFileSync(FILE), { worker: "always" });
  try {
    type Sms = { id: number; from: string; message: string };
    const rows = await wb
      .sheet<Sms>("Messages", { header: HEADERS, columns: ["id", "from", "message"] })
      .collect();
    assert.equal(rows.length, MESSAGES_ROWS);
    assert.deepEqual(Object.keys(rows[0]), ["id", "from", "message"], "projected object keys");
    assert.equal(rows[0].id, 1);
    assert.match(rows[0].from, /^\+1555/);
    assert.equal(typeof rows[0].message, "string");
  } finally {
    await wb.close();
  }
  console.log("  ok: explicit headers + column projection -> objects");
}

async function testFirstRowHeader() {
  // Contacts sheet: treat row 1 as headers just to exercise the path
  const wb = openWorkbook(FILE, { worker: "never" });
  try {
    const rows = await wb.sheet<Record<string, unknown>>("Contacts", { header: "first-row" }).collect();
    assert.equal(rows.length, CONTACTS_ROWS - 1, "first row consumed as header");
    assert.equal(Object.keys(rows[0]).length, 3);
  } finally {
    await wb.close();
  }
  console.log("  ok: header: first-row");
}

async function testEvents() {
  const wb = openWorkbook(FILE, { worker: "always" });
  try {
    const seen: string[] = [];
    const counts: Record<string, number> = {};
    for await (const ev of wb.events()) {
      if (ev.type === "sheetStart") seen.push(ev.sheet.name);
      if (ev.type === "sheetEnd") counts[ev.sheet.name] = ev.rowCount;
    }
    assert.deepEqual(seen, ["Messages", "Contacts"]);
    assert.equal(counts.Messages, MESSAGES_ROWS);
    assert.equal(counts.Contacts, CONTACTS_ROWS);
  } finally {
    await wb.close();
  }
  console.log("  ok: events() across all sheets");
}

async function testReadAll() {
  const rows = await readAll(FILE, { sheet: "Contacts" });
  assert.equal(rows.length, CONTACTS_ROWS);
  console.log("  ok: readAll");
}

async function testErrors() {
  const wb = openWorkbook(FILE, { worker: "always" });
  try {
    await assert.rejects(() => wb.sheet("Nope").collect(), /no sheet named "Nope"/);
    // workbook still usable after a name-resolution error
    const contacts = await wb.sheet("Contacts").collect();
    assert.equal(contacts.length, CONTACTS_ROWS);
  } finally {
    await wb.close();
  }

  const wb2 = openWorkbook(new Uint8Array([1, 2, 3, 4]).buffer, { worker: "always" });
  try {
    await assert.rejects(() => wb2.meta(), /open failed/);
  } finally {
    await wb2.close();
  }
  console.log("  ok: errors (bad sheet name, bad file)");
}

async function testEarlyBreakKeepsWorkbookUsable() {
  const wb = openWorkbook(FILE, { worker: "always" });
  try {
    for await (const b of wb.sheet("Messages", { batchSize: 500 })) {
      void b;
      break; // abandon mid-sheet -> cursor dismantled, workbook stays usable
    }
    const contacts = await wb.sheet("Contacts").collect();
    assert.equal(contacts.length, CONTACTS_ROWS, "workbook survives an abandoned sheet");
    // and the abandoned sheet can be restarted from scratch
    const again = await wb.sheet<unknown[]>("Messages", { columns: [0] }).collect();
    assert.equal(again.length, MESSAGES_ROWS);
  } finally {
    await wb.close();
  }
  console.log("  ok: early break keeps the workbook usable");
}

async function testAwaitUsing() {
  {
    await using wb = openWorkbook(FILE, { worker: "always" });
    const meta = await wb.meta();
    assert.equal(meta.sheets.length, 2);
  }
  console.log("  ok: await using disposes");
}

const NATIVE = createRequire(import.meta.url).resolve("@krllc/calamine-native");
const HEADERS = ["id", "ts", "from", "to", "direction", "status", "segments", "message"];

async function testProjectionPushdown() {
  const wb = openWorkbook(FILE, { worker: "always" });
  try {
    // numeric columns -> pushdown (Rust never serializes the rest)
    const byIdx = await wb.sheet<unknown[]>("Messages", { columns: [0, 7] }).collect();
    assert.equal(byIdx.length, MESSAGES_ROWS);
    assert.equal(byIdx[0].length, 2);
    assert.equal(byIdx[0][0], 1);
    assert.equal(typeof byIdx[0][1], "string");

    // names + explicit headers -> resolved to indices, still pushdown, object rows
    const byName = await wb
      .sheet<{ id: number; message: string }>("Messages", { header: HEADERS, columns: ["id", "message"] })
      .collect();
    assert.deepEqual(Object.keys(byName[0]), ["id", "message"]);
    assert.equal(byName[0].id, byIdx[0][0]);
    assert.equal(byName[0].message, byIdx[0][1]);
  } finally {
    await wb.close();
  }
  console.log("  ok: projection pushdown (indices + resolved names)");
}

async function testProjectionClientSide() {
  // names + header:"first-row" cannot push down (names unknown until row 1
  // arrives) — projection falls back to the client side
  const wb = openWorkbook(FILE, { worker: "always" });
  try {
    const rows = await wb
      .sheet<Record<string, unknown>>("Contacts", { header: "first-row", columns: [0, 1] })
      .collect();
    assert.equal(rows.length, CONTACTS_ROWS - 1);
    assert.equal(Object.keys(rows[0]).length, 2);
  } finally {
    await wb.close();
  }
  console.log("  ok: projection client-side fallback");
}

async function testBackpressure() {
  const wb = openWorkbook(FILE, { worker: "always" });
  const highWaterOf = () => (wb as unknown as { _lastQueue: { highWater: number } })._lastQueue.highWater;
  try {
    // strict lockstep window
    let rows = 0;
    for await (const b of wb.sheet("Messages", { batchSize: 256, backpressure: 1 })) {
      rows += b.rows.length;
      await new Promise((r) => setTimeout(r, 2)); // artificially slow consumer
    }
    assert.equal(rows, MESSAGES_ROWS, "all rows arrive");
    assert.ok(highWaterOf() <= 1, `window=1 high-water ${highWaterOf()} <= 1`);

    // default window (2) is also bounded, no option needed
    rows = 0;
    for await (const b of wb.sheet("Messages", { batchSize: 256 })) {
      rows += b.rows.length;
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(rows, MESSAGES_ROWS);
    assert.ok(highWaterOf() <= 2, `default window high-water ${highWaterOf()} <= 2`);
    console.log(`  ok: pull-window backpressure (window 1 and default 2, bounded)`);
  } finally {
    await wb.close();
  }
}

async function testWireJson() {
  const wb = openWorkbook(FILE, { worker: "always" });
  try {
    const viaJson = await wb.sheet<unknown[]>("Contacts", { wire: "json" }).collect();
    const viaClone = await wb.sheet<unknown[]>("Contacts").collect();
    assert.deepEqual(viaJson, viaClone, "wire formats agree");
  } finally {
    await wb.close();
  }
  console.log("  ok: wire json === wire rows");
}

async function testNativeEngine() {
  for (const worker of ["always", "never"] as const) {
    const wb = openWorkbook(FILE, { engine: "native", nativeModulePath: NATIVE, worker });
    try {
      const meta = await wb.meta();
      assert.deepEqual(meta.sheets.map((s) => s.name), ["Messages", "Contacts"]);
      let rows = 0;
      for await (const b of wb.sheet("Messages", { columns: [0, 7] })) {
        assert.equal((b.rows[0] as unknown[]).length, 2);
        rows += b.rows.length;
      }
      assert.equal(rows, MESSAGES_ROWS);
    } finally {
      await wb.close();
    }
  }
  // native + bytes source must fail with a clear message
  const bad = openWorkbook(readFileSync(FILE), { engine: "native", nativeModulePath: NATIVE });
  await assert.rejects(() => bad.meta(), /file-path source/);
  await bad.close();
  console.log("  ok: native engine (worker + inline, projection, error on bytes)");
}

const t0 = Date.now();
await testMetaAndTwoSheets("always");
await testMetaAndTwoSheets("never");
await testHeadersColumnsObjects();
await testFirstRowHeader();
await testEvents();
await testReadAll();
await testErrors();
await testEarlyBreakKeepsWorkbookUsable();
await testAwaitUsing();
await testProjectionPushdown();
await testProjectionClientSide();
await testBackpressure();
await testWireJson();
await testNativeEngine();
console.log(`all client tests passed in ${Date.now() - t0} ms`);
