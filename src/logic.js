import { presets } from "./balance.js";

// Mulberry32: keep the seed in GameData so a test can replay the same flock.
function random(gameData) {
  let randomBits = (gameData.randomSeed = (gameData.randomSeed + 0x6d2b79f5) | 0);
  randomBits = Math.imul(randomBits ^ (randomBits >>> 15), randomBits | 1);
  randomBits ^= randomBits + Math.imul(randomBits ^ (randomBits >>> 7), randomBits | 61);

  return ((randomBits ^ (randomBits >>> 14)) >>> 0) / 4294967296;
}

export function initialize(gameData, balance) {
  // Precompute nine neighboring cells, including offsets across wrapped edges.
  for (let row = 0; row < balance.gridRows; row++) {
    for (let column = 0; column < balance.gridColumns; column++) {
      let neighborSlot = (row * balance.gridColumns + column) * 9;

      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++, neighborSlot++) {
          const neighborColumn = column + columnOffset;
          const neighborRow = row + rowOffset;

          gameData.neighborCellIndices[neighborSlot] =
            ((neighborRow + balance.gridRows) % balance.gridRows) * balance.gridColumns +
            ((neighborColumn + balance.gridColumns) % balance.gridColumns);

          gameData.neighborWrapOffsetX[neighborSlot] =
            neighborColumn < 0
              ? -balance.width
              : neighborColumn >= balance.gridColumns
                ? balance.width
                : 0;
          gameData.neighborWrapOffsetY[neighborSlot] =
            neighborRow < 0
              ? -balance.height
              : neighborRow >= balance.gridRows
                ? balance.height
                : 0;
        }
      }
    }
  }

  // Static color variation is initialized for the whole pool and uploaded once.
  for (let agentIndex = 0; agentIndex < balance.capacity; agentIndex++) {
    gameData.colorVariation[agentIndex] = random(gameData);
  }

  setPopulation(gameData, balance, balance.initialCount);
}

function spawn(gameData, balance, firstAgentIndex, endAgentIndex) {
  for (let agentIndex = firstAgentIndex; agentIndex < endAgentIndex; agentIndex++) {
    const angle = random(gameData) * Math.PI * 2;
    const radius = 150 + random(gameData) * 260;
    const ripple = Math.sin(angle * 3) * 50;

    gameData.positionX[agentIndex] =
      balance.width / 2 + Math.cos(angle) * (radius + ripple) * 1.28;
    gameData.positionY[agentIndex] =
      balance.height / 2 + Math.sin(angle) * (radius + ripple) * 0.76;

    const heading = angle + Math.PI / 2 + (random(gameData) - 0.5) * 0.9;
    const speed =
      balance.minSpeed + random(gameData) * (balance.maxSpeed - balance.minSpeed);

    gameData.velocityX[agentIndex] = Math.cos(heading) * speed;
    gameData.velocityY[agentIndex] = Math.sin(heading) * speed;
  }
}

export function setPopulation(gameData, balance, requestedCount) {
  const agentCount = Math.max(
    balance.minCount,
    Math.min(balance.capacity, Math.round(requestedCount)),
  );

  // Growing the live prefix initializes existing slots; it never resizes a buffer.
  if (agentCount > gameData.agentCount) {
    spawn(gameData, balance, gameData.agentCount, agentCount);
  }

  gameData.agentCount = agentCount;
}

export function reseed(gameData, balance) {
  gameData.simulationTime = 0;
  gameData.tickIndex = 0;

  spawn(gameData, balance, 0, gameData.agentCount);
}

export function setPreset(gameData, presetIndex) {
  gameData.presetIndex = presetIndex;
  gameData.separation = presets[presetIndex].separation;
  gameData.alignment = presets[presetIndex].alignment;
  gameData.cohesion = presets[presetIndex].cohesion;
}

export function setParameter(gameData, parameterName, value) {
  gameData[parameterName] = value;
}

export function togglePause(gameData) {
  gameData.paused = !gameData.paused;
  gameData.pointerActive = false;
}

