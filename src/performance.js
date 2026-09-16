import { setPopulation } from "./logic.js";

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

// Smooth the displayed readings; keep raw totals for the one-second decisions.
export function recordFrame(performanceData, frameMs, cpuMs, workMs) {
  performanceData.frameMs += (frameMs - performanceData.frameMs) * 0.07;
  performanceData.cpuMs += (cpuMs - performanceData.cpuMs) * 0.07;
  performanceData.workMs += (workMs - performanceData.workMs) * 0.07;
  performanceData.fps = 1000 / performanceData.frameMs;
  performanceData.windowTime += frameMs;
  performanceData.windowWork += workMs;
  performanceData.windowFrames++;
  if (frameMs > 20) performanceData.slowFrames++;
  performanceData.samples++;
}

export function sampleHistory(performanceData) {
  performanceData.history[performanceData.historyIndex] = performanceData.frameMs;
  performanceData.historyIndex =
    (performanceData.historyIndex + 1) % performanceData.history.length;
  performanceData.historyCount = Math.min(
    performanceData.historyCount + 1,
    performanceData.history.length,
  );
}

// Grow cautiously, retreat quickly, and periodically probe a previous ceiling.
export function adaptPopulation(gameData, balance, performanceData) {
  if (performanceData.windowTime >= 1000) {
    const averageFrameMs = performanceData.windowTime / performanceData.windowFrames;
    const averageWorkMs = performanceData.windowWork / performanceData.windowFrames;
    const missedFrameRatio = performanceData.slowFrames / performanceData.windowFrames;

    if (gameData.autoScale && !gameData.paused) {
      if (performanceData.warmup > 0) {
        performanceData.warmup--;
      } else if (averageFrameMs > 17.6 || averageWorkMs > 13 || missedFrameRatio > 0.07) {
        performanceData.ceiling = Math.max(
          balance.minCount,
          Math.floor(gameData.agentCount * 0.95),
        );
        const populationScale = Math.max(
          0.65,
          Math.min(0.88, 16.67 / Math.max(averageFrameMs, averageWorkMs * 1.3)),
        );
        setPopulation(
          gameData,
          balance,
          Math.floor((gameData.agentCount * populationScale) / 100) * 100,
        );
        performanceData.goodWindows = 0;
        performanceData.retryIn = 12;
        performanceData.status =
          gameData.agentCount === balance.minCount ? "DEVICE LIMIT" : "SETTLING";
      } else if (
        averageFrameMs <= 17.1 &&
        averageWorkMs < 11.5 &&
        missedFrameRatio < 0.035
      ) {
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
