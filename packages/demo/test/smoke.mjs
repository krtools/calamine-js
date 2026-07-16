/** E2E smoke: serve the built demo, drop the library's test fixture into it,
 * run the race, and assert both engines finish with matching outputs.
 * Run via `npm run test:e2e` in packages/demo (build first). */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../calamine-wasm/test/fixtures/sms-small.xlsx");
const PORT = 4199;

const preview = spawn("npm", ["run", "preview", "--", "--port", String(PORT), "--strictPort"], {
  cwd: path.resolve(here, ".."),
  shell: true,
  stdio: ["ignore", "pipe", "inherit"],
});

// preview is a shell wrapping the real vite process — .kill() would orphan
// vite and its live stdio pipe keeps this script from ever exiting
const killPreview = () => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(preview.pid), "/T", "/F"]);
  else preview.kill();
};
const fail = async (msg) => {
  console.error(`SMOKE FAILED: ${msg}`);
  killPreview();
  process.exit(1);
};

// wait for the preview server to accept connections
const base = `http://localhost:${PORT}/`;
for (let i = 0; ; i++) {
  try {
    await fetch(base);
    break;
  } catch {
    if (i > 50) await fail("preview server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto(base);

  await page.setInputFiles("input[type=file]", FIXTURE);
  await page.getByRole("button", { name: /start the race/i }).click({ timeout: 15_000 });

  const verdict = page.locator(".verdict");
  await verdict.waitFor({ timeout: 120_000 });
  const text = await verdict.innerText();
  console.log("verdict:", text.replace(/\s+/g, " "));

  if (!/outputs match/.test(text)) await fail(`outputs did not match: ${text}`);
  if (!/10,240 rows/.test(text)) await fail(`unexpected row count: ${text}`);

  const chips = await page.locator(".chip.done").count();
  if (chips !== 2) await fail(`expected 2 done chips, saw ${chips}`);

  // second run in sequential mode exercises the other code path
  await page.getByRole("radio", { name: /sequential/i }).check();
  await page.getByRole("button", { name: /run again/i }).click();
  await page.locator(".history tbody tr").nth(1).waitFor({ timeout: 120_000 });
  const row = await page.locator(".history tbody tr").first().innerText();
  console.log("history row (sequential):", row.replace(/\s+/g, " "));
  if (!/✓ match/.test(row)) await fail(`sequential run did not match: ${row}`);

  console.log("SMOKE OK");
  await browser.close();
  killPreview();
  process.exit(0);
} catch (e) {
  await browser.close();
  await fail(e instanceof Error ? e.message : String(e));
}
