import * as THREE from "three";
import * as Logic from "./logic.js";
import { presets } from "./balance.js";
import { resetTuning, sampleHistory } from "./performance.js";
import { createFishAsset, fishVertexShader, fishFragmentShader } from "./fish.js";
import { createFishInspector, renderFishInspector } from "./fishInspector.js";

// Board owns presentation resources and translates browser input into plain state.
// Three.js objects and DOM nodes are shared scene/UI resources, not one per agent.

// The GPU receives one scalar per instance for each SoA field. The small shared
// wing geometry supplies `position`; Three.js supplies the camera matrices.
const vertexShader = `
// Instance attributes advance once per agent, while shape vertices are reused.
attribute float agentPositionX;
attribute float agentPositionY;
attribute float agentVelocityX;
attribute float agentVelocityY;
attribute float shade;
// Uniforms apply to the entire draw; varyings pass color/opacity to the fragment stage.
uniform vec2 worldSize;
uniform float pointScale;
varying vec3 flockColor;
varying float flockOpacity;

// Place a shared shape using this agent's position and velocity. Calculating its
// orientation here avoids storing and updating a CPU-side matrix for every agent.
void main() {
  // A small bias avoids normalizing a zero velocity; the perpendicular forms a basis.
  vec2 direction = normalize(vec2(agentVelocityX, agentVelocityY) + vec2(0.0001));
  vec2 side = vec2(-direction.y, direction.x);
  // Use the static shade to vary size, then rotate the shared shape into its heading.
  float size = (0.75 + shade * 0.85) * pointScale;
  vec2 local = (direction * position.x + side * position.y) * size;
  // Simulation coordinates start at a corner; the camera is centered at the origin.
  vec2 worldPosition = vec2(agentPositionX, agentPositionY) - worldSize * 0.5 + local;
  // Transform the world-space vertex into the clip coordinates expected by WebGL.
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPosition, 0.0, 1.0);
  // Derive appearance from one static scalar instead of uploading per-agent RGB values.
  vec3 moss = vec3(0.34, 0.48, 0.23);
  vec3 lime = vec3(0.77, 0.89, 0.45);
  vec3 cream = vec3(0.91, 0.94, 0.75);
  flockColor = shade < 0.7 ? mix(moss, lime, shade / 0.7) : mix(lime, cream, (shade - 0.7) / 0.3);
  flockOpacity = 0.38 + shade * 0.55;
}`;

// No texture lookup or lighting pass is needed for these flat translucent shapes.
const fragmentShader = `
precision highp float;
varying vec3 flockColor;
varying float flockOpacity;

// Output the vertex stage's color and opacity for alpha blending into the canvas.
void main() {
  gl_FragColor = vec4(flockColor, flockOpacity);
}
`;

/**
 * Create the shared renderer, mesh, GPU attributes, cached UI, and input handlers.
 * This startup function may allocate; the per-frame simulation must reuse its data.
 * Instance attributes reference existing typed arrays, avoiding a CPU packing copy.
 * WebGL still uploads those values to GPU buffers: this is not shared GPU memory.
 */
