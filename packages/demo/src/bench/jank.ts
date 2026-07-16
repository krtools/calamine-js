/** rAF-based main-thread responsiveness meter: while a race runs, records the
 * worst frame gap and how many frames exceeded 50 ms. Both engines parse in
 * workers, so this should stay near 16 ms — that's the point being made. */
export interface JankReport {
  worstFrameMs: number;
  longFrames: number;
  frames: number;
}

export function startJankMeter(): { stop(): JankReport } {
  let worst = 0;
  let longFrames = 0;
  let frames = 0;
  let prev = performance.now();
  let handle = 0;
  const loop = (t: number): void => {
    const d = t - prev;
    prev = t;
    frames++;
    if (d > worst) worst = d;
    if (d > 50) longFrames++;
    handle = requestAnimationFrame(loop);
  };
  handle = requestAnimationFrame(loop);
  return {
    stop(): JankReport {
      cancelAnimationFrame(handle);
      return { worstFrameMs: Math.round(worst), longFrames, frames };
    },
  };
}
