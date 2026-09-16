import { setPopulation } from "./logic.js";

// This controller operates on scalar measurements and the flock's live count.
// It has no browser or renderer dependencies; main.js supplies observed timings.

/**
 * Restart population tuning after a change such as a resize, preset, or pause.
 * Discard decisions based on the old workload and allow two warmup windows.
 * Reset fields in place so restarting does not replace any measurement buffers.
 */
export function resetTuning(performanceData, balance) {
  performanceData.warmup = 2;
  performanceData.goodWindows = 0;
  performanceData.ceiling = balance.capacity;
  performanceData.windowTime = 0;
  performanceData.windowFrames = 0;
  performanceData.windowWork = 0;
  performanceData.slowFrames = 0;
  performanceData.retryIn = 0;
  performanceData.status = "TUNING";
}

/**
 * Record one frame using scalar totals rather than allocating a sample object.
 * Exponential smoothing steadies the display; raw window totals drive adaptation.
 * frameMs is the animation interval, cpuMs is simulation time, and workMs includes
 * CPU render submission. None of these values is a direct GPU timing measurement.
 */
export function recordFrame(performanceData, frameMs, cpuMs, workMs) {
  // Move each displayed average 7% toward the new reading to reduce visual jitter.
  performanceData.frameMs += (frameMs - performanceData.frameMs) * 0.07;
  performanceData.cpuMs += (cpuMs - performanceData.cpuMs) * 0.07;
  performanceData.workMs += (workMs - performanceData.workMs) * 0.07;
  // Convert milliseconds per frame into frames per second for the readout.
  performanceData.fps = 1000 / performanceData.frameMs;
  // Accumulate unsmoothed measurements so display smoothing cannot hide overload.
  performanceData.windowTime += frameMs;
  performanceData.windowWork += workMs;
  performanceData.windowFrames++;
  // Count long intervals as well as the average: intermittent stalls also matter.
  if (frameMs > 20) performanceData.slowFrames++;
  performanceData.samples++;
}

/**
 * Append a chart reading by overwriting one slot of the fixed history array.
 * Advancing modulo the capacity implements a ring buffer: constant work, no shift,
 * no new array. The chart later reads the wrapped samples in chronological order.
 */
export function sampleHistory(performanceData) {
  performanceData.history[performanceData.historyIndex] = performanceData.frameMs;
  performanceData.historyIndex =
    (performanceData.historyIndex + 1) % performanceData.history.length;
  // Stop increasing the count once the ring is full; older readings are overwritten.
  performanceData.historyCount = Math.min(
    performanceData.historyCount + 1,
    performanceData.history.length,
  );
}

/**
 * Adjust the live population after roughly one second of frame measurements.
 * Grow cautiously, retreat quickly, and occasionally retry a previous ceiling.
 * DOD makes these changes practical: setPopulation activates preallocated slots or
 * shortens the live prefix, without replacing buffers or creating agent objects.
 * The thresholds are tuning heuristics; actual results depend on device and load.
 */
export function adaptPopulation(gameData, balance, performanceData) {
  // Make decisions per measurement window, not in reaction to each individual frame.
  if (performanceData.windowTime >= 1000) {
    const averageFrameMs = performanceData.windowTime / performanceData.windowFrames;
    const averageWorkMs = performanceData.windowWork / performanceData.windowFrames;
    const missedFrameRatio = performanceData.slowFrames / performanceData.windowFrames;

    if (gameData.autoScale && !gameData.paused) {
      if (performanceData.warmup > 0) {
        // Ignore early windows while startup and a changed workload settle.
        performanceData.warmup--;
      } else if (averageFrameMs > 17.6 || averageWorkMs > 13 || missedFrameRatio > 0.07) {
        // Any overload signal is enough to retreat and remember a lower ceiling.
        performanceData.ceiling = Math.max(
          balance.minCount,
          Math.floor(gameData.agentCount * 0.95),
        );
        const populationScale = Math.max(
          0.65,
          Math.min(0.88, 16.67 / Math.max(averageFrameMs, averageWorkMs * 1.3)),
        );
        // Retain 65–88% of the population, rounded down to a readable hundred.
        setPopulation(
          gameData,
          balance,
          Math.floor((gameData.agentCount * populationScale) / 100) * 100,
        );
        performanceData.goodWindows = 0;
        // Allow twelve healthy windows before trying to exceed the remembered limit.
        performanceData.retryIn = 12;
        performanceData.status =
          gameData.agentCount === balance.minCount ? "DEVICE LIMIT" : "SETTLING";
      } else if (
        averageFrameMs <= 17.1 &&
        averageWorkMs < 11.5 &&
        missedFrameRatio < 0.035
      ) {
        // Separate grow/shrink thresholds leave a neutral band that reduces oscillation.
        performanceData.goodWindows++;
        if (performanceData.retryIn > 0) performanceData.retryIn--;
        if (
          performanceData.retryIn === 0 &&
          gameData.agentCount >= performanceData.ceiling
        )
          performanceData.ceiling = Math.min(
            balance.capacity,
            Math.ceil(performanceData.ceiling * 1.08),
          );
        // Two healthy windows permit a 15% increase, bounded by the current ceiling.
        if (
          performanceData.goodWindows >= 2 &&
          gameData.agentCount < performanceData.ceiling
        ) {
          setPopulation(
            gameData,
            balance,
            Math.min(
              performanceData.ceiling,
              Math.ceil((gameData.agentCount * 1.15) / 100) * 100,
            ),
          );
          performanceData.goodWindows = 0;
          performanceData.status = "TUNING";
        } else
          performanceData.status =
            gameData.agentCount === balance.capacity ? "POOL LIMIT" : "STABLE";
      } else {
        // A middling window breaks the growth streak without forcing a population cut.
        performanceData.goodWindows = 0;
        performanceData.status = "BALANCED";
      }
    } else performanceData.status = gameData.paused ? "PAUSED" : "MANUAL";

    // Start the next independent measurement window.
    performanceData.windowTime = 0;
    performanceData.windowFrames = 0;
    performanceData.windowWork = 0;
    performanceData.slowFrames = 0;
  }
}