export function createBoard(gameData, balance, performanceData) {
  const canvas = document.querySelector("#swarm");
  // Transparent clearing exposes the page background. Disabling multisampling keeps
  // this renderer's pixel workload lower; powerPreference is only a browser hint.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x111310, 0);
  // An orthographic camera maps the two-dimensional world without perspective scaling.
  const camera = new THREE.OrthographicCamera(
    -balance.width / 2,
    balance.width / 2,
    balance.height / 2,
    -balance.height / 2,
    0.1,
    300,
  );
  // Leave depth room for the volumetric fish while retaining the same 2D projection.
  camera.position.z = 100;
  const scene = new THREE.Scene();
  // Instancing repeats one shape using attributes, instead of making an agent mesh pool.
  const geometry = new THREE.InstancedBufferGeometry();
  // Two slender wings; heading is applied in the shader, no instance matrices.
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [2.8, 0, 0, -1.9, 1.0, 0, -0.8, 0, 0, 2.8, 0, 0, -0.8, 0, 0, -1.9, -1.0, 0],
      3,
    ),
  );
  // Each attribute references its existing simulation array: no packing copy.
  const simulationArrays = [
    gameData.positionX,
    gameData.positionY,
    gameData.velocityX,
    gameData.velocityY,
  ];
  const attributeNames = [
    "agentPositionX",
    "agentPositionY",
    "agentVelocityX",
    "agentVelocityY",
  ];
  const instanceAttributes = new Array(4);
  // Reserve one reusable upload-range record for each changing simulation field.
  const attributeUpdateRanges = new Array(4);
  for (let attributeIndex = 0; attributeIndex < 4; attributeIndex++) {
    // itemSize = 1: this buffer contains one scalar per agent, not a packed vector.
    instanceAttributes[attributeIndex] = new THREE.InstancedBufferAttribute(
      simulationArrays[attributeIndex],
      1,
    ).setUsage(THREE.DynamicDrawUsage);
    attributeUpdateRanges[attributeIndex] = { start: 0, count: gameData.agentCount };
    geometry.setAttribute(
      attributeNames[attributeIndex],
      instanceAttributes[attributeIndex],
    );
  }
  // Color variation is initialized for the entire capacity and does not change per tick.
  geometry.setAttribute(
    "shade",
    new THREE.InstancedBufferAttribute(gameData.colorVariation, 1),
  );
  // Capacity may be larger: only this many instances are submitted for the draw.
  geometry.instanceCount = gameData.agentCount;
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    // All shapes occupy a flat layer, so blending is useful and depth testing is not.
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      worldSize: { value: new THREE.Vector2(balance.width, balance.height) },
      pointScale: { value: 1 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  // The CPU geometry bounds cover the tiny base shape, not shader-positioned agents.
  // Disable mesh culling so those incomplete bounds cannot hide the entire flock.
  mesh.frustumCulled = false;
  scene.add(mesh);
  // Both appearances are allocated once. Switching swaps this single mesh's resources.
  const fishAsset = createFishAsset();
  const fishGeometry = new THREE.InstancedBufferGeometry().copy(fishAsset.geometry);
  for (let attributeIndex = 0; attributeIndex < 4; attributeIndex++)
    fishGeometry.setAttribute(
      attributeNames[attributeIndex],
      instanceAttributes[attributeIndex],
    );
  fishGeometry.setAttribute("shade", geometry.getAttribute("shade"));
  const fishMaterial = new THREE.ShaderMaterial({
    vertexShader: fishVertexShader,
    fragmentShader: fishFragmentShader,
    vertexColors: true,
    side: THREE.DoubleSide,
    uniforms: {
      // Reuse the same view uniforms, so resize applies consistently to both modes.
      ...material.uniforms,
      swimPalette: { value: fishAsset.animationTexture },
      swimTime: { value: 0 },
    },
  });
  const chart = document.querySelector("#frame-chart");
  const ids = [
    "population-value",
    "population",
    "auto-scale",
    "scale-description",
    "performance-status",
    "fps-value",
    "frame-value",
    "cpu-value",
    "draw-value",
    "memory-value",
    "pointer-x",
    "pointer-y",
    "pointer-ring",
    "pause",
    "pause-overlay",
    "scene-name",
  ];
  const ui = {}; // DOM references are cached once, outside the frame loop.
  for (const id of ids) ui[id] = document.getElementById(id);
  // Report simulation typed-array storage only, excluding GPU and browser allocations.
  let poolBytes = 0;
  for (const value of Object.values(gameData))
    if (ArrayBuffer.isView(value)) poolBytes += value.byteLength;
  ui["memory-value"].textContent = `${(poolBytes / 1048576).toFixed(1)} MiB`;
  const board = {
    renderer,
    canvas,
    camera,
    scene,
    geometry,
    material,
    mesh,
    triangleGeometry: geometry,
    triangleMaterial: material,
    fishGeometry,
    fishMaterial,
    fishAsset,
    fishInspector: createFishInspector(fishAsset),
    appearance: "triangles",
    animationTime: 0,
    instanceAttributes,
    attributeUpdateRanges,
    chart,
    chartContext: chart.getContext("2d"),
    ui,
    width: 0,
    height: 0,
    viewWidth: balance.width,
    viewHeight: balance.height,
    // Presentation flags and caches do not belong in an individual agent's state.
    contextLost: false,
    lastCount: -1,
    lastStatus: "",
    pauseMarkup: ui.pause.innerHTML,
  };
  attachInput(board, gameData, balance, performanceData);
  // Install one resize callback; viewport changes rebuild the view, not the agent pool.
  const observer = new ResizeObserver(() => resize(board, balance, performanceData));
  observer.observe(canvas.parentElement);
  resize(board, balance, performanceData);
  refreshControls(board, gameData, balance);
  return board;
}

