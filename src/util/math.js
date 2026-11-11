// Utilidades matemáticas compartilhadas por simulação, GPU e HUD.

export const G = 9.81; // gravidade (m/s²)
export const RHO_WATER = 1025; // densidade da água do mar (kg/m³)
export const RHO_AIR = 1.225; // densidade do ar (kg/m³)

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function degToRad(d) {
  return (d * Math.PI) / 180;
}

export function radToDeg(r) {
  return (r * 180) / Math.PI;
}

/** PRNG determinístico (mulberry32) — garante que o oceano seja sempre o mesmo. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Escala Beaufort a partir da velocidade do vento em m/s (a 10 m de altura). */
export function beaufort(speed) {
  const limits = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let b = 0;
  while (b < limits.length && speed >= limits[b]) b++;
  const names = [
    'Calmo',
    'Bafagem',
    'Brisa leve',
    'Brisa fraca',
    'Brisa moderada',
    'Brisa fresca',
    'Vento fresco',
    'Ventania',
    'Ventania forte',
    'Tempestade',
    'Tempestade forte',
    'Tempestade violenta',
    'Furação',
  ];
  return { force: b, name: names[Math.min(b, names.length - 1)] };
}

/** Período de pico (s) a partir da velocidade do vento (mar totalmente desenvolvido). */
export function peakPeriod(windSpeed) {
  const U = Math.max(0.6, windSpeed);
  return (2 * Math.PI) / (0.877 * G / U);
}
