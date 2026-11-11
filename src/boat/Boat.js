/**
 * Veleiro procedural (nada de assets externos).
 *
 * O casco é uma superfície loftada: para cada estação ao longo do comprimento,
 * uma seção transversal em forma de "V" arredondado. O convés fecha o topo —
 * com um poço de cockpit recortado na grade.
 *
 * O casario é construído como um barco de verdade: painéis de fibra com
 * ABERTURAS reais para as janelas, vidro de verdade (metalness alto + baixa
 * opacidade: reflete o céu e deixa ver o interior) e um interior mobiliado com
 * luz própria, visível através das janelas.
 *
 * Convenções:
 *   +X = proa, +Z = boreste, +Y = cima.
 *   O barco é modelado com o convés em y≈0; o grupo é deslocado para que a
 *   origem fique no centro de massa (necessário para a dinâmica rotacional).
 *
 * Desempenho: as peças pequenas (ferragens, cabos, grades) são fundidas por
 * material com mergeGeometries — o barco inteiro sai em ~12 draw calls.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp } from '../util/math.js';
import {
  createTeakTexture,
  createGelcoatTexture,
  createSailTexture,
  createFabricTexture,
  createInteriorWoodTexture,
} from '../util/textures.js';

// ---------------------------------------------------------------------------
// utilitários de geometria
// ---------------------------------------------------------------------------
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

function place(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  _q.setFromEuler(_e.set(rx, ry, rz, 'XYZ'));
  _m4.compose(_v.set(x, y, z), _q, _one);
  geo.applyMatrix4(_m4);
  return geo;
}

const box = (w, h, d, x, y, z, rx, ry, rz) => place(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
const cyl = (rt, rb, h, x, y, z, rx, ry, rz, seg = 12) =>
  place(new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz);

function tube(points, radius, segments = 24, radial = 6) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])));
  return new THREE.TubeGeometry(curve, segments, radius, radial, false);
}

function mergeAll(list) {
  if (!list.length) return null;
  const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (list.length > 1) for (const g of list) g.dispose();
  return merged;
}

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

// ---------------------------------------------------------------------------
export class Boat {
  constructor({ renderer = null } = {}) {
    this.length = 8.4;
    this.beam = 2.9;
    this.depth = 1.18;
    this.comOffset = -0.5;
    this.designWaterline = 0;

    // geometria do casario (coordenadas do modelo)
    this.cabin = { x0: -2.38, x1: 1.10, z: 0.76, wall: 0.07, base: 0.06, sill: 0.34, head: 0.66, top: 0.78 };
    this.cockpit = { x0: -3.55, x1: -2.44, halfZ: 0.72, sole: -0.28 };

    this.equipment = { sailArea: 0, probes: 0 };
    this.glassMeshes = [];

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
    // Proa fina (entrada em V) e popa TRUNCADA: a boca para de afinar em
    // u = -0.86, o que dá o painel de popa (transom) de um veleiro de verdade
    // em vez de uma popa arredondada de banheira.
    this.transomU = -0.86;
    this.halfWidth = (u) => {
      const uc = Math.min(1, Math.max(this.transomU, u));
      const t = Math.max(0, 1 - uc * uc);
      const shape = uc > 0 ? Math.pow(t, 0.56) : Math.pow(t, 0.40);
      return (this.beam / 2) * shape;
    };

    this.buildMaterials(renderer);
    this.buildHull();
    this.buildDeck();
    this.buildCabin();
    this.buildInterior();
    this.buildCockpit();
    this.buildRig();
    this.buildFittings();
    this.buildProbes();
    this.finish();
  }

  // ------------------------------------------------------------- materiais
  buildMaterials(renderer) {
    // Em ambiente sem canvas 2D (testes de física no Node) as texturas viram
    // null — o material continua válido, só fica com cor chapada.
    const safe = (fn) => {
      try {
        return fn();
      } catch {
        return null;
      }
    };

    const gelcoat = safe(() => createGelcoatTexture(512));
    const teak = safe(() => createTeakTexture(renderer, 1024));
    const sail = safe(() => createSailTexture());
    const fabric = safe(() => createFabricTexture(256));
    const cabinWood = safe(() => createInteriorWoodTexture(renderer, 512));

    if (gelcoat) gelcoat.repeat.set(3, 3);
    if (teak) teak.repeat.set(1.1, 1);
    if (fabric) fabric.repeat.set(2, 2);
    if (cabinWood) cabinWood.repeat.set(2, 1);

    this.materials = {
      gelcoat,
      teak,
      sail,
      fabric,
      cabinWood,
    };

    // casco: gelcoat branco + pintura por altura (obra-viva e faixa)
    this.hullMaterial = new THREE.MeshStandardMaterial({
      map: gelcoat,
      color: 0xf7fafb,
      roughness: 0.15,
      metalness: 0.02,
      envMapIntensity: 1.0,
    });
    this.hullMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vHullY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHullY = position.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vHullY;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           // obra-viva (vermelho-escuro), faixa branca e borda azul-marinho
           float anti = 1.0 - smoothstep(-0.560, -0.530, vHullY);
           float stripe = smoothstep(-0.530, -0.518, vHullY) * (1.0 - smoothstep(-0.470, -0.455, vHullY));
           float sheer  = smoothstep(0.250, 0.275, vHullY);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.180, 0.048, 0.045), anti);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.030, 0.062, 0.115), stripe);
           diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.055, 0.085, 0.120), sheer);`
        );
    };
    this.hullMaterial.customProgramCacheKey = () => 'boat-hull-paint-v2';

    this.deckMaterial = new THREE.MeshStandardMaterial({
      map: teak,
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.0,
      envMapIntensity: 0.5,
    });

    this.cabinMaterial = new THREE.MeshStandardMaterial({
      map: this.materials.gelcoat,
      color: 0xf2f6f7,
      roughness: 0.26,
      metalness: 0.02,
      envMapIntensity: 0.85,
    });

    /**
     * Vidro: metal puro e liso reflete o environment map do céu e, por ser
     * translúcido, deixa o interior aparecer. É exatamente o visual de janela
     * de veleiro: 35% espelho, 65% interior.
     */
    this.glassMaterial = new THREE.MeshStandardMaterial({
      color: 0x9fc4d8,
      metalness: 1.0,
      roughness: 0.055,
      transparent: true,
      opacity: 0.34,
      envMapIntensity: 1.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    this.fabricMaterial = new THREE.MeshStandardMaterial({
      map: fabric,
      color: 0xc9b9a4,
      roughness: 0.94,
      metalness: 0.0,
      envMapIntensity: 0.28,
      emissive: new THREE.Color(0.09, 0.058, 0.032),
      emissiveIntensity: 0.5,
    });

    this.woodMaterial = new THREE.MeshStandardMaterial({
      map: cabinWood,
      color: 0xe6d3b8,
      roughness: 0.58,
      metalness: 0.0,
      envMapIntensity: 0.30,
      emissive: new THREE.Color(0.10, 0.062, 0.032),
      emissiveIntensity: 0.55,
    });

    this.metalMaterial = new THREE.MeshStandardMaterial({
      color: 0xb9c3ca,
      roughness: 0.28,
      metalness: 0.92,
      envMapIntensity: 1.15,
    });

    this.darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x1d242a,
      roughness: 0.52,
      metalness: 0.25,
      envMapIntensity: 0.7,
    });

    this.trimMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8eef1,
      roughness: 0.35,
      metalness: 0.05,
      envMapIntensity: 0.7,
    });

    this.lampMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.82, 0.56).multiplyScalar(1.35) });
    this.screenMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.22, 0.72, 0.95) });

    // madeira envernizada do cockpit (mais brilho que a teca crua do convés)
    this.varnishMaterial = new THREE.MeshStandardMaterial({
      map: this.materials.teak,
      color: 0xcdb79c,
      roughness: 0.26,
      metalness: 0.05,
      envMapIntensity: 0.9,
    });
  }

  /** Funde uma lista de geometrias num único mesh. */
  addMerged(list, material, { name = '', cast = false, receive = false, order } = {}) {
    const geo = mergeAll(list);
    if (!geo) return null;
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    if (order !== undefined) mesh.renderOrder = order;
    this.model.add(mesh);
    return mesh;
  }

  // ------------------------------------------------------------------ casco
  buildHull() {
    const NS = 64;
    const NC = 30;
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

    this.hullMesh = new THREE.Mesh(geo, this.hullMaterial);
    this.hullMesh.name = 'casco';
    this.model.add(this.hullMesh);

    // painel de popa: leque fechando a última estação do casco
    {
      const N = 30;
      const xs = -this.length / 2;
      const u = -1;
      const w = Math.max(this.halfWidth(u), 0.014);
      const dy = this.deckY(u);
      const ky = this.keelY(u);
      const pos = [];
      for (let j = 0; j <= N; j++) {
        const phi = (j / N) * Math.PI;
        const sv = Math.pow(Math.sin(phi), 0.72);
        pos.push(xs, dy + (ky - dy) * sv, w * Math.cos(phi));
      }
      const cy = (dy + ky) * 0.5;
      const center = pos.length / 3;
      pos.push(xs - 0.02, cy, 0);
      const idx = [];
      for (let j = 0; j < N; j++) idx.push(center, j, j + 1);
      const tgeo = new THREE.BufferGeometry();
      tgeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      tgeo.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((N + 2) * 2).fill(0.5), 2));
      tgeo.setIndex(idx);
      // normais explícitas: o painel é plano, apontando para a popa
      const nArr = new Float32Array((N + 2) * 3);
      for (let j = 0; j <= N + 1; j++) {
        nArr[j * 3] = -1;
        nArr[j * 3 + 1] = 0;
        nArr[j * 3 + 2] = 0;
      }
      tgeo.setAttribute('normal', new THREE.BufferAttribute(nArr, 3));
      // vira para fora (-X) se necessário
      const nrm = tgeo.attributes.normal;
      if (nrm.getX(N >> 1) > 0) {
        const arr = tgeo.index.array;
        for (let i = 0; i < arr.length; i += 3) {
          const t2 = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = t2;
        }
        tgeo.index.needsUpdate = true;
        tgeo.computeVertexNormals();
      }
      const transom = new THREE.Mesh(tgeo, this.hullMaterial);
      transom.name = 'painel-popa';
      this.model.add(transom);
    }

    // borda (tábua do convés): realce branco entre casco e teca
    const edge = [];
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= 24; i++) {
        const u = -0.985 + (1.97 * i) / 24;
        pts.push([(u * this.length) / 2, this.deckY(u) - 0.01, side * this.halfWidth(u) * 0.995]);
      }
      edge.push(tube(pts, 0.028, 40, 5));
    }
    this.addMerged(edge, this.trimMaterial, { name: 'borda' });
  }

  // ------------------------------------------------------------------ convés
  buildDeck() {
    const NS = 64;
    const M = 12;
    const positions = [];
    const uvs = [];
    const indices = [];

    const { x0: cx0, x1: cx1, halfZ } = this.cockpit;

    for (let i = 0; i <= NS; i++) {
      const u = -1 + (2 * i) / NS;
      const x = (u * this.length) / 2;
      const w = this.halfWidth(u);
      const dy = this.deckY(u);
      for (let j = 0; j <= M; j++) {
        const z = -w + (2 * w * j) / M;
        const camber = w > 0.05 ? 0.035 * (1 - (z / w) ** 2) : 0;
        positions.push(x, dy + camber, z);
        uvs.push(x / 2.6, (z + this.beam / 2) / 1.4);
      }
    }

    // recorta o poço do cockpit: quads cujo centro cai dentro do retângulo
    for (let i = 0; i < NS; i++) {
      const uA = -1 + (2 * i) / NS;
      const uB = -1 + (2 * (i + 1)) / NS;
      const xA = (uA * this.length) / 2;
      const xB = (uB * this.length) / 2;
      for (let j = 0; j < M; j++) {
        const wA = this.halfWidth(uA);
        const zA = -wA + (2 * wA * j) / M;
        const zB = -wA + (2 * wA * (j + 1)) / M;
        const cxm = (xA + xB) / 2;
        const czm = (zA + zB) / 2;
        const inside = cxm > cx0 && cxm < cx1 && Math.abs(czm) < halfZ;
        if (inside) continue;
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

    this.deckMesh = new THREE.Mesh(geo, this.deckMaterial);
    this.deckMesh.name = 'conves';
    this.model.add(this.deckMesh);
  }

  // ----------------------------------------------------------------- casario
  buildCabin() {
    const c = this.cabin;
    const shell = [];
    const walls = [];
    const frames = [];

    const spanFull = c.x1 - c.x0;
    const centerX = (c.x0 + c.x1) / 2;

    for (const side of [-1, 1]) {
      const z = side * c.z;
      // talha (abaixo das janelas)
      shell.push(box(spanFull, c.sill - c.base, c.wall, centerX, (c.sill + c.base) / 2, z));
      // testeira (acima das janelas)
      shell.push(box(spanFull, c.top - c.head, c.wall, centerX, (c.head + c.top) / 2, z));
      // montantes: popa, central e proa
      const winY = (c.sill + c.head) / 2;
      const winH = c.head - c.sill;
      const post = (xa, xb) => shell.push(box(xb - xa, winH, c.wall, (xa + xb) / 2, winY, z));
      post(c.x0, -1.86);
      post(-0.72, -0.50);
      post(0.72, c.x1);
    }

    // parede de popa com passagem (escotilha de entrada)
    const rear = c.x0;
    const doorW = 0.56;
    for (const side of [-1, 1]) {
      const w = c.z - doorW / 2;
      shell.push(box(c.wall, c.top - c.base, w, rear, (c.top + c.base) / 2, side * (doorW / 2 + w / 2)));
    }
    shell.push(box(c.wall, c.top - 0.62, doorW, rear, (c.top + 0.62) / 2, 0));

    // teto com pequena coroa
    const roofY = c.top + 0.03;
    shell.push(box(c.x1 - c.x0 + 0.10, 0.07, c.z * 2 + 0.10, centerX - 0.02, roofY, 0));
    // borda do teto
    shell.push(box(c.x1 - c.x0 + 0.14, 0.045, c.z * 2 + 0.14, centerX - 0.02, roofY - 0.045, 0));

    // para-brisa: vidro inclinado para trás (caixa fina, sem ambiguidade de eixos)
    const windBottom = new THREE.Vector3(1.16, c.base + 0.20, 0);
    const windTop = new THREE.Vector3(0.90, c.top + 0.02, 0);
    const windLen = windBottom.distanceTo(windTop);
    const windTilt = Math.atan2(windBottom.x - windTop.x, windTop.y - windBottom.y);
    const windCenter = new THREE.Vector3().addVectors(windBottom, windTop).multiplyScalar(0.5);

    const windshield = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, windLen, c.z * 2 - 0.04),
      this.glassMaterial
    );
    windshield.position.copy(windCenter);
    windshield.rotation.z = windTilt;
    windshield.renderOrder = 4;
    this.model.add(windshield);
    this.glassMeshes.push(windshield);

    // caixilho do para-brisa
    walls.push(box(0.05, 0.055, c.z * 2 + 0.05, windTop.x + 0.01, c.top + 0.03, 0));

    // travessa superior do para-brisa
    walls.push(box(0.06, 0.05, c.z * 2 + 0.04, 0.905, c.top + 0.035, 0));

    this.addMerged(shell, this.cabinMaterial, { name: 'casario' });
    this.addMerged(walls, this.trimMaterial, { name: 'caixilho' });
    this.addMerged(frames, this.darkMaterial, { name: 'gaxetas' });

    // ---- janelas laterais (vidro) ----
    for (const side of [-1, 1]) {
      for (const [xa, xb] of [
        [-1.84, -0.74],
        [-0.48, 0.70],
      ]) {
        const pane = new THREE.Mesh(
          new THREE.BoxGeometry(xb - xa, c.head - c.sill, 0.012),
          this.glassMaterial
        );
        pane.position.set((xa + xb) / 2, (c.head + c.sill) / 2, side * (c.z + 0.004));
        pane.renderOrder = 4;
        this.model.add(pane);
        this.glassMeshes.push(pane);

        // gaxeta de borracha em volta do vão: define a janela e esconde a
        // emenda entre o vidro e o painel de fibra
        const gz = side * (c.z + 0.012);
        const t = 0.028;
        frames.push(box(xb - xa + 0.03, t, 0.035, (xa + xb) / 2, c.head + t / 2, gz));
        frames.push(box(xb - xa + 0.03, t, 0.035, (xa + xb) / 2, c.sill - t / 2, gz));
        frames.push(box(t, c.head - c.sill + 0.06, 0.035, xa - t / 2, (c.head + c.sill) / 2, gz));
        frames.push(box(t, c.head - c.sill + 0.06, 0.035, xb + t / 2, (c.head + c.sill) / 2, gz));
      }
    }
  }

  // ---------------------------------------------------------------- interior
  buildInterior() {
    const c = this.cabin;
    const wood = [];
    const fabric = [];
    const dark = [];
    const lamps = [];
    const metalInterior = [];
    const screens = [];

    const floorY = 0.05;
    // piso
    wood.push(box(3.30, 0.03, 1.32, -0.66, floorY, 0));

    // beliches laterais + almofadas (afastados da parede: dá para ver o
    // interior através das janelas, em vez de um encosto encostado no vidro)
    for (const side of [-1, 1]) {
      wood.push(box(1.95, 0.19, 0.46, -1.32, floorY + 0.105, side * 0.42));
      fabric.push(box(1.88, 0.09, 0.42, -1.32, floorY + 0.25, side * 0.42));
      fabric.push(box(1.88, 0.16, 0.05, -1.32, floorY + 0.34, side * 0.62));
    }

    // mesa central (abaixada para não tapar as janelas)
    wood.push(box(0.86, 0.035, 0.52, -1.05, floorY + 0.34, 0));
    dark.push(cyl(0.025, 0.025, 0.32, -1.05, floorY + 0.17, 0, 0, 0, 0, 8));

    // cozinha a boreste, à proa da mesa
    wood.push(box(0.62, 0.46, 0.44, 0.30, floorY + 0.23, -0.42));
    dark.push(box(0.30, 0.03, 0.30, 0.30, floorY + 0.47, -0.42)); // cooktop
    // armário a bombordo
    wood.push(box(0.62, 0.46, 0.40, 0.30, floorY + 0.23, 0.44));
    fabric.push(box(0.60, 0.06, 0.38, 0.30, floorY + 0.49, 0.44));

    // anteparo de proa (fundo da cabine)
    wood.push(box(0.05, 0.70, 1.34, 0.80, floorY + 0.36, 0));

    // casa de máquinas: motor visível pela escotilha de entrada
    dark.push(box(0.62, 0.34, 0.62, -2.05, floorY + 0.17, 0));
    dark.push(cyl(0.10, 0.10, 0.30, -2.05, floorY + 0.36, -0.14, 0, 0, 0, 10));
    metalInterior.push(cyl(0.03, 0.03, 0.55, -2.05, floorY + 0.20, 0.20, 0, 0, Math.PI / 2, 8));

    // painel de instrumentos (tela emissiva) no anteparo de proa
    screens.push(box(0.012, 0.16, 0.24, 0.775, floorY + 0.52, 0.22));

    // luzes do teto (emissivas)
    for (const x of [-1.55, -0.55, 0.35]) {
      lamps.push(box(0.42, 0.014, 0.16, x, c.top - 0.06, 0));
    }

    // forro do teto: superfície clara que devolve a luz das luminárias
    wood.push(box(3.20, 0.02, 1.28, -0.66, c.top - 0.03, 0));
    this.addMerged(wood, this.woodMaterial, { name: 'interior-madeira' });
    this.addMerged(fabric, this.fabricMaterial, { name: 'interior-almofadas' });
    this.addMerged(dark, this.darkMaterial, { name: 'interior-maquinas' });
    this.addMerged(metalInterior, this.metalMaterial, { name: 'interior-tubos' });
    this.addMerged(screens, this.screenMaterial, { name: 'interior-painel' });
    this.addMerged(lamps, this.lampMaterial, { name: 'interior-luzes' });

    // luz quente da cabine: aparece pelas janelas ao entardecer
    this.cabinLight = new THREE.PointLight(0xffd7a8, 3.4, 6.0, 2.0);
    this.cabinLight.position.set(-0.7, 0.55, 0);
    this.model.add(this.cabinLight);
  }

  // ----------------------------------------------------------------- cockpit
  buildCockpit() {
    const k = this.cockpit;
    const shell = [];
    const wood = [];
    const fabric = [];
    const metal = [];
    const dark = [];

    const zc = k.halfZ;
    const x0 = k.x0;
    const x1 = k.x1;
    const sole = k.sole;
    const deckTop = 0.03;

    // fundo do poço
    wood.push(box(x1 - x0, 0.04, zc * 2, (x0 + x1) / 2, sole, 0));
    // paredes do poço
    shell.push(box(0.06, deckTop - sole, zc * 2, x1, (deckTop + sole) / 2, 0));
    shell.push(box(0.06, deckTop - sole, zc * 2, x0, (deckTop + sole) / 2, 0));
    for (const side of [-1, 1]) {
      shell.push(box(x1 - x0, deckTop - sole, 0.06, (x0 + x1) / 2, (deckTop + sole) / 2, side * zc));
    }

    // bancos laterais + almofadas
    for (const side of [-1, 1]) {
      wood.push(box(0.92, 0.26, 0.30, -3.02, sole + 0.15, side * 0.55));
      fabric.push(box(0.88, 0.09, 0.28, -3.02, sole + 0.32, side * 0.55));
    }

    // banco de popa
    wood.push(box(0.24, 0.26, zc * 1.8, x0 + 0.16, sole + 0.15, 0));
    fabric.push(box(0.22, 0.09, zc * 1.75, x0 + 0.16, sole + 0.32, 0));

    // ---- coluna do leme no MEIO do cockpit (não colada no casario) ----
    const wheelX = -3.02;
    const wheelY = 0.66;
    const soleY = k.sole;

    // pedestal cônico + base
    metal.push(cyl(0.075, 0.11, wheelY - soleY - 0.10, wheelX, (wheelY + soleY) / 2 - 0.02, 0, 0, 0, 0, 14));
    metal.push(cyl(0.20, 0.24, 0.05, wheelX, soleY + 0.03, 0, 0, 0, 0, 16));
    // mesa do pedestal (onde vão instrumentos)
    dark.push(box(0.30, 0.06, 0.42, wheelX, wheelY - 0.12, 0, 0, 0, 0));
    // compasso
    metal.push(place(new THREE.SphereGeometry(0.048, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), wheelX, wheelY + 0.05, 0));
    // manete do acelerador no pedestal
    dark.push(cyl(0.016, 0.020, 0.22, wheelX + 0.16, wheelY - 0.06, 0.12, 0, 0, -0.5, 8));

    this.addMerged(shell, this.cabinMaterial, { name: 'cockpit-poco' });

    // ---- roda do leme separada: gira junto com o leme ----
    const wheelGroup = new THREE.Group();
    wheelGroup.position.set(wheelX, wheelY, 0);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.45, metalness: 0.55 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.022, 10, 40), rimMat);
    rim.rotation.y = Math.PI / 2;
    wheelGroup.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.09, 12), this.metalMaterial);
    hub.rotation.z = Math.PI / 2;
    wheelGroup.add(hub);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.29, 0.016), this.metalMaterial);
      spoke.position.set(0, Math.cos(a) * 0.148, Math.sin(a) * 0.148);
      spoke.rotation.x = a;
      wheelGroup.add(spoke);
    }
    // manivelas do leme (as "manivelas" de verdade, no aro)
    for (const a of [0.4, 2.5, 4.4]) {
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.10, 8), rimMat);
      knob.position.set(0, Math.cos(a) * 0.30, Math.sin(a) * 0.30);
      knob.rotation.x = a + Math.PI / 2;
      wheelGroup.add(knob);
    }
    wheelGroup.name = 'roda-do-leme';
    this.model.add(wheelGroup);
    this.wheel = wheelGroup;
    this.wheelAngle = 0;

    this.addMerged(shell, this.cabinMaterial, { name: 'cockpit-poco' });
    this.addMerged(wood, this.varnishMaterial, { name: 'cockpit-madeira' });
    this.addMerged(fabric, this.fabricMaterial, { name: 'cockpit-almofadas' });
    this.addMerged(metal, this.metalMaterial, { name: 'cockpit-metal' });
    this.addMerged(dark, this.darkMaterial, { name: 'cockpit-leme' });
  }

  // ----------------------------------------------------------------- armação
  buildRig() {
    const c = this.cabin;
    const metal = [];
    const wires = [];

    const mastX = 0.62;
    const mastBase = c.top + 0.04;
    const mastTop = 8.4;

    metal.push(cyl(0.062, 0.088, mastTop, mastX, mastBase + mastTop / 2, 0, 0, 0, 0, 14));

    const boomY = mastBase + 1.55;
    metal.push(place(new THREE.CylinderGeometry(0.055, 0.055, 3.5, 12), mastX - 1.75, boomY, 0, 0, 0, Math.PI / 2));

    // retranca: pé de mastro e catraca
    metal.push(cyl(0.07, 0.09, 0.16, mastX, boomY - 0.10, 0, 0, 0, 0, 10));

    // ---- vela grande ----
    const mainA = new THREE.Vector3(mastX + 0.02, boomY + 0.05, 0);
    const mainB = new THREE.Vector3(mastX - 3.44, boomY + 0.12, 0);
    const mainC = new THREE.Vector3(mastX + 0.02, boomY + 6.70, 0);
    const mainsail = new THREE.Mesh(this.buildSail(mainA, mainB, mainC, 0.16, 0.55), this.sailMaterial());
    mainsail.name = 'vela-grande';
    this.model.add(mainsail);
    this.mainsail = mainsail;

    // ---- bujarrona ----
    const jibA = new THREE.Vector3(3.72, 0.32, 0);
    const jibB = new THREE.Vector3(0.24, boomY - 0.30, 0);
    const jibC = new THREE.Vector3(mastX + 0.02, boomY + 5.10, 0);
    const jib = new THREE.Mesh(this.buildSail(jibA, jibB, jibC, 0.14, 0.42), this.sailMaterial());
    jib.name = 'bujarrona';
    this.model.add(jib);
    this.jib = jib;

    this.equipment.sailArea = 0.5 * 3.5 * 6.7 + 0.5 * 3.5 * 5.0;

    // ---- cabos ----
    const head = new THREE.Vector3(mastX, mastBase + mastTop - 0.20, 0);
    wires.push(tube([[3.74, 0.30, 0], [head.x, head.y, head.z]], 0.012, 12));
    wires.push(tube([[-4.10, 0.24, 0], [head.x, head.y, head.z]], 0.011, 12));
    for (const side of [-1, 1]) {
      wires.push(
        tube(
          [
            [mastX, mastBase + mastTop - 0.95, 0],
            [-0.5, 0.06, side * 1.18],
          ],
          0.010,
          10
        )
      );
    }

    this.addMerged(metal, this.metalMaterial, { name: 'mastro-metal' });
    this.addMerged(wires, this.darkMaterial, { name: 'cabos' });
  }

  sailMaterial() {
    if (!this._sailMaterial) {
      this._sailMaterial = new THREE.MeshStandardMaterial({
        map: this.materials.sail,
        color: 0xfbfaf6,
        roughness: 0.86,
        metalness: 0.0,
        side: THREE.DoubleSide,
        envMapIntensity: 0.8,
      });
    }
    return this._sailMaterial;
  }

  /** Vela curva entre três pontos (punho, escota, cabeça). */
  buildSail(a, b, c, camber, twist) {
    const NU = 20;
    const NV = 18;
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

  // ----------------------------------------------------------------- detalhes
  buildFittings() {
    const metal = [];
    const dark = [];
    const lamps = [];
    const trim = [];

    // quilha + bulbo
    dark.push(box(1.02, 1.10, 0.13, 0.25, -1.45, 0));
    dark.push(place(new THREE.SphereGeometry(0.20, 16, 10).scale(2.4, 1.0, 1.0), 0.25, -1.95, 0));

    // leme
    dark.push(box(0.62, 0.88, 0.09, -3.58, -0.62, 0));

    // poitas
    for (const side of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const u = -0.45 + i * 0.42;
        metal.push(box(0.14, 0.045, 0.05, (u * this.length) / 2, this.deckY(u) + 0.05, side * this.halfWidth(u) * 0.85));
      }
    }

    // catracas do mastro
    for (const side of [-1, 1]) {
      metal.push(cyl(0.058, 0.07, 0.13, -0.55, 0.10, side * 0.62, 0, 0, 0, 12));
    }

    // guarda-corpo + balaústres
    for (const side of [-1, 1]) {
      const pts = [];
      const stanchions = [];
      for (let i = 0; i <= 12; i++) {
        const u = -0.86 + (1.72 * i) / 12;
        const w = this.halfWidth(u) * 0.90;
        const y = this.deckY(u) + 0.62;
        pts.push([(u * this.length) / 2, y, side * w]);
        stanchions.push([(u * this.length) / 2, this.deckY(u), side * w]);
      }
      metal.push(tube(pts, 0.015, 40, 6));
      for (const [x, y, z] of stanchions) {
        metal.push(cyl(0.017, 0.017, 0.62, x, y + 0.31, z, 0, 0, 0, 6));
      }
      // linha de vida inferior
      const lower = pts.map(([x, y, z]) => [x, y - 0.28, z]);
      metal.push(tube(lower, 0.008, 40, 5));
    }

    // púlpito de proa e popa
    for (const stern of [1, -1]) {
      const x = stern > 0 ? 3.95 : -3.85;
      const w = this.halfWidth((x / this.length) * 2) * 0.72;
      metal.push(
        tube(
          [
            [x - stern * 0.55, this.deckY(x / 4.2) + 0.02, w],
            [x, this.deckY(x / 4.2) + 0.55, w * 0.75],
            [x + stern * 0.18, this.deckY(x / 4.2) + 0.58, 0],
            [x, this.deckY(x / 4.2) + 0.55, -w * 0.75],
            [x - stern * 0.55, this.deckY(x / 4.2) + 0.02, -w],
          ],
          0.018,
          28,
          6
        )
      );
    }

    // gio de proa (anchor roller)
    metal.push(box(0.42, 0.05, 0.10, 4.02, 0.20, 0));

    // luzes de navegação: bombordo (vermelha) e boreste (verde)
    const red = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.10, 0.10).multiplyScalar(1.6) });
    const green = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.10, 1.0, 0.35).multiplyScalar(1.6) });
    const lampRed = new THREE.Mesh(box(0.07, 0.07, 0.07, 3.55, 0.55, -0.52), red);
    const lampGreen = new THREE.Mesh(box(0.07, 0.07, 0.07, 3.55, 0.55, 0.52), green);
    this.model.add(lampRed, lampGreen);

    // corrimão do teto
    for (const side of [-1, 1]) {
      trim.push(tube([[-2.05, 0.88, side * 0.62], [-0.9, 0.90, side * 0.66], [0.35, 0.88, side * 0.62]], 0.016, 12, 6));
    }

    // catracas (winches) com manivela, onde o cockpit encontra o casario
    this.winches = [];
    for (const side of [-1, 1]) {
      const wx = -2.52;
      const wz = side * 0.64;
      const base = this.deckY(wx / 4.2) + 0.02;
      metal.push(cyl(0.085, 0.10, 0.02, wx, base + 0.01, wz, 0, 0, 0, 14));
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.075, 0.13, 14), this.metalMaterial);
      drum.position.set(wx, base + 0.09, wz);
      this.model.add(drum);
      // manivela
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.26, 8), this.metalMaterial);
      handle.position.set(wx + 0.10, base + 0.14, wz);
      handle.rotation.z = Math.PI / 2 - 0.5;
      this.model.add(handle);
      this.winches.push({ drum, base: 0 });
    }

    this.addMerged(metal, this.metalMaterial, { name: 'ferragens' });
    this.addMerged(dark, this.darkMaterial, { name: 'quilha' });
    this.addMerged(trim, this.trimMaterial, { name: 'corrimao' });
  }

  /** Ajustes finais: ordem de desenho do vidro e materiais compartilhados. */
  finish() {
    for (const g of this.glassMeshes) {
      g.renderOrder = 4;
      g.material.depthWrite = false;
    }
    // o vidro precisa ser desenhado depois do interior e das velas
    this.model.traverse((o) => {
      if (o.isMesh && o.material === this.glassMaterial) o.renderOrder = 4;
    });
  }

  // ------------------------------------------------------------------ física
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

    let immersed = 0;
    for (const p of probes) immersed += p.volume * clamp(0.5 - p.local.y / p.size, 0, 1);
    const targetMass = 6000;
    const formFactor = targetMass / (immersed * 1025);
    for (const p of probes) p.volume *= formFactor;

    this.displacement = immersed * formFactor;
    this.mass = targetMass;
    this.totalProbeVolume = probes.reduce((s, p) => s + p.volume, 0);
    this.designWaterline = 0;
  }

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

  /**
   * Mecânica visível: o volante gira com o leme e as catracas giram quando há
   * regulagem de vela. É o que mostra "por dentro" que o barco está vivo.
   */
  updateMechanics(dt, rudder = 0, speed = 0) {
    if (this.wheel) {
      const target = this.wheelAngle + rudder * dt * 3.2;
      this.wheelAngle += (target - this.wheelAngle) * Math.min(1, dt * 6);
      this.wheel.rotation.x = this.wheelAngle;
    }
    if (this.winches) {
      for (let i = 0; i < this.winches.length; i++) {
        const w = this.winches[i];
        w.drum.rotation.y += dt * (0.35 + 0.5 * Math.abs(rudder)) * (i % 2 === 0 ? 1 : -1);
      }
    }
  }

  /** Ajusta a luz interna conforme a hora do dia (a cabine acende ao anoitecer). */
  updateInterior(dt, daylight) {
    if (!this.cabinLight) return;
    const target = 1.1 + 3.0 * (1 - clamp(daylight * 1.6, 0, 1));
    this.cabinLight.intensity += (target - this.cabinLight.intensity) * Math.min(1, dt * 2);
  }
}