/**
 * Select shared geometry/material without recreating agents or changing their motion.
 * Both modes reference the same instance arrays. Automatic mode restarts at a modest
 * count when entering the heavier fish renderer, then measures the new workload.
 * Manual mode preserves the exact user-selected population for direct comparison.
 */
export function setAppearance(board, gameData, balance, performanceData, appearance) {
  const fishMode = appearance === "fish";
  board.appearance = appearance;
  board.geometry = fishMode ? board.fishGeometry : board.triangleGeometry;
  board.material = fishMode ? board.fishMaterial : board.triangleMaterial;
  board.mesh.geometry = board.geometry;
  board.mesh.material = board.material;
  if (fishMode && gameData.autoScale)
    Logic.setPopulation(
      gameData,
      balance,
      Math.min(gameData.agentCount, balance.initialCount),
    );
  // Expose selection in both visual and accessible state; no per-agent flags are needed.
  for (const button of document.querySelectorAll(".appearance-mode")) {
    const selected = button.dataset.appearance === appearance;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", selected);
  }
  document.getElementById("appearance-description").textContent = fishMode
    ? "Animated 3D mesh · 5-bone skeleton."
    : "Two triangles per agent.";
  document.getElementById("inspect-fish").hidden = !fishMode;
  resetTuning(performanceData, balance);
  refreshControls(board, gameData, balance);
  updateStats(board, gameData, balance, performanceData);
}

/**
 * Fit the unchanged simulation world into the current canvas and resize the chart.
 * Cap canvas pixel density to limit fragment work on dense mobile/desktop displays.
 * Camera bounds and a shared size uniform adapt the view without rescaling every
 * agent's coordinates. Restart tuning because the rendering workload has changed.
 */
function resize(board, balance, performanceData) {
  const width = board.canvas.clientWidth,
    height = board.canvas.clientHeight;
  board.width = width;
  board.height = height;
  board.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  board.renderer.setSize(width, height, false);
  // Preserve world aspect ratio with a small margin; extra space appears on one axis.
  const scale = Math.max(balance.width / width, balance.height / height) * 1.08;
  board.viewWidth = width * scale;
  board.viewHeight = height * scale;
  board.camera.left = -board.viewWidth / 2;
  board.camera.right = board.viewWidth / 2;
  board.camera.top = board.viewHeight / 2;
  board.camera.bottom = -board.viewHeight / 2;
  // Camera property changes take effect after rebuilding its projection matrix.
  board.camera.updateProjectionMatrix();
  // Preserve visibility on a small display without raising pixel density.
  board.material.uniforms.pointScale.value = Math.max(0.8, scale * 0.64);
  // The small 2D chart uses its own density cap to keep thin lines readable.
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  board.chart.width = board.chart.clientWidth * pixelRatio;
  board.chart.height = board.chart.clientHeight * pixelRatio;
  resetTuning(performanceData, balance);
}

/**
 * Color the filled portion of a range input using its normalized value.
 * This is presentation work for control/stat updates, outside the agent loops.
 */
function paintRange(input) {
  input.style.setProperty(
    "--fill",
    `${((input.value - input.min) / (input.max - input.min)) * 100}%`,
  );
}

/**
 * Map a population into the slider's 0–1000 range on a logarithmic scale.
 * Equal slider distances represent equal ratios, preserving control over small
 * flocks as well as larger ones without changing the simulation's integer count.
 */
