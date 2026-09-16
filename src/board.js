import * as THREE from "three";
import * as Logic from "./logic.js";
import { presets } from "./balance.js";
import { resetTuning, sampleHistory } from "./performance.js";

const vertexShader = `
attribute float agentPositionX;
attribute float agentPositionY;
attribute float agentVelocityX;
attribute float agentVelocityY;
attribute float shade;
uniform vec2 worldSize;
uniform float pointScale;
varying vec3 flockColor;
varying float flockOpacity;
void main() {
  vec2 direction = normalize(vec2(agentVelocityX, agentVelocityY) + vec2(0.0001));
  vec2 side = vec2(-direction.y, direction.x);
  float size = (0.75 + shade * 0.85) * pointScale;
  vec2 local = (direction * position.x + side * position.y) * size;
  vec2 worldPosition = vec2(agentPositionX, agentPositionY) - worldSize * 0.5 + local;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPosition, 0.0, 1.0);
  vec3 moss = vec3(0.34, 0.48, 0.23);
  vec3 lime = vec3(0.77, 0.89, 0.45);
  vec3 cream = vec3(0.91, 0.94, 0.75);
  flockColor = shade < 0.7 ? mix(moss, lime, shade / 0.7) : mix(lime, cream, (shade - 0.7) / 0.3);
  flockOpacity = 0.38 + shade * 0.55;
}`;
const fragmentShader = `
precision highp float;
varying vec3 flockColor;
varying float flockOpacity;
void main() {
  gl_FragColor = vec4(flockColor, flockOpacity);
}
`;

export function createBoard(gameData, balance, performanceData) {
  const canvas = document.querySelector("#swarm");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x111310, 0);
  const camera = new THREE.OrthographicCamera(
    -balance.width / 2,
    balance.width / 2,
    balance.height / 2,
    -balance.height / 2,
    0.1,
    10,
  );
  camera.position.z = 5;
  const scene = new THREE.Scene();
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
  const attributeUpdateRanges = new Array(4);
  for (let attributeIndex = 0; attributeIndex < 4; attributeIndex++) {
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
  geometry.setAttribute(
    "shade",
    new THREE.InstancedBufferAttribute(gameData.colorVariation, 1),
  );
  geometry.instanceCount = gameData.agentCount;
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      worldSize: { value: new THREE.Vector2(balance.width, balance.height) },
      pointScale: { value: 1 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
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
    instanceAttributes,
    attributeUpdateRanges,
    chart,
    chartContext: chart.getContext("2d"),
    ui,
    width: 0,
    height: 0,
    viewWidth: balance.width,
    viewHeight: balance.height,
    contextLost: false,
    lastCount: -1,
    lastStatus: "",
    pauseMarkup: ui.pause.innerHTML,
  };
  attachInput(board, gameData, balance, performanceData);
  const observer = new ResizeObserver(() => resize(board, balance, performanceData));
  observer.observe(canvas.parentElement);
  resize(board, balance, performanceData);
  refreshControls(board, gameData, balance);
  return board;
}

function resize(board, balance, performanceData) {
  const width = board.canvas.clientWidth,
    height = board.canvas.clientHeight;
  board.width = width;
  board.height = height;
  board.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  board.renderer.setSize(width, height, false);
  const scale = Math.max(balance.width / width, balance.height / height) * 1.08;
  board.viewWidth = width * scale;
  board.viewHeight = height * scale;
  board.camera.left = -board.viewWidth / 2;
  board.camera.right = board.viewWidth / 2;
  board.camera.top = board.viewHeight / 2;
  board.camera.bottom = -board.viewHeight / 2;
  board.camera.updateProjectionMatrix();
  // Preserve visibility on a small display without raising pixel density.
  board.material.uniforms.pointScale.value = Math.max(0.8, scale * 0.64);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  board.chart.width = board.chart.clientWidth * pixelRatio;
  board.chart.height = board.chart.clientHeight * pixelRatio;
  resetTuning(performanceData, balance);
}

