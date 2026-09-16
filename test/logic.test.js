import { test } from "node:test";
import assert from "node:assert/strict";
import { balance } from "../src/balance.js";
import { allocateGameData, allocatePerformanceData } from "../src/gameData.js";
import {
  initialize,
  tick,
  buildGrid,
  setPopulation,
  reseed,
  setPreset,
} from "../src/logic.js";
import { recordFrame, adaptPopulation } from "../src/performance.js";

// The DOD boundary makes these tests possible without a canvas, DOM, or renderer.
// Use a smaller pool for quick checks while preserving the production grid geometry.
const testBalance = { ...balance, capacity: 4000, initialCount: 1000 };

/**
 * Allocate an isolated, seeded world for one test using the production state layout.
 * Fresh buffers keep tests independent; allocation here happens outside any tick.
 */
function create() {
  const gameData = allocateGameData(testBalance);
  initialize(gameData, testBalance);
  return gameData;
}

// Validate author-time relationships so hot loops can trust cell sizes and index widths.
test("author-time configuration matches the grid and sampling bounds", () => {
  assert.equal(balance.width, balance.cellSize * balance.gridColumns);
  assert.equal(balance.height, balance.cellSize * balance.gridRows);
  assert.ok(balance.neighborRadiusSq <= balance.cellSize ** 2);
  assert.ok(balance.gridColumns * balance.gridRows < 65536);
  assert.ok(
    balance.minCount <= balance.initialCount && balance.initialCount <= balance.capacity,
  );
});

// The counting-sort ranges must contain every active agent exactly once, even at edges.
test("grid partitions the live prefix exactly once, including world edges", () => {
  const gameData = create();
  gameData.positionX[0] = 0;
  gameData.positionY[0] = 0;
  gameData.positionX[1] = testBalance.width - 0.01;
  gameData.positionY[1] = testBalance.height - 0.01;
  buildGrid(gameData, testBalance);
  // A test-only visit counter detects both missing and duplicated agent indices.
  const seen = new Uint8Array(gameData.agentCount);
  for (let cellIndex = 0; cellIndex < gameData.cellAgentCount.length; cellIndex++) {
    for (
      let sortedIndex = gameData.cellStartOffset[cellIndex];
      sortedIndex < gameData.cellStartOffset[cellIndex + 1];
      sortedIndex++
    ) {
      const agentIndex = gameData.sortedAgentIndices[sortedIndex];
      assert.equal(gameData.agentCellIndex[agentIndex], cellIndex);
      seen[agentIndex]++;
    }
  }
  // Require one visit per slot; membership alone would not detect a missing agent.
  assert.ok(seen.every((visitCount) => visitCount === 1));
  assert.equal(
    gameData.cellStartOffset[gameData.cellAgentCount.length],
    gameData.agentCount,
  );
  assert.equal(gameData.agentCellIndex[0], 0);
  assert.equal(
    gameData.agentCellIndex[1],
    testBalance.gridColumns * testBalance.gridRows - 1,
  );
});

// Matching seeded runs catch hidden nondeterminism; bounds checks catch unstable motion.
test("deterministic simulation stays finite, bounded and within speed limits in all presets", () => {
  for (let preset = 0; preset < 3; preset++) {
    const firstRun = create(),
      secondRun = create();
    setPreset(firstRun, preset);
    setPreset(secondRun, preset);
    for (let frame = 0; frame < 90; frame++) {
      tick(firstRun, testBalance, 1 / 60);
      tick(secondRun, testBalance, 1 / 60);
    }
    assert.deepEqual(firstRun.positionX, secondRun.positionX);
    assert.deepEqual(firstRun.velocityY, secondRun.velocityY);
    // Deterministic output could still be invalid, so also inspect the physical limits.
    for (let agentIndex = 0; agentIndex < firstRun.agentCount; agentIndex++) {
      assert.ok(
        Number.isFinite(firstRun.positionX[agentIndex]) &&
          Number.isFinite(firstRun.positionY[agentIndex]),
      );
      assert.ok(
        firstRun.positionX[agentIndex] >= 0 &&
          firstRun.positionX[agentIndex] < testBalance.width &&
          firstRun.positionY[agentIndex] >= 0 &&
          firstRun.positionY[agentIndex] < testBalance.height,
      );
      const speed = Math.hypot(
        firstRun.velocityX[agentIndex],
        firstRun.velocityY[agentIndex],
      );
      // Float32 storage introduces small rounding differences at exact speed boundaries.
      assert.ok(
        speed >= testBalance.minSpeed - 0.001 && speed <= testBalance.maxSpeed + 0.001,
      );
    }
  }
});

// Deliberate overlap and zero speed exercise normalization guards under strong forces.
test("overlapping agents and strong pointer forces cannot create NaN velocities", () => {
  const gameData = create();
  gameData.positionX.fill(500);
  gameData.positionY.fill(500);
  gameData.velocityX.fill(0);
  gameData.velocityY.fill(0);
  gameData.pointerX = 501;
  gameData.pointerY = 501;
  gameData.pointerActive = true;
  for (let agentIndex = 0; agentIndex < 10; agentIndex++)
    tick(gameData, testBalance, 1 / 30);
  assert.ok(gameData.velocityX.every(Number.isFinite));
  assert.ok(gameData.velocityY.every(Number.isFinite));
});