function populationToSlider(count, balance) {
  return (
    (Math.log(count / balance.minCount) / Math.log(balance.capacity / balance.minCount)) *
    1000
  );
}

/**
 * Invert the logarithmic slider mapping and round to a hundred agents for display.
 * setPopulation applies the final pool bounds and initializes newly active slots.
 */
function sliderToPopulation(value, balance) {
  return (
    Math.round(
      (balance.minCount * (balance.capacity / balance.minCount) ** (value / 1000)) / 100,
    ) * 100
  );
}

/**
 * Reflect the current simulation settings in the existing controls and preset labels.
 * Called at startup or on interaction, this may query DOM nodes and build strings.
 * Keeping it out of the per-agent loop separates UI costs from numerical transforms.
 */
export function refreshControls(board, gameData, balance) {
  board.ui["auto-scale"].checked = gameData.autoScale;
  board.ui.population.value = populationToSlider(gameData.agentCount, balance);
  board.ui["population-value"].textContent = gameData.agentCount.toLocaleString("en-US");
  board.lastCount = gameData.agentCount;
  paintRange(board.ui.population);
  // Shared scalar settings drive four controls, regardless of the flock's population.
  for (const key of ["separation", "alignment", "cohesion", "speed"]) {
    const input = document.getElementById(key);
    input.value = gameData[key];
    document.getElementById(`${key}-value`).textContent =
      key === "speed"
        ? `${gameData[key].toFixed(2).replace(/0$/, "")}×`
        : gameData[key].toFixed(1);
    paintRange(input);
  }
  // Update both the visual highlight and accessible selection state for each preset.
  document.querySelectorAll(".preset").forEach((button, presetIndex) => {
    button.classList.toggle("active", presetIndex === gameData.presetIndex);
    button.setAttribute("aria-pressed", presetIndex === gameData.presetIndex);
  });
  board.ui["scene-name"].textContent = presets[gameData.presetIndex].name;
}

/**
 * Register browser handlers once, translating interaction into logic calls or input.
 * Simulation functions never need events or DOM references; pointer coordinates are
 * staged as plain numbers for the next tick. These callbacks are not per-agent work.
 */
