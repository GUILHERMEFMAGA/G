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
      const n1 = fbmTileable(u, v, 4, 5, 101);
      const n2 = fbmTileable(u, v, 3, 6, 777);
      const ridged = 1 - Math.abs(fbmTileable(u, v, 5, 4, 313) * 2 - 1);
      const i = (y * size + x) * 4;
      data[i] = Math.round(n1 * 255);
      data[i + 1] = Math.round(n2 * 255);
      data[i + 2] = Math.round(ridged * 255);
      data[i + 3] = 255;
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
        fbmTileable(u, v, 8, 5, 4111) * 0.65 +
        fbmTileable(u, v, 17, 4, 907) * 0.35;
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
