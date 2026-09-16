import * as THREE from "three";

// One authored rig is shared by the whole school. All allocations in this module
// happen at startup; the crowd reads the baked bone palette in its vertex shader.
export const fishSettings = Object.freeze({
  bonePositions: Object.freeze([1.2, 0.35, -0.6, -1.5, -2.05]),
  frameCount: 64,
  cycleSeconds: 1,
});

/**
 * Build a small, volumetric fish with body rings, fins, eyes, and skinning attributes.
 * Every vertex has up to two bone influences, blended by its position along the spine.
 * Temporary authoring lists are allowed here: the final geometry is stored in typed
 * buffers and reused by both the close-up SkinnedMesh and the instanced crowd.
 */
function createFishGeometry() {
  const positions = [];
  const colors = [];
  const indices = [];
  const skinIndices = [];
  const skinWeights = [];
  const bonePositions = fishSettings.bonePositions;

  /**
   * Append an authored vertex and assign normalized weights to adjacent spine bones.
   * The head follows the first bone; vertices beyond the tail joint follow the last.
   */
  function vertex(x, y, z, red, green, blue) {
    const vertexIndex = positions.length / 3;
    positions.push(x, y, z);
    colors.push(red, green, blue);
    let firstBone = 0;
    while (firstBone < bonePositions.length - 2 && x < bonePositions[firstBone + 1])
      firstBone++;
    const blend = THREE.MathUtils.clamp(
      (bonePositions[firstBone] - x) /
        (bonePositions[firstBone] - bonePositions[firstBone + 1]),
      0,
      1,
    );
    skinIndices.push(firstBone, firstBone + 1, 0, 0);
    skinWeights.push(1 - blend, blend, 0, 0);
    return vertexIndex;
  }

  // Elliptical cross-sections give the body real depth, with a tapered snout and tail.
  const rings = [
    [1.85, 0.1],
    [1.5, 0.43],
    [0.8, 0.66],
    [0, 0.7],
    [-0.85, 0.49],
    [-1.55, 0.2],
    [-1.95, 0.09],
  ];
  const radialSegments = 8;
  for (const [x, radius] of rings) {
    for (let segment = 0; segment < radialSegments; segment++) {
      const angle = (segment / radialSegments) * Math.PI * 2;
      const y = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius * 0.6;
      // A dark teal back, silver belly, and bright lateral stripe read at small sizes.
      const belly = (1 - Math.cos(angle)) * 0.5;
      const stripe = Math.abs(Math.cos(angle)) < 0.1 ? 0.2 : 0;
      vertex(
        x,
        y,
        z,
        0.13 + belly * 0.48 + stripe,
        0.42 + belly * 0.39 + stripe,
        0.38 + belly * 0.31 + stripe,
      );
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let segment = 0; segment < radialSegments; segment++) {
      const first = ring * radialSegments + segment;
      const next = ring * radialSegments + ((segment + 1) % radialSegments);
      indices.push(
        first,
        first + radialSegments,
        next,
        next,
        first + radialSegments,
        next + radialSegments,
      );
    }
  }
  // Close both ends instead of leaving an open tube visible in the model inspector.
  const nose = vertex(1.94, 0, 0, 0.48, 0.7, 0.58);
  const tail = vertex(-1.98, 0, 0, 0.2, 0.55, 0.47);
  for (let segment = 0; segment < radialSegments; segment++) {
    const next = (segment + 1) % radialSegments;
    indices.push(nose, segment, next);
    const lastRing = (rings.length - 1) * radialSegments;
    indices.push(tail, lastRing + next, lastRing + segment);
  }

  /**
   * Add a thin fin with its own vertices so body normals remain smoothly rounded.
   * Fins use the same spine weights and material, requiring no extra crowd draw call.
   */
  function fin(first, second, third) {
    const firstIndex = vertex(...first, 0.62, 0.76, 0.32);
    const secondIndex = vertex(...second, 0.37, 0.61, 0.31);
    const thirdIndex = vertex(...third, 0.52, 0.71, 0.36);
    indices.push(firstIndex, secondIndex, thirdIndex);
  }

  // The forked tail follows the last spine joint. Dorsal and belly fins define the profile.
  fin([-1.85, 0, 0], [-3.05, 1.02, 0], [-2.7, 0, 0.025]);
  fin([-1.85, 0, 0], [-2.7, 0, 0.025], [-3.05, -1.02, 0]);
  fin([0.55, 0.57, 0], [-0.45, 1.2, 0], [-0.95, 0.4, 0]);
  fin([-0.4, -0.58, 0], [-1.2, -0.94, 0], [-1.3, -0.28, 0]);
  fin([0.55, -0.12, 0.34], [-0.45, -0.68, 0.83], [-0.15, -0.26, 0.37]);
  fin([0.55, -0.12, -0.34], [-0.15, -0.26, -0.37], [-0.45, -0.68, -0.83]);

  // Small raised eye disks on both sides distinguish head from tail even at a distance.
  for (const side of [-1, 1]) {
    const center = vertex(1.35, 0.16, side * 0.285, 0.018, 0.027, 0.022);
    for (let segment = 0; segment < 8; segment++) {
      const angle = (segment / 8) * Math.PI * 2;
      vertex(
        1.35 + Math.cos(angle) * 0.12,
        0.16 + Math.sin(angle) * 0.12,
        side * 0.29,
        0.025,
        0.035,
        0.026,
      );
    }
    for (let segment = 0; segment < 8; segment++)
      indices.push(center, center + 1 + segment, center + 1 + ((segment + 1) % 8));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Author a looping swim clip with increasing, delayed rotation down a real bone chain.
 * Quaternion tracks animate the spine laterally around local Y, just as a loaded rig
 * would. The same clip drives the inspector and supplies poses for the crowd bake.
 */
function createSwimClip(bones) {
  const tracks = [];
  const axis = new THREE.Vector3(0, 1, 0);
  const rotation = new THREE.Quaternion();
  const amplitudes = [0.035, 0.09, 0.2, 0.35, 0.45];
  for (let boneIndex = 0; boneIndex < bones.length; boneIndex++) {
    const times = [];
    const values = [];
    for (let key = 0; key <= 32; key++) {
      const time = key / 32;
      const angle =
        Math.sin(time * Math.PI * 2 - boneIndex * 0.7) * amplitudes[boneIndex];
      times.push(time * fishSettings.cycleSeconds);
      rotation.setFromAxisAngle(axis, angle).toArray(values, values.length);
    }
    tracks.push(
      new THREE.QuaternionKeyframeTrack(
        `${bones[boneIndex].name}.quaternion`,
        times,
        values,
      ),
    );
  }
  return new THREE.AnimationClip("Swim", fishSettings.cycleSeconds, tracks);
}

/**
 * Create one conventional SkinnedMesh, bind its five-bone skeleton, and bake its clip.
 * Each animation-texture row stores a pose's bone matrices (four RGBA texels per bone).
 * The crowd samples this shared palette instead of updating a skeleton per agent.
 * Keeping the authoring rig also lets readers inspect real skinning up close.
 */
export function createFishAsset() {
  const geometry = createFishGeometry();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.46,
    metalness: 0.12,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const bones = [];
  for (let boneIndex = 0; boneIndex < fishSettings.bonePositions.length; boneIndex++) {
    const bone = new THREE.Bone();
    bone.name = `spine_${boneIndex}`;
    bone.position.x =
      boneIndex === 0
        ? fishSettings.bonePositions[0]
        : fishSettings.bonePositions[boneIndex] -
          fishSettings.bonePositions[boneIndex - 1];
    if (boneIndex === 0) mesh.add(bone);
    else bones[boneIndex - 1].add(bone);
    bones.push(bone);
  }
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.frustumCulled = false;
  const clip = createSwimClip(bones);
  const mixer = new THREE.AnimationMixer(mesh);
  mixer.clipAction(clip).play();
  const floatsPerPose = bones.length * 16;
  const animationData = new Float32Array(fishSettings.frameCount * floatsPerPose);
  for (let frame = 0; frame < fishSettings.frameCount; frame++) {
    mixer.setTime((frame / fishSettings.frameCount) * clip.duration);
    mesh.updateMatrixWorld(true);
    skeleton.update();
    animationData.set(skeleton.boneMatrices, frame * floatsPerPose);
  }
  const animationTexture = new THREE.DataTexture(
    animationData,
    bones.length * 4,
    fishSettings.frameCount,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  animationTexture.needsUpdate = true;
  mixer.setTime(0);
  return {
    mesh,
    skeleton,
    clip,
    mixer,
    animationTexture,
    geometry,
    triangleCount: geometry.index.count / 3,
  };
}

// This shader performs linear blend skinning with the authored skinIndex/skinWeight
// attributes. Bone transforms include inverse-bind matrices from the real skeleton.
export const fishVertexShader = `
attribute float agentPositionX;
attribute float agentPositionY;
attribute float agentVelocityX;
attribute float agentVelocityY;
attribute float shade;
attribute vec4 skinIndex;
attribute vec4 skinWeight;
uniform sampler2D swimPalette;
uniform vec2 worldSize;
uniform float pointScale;
uniform float swimTime;
varying vec3 fishColor;
varying vec3 fishNormal;

// Read one skinning matrix from the shared pose table using exact texel addresses.
mat4 boneMatrix(float boneIndex, float frameIndex) {
  int column = int(boneIndex) * 4;
  int row = int(frameIndex);
  return mat4(texelFetch(swimPalette, ivec2(column, row), 0),
    texelFetch(swimPalette, ivec2(column + 1, row), 0),
    texelFetch(swimPalette, ivec2(column + 2, row), 0),
    texelFetch(swimPalette, ivec2(column + 3, row), 0));
}

// Skin a shared 3D fish, then orient it toward this agent's two-dimensional velocity.
void main() {
  // Phase offsets and different cycle rates prevent synchronized tail movement.
  float phase = fract(swimTime * (1.2 + shade * 0.45) + shade);
  float frame = phase * ${fishSettings.frameCount.toFixed(1)};
  float firstFrame = floor(frame);
  float nextFrame = mod(firstFrame + 1.0, ${fishSettings.frameCount.toFixed(1)});
  mat4 firstPose = boneMatrix(skinIndex.x, firstFrame) * skinWeight.x
    + boneMatrix(skinIndex.y, firstFrame) * skinWeight.y;
  mat4 nextPose = boneMatrix(skinIndex.x, nextFrame) * skinWeight.x
    + boneMatrix(skinIndex.y, nextFrame) * skinWeight.y;
  // Blend between sampled poses so movement stays smooth across the loop boundary.
  mat4 skin = firstPose * (1.0 - fract(frame)) + nextPose * fract(frame);
  vec3 localPosition = (skin * vec4(position, 1.0)).xyz;
  vec3 localNormal = mat3(skin) * normal;
  // A slight roll reveals the body depth and lateral tail motion from above the scene.
  float roll = 0.6;
  mat3 bank = mat3(1.0, 0.0, 0.0, 0.0, cos(roll), sin(roll), 0.0, -sin(roll), cos(roll));
  vec2 direction = normalize(vec2(agentVelocityX, agentVelocityY) + vec2(0.0001));
  mat3 heading = mat3(direction.x, direction.y, 0.0, -direction.y, direction.x, 0.0, 0.0, 0.0, 1.0);
  float size = (0.85 + shade * 0.3) * pointScale * 5.6;
  vec3 worldPosition = heading * bank * localPosition * size;
  worldPosition.xy += vec2(agentPositionX, agentPositionY) - worldSize * 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPosition, 1.0);
  fishNormal = normalize(heading * bank * localNormal);
  fishColor = color * mix(vec3(0.8, 0.95, 1.0), vec3(1.15, 1.05, 0.78), shade);
}
`;

// A small lighting model gives the crowd depth without separate materials or lights.
export const fishFragmentShader = `
varying vec3 fishColor;
varying vec3 fishNormal;

// Shade the skinned surface; fins are visible from either side and fish remain opaque.
void main() {
  vec3 surfaceNormal = normalize(fishNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 lightDirection = normalize(vec3(-0.3, 0.55, 1.0));
  float diffuse = max(0.0, dot(surfaceNormal, lightDirection));
  float highlight = pow(max(0.0, dot(surfaceNormal, normalize(lightDirection + vec3(0.0, 0.0, 1.0)))), 28.0);
  gl_FragColor = vec4(fishColor * (0.42 + 0.72 * diffuse) + vec3(0.18) * highlight, 1.0);
}
`;
