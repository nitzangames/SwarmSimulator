import { presets } from "./balance.js";

// Logic is data in -> transformation -> data out. These free functions mutate plain
// state in place; they never access the DOM, Three.js, browser events, or clocks.
// In-place mutation is intentional: returning a fresh world each tick would allocate
// and copy the very buffers that the simulation and renderer are meant to reuse.

/**
 * Advance a Mulberry32 generator and return a reproducible number in [0, 1).
 * Its only persistent state is an integer in GameData, rather than a generator
 * object per agent. Tests can replay initialization by starting from the same seed.
 */
function random(gameData) {
  // Add the generator's fixed increment and coerce the state to a 32-bit integer.
  let randomBits = (gameData.randomSeed = (gameData.randomSeed + 0x6d2b79f5) | 0);
  // XOR/shift mixing and 32-bit multiplication scramble the incremented bits.
  randomBits = Math.imul(randomBits ^ (randomBits >>> 15), randomBits | 1);
  randomBits ^= randomBits + Math.imul(randomBits ^ (randomBits >>> 7), randomBits | 61);

  // Interpret the result as unsigned and divide by 2^32 to produce a fraction.
  return ((randomBits ^ (randomBits >>> 14)) >>> 0) / 4294967296;
}

/**
 * Prepare the fixed spatial lookup tables, appearance values, and initial flock.
 * Neighborhood topology depends on configuration, so calculate it once instead of
 * repeatedly discovering adjacent cells and wrap offsets in each agent's update.
 * All writes target storage already reserved by allocateGameData.
 */