function attachInput(board, gameData, balance, performanceData) {
  const ui = board.ui;
  for (const button of document.querySelectorAll(".appearance-mode")) {
    // A mode click changes the rendering workload while preserving the simulation pool.
    button.addEventListener("click", () => {
      setAppearance(board, gameData, balance, performanceData, button.dataset.appearance);
    });
  }
  // A mode change starts a fresh measurement window for automatic population tuning.
  ui["auto-scale"].addEventListener("change", () => {
    Logic.setParameter(gameData, "autoScale", ui["auto-scale"].checked);
    resetTuning(performanceData, balance);
    updateStats(board, gameData, balance, performanceData);
  });
  // Manual population input takes control from the tuner and changes the live prefix.
  ui.population.addEventListener("input", () => {
    Logic.setParameter(gameData, "autoScale", false);
    Logic.setPopulation(
      gameData,
      balance,
      sliderToPopulation(Number(ui.population.value), balance),
    );
    refreshControls(board, gameData, balance);
    updateStats(board, gameData, balance, performanceData);
  });
  // "Find my limit" enables adaptation and forgets any ceiling learned previously.
  document.querySelector("#maximize").addEventListener("click", () => {
    Logic.setParameter(gameData, "autoScale", true);
    resetTuning(performanceData, balance);
    refreshControls(board, gameData, balance);
    updateStats(board, gameData, balance, performanceData);
  });
  // Visit preset controls once at startup to attach their click handlers.
  document.querySelectorAll(".preset").forEach((button) =>
    // Select shared steering weights and retune for the resulting motion/workload.
    button.addEventListener("click", () => {
      Logic.setPreset(gameData, Number(button.dataset.preset));
      resetTuning(performanceData, balance);
      refreshControls(board, gameData, balance);
    }),
  );
  for (const key of ["separation", "alignment", "cohesion", "speed"]) {
    // Capture this control's key once; changing it updates one shared state scalar.
    document.getElementById(key).addEventListener("input", (event) => {
      Logic.setParameter(gameData, key, Number(event.target.value));
      refreshControls(board, gameData, balance);
    });
  }
  // Register mode controls once; the selected sign is later read by steering logic.
  document.querySelectorAll(".pointer-mode").forEach((button) =>
    // Translate a mode click into the force sign and synchronize its visible labels.
    button.addEventListener("click", () => {
      Logic.setParameter(gameData, "pointerMode", Number(button.dataset.mode));
      // Mark exactly the selected mode for both visual styling and assistive technology.
      document.querySelectorAll(".pointer-mode").forEach((item) => {
        const selected = Number(item.dataset.mode) === gameData.pointerMode;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-pressed", selected);
      });
      ui["pointer-ring"].firstElementChild.textContent =
        gameData.pointerMode === -1 ? "REPEL" : "ATTRACT";
    }),
  );

  /**
   * Toggle motion and synchronize the pause button, overlay, and measurement state.
   * The flock's arrays stay intact so a paused frame can still be drawn and inspected.
   */
  function pause() {
    Logic.togglePause(gameData);
    ui.pause.innerHTML = gameData.paused
      ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 4 10 6-10 6Z" fill="currentColor"/></svg>'
      : board.pauseMarkup;
    ui.pause.setAttribute(
      "aria-label",
      gameData.paused ? "Resume simulation" : "Pause simulation",
    );
    ui.pause.title = gameData.paused ? "Resume (Space)" : "Pause (Space)";
    ui["pause-overlay"].hidden = !gameData.paused;
    ui["pointer-ring"].hidden = true;
    resetTuning(performanceData, balance);
    updateStats(board, gameData, balance, performanceData);
  }

  /**
   * Reinitialize the active agents in their existing slots and restart tuning.
   * No renderer resources need rebuilding because the buffer references are unchanged.
   */
  function reset() {
    Logic.reseed(gameData, balance);
    board.animationTime = 0;
    resetTuning(performanceData, balance);
  }
  const fullscreenButton = document.getElementById("fullscreen");

  /**
   * Toggle the browser's fullscreen mode in response to a user gesture.
   * This asynchronous presentation action stays outside synchronous simulation logic;
   * the resize observer handles any resulting change in the canvas dimensions.
   */
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      fullscreenButton.title = "Fullscreen is unavailable in this browser";
    }
  }
  if (!document.fullscreenEnabled) {
    fullscreenButton.hidden = true;
  }
  ui.pause.addEventListener("click", pause);
  document.getElementById("reset").addEventListener("click", reset);
  fullscreenButton.addEventListener("click", fullscreen);
  // Fullscreen can also end via Escape, so derive the accessible label from the browser.
  document.addEventListener("fullscreenchange", () => {
    fullscreenButton.setAttribute(
      "aria-label",
      document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen",
    );
  });
  const about = document.getElementById("about");
  // Open the existing dialog; its content is created in HTML rather than per frame.
  document
    .getElementById("about-open")
    .addEventListener("click", () => about.showModal());
  // Close the dialog without removing its DOM or rebuilding its code examples.
  document.getElementById("about-close").addEventListener("click", () => about.close());
  // A click outside the dialog's bounds dismisses the backdrop; content clicks do not.
  about.addEventListener("click", (event) => {
    if (
      event.target === about &&
      (event.clientX < about.getBoundingClientRect().left ||
        event.clientX > about.getBoundingClientRect().right ||
        event.clientY < about.getBoundingClientRect().top ||
        event.clientY > about.getBoundingClientRect().bottom)
    )
      about.close();
  });
  // Keyboard shortcuts share the button actions, excluding text entry and modal use.
  document.addEventListener("keydown", (event) => {
    if (
      event.target.matches("input, button, a, select, textarea") ||
      about.open ||
      board.fishInspector.dialog.open ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.repeat
    )
      return;
    if (event.code === "Space") {
      event.preventDefault();
      pause();
    }
    if (event.code === "KeyR") reset();
    if (event.code === "KeyF") fullscreen();
  });

  /**
   * Convert pointer pixels into the camera's world coordinates and position the marker.
   * The Y axis flips between DOM pixels and the simulation. Staging these numbers is
   * the input exception to Board's read-only access to simulation state; tick applies
   * the actual force later, without reading the DOM or creating a vector object.
   */
  function pointer(event) {
    const rect = board.canvas.getBoundingClientRect();
    // Normalize within the canvas, accounting for its offset on the page.
    const normalizedX = (event.clientX - rect.left) / rect.width;
    const normalizedY = (event.clientY - rect.top) / rect.height;
    // Camera extents may include margins, so use viewWidth/viewHeight, not only bounds.
    gameData.pointerX = (normalizedX - 0.5) * board.viewWidth + balance.width / 2;
    gameData.pointerY = (0.5 - normalizedY) * board.viewHeight + balance.height / 2;
    // Display coordinates and marker pixels are UI concerns, separate from world input.
    ui["pointer-x"].textContent = (normalizedX * 2 - 1).toFixed(2);
    ui["pointer-y"].textContent = (1 - normalizedY * 2).toFixed(2);
    ui["pointer-ring"].style.left = `${event.clientX - rect.left}px`;
    ui["pointer-ring"].style.top = `${event.clientY - rect.top}px`;
  }
  // Capture the primary pointer so releasing outside the canvas still ends the gesture.
  board.canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    pointer(event);
    gameData.pointerActive = !gameData.paused;
    board.canvas.setPointerCapture(event.pointerId);
    ui["pointer-ring"].hidden = gameData.paused;
  });
  board.canvas.addEventListener("pointermove", pointer);

  /**
   * End a gesture on release, cancellation, lost capture, or window blur.
   * Clear one shared activation flag instead of walking the agents to remove forces.
   */
  function release() {
    gameData.pointerActive = false;
    ui["pointer-ring"].hidden = true;
  }
  board.canvas.addEventListener("pointerup", release);
  board.canvas.addEventListener("pointercancel", release);
  board.canvas.addEventListener("lostpointercapture", release);
  window.addEventListener("blur", release);
  // Allow context recovery and suspend rendering; preserve CPU state for restoration.
  board.canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    board.contextLost = true;
    showError(
      "The graphics context was interrupted. The flock will resume when the browser restores it, or you can reload.",
    );
  });
  // Three.js restores its GPU resources; resume using the same simulation arrays.
  board.canvas.addEventListener("webglcontextrestored", () => {
    board.contextLost = false;
    document.querySelector("#canvas-error").hidden = true;
    resetTuning(performanceData, balance);
  });
}

