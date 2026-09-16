import * as THREE from "three";

/**
 * Wire the optional close-up viewer without starting a second animation loop.
 * The crowd and inspector share the authored fish asset. A separate renderer is
 * allocated only on first inspection; closed inspectors do no rendering work.
 */
export function createFishInspector(asset) {
  const dialog = document.getElementById("fish-inspector");
  const canvas = document.getElementById("fish-model");
  const inspector = {
    dialog,
    canvas,
    asset,
    renderer: null,
    scene: null,
    camera: null,
    group: null,
    skeletonHelper: null,
    jointMarkers: [],
    width: 0,
    height: 0,
    dragging: false,
    pointerX: 0,
    pointerY: 0,
    rotationX: 0.2,
    rotationY: -0.35,
    contextLost: false,
  };
  // Show the existing modal and allocate its GPU resources only when first requested.
  document.getElementById("inspect-fish").addEventListener("click", () => {
    dialog.showModal();
    if (!inspector.renderer) initializeInspector(inspector);
  });
  // Closing hides the model without destroying the reusable renderer or rig.
  document.getElementById("fish-close").addEventListener("click", () => dialog.close());
  // Skeleton lines are an inspector aid; they never add crowd geometry or draw calls.
  document.getElementById("fish-bones").addEventListener("change", (event) => {
    inspector.skeletonHelper.visible = event.target.checked;
    for (const marker of inspector.jointMarkers) marker.visible = event.target.checked;
  });
  // Capture drag intent as a few numbers, leaving all rendering in the main frame loop.
  canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary) return;
    inspector.dragging = true;
    inspector.pointerX = event.clientX;
    inspector.pointerY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  // Orbit the model to show that the fish has depth and a weighted three-dimensional mesh.
  canvas.addEventListener("pointermove", (event) => {
    if (!inspector.dragging) return;
    inspector.rotationY += (event.clientX - inspector.pointerX) * 0.01;
    inspector.rotationX = THREE.MathUtils.clamp(
      inspector.rotationX + (event.clientY - inspector.pointerY) * 0.01,
      -1.3,
      1.3,
    );
    inspector.pointerX = event.clientX;
    inspector.pointerY = event.clientY;
  });

  /** Clear drag state on all gesture endings, including dismissing the modal. */
  function release() {
    inspector.dragging = false;
  }
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("lostpointercapture", release);
  dialog.addEventListener("close", release);
  // Preserve the asset if the optional inspector's WebGL context is interrupted.
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    inspector.contextLost = true;
  });
  // Three.js restores the viewer resources independently of the swarm's renderer.
  canvas.addEventListener("webglcontextrestored", () => {
    inspector.contextLost = false;
  });
  return inspector;
}

/**
 * Allocate a conventional lit SkinnedMesh scene to inspect the same rig used in baking.
 * The bone helper draws through the surface so all five joints remain easy to follow.
 * This scene is only for inspection; the school uses its separate instanced shader.
 */
function initializeInspector(inspector) {
  inspector.renderer = new THREE.WebGLRenderer({
    canvas: inspector.canvas,
    antialias: true,
  });
  inspector.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  inspector.renderer.setClearColor(0x111c19);
  inspector.scene = new THREE.Scene();
  inspector.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
  inspector.camera.position.set(0, 0.3, 10);
  inspector.camera.lookAt(0, 0, 0);
  inspector.group = new THREE.Group();
  inspector.group.add(inspector.asset.mesh);
  inspector.scene.add(inspector.group);
  inspector.scene.add(new THREE.HemisphereLight(0xd9f8ef, 0x263322, 2.3));
  const light = new THREE.DirectionalLight(0xfff1ce, 3);
  light.position.set(2, 4, 5);
  inspector.scene.add(light);
  inspector.skeletonHelper = new THREE.SkeletonHelper(inspector.asset.mesh);
  inspector.skeletonHelper.material.depthTest = false;
  inspector.skeletonHelper.material.transparent = true;
  inspector.skeletonHelper.setColors(
    new THREE.Color(0xe8ffc1),
    new THREE.Color(0x8be7c2),
  );
  inspector.skeletonHelper.renderOrder = 10;
  inspector.skeletonHelper.visible = document.getElementById("fish-bones").checked;
  inspector.scene.add(inspector.skeletonHelper);
  // Small joint markers make the actual bone chain readable, including its endpoints.
  const jointGeometry = new THREE.SphereGeometry(0.06, 8, 6);
  const jointMaterial = new THREE.MeshBasicMaterial({
    color: 0xe7ffb1,
    depthTest: false,
  });
  for (const bone of inspector.asset.skeleton.bones) {
    const marker = new THREE.Mesh(jointGeometry, jointMaterial);
    marker.renderOrder = 11;
    marker.visible = inspector.skeletonHelper.visible;
    bone.add(marker);
    inspector.jointMarkers.push(marker);
  }
}

/**
 * Draw the optional viewer using the simulation's pause-aware animation clock.
 * A standard AnimationMixer drives the actual bones here. The crowd instead samples
 * the same clip's precomputed palette, so inspector work does not scale with population.
 */
export function renderFishInspector(inspector, animationTime) {
  if (inspector.dialog.open && inspector.renderer && !inspector.contextLost) {
    const width = inspector.canvas.clientWidth;
    const height = inspector.canvas.clientHeight;
    if (width !== inspector.width || height !== inspector.height) {
      inspector.width = width;
      inspector.height = height;
      inspector.renderer.setSize(width, height, false);
      inspector.camera.aspect = width / height;
      // Keep the whole fish in frame on narrow phone displays too.
      inspector.camera.position.z = Math.max(8.5, 10.5 / inspector.camera.aspect);
      inspector.camera.updateProjectionMatrix();
    }
    inspector.asset.mixer.setTime(animationTime * 1.4);
    inspector.group.rotation.set(inspector.rotationX, inspector.rotationY, 0);
    inspector.renderer.render(inspector.scene, inspector.camera);
  }
}