export function buildGrid(gameData, balance) {
  gameData.cellAgentCount.fill(0);
  gameData.cellPositionSumX.fill(0);
  gameData.cellPositionSumY.fill(0);
  gameData.cellVelocitySumX.fill(0);
  gameData.cellVelocitySumY.fill(0);

  const inverseCellSize = 1 / balance.cellSize;

  // Pass 1: count each cell's occupants and accumulate their positions/velocities.
  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    const cellIndex =
      Math.min(
        balance.gridRows - 1,
        (gameData.positionY[agentIndex] * inverseCellSize) | 0,
      ) *
        balance.gridColumns +
      Math.min(
        balance.gridColumns - 1,
        (gameData.positionX[agentIndex] * inverseCellSize) | 0,
      );

    gameData.agentCellIndex[agentIndex] = cellIndex;
    gameData.cellAgentCount[cellIndex]++;
    gameData.cellPositionSumX[cellIndex] += gameData.positionX[agentIndex];
    gameData.cellPositionSumY[cellIndex] += gameData.positionY[agentIndex];
    gameData.cellVelocitySumX[cellIndex] += gameData.velocityX[agentIndex];
    gameData.cellVelocitySumY[cellIndex] += gameData.velocityY[agentIndex];
  }

  // Pass 2: prefix offsets reserve a contiguous range of indices for each cell.
  let nextCellStart = 0;

  for (let cellIndex = 0; cellIndex < gameData.cellAgentCount.length; cellIndex++) {
    gameData.cellStartOffset[cellIndex] = nextCellStart;
    gameData.cellWriteOffset[cellIndex] = nextCellStart;
    nextCellStart += gameData.cellAgentCount[cellIndex];
  }

  gameData.cellStartOffset[gameData.cellAgentCount.length] = nextCellStart;

  // Pass 3: counting-sort the indices, without moving the agents' state arrays.
  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    const cellIndex = gameData.agentCellIndex[agentIndex];
    gameData.sortedAgentIndices[gameData.cellWriteOffset[cellIndex]++] = agentIndex;
  }

  // Compute a shared neighborhood average once per cell, rather than per agent.
  for (let cellIndex = 0; cellIndex < gameData.cellAgentCount.length; cellIndex++) {
    let positionSumX = 0;
    let positionSumY = 0;
    let velocitySumX = 0;
    let velocitySumY = 0;
    let neighborAgentCount = 0;

    for (
      let neighborSlot = cellIndex * 9;
      neighborSlot < cellIndex * 9 + 9;
      neighborSlot++
    ) {
      const neighborCellIndex = gameData.neighborCellIndices[neighborSlot];
      const cellAgentCount = gameData.cellAgentCount[neighborCellIndex];

      positionSumX +=
        gameData.cellPositionSumX[neighborCellIndex] +
        gameData.neighborWrapOffsetX[neighborSlot] * cellAgentCount;
      positionSumY +=
        gameData.cellPositionSumY[neighborCellIndex] +
        gameData.neighborWrapOffsetY[neighborSlot] * cellAgentCount;
      velocitySumX += gameData.cellVelocitySumX[neighborCellIndex];
      velocitySumY += gameData.cellVelocitySumY[neighborCellIndex];
      neighborAgentCount += cellAgentCount;
    }

    const inverseCount = neighborAgentCount > 0 ? 1 / neighborAgentCount : 0;

    gameData.neighborPositionMeanX[cellIndex] = positionSumX * inverseCount;
    gameData.neighborPositionMeanY[cellIndex] = positionSumY * inverseCount;
    gameData.neighborVelocityMeanX[cellIndex] = velocitySumX * inverseCount;
    gameData.neighborVelocityMeanY[cellIndex] = velocitySumY * inverseCount;
    gameData.neighborAgentCount[cellIndex] = neighborAgentCount;
  }
}

