// Author-time constants. User-controlled values belong to GameData.
export const balance = Object.freeze({
  capacity: 300_000,
  minCount: 500,
  initialCount: 12_000,
  width: 1440,
  height: 960,
  cellSize: 48,
  gridColumns: 30,
  gridRows: 20,
  samplesPerCell: 2,
  neighborRadiusSq: 48 * 48,
  separationRadiusSq: 16 * 16,
  minSpeed: 34,
  maxSpeed: 76,
  maxForce: 95,
  targetFrameMs: 1000 / 60,
  historySize: 100,
});

export const presets = Object.freeze([
  Object.freeze({
    name: "Murmuration",
    separation: 1.5,
    alignment: 1,
    cohesion: 0.8,
  }),
  Object.freeze({
    name: "Vortex",
    separation: 1.2,
    alignment: 1.4,
    cohesion: 1.1,
  }),
  Object.freeze({
    name: "Stream",
    separation: 1.7,
    alignment: 1.8,
    cohesion: 0.5,
  }),
]);
