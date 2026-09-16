import "./style.css";
import { balance } from "./balance.js";
import { allocateGameData, allocatePerformanceData } from "./gameData.js";
import { initialize, setParameter } from "./logic.js";
import { recordFrame, adaptPopulation, resetTuning } from "./performance.js";
import * as Board from "./board.js";

const gameData = allocateGameData(balance);
const performanceData = allocatePerformanceData(balance);
initialize(gameData, balance);

if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  setParameter(gameData, "speed", 0.4);

document
  .getElementById("reload")
  .addEventListener("click", () => window.location.reload());

try {
  const board = Board.createBoard(gameData, balance, performanceData);
  let lastFrameTime = 0;
  let lastInterfaceUpdateTime = 0;
  let animationFrameHandle = 0;

  function frame(currentTime) {
    const frameMs =
      lastFrameTime === 0 ? balance.targetFrameMs : currentTime - lastFrameTime;
    lastFrameTime = currentTime;

    if (!board.contextLost) {
      const simulationStartTime = performance.now();
      Board.step(board, gameData, balance, Math.min(frameMs / 1000, 1 / 30));
      const cpuMs = performance.now() - simulationStartTime;

      Board.render(board, gameData);
      const workMs = performance.now() - simulationStartTime;

      if (!gameData.paused) {
        recordFrame(performanceData, frameMs, cpuMs, workMs);
        adaptPopulation(gameData, balance, performanceData);
      }

      // Refresh text and the chart four times per second, outside the simulation.
      if (currentTime - lastInterfaceUpdateTime > 250) {
        Board.updateStats(board, gameData, balance, performanceData);
        lastInterfaceUpdateTime = currentTime;
      }
    }

    animationFrameHandle = requestAnimationFrame(frame);
  }

  // Ignore time spent in a hidden tab; resume with a fresh tuning window.
  document.addEventListener("visibilitychange", () => {
    cancelAnimationFrame(animationFrameHandle);
    gameData.pointerActive = false;
    board.ui["pointer-ring"].hidden = true;
    lastFrameTime = 0;
    resetTuning(performanceData, balance);
    if (!document.hidden) animationFrameHandle = requestAnimationFrame(frame);
  });

  animationFrameHandle = requestAnimationFrame(frame);
} catch (error) {
  console.error(error);
  Board.showError(
    "This demo needs WebGL 2. Try a browser with hardware acceleration enabled.",
  );
}
