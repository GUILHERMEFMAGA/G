/**
 * Domo celeste: gradiente atmosférico, halo/disco solar, nuvens em camadas e
 * estrelas. Desenhado como fundo (sem teste de profundidade).
 */

import * as THREE from 'three';
import vertexShader from '../shaders/sky.vert.glsl?raw';
import fragmentShader from '../shaders/sky.frag.glsl?raw';

export class Sky {
  constructor({ radius = 20000 } = {}) {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRadiance: { value: new THREE.Color(1, 1, 1) },
      uZenithColor: { value: new THREE.Color() },
      uHorizonColor: { value: new THREE.Color() },
      uSunsetColor: { value: new THREE.Color(0.98, 0.44, 0.17) },
      uCloudLitColor: { value: new THREE.Color() },
      uCloudShadowColor: { value: new THREE.Color() },
      uWarmth: { value: 0 },
      uCloudCover: { value: 0.35 },
      uCloudOffset: { value: new THREE.Vector2() },
      uNightFactor: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      lights: false,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 40), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
  }

  update(atmosphere, camera, time, windDir = { x: 0, z: 1 }) {
    const u = this.uniforms;
    u.uSunDir.value.copy(atmosphere.sunDir);
    u.uSunRadiance.value.copy(atmosphere.sunRadiance);
    u.uZenithColor.value.copy(atmosphere.zenith);
    u.uHorizonColor.value.copy(atmosphere.horizon);
    u.uCloudLitColor.value.copy(atmosphere.cloudLit);
    u.uCloudShadowColor.value.copy(atmosphere.cloudShadow);
    u.uSunsetColor.value.copy(atmosphere.sunset);
    u.uWarmth.value = atmosphere.warmth;
    u.uCloudCover.value = atmosphere.cloudCover;
    u.uNightFactor.value = atmosphere.nightFactor;
    u.uCloudOffset.value.set(time * windDir.x * 0.6 + 12.0, time * windDir.z * 0.6 + 4.0);

    this.mesh.position.copy(camera.position);
  }
}
