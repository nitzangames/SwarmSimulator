import { performance } from "node:perf_hooks";
import { balance } from "../src/balance.js";
import { allocateGameData } from "../src/gameData.js";
import { initialize, tick, setPopulation } from "../src/logic.js";

const gameData = allocateGameData(balance);
initialize(gameData, balance);
console.log(
  "CPU simulation only; excludes browser scheduling, buffer uploads, and GPU rendering.",
);
for (const count of [10000, 25000, 50000, 100000]) {
  setPopulation(gameData, balance, count);
  for (let frameIndex = 0; frameIndex < 25; frameIndex++) tick(gameData, balance, 1 / 60);
  const samples = [];
  for (let frameIndex = 0; frameIndex < 60; frameIndex++) {
    const start = performance.now();
    tick(gameData, balance, 1 / 60);
    samples.push(performance.now() - start);
  }
  samples.sort((first, second) => first - second);
  console.log(
    `${count.toLocaleString().padStart(7)} agents  median ${samples[30].toFixed(2)} ms  p95 ${samples[57].toFixed(2)} ms`,
  );
}
