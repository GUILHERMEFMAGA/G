/**
 * Respingo da proa e do casco — partículas 100% na GPU.
 *
 * Cada partícula é "sem estado": o vértice sabe apenas a semente dela (direção,
 * fase de nascimento, tamanho) e a posição é resolvida por uma função do tempo
 * no vertex shader — lançamento balístico com arrasto do ar. Isso significa:
 *   • zero trabalho de CPU por frame (nada de arrays sendo reescritos);
 *   • um único draw call para milhares de gotas;
 *   • rodar a 30 ou 144 Hz dá exatamente o mesmo resultado.
 *
 * A emissão é modulada pela velocidade do barco e pelo "impacto" (quanto a proa
 * está caindo na água), que a física entrega a cada passo.
 */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  attribute vec4 aSeed; // x: direção lateral, y: fase, z: tamanho/altura, w: vida

  uniform float uTime;
  uniform vec3 uOrigin;      // proa, em espaço de mundo
  uniform vec3 uFwd;         // proa (horizontal)
  uniform vec3 uRight;       // boreste (horizontal)
  uniform float uSpeed01;    // 0..1 velocidade relativa
  uniform float uImpact;     // 0..1 pancada da proa na água
  uniform float uPointScale; // pixels por metro na distância de referência
  uniform vec3 uLight;       // luz ambiente do céu

  varying float vAlpha;
  varying float vShade;

  void main() {
    float life = 0.85 + aSeed.w * 1.10;
    float cycle = uTime / life + aSeed.y * 7.31;
    float t = fract(cycle);
    float tt = t * life;

    // lado do casco: metade das gotas sai por boreste, metade por bombordo
    float side = step(0.5, aSeed.y) * 2.0 - 1.0;
    float outward = 0.55 + aSeed.x * 1.25;

    vec3 origin = uOrigin + uRight * side * (0.22 + 0.55 * aSeed.z) + uFwd * (aSeed.w - 0.5) * 1.2;
    origin.y += (aSeed.w - 0.5) * 0.35;

    // velocidade de lançamento: para cima e para fora, proporcional à prancha
    float boost = 0.18 + 1.15 * uImpact + 0.95 * uSpeed01;
    vec3 v0 = uFwd * (0.35 + 1.15 * uSpeed01) * (0.6 + 0.8 * aSeed.x)
            + uRight * side * outward * boost * 2.8
            + vec3(0.0, (1.1 + 1.9 * aSeed.z) * boost, 0.0);

    // arrasto do ar + gravidade (solução fechada, sem integração)
    const float k = 1.15;
    const float g = 9.81;
    float d = (1.0 - exp(-k * tt)) / k;
    vec3 pos = origin + v0 * d;
    pos.y += -0.5 * g * tt * tt + (v0.y / k) * (1.0 - exp(-k * tt)) - v0.y * d;

    // a gota morre na água
    float under = smoothstep(0.05, -0.15, pos.y);
    vAlpha = smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.55, 1.0, t)) * (1.0 - under);

    vec4 mv = viewMatrix * vec4(pos, 1.0);
    float dist = max(-mv.z, 0.5);
    gl_PointSize = clamp((0.010 + 0.042 * aSeed.z) * uPointScale / dist, 1.0, 9.0);
    vShade = 0.72 + 0.5 * clamp(uLight.r, 0.0, 1.0);

    gl_Position = projectionMatrix * mv;
  }
`;

const fragmentShader = /* glsl */ `
  varying float vAlpha;
  varying float vShade;

  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = dot(p, p);
    if (r > 1.0) discard;
    // gota: núcleo brilhante com borda macia
    float a = smoothstep(1.0, 0.15, r) * vAlpha;
    if (a < 0.01) discard;
    vec3 col = mix(vec3(0.72, 0.80, 0.87), vec3(1.0), smoothstep(0.7, 0.0, r)) * vShade;
    gl_FragColor = vec4(col, a * 0.42);
  }
`;

export class Spray {
  constructor({ count = 2600 } = {}) {
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      seeds[i * 4 + 0] = Math.random();
      seeds[i * 4 + 1] = Math.random();
      seeds[i * 4 + 2] = Math.random();
      seeds[i * 4 + 3] = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    // posição fictícia: o vertex shader calcula tudo
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uFwd: { value: new THREE.Vector3(1, 0, 0) },
      uRight: { value: new THREE.Vector3(0, 0, 1) },
      uSpeed01: { value: 0 },
      uImpact: { value: 0 },
      uPointScale: { value: 500 },
      uLight: { value: new THREE.Color(0.3, 0.35, 0.4) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.name = 'spray';

    this._origin = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  /**
   * @param {object} p
   * @param {THREE.Vector3} p.boatPosition posição do barco
   * @param {THREE.Quaternion} p.boatQuaternion orientação
   * @param {number} p.halfLength comprimento/2
   * @param {number} p.speed m/s
   * @param {number} p.impact 0..1 (quanto a proa está enterrando)
   * @param {number} p.time
   * @param {THREE.Camera} p.camera
   * @param {THREE.Color} p.light
   */
  update({ boatPosition, boatQuaternion, halfLength, speed, impact, time, camera, light, pixelHeight = 720 }) {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uSpeed01.value = Math.min(1, Math.abs(speed) / 4.0);
    u.uImpact.value = Math.min(1, Math.max(0, impact));

    this._fwd.set(1, 0, 0).applyQuaternion(boatQuaternion);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(1, 0, 0);
    this._fwd.normalize();
    this._right.set(-this._fwd.z, 0, this._fwd.x);

    // origem do respingo: proa, logo acima da linha d'água
    this._origin.copy(boatPosition).addScaledVector(this._fwd, halfLength * 0.92);
    this._origin.y = boatPosition.y + 0.15;

    u.uOrigin.value.copy(this._origin);
    u.uFwd.value.copy(this._fwd);
    u.uRight.value.copy(this._right);

    // escala de pontos: tan(fov/2) * altura / 2 → pixels por metro
    const h = 1 / (2 * Math.tan((camera.fov * Math.PI) / 360));
    u.uPointScale.value = h * pixelHeight;

    if (light) u.uLight.value.copy(light);

    this.points.visible = u.uSpeed01.value > 0.04 || u.uImpact.value > 0.05;
  }
}
