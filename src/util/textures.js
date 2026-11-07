/**
 * Texturas procedurais — nada é baixado da internet, tudo é gerado no cliente.
 *
 *  - createFoamTexture(): ruído fBm tileável em R/G e ruído "ridged" em B,
 *    usado para desenhar a espuma das cristas.
 *  - createWoodTexture(): convés de teca com juntas e veios.
 */

import * as THREE from 'three';

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoiseTileable(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const wrap = (n) => ((n % period) + period) % period;
  const x0 = wrap(xi);
  const x1 = wrap(xi + 1);
  const y0 = wrap(yi);
  const y1 = wrap(yi + 1);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

function fbmTileable(u, v, basePeriod, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoiseTileable(u * period, v * period, period, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

export function createFoamTexture(size = 512) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;

      // R: bolhas finas (espuma fresca, recém-formada)
      const fine = fbmTileable(u, v, 26, 4, 101);
      // G: malha média (a "renda" da crista quebrando)
      const mid = fbmTileable(u, v, 13, 5, 777);
      // B: estrutura grande, em cristas (ridged) — desenha as linhas de espuma
      const ridged = 1 - Math.abs(fbmTileable(u, v, 7, 5, 313) * 2 - 1);
      // A: pontilhado de micro-bolhas (o "salpicado" branco)
      const speckle = fbmTileable(u, v, 46, 3, 9001);

      const i = (y * size + x) * 4;
      data[i] = Math.round(fine * 255);
      data[i + 1] = Math.round(mid * 255);
      data[i + 2] = Math.round(ridged * 255);
      data[i + 3] = Math.round(speckle * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Mapa de normais tileável para as ondulações finas da superfície. */
export function createRippleNormalTexture(size = 512, strength = 2.2) {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // duas escalas para evitar padrão repetitivo
      height[y * size + x] =
        fbmTileable(u, v, 12, 5, 4111) * 0.55 +
        fbmTileable(u, v, 29, 4, 907) * 0.30 +
        fbmTileable(u, v, 58, 3, 3313) * 0.15;
    }
  }

  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength * size * 0.02;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength * size * 0.02;
      const nx = -dx;
      const ny = 1;
      const nz = -dy;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Convés de madeira (teca) desenhado em canvas. */
export function createWoodTexture(renderer = null) {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#b3844f';
  ctx.fillRect(0, 0, w, h);

  const planks = 10;
  const ph = h / planks;
  for (let p = 0; p < planks; p++) {
    const y0 = p * ph;
    const tone = 0.86 + Math.random() * 0.2;
    ctx.fillStyle = `rgb(${Math.round(179 * tone)}, ${Math.round(132 * tone)}, ${Math.round(79 * tone)})`;
    ctx.fillRect(0, y0, w, ph);

    // veios
    for (let g = 0; g < 26; g++) {
      const gy = y0 + Math.random() * ph;
      ctx.strokeStyle = `rgba(90, 60, 30, ${0.04 + Math.random() * 0.12})`;
      ctx.lineWidth = 0.6 + Math.random() * 1.4;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      for (let x = 0; x <= w; x += 32) {
        ctx.lineTo(x, gy + Math.sin((x / w) * 12 + g) * 1.6 + (Math.random() - 0.5) * 1.6);
      }
      ctx.stroke();
    }

    // calafeto (junta escura)
    ctx.fillStyle = 'rgba(24, 16, 10, 0.85)';
    ctx.fillRect(0, y0 + ph - 2, w, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 4;
  tex.needsUpdate = true;
  return tex;
}

/** Vela: tecido com costuras leves. */
export function createSailTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#efe9df';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = 'rgba(180, 174, 162, 0.55)';
  ctx.lineWidth = 1.2;
  for (let i = 1; i < 12; i++) {
    const x = (i / 12) * size;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(196, 190, 178, 0.4)';
  for (let i = 1; i < 8; i++) {
    const y = (i / 8) * size;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Superfícies do barco
// ---------------------------------------------------------------------------

/** Teca do convés: tábuas com calafeto, veio, juntas de topo e manchas de sal. */
export function createTeakTexture(renderer = null, size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberryLike(1337);

  ctx.fillStyle = '#9c7c56';
  ctx.fillRect(0, 0, size, size);

  const planks = 26;
  const ph = size / planks;
  for (let p = 0; p < planks; p++) {
    const y0 = p * ph;
    const tone = 0.76 + rand() * 0.38;
    const r = Math.round(172 * tone);
    const g = Math.round(140 * tone);
    const b = Math.round(102 * tone);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y0, size, ph);

    // veio do veio: linhas longas e finas
    for (let k = 0; k < 52; k++) {
      const gy = y0 + rand() * ph;
      ctx.strokeStyle = `rgba(74, 50, 28, ${0.05 + rand() * 0.22})`;
      ctx.lineWidth = 0.4 + rand() * 1.5;
      ctx.beginPath();
      const phase = rand() * 10;
      for (let x = 0; x <= size; x += 28) {
        ctx.lineTo(x, gy + Math.sin((x / size) * 9 + phase) * 1.9 + Math.sin(x * 0.05 + phase) * 0.7);
      }
      ctx.stroke();
    }

    // juntas de topo (butt joints) — 2 por tábua, desalinhadas
    const joints = 2;
    for (let j = 0; j < joints; j++) {
      const jx = ((p * 0.37 + j * 0.53 + rand() * 0.12) % 1) * size;
      ctx.strokeStyle = 'rgba(28, 19, 11, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(jx, y0);
      ctx.lineTo(jx, y0 + ph);
      ctx.stroke();
    }

    // calafeto
    ctx.fillStyle = 'rgba(22, 15, 9, 0.92)';
    ctx.fillRect(0, y0 + ph - 2.5, size, 2.5);
    const bevel = ctx.createLinearGradient(0, y0, 0, y0 + ph);
    bevel.addColorStop(0, 'rgba(255, 240, 220, 0.16)');
    bevel.addColorStop(0.12, 'rgba(255, 240, 220, 0.0)');
    bevel.addColorStop(0.86, 'rgba(40, 26, 14, 0.0)');
    bevel.addColorStop(1, 'rgba(40, 26, 14, 0.22)');
    ctx.fillStyle = bevel;
    ctx.fillRect(0, y0, size, ph);
  }

  // fibras curtas cruzadas: quebra a uniformidade do veio
  for (let i = 0; i < 2600; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const len = 4 + rand() * 16;
    ctx.strokeStyle = `rgba(${rand() > 0.5 ? '250, 236, 214' : '58, 40, 22'}, ${0.02 + rand() * 0.05})`;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + len, cy + (rand() - 0.5) * 1.6);
    ctx.stroke();
  }

  // manchas de sal / água seca
  for (let i = 0; i < 120; i++) {
    const a = 0.012 + rand() * 0.035;
    ctx.fillStyle = `rgba(240, 246, 250, ${a})`;
    const cx = rand() * size;
    const cy = rand() * size;
    const rr = 10 + rand() * 90;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rr, rr * (0.25 + rand() * 0.5), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  tex.needsUpdate = true;
  return tex;
}

/** Gelcoat: branco levemente irregular ("orange peel") e micro riscos. */
export function createGelcoatTexture(size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const n = fbmTileable(u, v, 6, 4, 21) * 0.55 + fbmTileable(u, v, 24, 3, 55) * 0.45;
      // escorridos verticais (a água que escorre do convés mancha o casco)
      const run = fbmTileable(u, v * 0.18 + 0.37, 9, 3, 611);
      const streak = Math.pow(Math.max(0, run - 0.45) / 0.55, 1.6);
      const dirt = streak * 0.55 + Math.pow(Math.max(0, n - 0.52), 1.3) * 0.9;
      const shade = 238 + Math.round((n - 0.5) * 22 - dirt * 34);
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, shade + 2);
      data[i + 1] = Math.min(255, shade + 3);
      data[i + 2] = Math.min(255, shade + 5);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Tecido de algodão (almofadas) — trama fina em duas direções. */
export function createFabricTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberryLike(91);
  ctx.fillStyle = '#8d9aa6';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size; i += 2) {
    ctx.fillStyle = i % 4 === 0 ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
    ctx.fillRect(0, i, size, 1);
    ctx.fillRect(i, 0, 1, size);
  }
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(${rand() > 0.5 ? '255,255,255' : '0,0,0'}, ${0.02 + rand() * 0.04})`;
    ctx.fillRect(rand() * size, rand() * size, 2, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Painéis de madeira do interior (mogno claro). */
export function createInteriorWoodTexture(renderer = null, size = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberryLike(4242);
  ctx.fillStyle = '#8a5a34';
  ctx.fillRect(0, 0, size, size);
  const rows = 6;
  const ph = size / rows;
  for (let p = 0; p < rows; p++) {
    const tone = 0.9 + rand() * 0.2;
    ctx.fillStyle = `rgb(${Math.round(150 * tone)}, ${Math.round(98 * tone)}, ${Math.round(58 * tone)})`;
    ctx.fillRect(0, p * ph, size, ph);
    for (let k = 0; k < 22; k++) {
      const gy = p * ph + rand() * ph;
      ctx.strokeStyle = `rgba(70, 40, 20, ${0.05 + rand() * 0.1})`;
      ctx.lineWidth = 0.6 + rand() * 1.2;
      ctx.beginPath();
      for (let x = 0; x <= size; x += 24) ctx.lineTo(x, gy + Math.sin(x * 0.03 + k) * 1.4);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(40, 24, 12, 0.5)';
    ctx.fillRect(0, p * ph + ph - 1, size, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  tex.needsUpdate = true;
  return tex;
}

function mulberryLike(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
