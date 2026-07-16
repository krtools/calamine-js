/** Best-effort agent memory sampling. measureUserAgentSpecificMemory() covers
 * workers + wasm but only runs under cross-origin isolation — which
 * calamine-wasm itself never needs; the vite server sends COOP/COEP purely to
 * unlock this measurement API. Returns null when unavailable (e.g. GitHub
 * Pages, non-Chromium browsers). */
interface MemoryMeasurement {
  bytes: number;
}

export function memoryApiAvailable(): boolean {
  return (
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated &&
    "measureUserAgentSpecificMemory" in performance
  );
}

export async function sampleMemory(): Promise<number | null> {
  if (!memoryApiAvailable()) return null;
  try {
    const m = await (
      performance as unknown as { measureUserAgentSpecificMemory(): Promise<MemoryMeasurement> }
    ).measureUserAgentSpecificMemory();
    return m.bytes;
  } catch {
    return null;
  }
}