// Data in -> transform -> data out. No DOM, renderer, clocks, or allocations.
export function tick(gameData, balance, deltaSeconds) {
  gameData.simulationTime += deltaSeconds;
  gameData.tickIndex++;
  buildGrid(gameData, balance);

  const positionX = gameData.positionX;
  const positionY = gameData.positionY;
  const velocityX = gameData.velocityX;
  const velocityY = gameData.velocityY;
  const flowPhase = gameData.simulationTime * 0.13;
  const flowCenterX = balance.width * 0.5 + Math.sin(flowPhase) * 105;
  const flowCenterY = balance.height * 0.5 + Math.sin(flowPhase * 1.3) * 75;
  const stepSeconds = deltaSeconds * gameData.speed;

  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    const agentX = positionX[agentIndex];
    const agentY = positionY[agentIndex];
    let separationX = 0;
    let separationY = 0;

    const homeCellIndex = gameData.agentCellIndex[agentIndex];
    const homeNeighborSlot = homeCellIndex * 9 + 4;
    const horizontalCellOffset =
      agentX % balance.cellSize < balance.cellSize / 2 ? -1 : 1;
    const verticalCellOffset = agentY % balance.cellSize < balance.cellSize / 2 ? -3 : 3;

    // The separation radius fits within the four nearest cells. Sampling two
    // occupants per cell bounds this pass to eight distance checks per agent.
    for (let quadrantIndex = 0; quadrantIndex < 4; quadrantIndex++) {
      const neighborSlot =
        homeNeighborSlot +
        (quadrantIndex & 1) * horizontalCellOffset +
        (quadrantIndex >> 1) * verticalCellOffset;
      const neighborCellIndex = gameData.neighborCellIndices[neighborSlot];
      const cellAgentCount = gameData.cellAgentCount[neighborCellIndex];
      const sampleCount = Math.min(cellAgentCount, balance.samplesPerCell);
      const cellStartOffset = gameData.cellStartOffset[neighborCellIndex];
      const rotatingSampleOffset = (agentIndex * 13 + gameData.tickIndex * 7) >>> 0;

      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
        const neighborAgentIndex =
          gameData.sortedAgentIndices[
            cellStartOffset +
              ((rotatingSampleOffset +
                Math.floor((sampleIndex * cellAgentCount) / sampleCount)) %
                cellAgentCount)
          ];

        if (neighborAgentIndex === agentIndex) continue;

        const distanceX =
          positionX[neighborAgentIndex] +
          gameData.neighborWrapOffsetX[neighborSlot] -
          agentX;
        const distanceY =
          positionY[neighborAgentIndex] +
          gameData.neighborWrapOffsetY[neighborSlot] -
          agentY;
        const distanceSquared = distanceX * distanceX + distanceY * distanceY;

        if (distanceSquared < balance.separationRadiusSq && distanceSquared > 0.001) {
          const repulsionStrength =
            (1 - distanceSquared / balance.separationRadiusSq) /
            Math.max(distanceSquared, 4);
          separationX -= distanceX * repulsionStrength;
          separationY -= distanceY * repulsionStrength;
        }
      }
    }

    let accelerationX = separationX * 230 * gameData.separation;
    let accelerationY = separationY * 230 * gameData.separation;

    // Remove this agent's own contribution from the neighborhood averages.
    if (gameData.neighborAgentCount[homeCellIndex] > 1) {
      const selfExclusionScale =
        gameData.neighborAgentCount[homeCellIndex] /
        (gameData.neighborAgentCount[homeCellIndex] - 1);

      accelerationX +=
        ((gameData.neighborVelocityMeanX[homeCellIndex] - velocityX[agentIndex]) *
          gameData.alignment *
          1.7 +
          (gameData.neighborPositionMeanX[homeCellIndex] - agentX) *
            gameData.cohesion *
            0.65) *
        selfExclusionScale;
      accelerationY +=
        ((gameData.neighborVelocityMeanY[homeCellIndex] - velocityY[agentIndex]) *
          gameData.alignment *
          1.7 +
          (gameData.neighborPositionMeanY[homeCellIndex] - agentY) *
            gameData.cohesion *
            0.65) *
        selfExclusionScale;
    }

    // A gentle global flow gives each preset its characteristic large-scale motion.
    const centerOffsetX = agentX - flowCenterX;
    const centerOffsetY = agentY - flowCenterY;
    const radius =
      Math.sqrt(centerOffsetX * centerOffsetX + centerOffsetY * centerOffsetY) + 0.001;

    if (gameData.presetIndex === 2) {
      accelerationX += (58 - velocityX[agentIndex]) * 0.35;
      accelerationY +=
        (Math.sin(agentX * 0.008 + flowPhase * 3) * 30 - velocityY[agentIndex]) * 0.5;
    } else {
      const orbitStrength = gameData.presetIndex === 1 ? 1.8 : 0.45;
      const targetRadius =
        gameData.presetIndex === 1
          ? 265
          : 320 + Math.sin(flowPhase * 2 + agentX * 0.005) * 80;
      const radialForce =
        (radius - targetRadius) * (gameData.presetIndex === 1 ? 0.12 : 0.065);

      accelerationX +=
        ((-centerOffsetY / radius) * 60 - velocityX[agentIndex]) * orbitStrength -
        (centerOffsetX / radius) * radialForce;
      accelerationY +=
        ((centerOffsetX / radius) * 60 - velocityY[agentIndex]) * orbitStrength -
        (centerOffsetY / radius) * radialForce;
    }

    if (gameData.pointerActive) {
      const pointerDistanceX = gameData.pointerX - agentX;
      const pointerDistanceY = gameData.pointerY - agentY;
      const pointerDistanceSquared =
        pointerDistanceX * pointerDistanceX + pointerDistanceY * pointerDistanceY;

      if (pointerDistanceSquared < 220 * 220 && pointerDistanceSquared > 1) {
        const pointerForce =
          (gameData.pointerMode * 260 * (1 - Math.sqrt(pointerDistanceSquared) / 220)) /
          Math.sqrt(pointerDistanceSquared);
        accelerationX += pointerDistanceX * pointerForce;
        accelerationY += pointerDistanceY * pointerForce;
      }
    }

    // Limit steering acceleration first, then keep flight speed within its bounds.
    const forceSquared = accelerationX * accelerationX + accelerationY * accelerationY;

    if (forceSquared > balance.maxForce * balance.maxForce) {
      const forceScale = balance.maxForce / Math.sqrt(forceSquared);
      accelerationX *= forceScale;
      accelerationY *= forceScale;
    }

    let nextVelocityX = velocityX[agentIndex] + accelerationX * stepSeconds;
    let nextVelocityY = velocityY[agentIndex] + accelerationY * stepSeconds;
    const speedSquared = nextVelocityX * nextVelocityX + nextVelocityY * nextVelocityY;

    if (
      speedSquared > balance.maxSpeed * balance.maxSpeed ||
      speedSquared < balance.minSpeed * balance.minSpeed
    ) {
      const speed = Math.sqrt(speedSquared);
      const speedScale =
        (speedSquared > balance.maxSpeed * balance.maxSpeed
          ? balance.maxSpeed
          : balance.minSpeed) / (speed || 1);
      nextVelocityX = speed > 0 ? nextVelocityX * speedScale : balance.minSpeed;
      nextVelocityY *= speedScale;
    }

    // Neighbor velocities are already snapshotted into the grid's cell averages.
    velocityX[agentIndex] = nextVelocityX;
    velocityY[agentIndex] = nextVelocityY;
  }

  integratePositions(gameData, balance, stepSeconds);
}

// Commit positions only after every separation query has read the previous frame.
export function integratePositions(gameData, balance, stepSeconds) {
  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    const nextX =
      gameData.positionX[agentIndex] + gameData.velocityX[agentIndex] * stepSeconds;
    const nextY =
      gameData.positionY[agentIndex] + gameData.velocityY[agentIndex] * stepSeconds;

    gameData.positionX[agentIndex] = (nextX + balance.width) % balance.width;
    gameData.positionY[agentIndex] = (nextY + balance.height) % balance.height;
  }
}
