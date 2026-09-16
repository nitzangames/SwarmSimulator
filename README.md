# Murmur — Three.js + Typed Arrays

**[Run the live demo](https://swarm.nitzan.games/)** · **[Data-oriented-design skill](https://github.com/Data-Oriented-Design-for-Games/data-oriented-design)** · **[The book](https://www.manning.com/books/high-performance-unity-game-development)**

A data-oriented flocking demo built with **JavaScript typed arrays and Three.js**.

The **Behind the swarm** panel explains the implementation with code examples and links to the source. This repository contains the readable, commented source used to build the public site; production bundles are minified by Vite.

## Why this is data-oriented design

- **An agent is an index.** Its position and velocity live at the same index in separate arrays. There is no per-agent object or update method.
- **Data and logic are separate.** Free functions transform plain state. The simulation never reaches into the DOM, Three.js, or the animation loop.
- **Memory is allocated up front.** The live population is a count into a fixed pool. Grid scratch buffers are cleared and reused.
- **Work follows the data layout.** A counting-sort grid creates contiguous ranges of agent indices, so nearby work can share cell averages.
- **Rendering reuses the layout.** Three.js instance attributes reference the existing simulation arrays; no per-agent matrices or CPU packing buffer are needed.

This architecture follows the [language-agnostic data-oriented-design skill](https://github.com/Data-Oriented-Design-for-Games/data-oriented-design). The skill is adapted from Nitzan Wilnai’s [_High Performance Unity Game Development — Using data-oriented design_](https://www.manning.com/books/high-performance-unity-game-development), published by Manning. The book explores the architecture in Unity; this demo applies the same principles to browser JavaScript.

## Run locally

Requires Node.js **22.12 or newer** and npm. A browser with WebGL 2 is required.

```sh
git clone https://github.com/nitzangames/SwarmSimulator.git
cd SwarmSimulator
npm ci
npm run dev
```

Open the local URL printed by Vite. On a phone connected to the same Wi-Fi, use the printed network URL. If another local app uses IPv6 on the same port, use `127.0.0.1` instead of `localhost`.

```sh
npm run build        # Generate the static site in dist/
npm run preview      # Preview the production build
npm test             # Simulation and adaptive-controller tests
npm run benchmark    # CPU-only timings at several populations
npm run format       # Apply consistent indentation and line breaks
npm run format:check # Check source formatting
```

## How the code works

### 1. Allocate a Structure of Arrays

[gameData.js](src/gameData.js) owns the mutable simulation state. This simplified excerpt shows the central data layout:

```js
const capacity = 300_000;

const gameData = {
  positionX: new Float32Array(capacity),
  positionY: new Float32Array(capacity),
  velocityX: new Float32Array(capacity),
  velocityY: new Float32Array(capacity),
  agentCount: 12_000,
};
```

`gameData.positionX[agentIndex]` and `gameData.velocityX[agentIndex]` belong to the same agent. Changing the live population initializes or excludes slots in these buffers; it does not resize them.

Positions and velocities use 32-bit floats. Cell counters, offsets, and sorted indices use integer typed arrays. Cell sums use `Float64Array` to retain accumulation precision when many agents share a cell. The complete simulation pool occupies approximately **8.1 MiB**, excluding Three.js, browser memory, and GPU buffers.

### 2. Transform the data with plain functions

[logic.js](src/logic.js) contains initialization, grid building, steering, and movement. The position integration function illustrates the data-in / transformation / data-out pattern:

```js
export function integratePositions(gameData, balance, stepSeconds) {
  for (let agentIndex = 0; agentIndex < gameData.agentCount; agentIndex++) {
    const nextX =
      gameData.positionX[agentIndex] + gameData.velocityX[agentIndex] * stepSeconds;
    const nextY =
      gameData.positionY[agentIndex] + gameData.velocityY[agentIndex] * stepSeconds;

    // The world wraps, including neighbor interactions across its edges.
    gameData.positionX[agentIndex] = (nextX + balance.width) % balance.width;
    gameData.positionY[agentIndex] = (nextY + balance.height) % balance.height;
  }
}
```

The steering pass runs first. It reads unchanged positions and a snapshot of cell velocity averages, then updates velocities. Position integration runs only after all separation queries finish. The tick allocates no arrays, objects, or closures, and a seeded generator makes initialization reproducible.

### 3. Keep neighbor work bounded

The uniform spatial grid has 30 columns and 20 rows:

1. Count agents in each cell and accumulate their positions and velocities.
2. Calculate prefix offsets to reserve a contiguous index range per cell.
3. Scatter agent indices into those ranges using reusable typed arrays.
4. Aggregate position and velocity across nine neighboring cells once per cell.
5. Use those averages for alignment/cohesion, and sample at most two occupants in each of the four nearest cells for separation.

The sample rotates each tick. This produces **O(N + grid cells)** work, with at most eight separation candidates per agent even in a dense cell.

This is an **approximate boids model**: alignment/cohesion use a grid neighborhood and separation is sampled. It does not check every neighbor or guarantee collision avoidance. A gentle global flow gives Murmuration, Vortex, and Stream their distinct large-scale motion.

### 4. Render with Three.js instancing

[board.js](src/board.js) creates one `InstancedBufferGeometry`, one mesh, and one shader material. This abbreviated example shows how a field becomes a GPU instance attribute:

```js
const geometry = new THREE.InstancedBufferGeometry();
const positionAttribute = new THREE.InstancedBufferAttribute(
  gameData.positionX,
  1,
).setUsage(THREE.DynamicDrawUsage);

geometry.setAttribute("agentPositionX", positionAttribute);
geometry.instanceCount = gameData.agentCount;

// The full renderer also supplies Y, both velocities, and the shape vertices.
renderer.render(scene, camera);
```

The vertex shader places each two-triangle shape and rotates it toward its velocity. Color variation is static. Dynamic attributes reference the existing state buffers, and reusable update-range records select only the live prefixes after the first upload.

**There is still a CPU-to-GPU upload.** Sharing typed-array references with Three.js avoids an extra CPU packing copy; it is not zero-copy shared GPU memory. Drawing resolution is capped at 1.5× device pixel ratio.

## Project map

| DOD role          | File                                                     | Responsibility                                       |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Balance           | [src/balance.js](src/balance.js)                         | Immutable configuration and preset defaults          |
| GameData          | [src/gameData.js](src/gameData.js)                       | Parallel typed arrays, counts, and runtime state     |
| Logic             | [src/logic.js](src/logic.js)                             | Pure state transformations and seeded initialization |
| Board             | [src/board.js](src/board.js)                             | Three.js rendering, UI, and input                    |
| Game              | [src/main.js](src/main.js)                               | One animation loop and visibility handling           |
| Performance logic | [src/performance.js](src/performance.js)                 | Frame measurements and population adaptation         |
| Presentation      | [index.html](index.html), [src/style.css](src/style.css) | Responsive UI and the technical walkthrough          |

## Controls

- Press and drag the simulation to repel or attract nearby agents.
- **Space** pauses/resumes, **R** reseeds, and **F** toggles fullscreen where supported.
- The population slider switches to manual mode. **Find my limit** restarts automatic tuning.
- Murmuration, Vortex, and Stream change the global flow and flocking weights.
- Separation, alignment, cohesion, and flight speed remain adjustable in every preset.

## Performance and measurement

Auto-scale warms up for two measurement windows, then increases the population after two healthy windows. It retreats when frame intervals, missed frames, or CPU work exceed the budget. A remembered ceiling and delayed probes reduce repeated overshoot and allow recovery when device load improves.

- **FPS / frame time** measure animation-frame intervals, including browser scheduling.
- **CPU simulation** measures only the logic call.
- **Typed-array pool** measures simulation buffers, excluding browser and GPU memory.
- **Draw calls** comes from the Three.js renderer.

These readings are not GPU timestamps. Hidden tabs stop the loop and reset tuning on return. Delta time is clamped after stalls. Reduced-motion preferences lower the default flight speed.

Performance depends on your device and browser. Use the live readouts to see how your device performs. Run `npm run benchmark` to measure CPU simulation time separately from rendering.

## Validation

```sh
npm test
npm run build

# With a local dev server and Google Chrome installed:
SWARM_URL=http://127.0.0.1:5173 npm run test:browser
```

The Node tests cover deterministic motion, finite/bounded state, grid membership, edge wrapping, flocking forces, backing-buffer reuse, and population adaptation. The browser check covers presets, controls, pause/resume, mouse/touch interaction, the explanation panel, the complete 300,000-agent pool, and WebGL context recovery. Screenshots are written to `test-results/`.

Mobile browser emulation checks layout and input; actual phone performance must be measured on a physical device.

## Deployment

The public site is **https://swarm.nitzan.games/**. A dedicated Cloudflare Worker, `murmur-swarm`, serves only the built files in `dist/`.

The site also works on a static host that serves the contents of `dist/`. To update this specific production domain, use the authorized Cloudflare account:

```sh
npm run deploy
```

[wrangler.jsonc](wrangler.jsonc) configures the exact `swarm.nitzan.games/*` route. It uses existing proxied DNS and takes precedence over the zone's shared wildcard route. Source files, local credentials, test screenshots, and dependencies are not uploaded to the site. Publishing changes to GitHub does not automatically deploy the website.

WebGL 2 is required; no WebGPU, cross-origin isolation, SharedArrayBuffer, or worker setup is needed. Fonts load from Google Fonts with system fallbacks. Three.js and the simulation are bundled locally.

## Learn more

- [Data-oriented-design skill](https://github.com/Data-Oriented-Design-for-Games/data-oriented-design), including its [HTML/JavaScript guide](https://github.com/Data-Oriented-Design-for-Games/data-oriented-design/blob/main/references/html-js.md).
- [High Performance Unity Game Development — Using data-oriented design](https://www.manning.com/books/high-performance-unity-game-development), by Nitzan Wilnai, Manning.
- [Three.js InstancedBufferGeometry](https://threejs.org/docs/pages/InstancedBufferGeometry.html) and [BufferAttribute update ranges](https://threejs.org/docs/pages/BufferAttribute.html).