/**
 * Gate the simulation tick on one shared pause flag before visiting any agents.
 * Board calls Logic, while Logic remains independent of presentation and timing APIs.
 */
export function step(board, gameData, balance, deltaSeconds) {
  if (!gameData.paused) {
    Logic.tick(gameData, balance, deltaSeconds);
    // Cosmetic skinning follows simulation speed and freezes with the pause control.
    board.animationTime += deltaSeconds * gameData.speed;
  }
}

/**
 * Submit the flock as one instanced mesh using the current live array prefix.
 * Mark the four changing attributes for upload, reusing their range records.
 * After the initial buffer upload, ranges limit transfers to active slots; static
 * shade values need no per-frame update. There is no CPU matrix/packing pass per agent.
 */
export function render(board, gameData) {
  board.geometry.instanceCount = gameData.agentCount;
  board.fishMaterial.uniforms.swimTime.value = board.animationTime;
  for (let attributeIndex = 0; attributeIndex < 4; attributeIndex++) {
    // Three.js clears this list after upload. Reuse the range record itself.
    board.attributeUpdateRanges[attributeIndex].count = gameData.agentCount;
    board.instanceAttributes[attributeIndex].updateRanges[0] =
      board.attributeUpdateRanges[attributeIndex];
    // Increment the attribute version so Three.js uploads the values before drawing.
    board.instanceAttributes[attributeIndex].needsUpdate = true;
  }
  board.renderer.render(board.scene, board.camera);
}

/**
 * Render the optional model viewer outside the swarm's CPU submission measurement.
 * It uses the same main loop and clock; closed dialogs do no drawing or mixer updates.
 */
