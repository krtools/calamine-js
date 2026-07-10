import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  assetsInclude: ["**/*.xlsx"],
  // Deliberately NO COOP/COEP headers: the pull-cursor backpressure must work
  // without cross-origin isolation (the browser test asserts it does).
  test: {
    include: ["test/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