// Wrapped coordinate offsets must make opposite-edge agents repel as nearby neighbors.
test("toroidal neighbors interact across the left and right boundaries", () => {
  const gameData = create();
  gameData.agentCount = 2;
  gameData.positionX[0] = 1;
  gameData.positionX[1] = testBalance.width - 1;
  gameData.positionY[0] = gameData.positionY[1] = 200;
  gameData.velocityX[0] = gameData.velocityX[1] = 0;
  gameData.velocityY[0] = gameData.velocityY[1] = 40;
  gameData.separation = 3;
  // Isolate separation from the two neighborhood-average steering terms.
  gameData.alignment = 0;
  gameData.cohesion = 0;
  tick(gameData, testBalance, 1 / 60);
  assert.ok(
    gameData.velocityX[0] > 0,
    "left agent moves right away from wrapped neighbor",
  );
  assert.ok(
    gameData.velocityX[1] < 0,
    "right agent moves left away from wrapped neighbor",
  );
});

// Compare identical worlds with one force enabled, isolating its effect from global flow.
test("alignment steers toward neighbors and cohesion closes a gap", () => {
  const baseline = create(),
    aligned = create(),
    cohesive = create();
  for (const gameData of [baseline, aligned, cohesive]) {
    gameData.agentCount = 2;
    gameData.positionX[0] = 400;
    gameData.positionX[1] = 430;
    gameData.positionY[0] = gameData.positionY[1] = 400;
    gameData.velocityX[0] = 40;
    gameData.velocityY[0] = 0;
    gameData.velocityX[1] = 0;
    gameData.velocityY[1] = 40;
    gameData.alignment = 0;
    gameData.cohesion = 0;
    gameData.separation = 0;
  }
  aligned.alignment = 1;
  cohesive.cohesion = 1;
  tick(baseline, testBalance, 1 / 60);
  tick(aligned, testBalance, 1 / 60);
  tick(cohesive, testBalance, 1 / 60);
  assert.ok(aligned.velocityY[0] > baseline.velocityY[0]);
  assert.ok(cohesive.velocityX[0] > baseline.velocityX[0]);
});

// Buffer identity is a DOD contract: population changes must reuse the allocated pool.
test("population changes and reseeding preserve all backing buffers", () => {
  const gameData = create();
  // Retain each typed-array reference; scalar settings are not storage buffers to compare.
  const entries = Object.entries(gameData).filter(([, value]) =>
    ArrayBuffer.isView(value),
  );
  setPopulation(gameData, testBalance, 100000);
  assert.equal(gameData.agentCount, testBalance.capacity);
  setPopulation(gameData, testBalance, 0);
  assert.equal(gameData.agentCount, testBalance.minCount);
  setPopulation(gameData, testBalance, 3000);
  reseed(gameData, testBalance);
  tick(gameData, testBalance, 1 / 60);
  // Reference equality catches replacement even when a copied buffer has identical values.
  for (const [key, value] of entries) assert.equal(gameData[key], value);
});

/**
 * Feed synthetic frame timings through the real adaptive controller without waiting.
 * Scalar inputs make the test reproducible and independent of the test machine's load.
 * No simulation or rendering is needed to exercise population decision thresholds.
 */
function runWindow(gameData, performanceData, frameMs, workMs, seconds = 1.1) {
  for (let agentIndex = 0; agentIndex < (seconds * 1000) / frameMs; agentIndex++) {
    recordFrame(performanceData, frameMs, workMs * 0.8, workMs);
    adaptPopulation(gameData, testBalance, performanceData);
  }
}

// Healthy windows should activate more slots; overload should shorten the same live prefix.
test("auto-scale grows with headroom and retreats when frame budget is missed", () => {
  const gameData = create(),
    performanceData = allocatePerformanceData(testBalance);
  performanceData.warmup = 0;
  runWindow(gameData, performanceData, 16.67, 4, 3);
  const high = gameData.agentCount;
  assert.ok(high > testBalance.initialCount);
  runWindow(gameData, performanceData, 33.33, 24, 2);
  assert.ok(gameData.agentCount < high);
  assert.ok(gameData.agentCount >= testBalance.minCount);
});

// Explicit user modes must override the controller even when timings would suggest changes.
test("manual mode and paused state never auto-adjust population", () => {
  const gameData = create(),
    performanceData = allocatePerformanceData(testBalance);
  performanceData.warmup = 0;
  gameData.autoScale = false;
  runWindow(gameData, performanceData, 40, 30, 4);
  assert.equal(gameData.agentCount, testBalance.initialCount);
  gameData.autoScale = true;
  gameData.paused = true;
  runWindow(gameData, performanceData, 16.67, 1, 4);
  assert.equal(gameData.agentCount, testBalance.initialCount);
});

// Very long frame intervals must trigger retreat rather than being ignored as outliers.
test("severe sustained overload also reduces the population", () => {
  const gameData = create(),
    performanceData = allocatePerformanceData(testBalance);
  performanceData.warmup = 0;
  runWindow(gameData, performanceData, 400, 380, 2);
  assert.ok(gameData.agentCount < testBalance.initialCount);
});