export function renderInspector(board) {
  renderFishInspector(board.fishInspector, board.animationTime);
}

/**
 * Refresh measured readouts and the chart, normally four times per second in main.js.
 * Formatting strings and updating DOM are real costs; throttling them keeps that
 * work out of the simulation passes. This UI layer is not claimed allocation-free.
 */
export function updateStats(board, gameData, balance, performanceData) {
  const ui = board.ui;
  // Skip population formatting and slider writes when adaptation has not changed count.
  if (gameData.agentCount !== board.lastCount) {
    ui["population-value"].textContent = gameData.agentCount.toLocaleString("en-US");
    ui.population.value = populationToSlider(gameData.agentCount, balance);
    paintRange(ui.population);
    board.lastCount = gameData.agentCount;
  }
  // User modes take precedence over the adaptive controller's last running status.
  const status = gameData.paused
    ? "PAUSED"
    : !gameData.autoScale
      ? "MANUAL"
      : performanceData.status;
  ui["performance-status"].textContent = status;
  ui["scale-description"].textContent = gameData.paused
    ? "Paused. Take a closer look."
    : !gameData.autoScale
      ? "You’re in control. Slide to set the population."
      : status === "POOL LIMIT"
        ? "At the population limit."
        : status === "DEVICE LIMIT"
          ? "At the minimum population."
          : status === "TUNING"
            ? "Finding your device’s sweet spot."
            : "Adapting the flock to your device.";
  ui["fps-value"].textContent = gameData.paused
    ? "—"
    : Math.round(performanceData.fps).toString();
  ui["frame-value"].innerHTML = gameData.paused
    ? "—<small> ms</small>"
    : `${performanceData.frameMs.toFixed(1)}<small> ms</small>`;
  ui["cpu-value"].textContent = gameData.paused
    ? "— ms"
    : `${performanceData.cpuMs.toFixed(2)} ms`;
  ui["draw-value"].textContent = board.renderer.info.render.calls.toString();
  // Pausing keeps the history still instead of recording idle-loop measurements.
  if (!gameData.paused) sampleHistory(performanceData);
  drawChart(board, balance, performanceData);
}

/**
 * Draw the fixed history buffer without copying it into chronological order.
 * Wrapped indexing reads oldest to newest; unused leading slots leave space until
 * the history fills. The dashed line is a timing target, not a performance claim.
 */
function drawChart(board, balance, performanceData) {
  const context = board.chartContext;
  const width = board.chart.width,
    height = board.chart.height;
  context.clearRect(0, 0, width, height);
  // Map a 0–25 ms scale to canvas coordinates, which increase downward.
  const targetY = height - (balance.targetFrameMs / 25) * height;
  context.strokeStyle = "#52623b";
  context.lineWidth = 1;
  context.setLineDash([3, 5]);
  context.beginPath();
  context.moveTo(0, targetY);
  context.lineTo(width, targetY);
  context.stroke();
  context.setLineDash([]);
  context.strokeStyle = "#b4d878";
  context.lineWidth = 1.4;
  context.beginPath();
  for (let sampleIndex = 0; sampleIndex < performanceData.historyCount; sampleIndex++) {
    // historyIndex points at the next write; subtracting count finds the oldest sample.
    const index =
      (performanceData.historyIndex -
        performanceData.historyCount +
        sampleIndex +
        performanceData.history.length) %
      performanceData.history.length;
    // Right-align partial history so the newest sample always appears at the right edge.
    const x =
      ((sampleIndex + performanceData.history.length - performanceData.historyCount) /
        (performanceData.history.length - 1)) *
      width;
    // Clip chart spikes for readability; the underlying measurement is preserved.
    const y = height - (Math.min(24, performanceData.history[index]) / 25) * height;
    if (sampleIndex === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}

/**
 * Display a renderer/startup error in the existing HTML panel.
 * Keeping error presentation here lets numerical logic stay usable without a browser.
 */
export function showError(message) {
  document.getElementById("canvas-error").hidden = false;
  document.getElementById("error-message").textContent = message;
}
