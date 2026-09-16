// GameData owns storage; logic.js owns the transformations over that storage.
// An agent has no object or methods: its integer index identifies it in every array.

/**
 * Allocate the simulation's state and scratch buffers once, before animation starts.
 * Each field occupies a contiguous typed array (Structure of Arrays, or SoA), so
 * a pass can read just the fields it needs without traversing per-agent objects.
 * The live count changes later; buffer sizes and references stay fixed. This avoids
 * allocating replacement arrays when the flock grows or the grid is rebuilt.
 */
export function allocateGameData(balance) {
  // Capacity is reserved storage, not a promise about a device's frame rate.
  const capacity = balance.capacity;
  // Flatten the two-dimensional grid into one index: row * gridColumns + column.
  const cellCount = balance.gridColumns * balance.gridRows;

  return {
    // Float32 uses four bytes per value and matches the GPU's float attributes.
    // Position and velocity are split by axis; integration streams all four arrays.
    positionX: new Float32Array(capacity),
    positionY: new Float32Array(capacity),
    velocityX: new Float32Array(capacity),
    velocityY: new Float32Array(capacity),
    // Appearance is seeded once for every slot, including currently unused slots.
    colorVariation: new Float32Array(capacity),

    // Each agent remembers its cell, avoiding a second coordinate-to-cell calculation.
    agentCellIndex: new Uint32Array(capacity),
    // Cell occupants are integer references into the state arrays, not copied agents.
    sortedAgentIndices: new Uint32Array(capacity),
    // Counts become prefix offsets that reserve one contiguous range per cell.
    cellAgentCount: new Uint32Array(cellCount),
    // The extra end offset lets the last cell use the same [start, end) convention.
    cellStartOffset: new Uint32Array(cellCount + 1),
    // A separate write cursor preserves each cell's start while scattering indices.
    cellWriteOffset: new Uint32Array(cellCount),

    // Wider accumulators retain precision when many agents share a cell.
    cellPositionSumX: new Float64Array(cellCount),
    cellPositionSumY: new Float64Array(cellCount),
    cellVelocitySumX: new Float64Array(cellCount),
    cellVelocitySumY: new Float64Array(cellCount),

    // Reuse one neighborhood average per cell for every agent in that cell.
    // These are an approximation: alignment/cohesion do not scan every neighbor.
    neighborPositionMeanX: new Float32Array(cellCount),
    neighborPositionMeanY: new Float32Array(cellCount),
    neighborVelocityMeanX: new Float32Array(cellCount),
    neighborVelocityMeanY: new Float32Array(cellCount),
    // Counts allow steering to remove the current agent from the shared average.
    neighborAgentCount: new Uint32Array(cellCount),
    // Nine entries per cell describe its 3x3 neighborhood, including the cell itself.
    // Uint16 is sufficient for this grid's cell IDs; configuration tests check that.
    neighborCellIndices: new Uint16Array(cellCount * 9),
    // Wrapped neighbors need translated coordinates to interact across world edges.
    neighborWrapOffsetX: new Float32Array(cellCount * 9),
    neighborWrapOffsetY: new Float32Array(cellCount * 9),

    // Only the live prefix [0, agentCount) is simulated and rendered.
    agentCount: 0,
    // Seconds drive the shared flow; the tick number rotates separation samples.
    simulationTime: 0,
    tickIndex: 0,
    // Keeping the generator's state here makes initialization reproducible in tests.
    randomSeed: 42,
    // User-adjustable values are plain shared scalars, not duplicated per agent.
    presetIndex: 0,
    separation: 1.5,
    alignment: 1,
    cohesion: 0.8,
    speed: 1,
    // The presentation layer stages pointer input; simulation logic consumes it.
    pointerX: 0,
    pointerY: 0,
    pointerActive: false,
    // Negative force repels; positive force attracts along the pointer direction.
    pointerMode: -1,
    paused: false,
    autoScale: true,
  };
}

/**
 * Allocate measurement state separately from the flock's physical state.
 * A fixed history buffer stores chart samples without growing or shifting an array.
 * Scalar totals support population decisions without keeping every frame sample.
 */
export function allocatePerformanceData(balance) {
  return {
    // A ring buffer overwrites the oldest sample once all slots are occupied.
    history: new Float32Array(balance.historySize),
    // The index is the next write slot; count distinguishes unwritten slots from data.
    historyIndex: 0,
    historyCount: 0,
    // Initial display values are placeholders until measured frames arrive.
    frameMs: balance.targetFrameMs,
    cpuMs: 0,
    workMs: 0,
    fps: 60,
    // Unsmoothed totals cover approximately one second of measured frame intervals.
    windowTime: 0,
    windowFrames: 0,
    windowWork: 0,
    slowFrames: 0,
    // Wait through startup, then require sustained headroom before adding agents.
    warmup: 2,
    goodWindows: 0,
    // Remember a recent population limit and delay attempts to exceed it.
    ceiling: balance.capacity,
    retryIn: 0,
    status: "TUNING",
    // Total accepted frame measurements, independent of the chart's sample count.
    samples: 0,
  };
}