function paintRange(input) {
  input.style.setProperty(
    "--fill",
    `${((input.value - input.min) / (input.max - input.min)) * 100}%`,
  );
}

function populationToSlider(count, balance) {
  return (
    (Math.log(count / balance.minCount) / Math.log(balance.capacity / balance.minCount)) *
    1000
  );
}
function sliderToPopulation(value, balance) {
  return (
    Math.round(
      (balance.minCount * (balance.capacity / balance.minCount) ** (value / 1000)) / 100,
    ) * 100
  );
}

export function refreshControls(board, gameData, balance) {
  board.ui["auto-scale"].checked = gameData.autoScale;
  board.ui.population.value = populationToSlider(gameData.agentCount, balance);
  board.ui["population-value"].textContent = gameData.agentCount.toLocaleString("en-US");
  board.lastCount = gameData.agentCount;
  paintRange(board.ui.population);
  for (const key of ["separation", "alignment", "cohesion", "speed"]) {
    const input = document.getElementById(key);
    input.value = gameData[key];
    document.getElementById(`${key}-value`).textContent =
      key === "speed"
        ? `${gameData[key].toFixed(2).replace(/0$/, "")}×`
        : gameData[key].toFixed(1);
    paintRange(input);
  }
  document.querySelectorAll(".preset").forEach((button, presetIndex) => {
    button.classList.toggle("active", presetIndex === gameData.presetIndex);
    button.setAttribute("aria-pressed", presetIndex === gameData.presetIndex);
  });
  board.ui["scene-name"].textContent = presets[gameData.presetIndex].name;
}

function attachInput(board, gameData, balance, performanceData) {
  const ui = board.ui;
  ui["auto-scale"].addEventListener("change", () => {
    Logic.setParameter(gameData, "autoScale", ui["auto-scale"].checked);
    resetTuning(performanceData, balance);
    updateStats(board, gameData, balance, performanceData);
  });
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
  document.querySelector("#maximize").addEventListener("click", () => {
    Logic.setParameter(gameData, "autoScale", true);
    resetTuning(performanceData, balance);
    refreshControls(board, gameData, balance);
    updateStats(board, gameData, balance, performanceData);
  });
  document.querySelectorAll(".preset").forEach((button) =>
    button.addEventListener("click", () => {
      Logic.setPreset(gameData, Number(button.dataset.preset));
      resetTuning(performanceData, balance);
      refreshControls(board, gameData, balance);
    }),
  );
  for (const key of ["separation", "alignment", "cohesion", "speed"]) {
    document.getElementById(key).addEventListener("input", (event) => {
      Logic.setParameter(gameData, key, Number(event.target.value));
      refreshControls(board, gameData, balance);
    });
  }
  document.querySelectorAll(".pointer-mode").forEach((button) =>
    button.addEventListener("click", () => {
      Logic.setParameter(gameData, "pointerMode", Number(button.dataset.mode));
      document.querySelectorAll(".pointer-mode").forEach((item) => {
        const selected = Number(item.dataset.mode) === gameData.pointerMode;
        item.classList.toggle("active", selected);
        item.setAttribute("aria-pressed", selected);
      });
      ui["pointer-ring"].firstElementChild.textContent =
        gameData.pointerMode === -1 ? "REPEL" : "ATTRACT";
    }),
  );
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
  function reset() {
    Logic.reseed(gameData, balance);
    resetTuning(performanceData, balance);
  }
  const fullscreenButton = document.getElementById("fullscreen");
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
  document.addEventListener("fullscreenchange", () => {
    fullscreenButton.setAttribute(
      "aria-label",
      document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen",
    );
  });
  const about = document.getElementById("about");
  document
    .getElementById("about-open")
    .addEventListener("click", () => about.showModal());
  document.getElementById("about-close").addEventListener("click", () => about.close());
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
  document.addEventListener("keydown", (event) => {
    if (
      event.target.matches("input, button, a, select, textarea") ||
      about.open ||
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
  function pointer(event) {
    const rect = board.canvas.getBoundingClientRect();
    const normalizedX = (event.clientX - rect.left) / rect.width;
    const normalizedY = (event.clientY - rect.top) / rect.height;
    gameData.pointerX = (normalizedX - 0.5) * board.viewWidth + balance.width / 2;
    gameData.pointerY = (0.5 - normalizedY) * board.viewHeight + balance.height / 2;
    ui["pointer-x"].textContent = (normalizedX * 2 - 1).toFixed(2);
    ui["pointer-y"].textContent = (1 - normalizedY * 2).toFixed(2);
    ui["pointer-ring"].style.left = `${event.clientX - rect.left}px`;
    ui["pointer-ring"].style.top = `${event.clientY - rect.top}px`;
  }
  board.canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    pointer(event);
    gameData.pointerActive = !gameData.paused;
    board.canvas.setPointerCapture(event.pointerId);
    ui["pointer-ring"].hidden = gameData.paused;
  });
  board.canvas.addEventListener("pointermove", pointer);
  function release() {
    gameData.pointerActive = false;
    ui["pointer-ring"].hidden = true;
  }
  board.canvas.addEventListener("pointerup", release);
  board.canvas.addEventListener("pointercancel", release);
  board.canvas.addEventListener("lostpointercapture", release);
  window.addEventListener("blur", release);
  board.canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    board.contextLost = true;
    showError(
      "The graphics context was interrupted. The flock will resume when the browser restores it, or you can reload.",
    );
  });
  board.canvas.addEventListener("webglcontextrestored", () => {
    board.contextLost = false;
    document.querySelector("#canvas-error").hidden = true;
    resetTuning(performanceData, balance);
  });
}

