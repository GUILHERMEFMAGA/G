/**
 * Veleiro procedural (nada de assets externos).
 *
 * O casco é uma superfície loftada: para cada estação ao longo do comprimento,
 * uma seção transversal em forma de "V" arredondado. O convés fecha o topo.
 * A partir da mesma função de casco são gerados os pontos de flutuação
 * (sondas volumétricas) usados pela física.
 *
 * Convenções:
 *   +X = proa, +Z = boreste, +Y = cima.
 *   O barco é modelado com o convés em y=0; o grupo é deslocado para que a
 *   origem fique no centro de massa (necessário para a dinâmica rotacional).
 */

import * as THREE from 'three';
import { clamp } from '../util/math.js';
import { createWoodTexture, createSailTexture } from '../util/textures.js';

function orientOutward(geometry, axisY) {
  geometry.computeVertexNormals();
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  let score = 0;
  const ref = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 7) {
    ref.set(pos.getX(i) * 0.15, pos.getY(i) - axisY, pos.getZ(i)).normalize();
    score += nor.getX(i) * ref.x + nor.getY(i) * ref.y + nor.getZ(i) * ref.z;
  }
  const index = geometry.index;
  if (score < 0 && index) {
    const arr = index.array;
    for (let i = 0; i < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
    geometry.computeVertexNormals();
  }
  return geometry;
}

export class Boat {
  constructor({ renderer = null } = {}) {
    this.length = 8.4;
    this.beam = 2.9;
    this.depth = 1.18;
    this.comOffset = -0.5; // centro de massa em coordenadas do modelo
    this.designWaterline = 0; // grupo: a linha d'água de projeto fica em y = 0

    this.equipment = {
      sailArea: 0,
      probes: 0,
    };

    this.group = new THREE.Group();
    this.group.name = 'boat';

    this.model = new THREE.Group();
    this.model.position.y = -this.comOffset; // convés em +0.5 no grupo
    this.group.add(this.model);

    this.deckY = (u) => 0.30 * Math.pow(Math.max(0, u), 2.0) + 0.06 * Math.pow(Math.max(0, -u), 1.6);
    this.keelY = (u) => {
      const t = Math.max(0, 1 - u * u);
      return -this.depth * (0.62 + 0.38 * Math.pow(t, 0.35));
    };
    this.halfWidth = (u) => {
      const t = Math.max(0, 1 - u * u);
      const shape = u > 0 ? Math.pow(t, 0.72) : Math.pow(t, 0.42);
      return (this.beam / 2) * shape;
    };

    this.buildHull(renderer);
    this.buildDeck(renderer);
    this.buildCabin(renderer);
    this.buildRig(renderer);
    this.buildFittings();
    this.buildProbes();
  }

