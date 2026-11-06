/**
 * Superfície do oceano: malha polar que acompanha a câmera (mais densa perto)
 * + material com deslocamento Gerstner, reflexão planar e espuma.
 */

import * as THREE from 'three';
import vertexShader from '../shaders/ocean.vert.glsl?raw';
import fragmentShader from '../shaders/ocean.frag.glsl?raw';
import { SWELL_COUNT, DETAIL_COUNT } from '../waves/WaveField.js';

function buildPolarGrid(rings = 210, segments = 256, r0 = 0.5, rMax = 26000) {
  const verts = rings + 1;
  const segs = segments + 1;
  const positions = new Float32Array(verts * segs * 3);
  const growth = Math.pow(rMax / r0, 1 / (rings - 1));

  let p = 0;
  for (let i = 0; i <= rings; i++) {
    const r = i === 0 ? 0 : r0 * Math.pow(growth, i - 1);
    for (let j = 0; j <= segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      positions[p++] = Math.sin(a) * r;
      positions[p++] = 0;
      positions[p++] = Math.cos(a) * r;
    }
  }

  const indices = new Uint32Array(rings * segments * 6);
  let k = 0;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segs + j;
      const b = a + 1;
      const c = a + segs;
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return geo;
}

export class Ocean {
  constructor({ waveField, foamTexture, rippleTexture }) {
    this.waveField = waveField;

    this.uniforms = {
      uTime: { value: 0 },
      uSwellA: { value: waveField.swellA },
      uSwellB: { value: waveField.swellB },
      uDetA: { value: waveField.detailA },
      uDetB: { value: waveField.detailB },

      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uZenithColor: { value: new THREE.Color() },
      uHorizonColor: { value: new THREE.Color() },

      uDeepColor: { value: new THREE.Color(0.0055, 0.027, 0.056) },
      uShallowColor: { value: new THREE.Color(0.018, 0.082, 0.100) },
      uSssColor: { value: new THREE.Color(0.035, 0.33, 0.29) },
      uFoamColor: { value: new THREE.Color(0.80, 0.88, 0.93) },

      uSssStrength: { value: 1.0 },
      uFoamStrength: { value: 1.0 },
      uFoamThreshold: { value: 0.88 },
      uRoughness: { value: 0.06 },
      uDetailStrength: { value: 1.0 },
      uMaxAmp: { value: 2.0 },
      uHazeDistance: { value: 9000 },
      uReflectionStrength: { value: 1.0 },
      uSunSpecular: { value: 0.55 },
      uWindDir: { value: new THREE.Vector2(0, 1) },

      uReflection: { value: null },
      uFoamTex: { value: foamTexture },
      uRippleTex: { value: rippleTexture },
      uRippleStrength: { value: 0.85 },
      uReflectionMatrix: { value: new THREE.Matrix4() },
    };

    const defines = `#define NW ${SWELL_COUNT}\n#define ND ${DETAIL_COUNT}\n`;

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: defines + vertexShader,
      fragmentShader: defines + fragmentShader,
      side: THREE.FrontSide,
      fog: false,
      lights: false,
    });

    this.mesh = new THREE.Mesh(buildPolarGrid(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'ocean';

    this._followThreshold = 22;
    this._target = new THREE.Vector3();
  }

  /** Acompanha a câmera mantendo a malha densa sob o ponto de vista. */
  follow(camera) {
    const dx = camera.position.x - this.mesh.position.x;
    const dz = camera.position.z - this.mesh.position.z;
    if (dx * dx + dz * dz > this._followThreshold * this._followThreshold) {
      this.mesh.position.set(camera.position.x, 0, camera.position.z);
    }
  }

  update({ time, camera, atmosphere, reflectionTexture, reflectionMatrix, params }) {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uCameraPos.value.copy(camera.position);
    u.uSunDir.value.copy(atmosphere.sunDir);
    u.uSunColor.value.copy(atmosphere.sunRadiance);

    const daylight = atmosphere.daylight;
    u.uZenithColor.value.copy(atmosphere.zenith).multiplyScalar(0.9 * daylight + 0.06);
    u.uHorizonColor.value.copy(atmosphere.horizon).multiplyScalar(0.92 * daylight + 0.05);

    u.uMaxAmp.value = Math.max(this.waveField.maxAmp, 0.25);
    u.uWindDir.value.set(this.waveField.windDir.x, this.waveField.windDir.z);

    if (reflectionTexture) u.uReflection.value = reflectionTexture;
    if (reflectionMatrix) u.uReflectionMatrix.value.copy(reflectionMatrix);

    // cores de corpo da água acompanham a luz do dia
    u.uDeepColor.value.setRGB(0.0055, 0.027, 0.056).multiplyScalar(daylight);
    u.uShallowColor.value.setRGB(0.018, 0.082, 0.100).multiplyScalar(daylight);
    u.uSssColor.value.setRGB(0.035, 0.33, 0.29).multiplyScalar(daylight);

    if (params) {
      u.uFoamStrength.value = params.foam;
      u.uSssStrength.value = params.sss;
      u.uDetailStrength.value = params.detail;
      u.uRoughness.value = params.roughness;
      u.uSunSpecular.value = params.sunGlitter;
      u.uFoamThreshold.value = params.foamThreshold;
    }

    this.follow(camera);
  }
}
