// Author-time constants. User-controlled values belong to GameData.
// Keeping configuration separate lets logic trust one shared set of bounds instead
// of copying settings into every agent. Tests validate the grid relationships.
export const balance = Object.freeze({
  // Reserve the pool once; the live population is chosen independently at runtime.
  capacity: 300_000,
  minCount: 500,
  initialCount: 12_000,
  // Simulation coordinates stay fixed when the viewport changes size.
  width: 1440,
  height: 960,
  // The grid tiles the world exactly, so wrapped cell lookups need no partial cells.
  cellSize: 48,
  gridColumns: 30,
  gridRows: 20,
  // Cap separation work per cell; dense cells do not trigger unbounded scans.
  samplesPerCell: 2,
  // Squared radii support comparisons without taking a square root.
  // neighborRadiusSq documents the grid scale; cohesion/alignment use cell averages.
  neighborRadiusSq: 48 * 48,
  separationRadiusSq: 16 * 16,
  // Speeds are world units/second; maxForce limits acceleration in units/second².
  minSpeed: 34,
  maxSpeed: 76,
  maxForce: 95,
  // This is the controller's target, not a guarantee of any population or frame rate.
  targetFrameMs: 1000 / 60,
  // The chart retains a fixed number of samples instead of an ever-growing history.
  historySize: 100,
});

// Presets provide immutable defaults. Selecting one copies these few weights into
// GameData, where sliders may change them without modifying the shared definitions.
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