export function step(board, gameData, balance, deltaSeconds) {
  if (!gameData.paused) Logic.tick(gameData, balance, deltaSeconds);
}

// The flock is a single mesh; the instance count selects the live array prefix.
export function render(board, gameData) {
  board.geometry.instanceCount = gameData.agentCount;
  for (let attributeIndex = 0; attributeIndex < 4; attributeIndex++) {
    // Three.js clears this list after upload. Reuse the range record itself.
    board.attributeUpdateRanges[attributeIndex].count = gameData.agentCount;
    board.instanceAttributes[attributeIndex].updateRanges[0] =
      board.attributeUpdateRanges[attributeIndex];
    board.instanceAttributes[attributeIndex].needsUpdate = true;
  }
  board.renderer.render(board.scene, board.camera);
}

export function updateStats(board, gameData, balance, performanceData) {
  const ui = board.ui;
  if (gameData.agentCount !== board.lastCount) {
    ui["population-value"].textContent = gameData.agentCount.toLocaleString("en-US");
    ui.population.value = populationToSlider(gameData.agentCount, balance);
    paintRange(ui.population);
    board.lastCount = gameData.agentCount;
  }
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
  if (!gameData.paused) sampleHistory(performanceData);
  drawChart(board, balance, performanceData);
}

function drawChart(board, balance, performanceData) {
  const context = board.chartContext;
  const width = board.chart.width,
    height = board.chart.height;
  context.clearRect(0, 0, width, height);
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
    const index =
      (performanceData.historyIndex -
        performanceData.historyCount +
        sampleIndex +
        performanceData.history.length) %
      performanceData.history.length;
    const x =
      ((sampleIndex + performanceData.history.length - performanceData.historyCount) /
        (performanceData.history.length - 1)) *
      width;
    const y = height - (Math.min(24, performanceData.history[index]) / 25) * height;
    if (sampleIndex === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}

export function showError(message) {
  document.getElementById("canvas-error").hidden = false;
  document.getElementById("error-message").textContent = message;
}
