import "./style.css";
import { balance } from "./balance.js";
import { allocateGameData, allocatePerformanceData } from "./gameData.js";
import { initialize, setParameter } from "./logic.js";
import { recordFrame, adaptPopulation, resetTuning } from "./performance.js";
import * as Board from "./board.js";

// Game owns startup and the only animation loop. State, transformations, and
// presentation live in separate modules so each has a clear responsibility.
const gameData = allocateGameData(balance);
const performanceData = allocatePerformanceData(balance);
// Fill reusable lookup tables and activate the initial portion of the agent pool.
initialize(gameData, balance);

// Reduced motion changes a simulation scalar; it needs no alternative data layout.
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  setParameter(gameData, "speed", 0.4);

// The error panel's reload action runs only on a click, outside simulation logic.
document
  .getElementById("reload")
  .addEventListener("click", () => window.location.reload());

try {
  // Allocate rendering resources and register input handlers before the first frame.
  const board = Board.createBoard(gameData, balance, performanceData);
  // Timestamps and the pending callback handle are reused by the same loop closure.
  let lastFrameTime = 0;
  let lastInterfaceUpdateTime = 0;
  let animationFrameHandle = 0;

  /**
   * Run one browser frame: transform state, submit the draw, then update measurements.
   * A single callback orders these phases so rendering sees the completed simulation.
   * Reuse this function on every requestAnimationFrame; do not create per-agent
   * callbacks or mix browser timing into the data-only simulation functions.
   */
  function frame(currentTime) {
    // The first frame has no previous timestamp, including after a hidden-tab pause.
    const frameMs =
      lastFrameTime === 0 ? balance.targetFrameMs : currentTime - lastFrameTime;
    lastFrameTime = currentTime;

    if (!board.contextLost) {
      // Keep wall-clock measurement here so the same logic can run in Node tests.
      const simulationStartTime = performance.now();
      // Convert milliseconds to seconds and cap large steps after a browser stall.
      Board.step(board, gameData, balance, Math.min(frameMs / 1000, 1 / 30));
      const cpuMs = performance.now() - simulationStartTime;

      Board.render(board, gameData);
      // This measures CPU submission time, not the time until GPU work completes.
      const workMs = performance.now() - simulationStartTime;

      if (!gameData.paused) {
        // A paused flock is not a useful sample of the running simulation's workload.
        recordFrame(performanceData, frameMs, cpuMs, workMs);
        adaptPopulation(gameData, balance, performanceData);
      }

      // Refresh text and the chart four times per second, outside the simulation.
      if (currentTime - lastInterfaceUpdateTime > 250) {
        Board.updateStats(board, gameData, balance, performanceData);
        lastInterfaceUpdateTime = currentTime;
      }
    }

    // Retain the handle so visibility changes can cancel the next scheduled frame.
    animationFrameHandle = requestAnimationFrame(frame);
  }

  // Ignore time spent in a hidden tab; resume with a fresh tuning window. This event
  // handler is installed once and prevents background throttling from skewing tuning.
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(animationFrameHandle);
    // Clear a held pointer so switching tabs cannot leave an attraction force active.
    gameData.pointerActive = false;
    board.ui["pointer-ring"].hidden = true;
    lastFrameTime = 0;
    resetTuning(performanceData, balance);
    if (!document.hidden) animationFrameHandle = requestAnimationFrame(frame);
  });

  // Start exactly one chain; subsequent callbacks schedule their own next frame.
  animationFrameHandle = requestAnimationFrame(frame);
} catch (error) {
  // WebGL startup failures belong to presentation; the data modules need no DOM.
  console.error(error);
  Board.showError(
    "This demo needs WebGL 2. Try a browser with hardware acceleration enabled.",
  );
}
