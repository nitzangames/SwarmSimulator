import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createFishAsset, fishSettings } from "../src/fish.js";

// Check authoring invariants before the GPU relies on valid indices and normalized weights.
test("fish has a volumetric mesh bound to a five-bone hierarchy", () => {
  const asset = createFishAsset();
  assert.equal(asset.mesh.isSkinnedMesh, true);
  assert.equal(asset.skeleton.bones.length, 5);
  for (let index = 1; index < asset.skeleton.bones.length; index++)
    assert.equal(asset.skeleton.bones[index].parent, asset.skeleton.bones[index - 1]);
  asset.geometry.computeBoundingBox();
  const size = asset.geometry.boundingBox.getSize(new THREE.Vector3());
  assert.ok(
    size.x > 4 && size.y > 1 && size.z > 0.5,
    "mesh has depth, not a flat sprite",
  );
  const weights = asset.geometry.getAttribute("skinWeight");
  const boneIndices = asset.geometry.getAttribute("skinIndex");
  for (let vertex = 0; vertex < weights.count; vertex++) {
    assert.ok(Math.abs(weights.getX(vertex) + weights.getY(vertex) - 1) < 1e-6);
    assert.ok(boneIndices.getX(vertex) >= 0 && boneIndices.getY(vertex) < 5);
    assert.equal(weights.getZ(vertex) + weights.getW(vertex), 0);
  }
  for (const index of asset.geometry.index.array) assert.ok(index < weights.count);
});

// Independently compare the baked palette against Three.js's actual SkinnedMesh transforms.
test("baked fish skinning agrees with the real skeleton at sampled animation poses", () => {
  const asset = createFishAsset();
  const positions = asset.geometry.getAttribute("position");
  const weights = asset.geometry.getAttribute("skinWeight");
  const indices = asset.geometry.getAttribute("skinIndex");
  const palette = asset.animationTexture.image.data;
  const matrix = new THREE.Matrix4();
  const expected = new THREE.Vector3();
  const actual = new THREE.Vector3();
  const contribution = new THREE.Vector3();
  assert.equal(palette.byteLength, fishSettings.frameCount * 5 * 16 * 4);
  for (const frame of [0, 9, 37, 63]) {
    asset.mixer.setTime((frame / fishSettings.frameCount) * asset.clip.duration);
    asset.mesh.updateMatrixWorld(true);
    for (let vertex = 0; vertex < positions.count; vertex++) {
      expected.fromBufferAttribute(positions, vertex);
      asset.mesh.applyBoneTransform(vertex, expected);
      actual.set(0, 0, 0);
      for (let influence = 0; influence < 2; influence++) {
        const bone = indices.getComponent(vertex, influence);
        matrix.fromArray(palette, (frame * 5 + bone) * 16);
        contribution.fromBufferAttribute(positions, vertex).applyMatrix4(matrix);
        actual.addScaledVector(contribution, weights.getComponent(vertex, influence));
      }
      assert.ok(
        actual.distanceTo(expected) < 1e-5,
        "GPU palette preserves inverse-bind transforms",
      );
    }
  }
});

// A real deformation must move tail vertices and close the loop without a pose discontinuity.
test("swim clip bends the tail, loops, and restores the bind pose correctly", () => {
  const asset = createFishAsset();
  const positions = asset.geometry.getAttribute("position");
  let tailVertex = 0;
  for (let index = 1; index < positions.count; index++)
    if (positions.getX(index) < positions.getX(tailVertex)) tailVertex = index;

  /** Evaluate a vertex through Three.js's skinning path, independent of the crowd shader. */
  function sample(time) {
    asset.mixer.setTime(time);
    asset.mesh.updateMatrixWorld(true);
    return asset.mesh.applyBoneTransform(
      tailVertex,
      new THREE.Vector3().fromBufferAttribute(positions, tailVertex),
    );
  }
  const start = sample(0);
  assert.ok(
    start.distanceTo(sample(0.25)) > 0.1,
    "tail actually deforms during swimming",
  );
  assert.ok(
    start.distanceTo(sample(asset.clip.duration)) < 1e-5,
    "clip loops seamlessly",
  );
  asset.skeleton.pose();
  asset.mesh.updateMatrixWorld(true);
  for (let vertex = 0; vertex < positions.count; vertex++) {
    const original = new THREE.Vector3().fromBufferAttribute(positions, vertex);
    const restored = asset.mesh.applyBoneTransform(vertex, original.clone());
    assert.ok(
      original.distanceTo(restored) < 1e-5,
      "bind pose preserves the authored mesh",
    );
  }
});