export function initialize(gameData, balance) {
  // Precompute nine neighboring cells, including offsets across wrapped edges.
  for (let row = 0; row < balance.gridRows; row++) {
    for (let column = 0; column < balance.gridColumns; column++) {
      // Reserve nine consecutive table slots for this cell's 3x3 neighborhood.
      let neighborSlot = (row * balance.gridColumns + column) * 9;

      for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
        for (let columnOffset = -1; columnOffset <= 1; columnOffset++, neighborSlot++) {
          const neighborColumn = column + columnOffset;
          const neighborRow = row + rowOffset;

          // Modulo maps out-of-bounds cells to the opposite edge of the world.
          gameData.neighborCellIndices[neighborSlot] =
            ((neighborRow + balance.gridRows) % balance.gridRows) * balance.gridColumns +
            ((neighborColumn + balance.gridColumns) % balance.gridColumns);

          // Translate a wrapped neighbor into this cell's local coordinate frame.
          // For example, a neighbor at the far right appears just left of x = 0.
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

/**
 * Fill the half-open slot range [firstAgentIndex, endAgentIndex) with a new flock.
 * An irregular ring and roughly tangential headings give the starting scene shape.
 * Adding agents writes into existing SoA slots; no agent object is constructed.
 */
function spawn(gameData, balance, firstAgentIndex, endAgentIndex) {
  for (let agentIndex = firstAgentIndex; agentIndex < endAgentIndex; agentIndex++) {
    // Polar coordinates provide a ring; a three-lobed ripple breaks its symmetry.
    const angle = random(gameData) * Math.PI * 2;
    const radius = 150 + random(gameData) * 260;
    const ripple = Math.sin(angle * 3) * 50;

    // Stretch the ring into an ellipse centered inside the simulation world.
    gameData.positionX[agentIndex] =
      balance.width / 2 + Math.cos(angle) * (radius + ripple) * 1.28;
    gameData.positionY[agentIndex] =
      balance.height / 2 + Math.sin(angle) * (radius + ripple) * 0.76;

    // Turn a quarter-circle from the radius to fly around the ring, with some jitter.
    const heading = angle + Math.PI / 2 + (random(gameData) - 0.5) * 0.9;
    const speed =
      balance.minSpeed + random(gameData) * (balance.maxSpeed - balance.minSpeed);

    // Store Cartesian velocity directly; later passes need no heading conversion.
    gameData.velocityX[agentIndex] = Math.cos(heading) * speed;
    gameData.velocityY[agentIndex] = Math.sin(heading) * speed;
  }
}

/**
 * Change the live prefix while retaining the pool's capacity and backing buffers.
 * Growing initializes only the added slots; shrinking only changes the count.
 * Both simulation and rendering use that count, so inactive slots need no per-agent
 * alive flag, removal pass, or destruction of presentation objects.
 */
export function setPopulation(gameData, balance, requestedCount) {
  // Clamp external UI/controller requests at this boundary, before hot loops use them.
  const agentCount = Math.max(
    balance.minCount,
    Math.min(balance.capacity, Math.round(requestedCount)),
  );

  // Growing the live prefix initializes existing slots; it never resizes a buffer.
  if (agentCount > gameData.agentCount) {
    spawn(gameData, balance, gameData.agentCount, agentCount);
  }

  // Publish the new count only after any newly active slots have valid state.
  gameData.agentCount = agentCount;
}

/**
 * Restart motion for the current population without replacing any arrays.
 * Time and sample rotation restart, but randomSeed continues its sequence so each
 * reseed produces a different arrangement. Static colors remain attached to slots.
 */
export function reseed(gameData, balance) {
  gameData.simulationTime = 0;
  gameData.tickIndex = 0;

  spawn(gameData, balance, 0, gameData.agentCount);
}

/**
 * Copy a preset's shared steering weights into mutable runtime settings.
 * Agents read these few scalars during steering; changing a preset requires no
 * traversal to update settings on individual agents and no new agent type objects.
 */
export function setPreset(gameData, presetIndex) {
  gameData.presetIndex = presetIndex;
  gameData.separation = presets[presetIndex].separation;
  gameData.alignment = presets[presetIndex].alignment;
  gameData.cohesion = presets[presetIndex].cohesion;
}

/**
 * Apply a named UI setting through the logic layer's input boundary.
 * The dynamic property lookup happens on user interaction, outside the per-agent
 * loop. Hot simulation code reads known fields and indexed typed arrays directly.
 */
export function setParameter(gameData, parameterName, value) {
  gameData[parameterName] = value;
}

/**
 * Toggle simulation time advancement while leaving the current arrays intact.
 * Clear pointer activation so resuming cannot revive a force from an old gesture.
 * Board.step reads this shared flag once before deciding whether to run the tick.
 */
export function togglePause(gameData) {
  gameData.paused = !gameData.paused;
  gameData.pointerActive = false;
}

/**
 * Rebuild a counting-sort grid and shared neighborhood averages from current state.
 * Count occupants, reserve contiguous ranges, then scatter integer agent indices.
 * Reuse every scratch array; do not create per-cell lists or sort agent objects.
 * With nine neighbors per cell, the passes cost O(live agents + grid cells).
 * Only indices are grouped: the position/velocity arrays keep their original order.
 */
export function buildGrid(gameData, balance) {
  // Clear accumulators in place. Other scratch fields are fully overwritten below.
  gameData.cellAgentCount.fill(0);
  gameData.cellPositionSumX.fill(0);
  gameData.cellPositionSumY.fill(0);
  gameData.cellVelocitySumX.fill(0);
  gameData.cellVelocitySumY.fill(0);

  // Hoist this shared conversion factor out of the agent loop.
  const inverseCellSize = 1 / balance.cellSize;

  // Pass 1: count each cell's occupants and accumulate their positions/velocities.
  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    // Positions are nonnegative: truncation finds the row/column, then flatten them.
    // Clamp the upper edge to keep floating-point rounding inside the last cell.
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

    // Remember membership for later passes and add to this cell's aggregate state.
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
    // Example: counts [2, 0, 3] reserve ranges [0, 2), [2, 2), and [2, 5).
    gameData.cellStartOffset[cellIndex] = nextCellStart;
    gameData.cellWriteOffset[cellIndex] = nextCellStart;
    nextCellStart += gameData.cellAgentCount[cellIndex];
  }

  // Store the last range's end as a sentinel, equal to the total live population.
  gameData.cellStartOffset[gameData.cellAgentCount.length] = nextCellStart;

  // Pass 3: counting-sort the indices, without moving the agents' state arrays.
  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    const cellIndex = gameData.agentCellIndex[agentIndex];
    // Write at the cell's next free slot, then advance its cursor for the next agent.
    gameData.sortedAgentIndices[gameData.cellWriteOffset[cellIndex]++] = agentIndex;
  }

  // Compute a shared neighborhood average once per cell, rather than per agent.
  for (let cellIndex = 0; cellIndex < gameData.cellAgentCount.length; cellIndex++) {
    // Scalar accumulators replace temporary arrays or per-neighborhood result objects.
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

      // Translating a sum requires one wrap offset for every occupant of that cell.
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

    // Empty neighborhoods get zero means; otherwise divide the sums once per cell.
    const inverseCount = neighborAgentCount > 0 ? 1 / neighborAgentCount : 0;

    // Cache the same answer for all occupants instead of recomputing it per agent.
    gameData.neighborPositionMeanX[cellIndex] = positionSumX * inverseCount;
    gameData.neighborPositionMeanY[cellIndex] = positionSumY * inverseCount;
    gameData.neighborVelocityMeanX[cellIndex] = velocitySumX * inverseCount;
    gameData.neighborVelocityMeanY[cellIndex] = velocitySumY * inverseCount;
    gameData.neighborAgentCount[cellIndex] = neighborAgentCount;
  }
}

/**
 * Advance flocking by one time step using the preallocated arrays and grid.
 * Build a snapshot, calculate velocities, then commit positions in a separate pass.
 * This ordering prevents earlier agents from moving before later queries read them.
 * Shared cell averages and bounded separation samples keep neighbor work linear;
 * this is approximate flocking, not an exhaustive neighbor or collision solver.
 * The tick creates no arrays, objects, or closures, reducing simulation GC pressure.
 */
export function tick(gameData, balance, deltaSeconds) {
  gameData.simulationTime += deltaSeconds;
  gameData.tickIndex++;
  buildGrid(gameData, balance);

  // These locals reference existing buffers; they do not copy the typed-array data.
  const positionX = gameData.positionX;
  const positionY = gameData.positionY;
  const velocityX = gameData.velocityX;
  const velocityY = gameData.velocityY;
  // All agents share a slowly moving flow center; calculate it once per tick.
  const flowPhase = gameData.simulationTime * 0.13;
  const flowCenterX = balance.width * 0.5 + Math.sin(flowPhase) * 105;
  const flowCenterY = balance.height * 0.5 + Math.sin(flowPhase * 1.3) * 75;
  // The speed slider scales integration time, keeping velocity units consistent.
  const stepSeconds = deltaSeconds * gameData.speed;

  // A dense live prefix avoids checking an active/inactive flag for every pool slot.
  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    const agentX = positionX[agentIndex];
    const agentY = positionY[agentIndex];
    let separationX = 0;
    let separationY = 0;

    const homeCellIndex = gameData.agentCellIndex[agentIndex];
    // Slot 4 is the center of a row-major 3x3 table. Adjacent rows are three slots apart.
    const homeNeighborSlot = homeCellIndex * 9 + 4;
    // Choose the nearer horizontal and vertical edge to find the four closest cells.
    const horizontalCellOffset =
      agentX % balance.cellSize < balance.cellSize / 2 ? -1 : 1;
    const verticalCellOffset = agentY % balance.cellSize < balance.cellSize / 2 ? -3 : 3;

    // The separation radius fits within the four nearest cells. Sampling two
    // occupants per cell bounds this pass to eight distance checks per agent.
    for (let quadrantIndex = 0; quadrantIndex < 4; quadrantIndex++) {
      // The low bit selects the horizontal neighbor; the next bit selects the row.
      const neighborSlot =
        homeNeighborSlot +
        (quadrantIndex & 1) * horizontalCellOffset +
        (quadrantIndex >> 1) * verticalCellOffset;
      const neighborCellIndex = gameData.neighborCellIndices[neighborSlot];
      const cellAgentCount = gameData.cellAgentCount[neighborCellIndex];
      const sampleCount = Math.min(cellAgentCount, balance.samplesPerCell);
      const cellStartOffset = gameData.cellStartOffset[neighborCellIndex];
      // Vary selection by agent and tick so dense cells do not always sample one pair.
      const rotatingSampleOffset = (agentIndex * 13 + gameData.tickIndex * 7) >>> 0;

      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
        // Spread samples across the cell's occupied range, then look up their agent IDs.
        const neighborAgentIndex =
          gameData.sortedAgentIndices[
            cellStartOffset +
              ((rotatingSampleOffset +
                Math.floor((sampleIndex * cellAgentCount) / sampleCount)) %
                cellAgentCount)
          ];

        // The home cell includes this agent; it must not repel itself.
        if (neighborAgentIndex === agentIndex) continue;

        // Apply the precomputed translation before measuring across a wrapped edge.
        const distanceX =
          positionX[neighborAgentIndex] +
          gameData.neighborWrapOffsetX[neighborSlot] -
          agentX;
        const distanceY =
          positionY[neighborAgentIndex] +
          gameData.neighborWrapOffsetY[neighborSlot] -
          agentY;
        // A squared-radius comparison avoids square roots for rejected candidates.
        const distanceSquared = distanceX * distanceX + distanceY * distanceY;

        if (distanceSquared < balance.separationRadiusSq && distanceSquared > 0.001) {
          // Fade at the radius and cap the inverse-distance term near overlap.
          const repulsionStrength =
            (1 - distanceSquared / balance.separationRadiusSq) /
            Math.max(distanceSquared, 4);
          // Subtract the neighbor direction to steer away from the sampled occupant.
          separationX -= distanceX * repulsionStrength;
          separationY -= distanceY * repulsionStrength;
        }
      }
    }

    // Convert separation into acceleration and apply the shared user-selected weight.
    let accelerationX = separationX * 230 * gameData.separation;
    let accelerationY = separationY * 230 * gameData.separation;

    // Remove this agent's own contribution from the neighborhood averages.
    if (gameData.neighborAgentCount[homeCellIndex] > 1) {
      // (mean - self) * n / (n - 1) equals (mean of the other agents - self).
      const selfExclusionScale =
        gameData.neighborAgentCount[homeCellIndex] /
        (gameData.neighborAgentCount[homeCellIndex] - 1);

      // Alignment matches average velocity; cohesion steers toward average position.
      // Both read a cached cell answer, with no additional neighbor traversal.
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
      // Stream favors rightward motion with a wave in the vertical target velocity.
      accelerationX += (58 - velocityX[agentIndex]) * 0.35;
      accelerationY +=
        (Math.sin(agentX * 0.008 + flowPhase * 3) * 30 - velocityY[agentIndex]) * 0.5;
    } else {
      // Vortex strengthens tangential motion; Murmuration uses a gentler changing ring.
      const orbitStrength = gameData.presetIndex === 1 ? 1.8 : 0.45;
      const targetRadius =
        gameData.presetIndex === 1
          ? 265
          : 320 + Math.sin(flowPhase * 2 + agentX * 0.005) * 80;
      const radialForce =
        (radius - targetRadius) * (gameData.presetIndex === 1 ? 0.12 : 0.065);

      // The perpendicular direction drives orbiting; the radial term restores the ring.
      accelerationX +=
        ((-centerOffsetY / radius) * 60 - velocityX[agentIndex]) * orbitStrength -
        (centerOffsetX / radius) * radialForce;
      accelerationY +=
        ((centerOffsetX / radius) * 60 - velocityY[agentIndex]) * orbitStrength -
        (centerOffsetY / radius) * radialForce;
    }

    // Input is already expressed in world coordinates; logic needs no DOM knowledge.
    if (gameData.pointerActive) {
      const pointerDistanceX = gameData.pointerX - agentX;
      const pointerDistanceY = gameData.pointerY - agentY;
      const pointerDistanceSquared =
        pointerDistanceX * pointerDistanceX + pointerDistanceY * pointerDistanceY;

      if (pointerDistanceSquared < 220 * 220 && pointerDistanceSquared > 1) {
        // Inside the influence radius, normalize direction and fade force with distance.
        // The mode's sign switches between attraction and repulsion.
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
      // Only take the square root when the vector actually needs rescaling.
      const forceScale = balance.maxForce / Math.sqrt(forceSquared);
      accelerationX *= forceScale;
      accelerationY *= forceScale;
    }

    // Integrate acceleration into velocity, leaving positions untouched for now.
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
      // An exactly stationary agent needs a direction as well as a minimum speed.
      nextVelocityX = speed > 0 ? nextVelocityX * speedScale : balance.minSpeed;
      nextVelocityY *= speedScale;
    }

    // Neighbor velocities are already snapshotted into the grid's cell averages.
    velocityX[agentIndex] = nextVelocityX;
    velocityY[agentIndex] = nextVelocityY;
  }

  // Every neighbor query has finished; it is now safe to overwrite positions.
  integratePositions(gameData, balance, stepSeconds);
}

/**
 * Move the live agents using the velocities computed by the steering pass.
 * This compact SoA pass streams position and velocity fields without grid lookups
 * or per-agent methods. It writes results in place for rendering to consume.
 * Separating this pass preserves a consistent position snapshot during steering.
 */
export function integratePositions(gameData, balance, stepSeconds) {
  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    // Distance = velocity * elapsed seconds, independently for each axis.
    const nextX =
      gameData.positionX[agentIndex] + gameData.velocityX[agentIndex] * stepSeconds;
    const nextY =
      gameData.positionY[agentIndex] + gameData.velocityY[agentIndex] * stepSeconds;

    // Wrap to the opposite edge. Adding one world span handles a negative crossing;
    // the loop's bounded time step and speed limits keep travel below that span.
    gameData.positionX[agentIndex] = (nextX + balance.width) % balance.width;
    gameData.positionY[agentIndex] = (nextY + balance.height) % balance.height;
  }
}
