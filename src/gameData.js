// Allocate the maximum pool once. An agent is an index shared by these arrays.
export function allocateGameData(balance) {
  const capacity = balance.capacity;
  const cellCount = balance.gridColumns * balance.gridRows;
  return {
    // Structure of Arrays: each field has its own contiguous typed buffer.
    positionX: new Float32Array(capacity),
    positionY: new Float32Array(capacity),
    velocityX: new Float32Array(capacity),
    velocityY: new Float32Array(capacity),
    colorVariation: new Float32Array(capacity),

    // Counting-sort scratch space groups agent indices by cell.
    agentCellIndex: new Uint32Array(capacity),
    sortedAgentIndices: new Uint32Array(capacity),
    cellAgentCount: new Uint32Array(cellCount),
    cellStartOffset: new Uint32Array(cellCount + 1),
    cellWriteOffset: new Uint32Array(cellCount),

    // Wider accumulators retain precision when many agents share a cell.
    cellPositionSumX: new Float64Array(cellCount),
    cellPositionSumY: new Float64Array(cellCount),
    cellVelocitySumX: new Float64Array(cellCount),
    cellVelocitySumY: new Float64Array(cellCount),

    // Shared neighborhood averages keep steering work linear in population.
    neighborPositionMeanX: new Float32Array(cellCount),
    neighborPositionMeanY: new Float32Array(cellCount),
    neighborVelocityMeanX: new Float32Array(cellCount),
    neighborVelocityMeanY: new Float32Array(cellCount),
    neighborAgentCount: new Uint32Array(cellCount),
    neighborCellIndices: new Uint16Array(cellCount * 9),
    neighborWrapOffsetX: new Float32Array(cellCount * 9),
    neighborWrapOffsetY: new Float32Array(cellCount * 9),

    // Only the live prefix [0, agentCount) is simulated and rendered.
    agentCount: 0,
    simulationTime: 0,
    tickIndex: 0,
    randomSeed: 42,
    presetIndex: 0,
    separation: 1.5,
    alignment: 1,
    cohesion: 0.8,
    speed: 1,
    pointerX: 0,
    pointerY: 0,
    pointerActive: false,
    pointerMode: -1,
    paused: false,
    autoScale: true,
  };
}

export function allocatePerformanceData(balance) {
  return {
    history: new Float32Array(balance.historySize),
    historyIndex: 0,
    historyCount: 0,
    frameMs: balance.targetFrameMs,
    cpuMs: 0,
    workMs: 0,
    fps: 60,
    windowTime: 0,
    windowFrames: 0,
    windowWork: 0,
    slowFrames: 0,
    warmup: 2,
    goodWindows: 0,
    ceiling: balance.capacity,
    retryIn: 0,
    status: "TUNING",
    samples: 0,
  };
}
