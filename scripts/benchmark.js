import { performance } from "node:perf_hooks";
import { balance } from "../src/balance.js";
import { allocateGameData } from "../src/gameData.js";
import { initialize, tick, setPopulation } from "../src/logic.js";

// Run the same data-only logic used in the browser, without Three.js or the DOM.
// This measures CPU simulation cost, not achievable end-to-end frames per second.
const gameData = allocateGameData(balance);
initialize(gameData, balance);
console.log(
  "CPU simulation only; excludes browser scheduling, buffer uploads, and GPU rendering.",
);
for (const count of [10000, 25000, 50000, 100000]) {
  // Reuse one pool for every population so allocation/startup are outside the timing.
  setPopulation(gameData, balance, count);
  // Give the engine and flock a brief warmup before collecting this population's samples.
  for (let frameIndex = 0; frameIndex < 25; frameIndex++) tick(gameData, balance, 1 / 60);
  // This growable array belongs to the measurement script, not the simulation tick.
  const samples = [];
  for (let frameIndex = 0; frameIndex < 60; frameIndex++) {
    const start = performance.now();
    // A fixed simulated time step keeps the workload independent of elapsed wall time.
    tick(gameData, balance, 1 / 60);
    samples.push(performance.now() - start);
  }
  // Sort numerically once after measurement so percentile lookup uses elapsed-time order.
  samples.sort((first, second) => first - second);
  // Report representative and slower samples; a short run is not a device guarantee.
  console.log(
    `${count.toLocaleString().padStart(7)} agents  median ${samples[30].toFixed(2)} ms  p95 ${samples[57].toFixed(2)} ms`,
  );
}