  // ------------------------------------------------------------------ casco
  buildHull(renderer) {
    const NS = 56;
    const NC = 28;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= NS; i++) {
      const u = -1 + (2 * i) / NS;
      const x = (u * this.length) / 2;
      const w = Math.max(this.halfWidth(u), 0.014);
      const dy = this.deckY(u);
      const ky = this.keelY(u);
      for (let j = 0; j <= NC; j++) {
        const phi = (j / NC) * Math.PI;
        const s = Math.pow(Math.sin(phi), 0.72);
        const y = dy + (ky - dy) * s;
        const z = w * Math.cos(phi);
        positions.push(x, y, z);
        uvs.push(i / NS, j / NC);
      }
    }
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NC; j++) {
        const a = i * (NC + 1) + j;
        const b = a + 1;
        const c = a + NC + 1;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    orientOutward(geo, -0.4);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xf4f7f9,
      roughness: 0.22,
      metalness: 0.03,
      envMapIntensity: 0.9,
    });

    // pintura do casco: obra-viva, faixa de borda e amurada, em função de y
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vHullY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHullY = position.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vHullY;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           float anti = 1.0 - smoothstep(-0.575, -0.545, vHullY);
           float stripe = smoothstep(-0.545, -0.530, vHullY) * (1.0 - smoothstep(-0.470, -0.455, vHullY));
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.235, 0.075, 0.070), anti);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.085, 0.145), stripe);`
        );
    };
    mat.customProgramCacheKey = () => 'boat-hull-paint';

    this.hullMesh = new THREE.Mesh(geo, mat);
    this.hullMesh.castShadow = false;
    this.hullMesh.receiveShadow = false;
    this.model.add(this.hullMesh);
    this.hullMaterial = mat;
  }

  // ------------------------------------------------------------------ convés
  buildDeck(renderer) {
    const NS = 56;
    const M = 10;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= NS; i++) {
      const u = -1 + (2 * i) / NS;
      const x = (u * this.length) / 2;
      const w = this.halfWidth(u);
      const dy = this.deckY(u);
      for (let j = 0; j <= M; j++) {
        const z = -w + (2 * w * j) / M;
        const camber = w > 0.05 ? 0.035 * (1 - (z / w) ** 2) : 0;
        positions.push(x, dy + camber, z);
        uvs.push(x / 2.4, (z + this.beam / 2) / 1.6);
      }
    }
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < M; j++) {
        const a = i * (M + 1) + j;
        const b = a + 1;
        const c = a + M + 1;
        const d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const wood = createWoodTexture(renderer);
    wood.repeat.set(2, 1);
    const mat = new THREE.MeshStandardMaterial({
      map: wood,
      color: 0xffffff,
      roughness: 0.62,
      metalness: 0.0,
      envMapIntensity: 0.55,
    });

    this.deckMesh = new THREE.Mesh(geo, mat);
    this.model.add(this.deckMesh);
  }

  // ------------------------------------------------------------------ cabine
  buildCabin(renderer) {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xeef2f4,
      roughness: 0.30,
      metalness: 0.02,
    });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x0a1420,
      roughness: 0.06,
      metalness: 0.75,
      envMapIntensity: 1.4,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x2a3138,
      roughness: 0.55,
      metalness: 0.2,
    });

    const cabin = new THREE.Group();
    cabin.position.set(-0.55, 0, 0);

    const body = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.60, 1.55), bodyMat);
    body.position.y = 0.28;
    cabin.add(body);

    const top = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.10, 1.35), bodyMat);
    top.position.set(-0.05, 0.60, 0);
    cabin.add(top);

    // janelas laterais + para-brisa
    for (const side of [-1, 1]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.24, 0.06), glassMat);
      win.position.set(-0.05, 0.34, side * 0.79);
      cabin.add(win);
    }
    const front = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.30, 1.25), glassMat);
    front.position.set(1.26, 0.32, 0);
    front.rotation.z = -0.18;
    cabin.add(front);

    // escotilha e detalhes
    const hatch = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.05, 0.5), darkMat);
    hatch.position.set(1.9, 0.06, 0);
    cabin.add(hatch);

    // cockpit (banco + console)
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.28, 1.35), darkMat);
    bench.position.set(-2.1, 0.16, 0);
    cabin.add(bench);
    const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 8), darkMat);
    tiller.position.set(-3.05, 0.35, 0);
    tiller.rotation.z = Math.PI / 2 - 0.2;
    cabin.add(tiller);

    this.model.add(cabin);
  }

  // ------------------------------------------------------------------ armação
  buildRig(renderer) {
    const mastMat = new THREE.MeshStandardMaterial({
      color: 0xb8c2c9,
      roughness: 0.26,
      metalness: 0.9,
      envMapIntensity: 1.2,
    });
    const wireMat = new THREE.MeshStandardMaterial({
      color: 0x5b666e,
      roughness: 0.35,
      metalness: 0.85,
    });
    const sailMat = new THREE.MeshStandardMaterial({
      map: createSailTexture(),
      color: 0xffffff,
      roughness: 0.88,
      metalness: 0.0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.85,
    });

    const mastX = 0.75;
    const mastBase = 0.62;
    const mastTop = 8.6;

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.062, 0.085, mastTop, 12),
      mastMat
    );
    mast.position.set(mastX, mastBase + mastTop / 2, 0);
    this.model.add(mast);

    const boomY = mastBase + 1.55;
    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 3.4, 10), mastMat);
    boom.position.set(mastX - 1.7, boomY, 0);
    boom.rotation.z = Math.PI / 2;
    this.model.add(boom);

    // ---- vela grande ----
    const mainA = new THREE.Vector3(mastX + 0.02, boomY + 0.05, 0);
    const mainB = new THREE.Vector3(mastX - 3.35, boomY + 0.10, 0);
    const mainC = new THREE.Vector3(mastX + 0.02, boomY + 6.85, 0);
    const mainsail = this.buildSail(mainA, mainB, mainC, 0.16, 0.55);
    const mainsailMesh = new THREE.Mesh(mainsail, sailMat);
    this.model.add(mainsailMesh);
    this.mainsail = mainsailMesh;

    // ---- bujarrona (jib) ----
    const jibA = new THREE.Vector3(3.75, 0.30, 0);
    const jibB = new THREE.Vector3(0.35, boomY - 0.35, 0);
    const jibC = new THREE.Vector3(mastX + 0.02, boomY + 5.15, 0);
    const jib = this.buildSail(jibA, jibB, jibC, 0.14, 0.42);
    const jibMesh = new THREE.Mesh(jib, sailMat);
    this.model.add(jibMesh);
    this.jib = jibMesh;

    this.equipment.sailArea = 0.5 * 3.4 * 6.8 + 0.5 * 3.4 * 5.0;

    // ---- cabos ----
    const cable = (from, to, radius = 0.014) => {
      const dir = new THREE.Vector3().subVectors(to, from);
      const len = dir.length();
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6), wireMat);
      mesh.position.copy(from).addScaledVector(dir, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      return mesh;
    };

    const head = new THREE.Vector3(mastX, mastBase + mastTop - 0.15, 0);
    this.model.add(cable(new THREE.Vector3(3.78, 0.28, 0), head, 0.013)); // estai de proa
    this.model.add(cable(new THREE.Vector3(-4.15, 0.22, 0), head, 0.012)); // estai de popa
    for (const side of [-1, 1]) {
      this.model.add(
        cable(new THREE.Vector3(mastX, mastBase + mastTop - 0.9, 0), new THREE.Vector3(-0.4, 0.05, side * 1.25), 0.011)
      );
    }

    // ---- guarda-corpo ----
    const railMat = new THREE.MeshStandardMaterial({ color: 0xc9d2d8, roughness: 0.3, metalness: 0.8 });
    for (const side of [-1, 1]) {
      const points = [];
      const stanchions = [];
      for (let i = 0; i <= 12; i++) {
        const u = -0.82 + (1.62 * i) / 12;
        const w = this.halfWidth(u) * 0.9;
        const y = this.deckY(u) + 0.58;
        points.push(new THREE.Vector3((u * this.length) / 2, y, side * w));
        stanchions.push([(u * this.length) / 2, this.deckY(u), side * w]);
      }
      const curve = new THREE.CatmullRomCurve3(points);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.016, 6, false), railMat);
      this.model.add(tube);
      for (const [x, y, z] of stanchions) {
        const s = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.58, 6), railMat);
        s.position.set(x, y + 0.29, z);
        this.model.add(s);
      }
    }
  }

  /** Vela curva entre três pontos (punho, escota, cabeça). */
  buildSail(a, b, c, camber, twist) {
    const NU = 18;
    const NV = 16;
    const positions = [];
    const uvs = [];
    const indices = [];

    const p1 = new THREE.Vector3();
    const p2 = new THREE.Vector3();
    const p = new THREE.Vector3();

    for (let v = 0; v <= NV; v++) {
      const tv = v / NV;
      p1.copy(a).lerp(c, tv);
      p2.copy(b).lerp(c, tv);
      const chord = p1.distanceTo(p2);
      for (let u = 0; u <= NU; u++) {
        const tu = u / NU;
        p.copy(p1).lerp(p2, tu);
        const belly = Math.sin(Math.PI * tu) * chord * camber;
        const flutter = Math.sin(Math.PI * tu) * chord * 0.02 * Math.sin(tv * 9.0 + tu * 4.0);
        p.z += belly + flutter + twist * 0.02 * chord * Math.sin(Math.PI * tu);
        positions.push(p.x, p.y, p.z);
        uvs.push(tu, tv);
      }
    }
    for (let v = 0; v < NV; v++) {
      for (let u = 0; u < NU; u++) {
        const i0 = v * (NU + 1) + u;
        const i1 = i0 + 1;
        const i2 = i0 + NU + 1;
        const i3 = i2 + 1;
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // ------------------------------------------------------------------ detalhes
  buildFittings() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x9aa6ae, roughness: 0.3, metalness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x232a30, roughness: 0.5, metalness: 0.3 });

    // quilha + bulbo
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.05, 0.13), dark);
    fin.position.set(0.25, -1.42, 0);
    this.model.add(fin);

    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.20, 14, 10), dark);
    bulb.scale.set(2.4, 1.0, 1.0);
    bulb.position.set(0.25, -1.92, 0);
    this.model.add(bulb);

    // leme
    const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.85, 0.09), dark);
    rudder.position.set(-3.55, -0.62, 0);
    this.model.add(rudder);

    // poita / ferragens
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const u = -0.45 + i * 0.42;
        const cleat = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.05), metal);
        cleat.position.set((u * this.length) / 2, this.deckY(u) + 0.045, side * this.halfWidth(u) * 0.86);
        this.model.add(cleat);
      }
    }

    // mastro: catraca
    const winch = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.2, 12), metal);
    winch.position.set(-1.0, 0.15, 0.75);
    this.model.add(winch);
  }

  // ------------------------------------------------------------------ física
  /**
   * Sondas de flutuação: pequenos volumes distribuídos dentro do casco.
   * Cada sonda submersa gera empuxo proporcional à fração submersa.
   */
  buildProbes() {
    const stations = 10;
    const rows = 3;
    const cols = 4;
    const yTop = -0.30;
    const yBot = -1.06;

    const probes = [];
    const dyStep = (yTop - yBot) / rows;
    const dxStep = (this.length * 1.78) / stations;

    for (let i = 0; i < stations; i++) {
      const u = -0.89 + (1.78 * i) / (stations - 1);
      const x = (u * this.length) / 2;
      const w = this.halfWidth(u);
      const dy = this.deckY(u);
      const ky = this.keelY(u);

      for (let r = 0; r < rows; r++) {
        const y = yBot + dyStep * (r + 0.5);
        const tt = clamp((y - dy) / (ky - dy), 0, 1);
        const sinPhi = Math.pow(tt, 1 / 0.72);
        const wAtY = w * Math.sqrt(Math.max(0, 1 - sinPhi * sinPhi));
        if (wAtY < 0.10) continue;

        const dzStep = (1.9 * wAtY) / cols;
        for (let c = 0; c < cols; c++) {
          const z = -0.95 * wAtY + dzStep * (c + 0.5);
          const volume = dxStep * dyStep * dzStep * 0.92;
          probes.push({
            local: new THREE.Vector3(x, y - this.comOffset, z),
            size: dyStep,
            volume,
            area: dzStep * dyStep * 1.35,
          });
        }
      }
    }

    this.probes = probes;
    this.equipment.probes = probes.length;

    // Calibração: o deslocamento (volume submerso na linha d'água de projeto)
    // é ajustado para uma massa realista de veleiro de 8,4 m. Como o empuxo e a
    // massa escalam juntos, o equilíbrio e a dinâmica não mudam — só o valor
    // físico da massa.
    let immersed = 0;
    for (const p of probes) {
      immersed += p.volume * clamp(0.5 - p.local.y / p.size, 0, 1);
    }
    const targetMass = 6000; // kg
    const formFactor = targetMass / (immersed * 1025);
    for (const p of probes) p.volume *= formFactor;

    this.displacement = immersed * formFactor;
    this.mass = targetMass;
    this.totalProbeVolume = probes.reduce((s, p) => s + p.volume, 0);
    this.designWaterline = 0;
  }

  /** Visualização das sondas (debug da física). */
  createProbeDebug() {
    const group = new THREE.Group();
    const geo = new THREE.SphereGeometry(0.07, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0x66ffd0, transparent: true, opacity: 0.85 });
    for (const p of this.probes) {
      const m = new THREE.Mesh(geo, mat);
      m.position.copy(p.local);
      group.add(m);
    }
    this.group.add(group);
    return group;
  }
}
