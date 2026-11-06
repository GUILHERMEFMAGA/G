/**
 * Campo de ondas oceânicas.
 *
 * As ondas são geradas a partir de um espectro de energia JONSWAP (o modelo
 * clássico para mares gerados por vento), discretizado em um conjunto finito de
 * componentes de Gerstner. Cada componente respeita a relação de dispersão de
 * águas profundas  ω² = g·k  — ou seja, ondas longas viajam mais rápido que as
 * curtas, o que é o que dá ao mar a sua aparência característica.
 *
 * O MESMO campo de ondas alimenta:
 *   1. o shader da GPU (deslocamento + normais + Jacobiano para a espuma);
 *   2. a física de flutuação na CPU (altura e velocidade orbital da água).
 * Assim o barco não "flutua no vazio": ele responde exatamente ao mar desenhado.
 */

import { G, clamp, mulberry32, degToRad } from '../util/math.js';

export const SWELL_COUNT = 16; // ondas que deformam a geometria
export const DETAIL_COUNT = 14; // ondulações finas (apenas normais, no shader)
const DEFAULT_SEED = 20241106;

/** Densidade espectral JONSWAP em frequência angular (m²·s). */
export function jonswap(omega, U10, gamma = 3.3) {
  const alpha = 0.0081;
  const wp = (0.877 * G) / Math.max(U10, 0.5);
  const sigma = omega <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((omega - wp) ** 2) / (2 * sigma * sigma * wp * wp));
  const base = ((alpha * G * G) / omega ** 5) * Math.exp(-1.25 * (wp / omega) ** 4);
  return base * gamma ** r;
}

/**
 * Discretiza uma faixa de frequências em componentes de Gerstner.
 * Retorna também o Jacobiano médio para controle de instabilidade.
 */
function spectralBand({
  rng,
  windSpeed,
  count,
  omegaMin,
  omegaMax,
  dirRad,
  targetHs,
  choppiness,
  spreadBase,
  normalizeBySlope = false,
  slopeTarget = 0.55,
  crossFraction = 0,
  crossAngle = 0.95,
  crossAmp = 0.6,
}) {
  const dw = (omegaMax - omegaMin) / count;
  const waves = [];
  let variance = 0;

  for (let i = 0; i < count; i++) {
    const omega = omegaMin + (i + 0.5) * dw;
    const k = (omega * omega) / G;
    let amp = Math.sqrt(Math.max(0, 2 * jonswap(omega, windSpeed) * dw));
    if (!Number.isFinite(amp) || amp <= 0) amp = 1e-5;

    // Espalhamento direcional: quanto mais curta a onda, mais aberto é o leque.
    const omegaPeak = (0.877 * G) / Math.max(windSpeed, 0.5);
    const spread = Math.min(1.45, spreadBase + 0.30 * (omega / omegaPeak));
    const r = ((rng() + rng() + rng()) / 3) * 2 - 1; // triangular em [-1, 1]

    // Mar cruzado: parte da energia vem de um sistema secundário, o que quebra
    // as cristas paralelas e deixa o mar muito mais convincente.
    const isCross = crossFraction > 0 && rng() < crossFraction;
    const ang = dirRad + (isCross ? crossAngle : 0) + r * spread;
    if (isCross) amp *= crossAmp;

    waves.push({
      dirX: Math.sin(ang),
      dirZ: Math.cos(ang),
      k,
      omega,
      amp,
      phase: rng() * Math.PI * 2,
      qx: 0,
      qz: 0,
    });
    variance += 0.5 * amp * amp;
  }

  // Normalização
  if (normalizeBySlope) {
    let slope = 0;
    for (const w of waves) slope += w.k * w.amp;
    const scale = slopeTarget / Math.max(slope, 1e-9);
    for (const w of waves) w.amp *= scale;
  } else {
    const hsNow = 4 * Math.sqrt(Math.max(variance, 1e-12));
    const scale = targetHs / Math.max(hsNow, 1e-6);
    for (const w of waves) w.amp *= scale;
  }

  // Choppiness: achatamento das cristas. Distribui o "orçamento de declividade"
  // proporcionalmente à declividade de cada componente (fisicamente plausível),
  // limitando o deslocamento horizontal por onda a λ/4π para não auto-intersectar.
  let steep = 0;
  for (const w of waves) steep += w.k * w.amp;
  const qGlobal = steep > 1e-9 ? clamp(choppiness / steep, 0, 2.5) : 0;
  for (const w of waves) {
    const maxQa = 0.42 / Math.max(w.k, 1e-5);
    const qa = Math.min(qGlobal * w.amp, maxQa);
    w.qx = qa * w.dirX;
    w.qz = qa * w.dirZ;
  }

  return waves;
}

export class WaveField {
  constructor(opts = {}) {
    this.count = SWELL_COUNT;
    this.detailCount = DETAIL_COUNT;
    this.seed = opts.seed ?? DEFAULT_SEED;
    this.windSpeed = opts.windSpeed ?? 10.5;
    this.windDirDeg = opts.windDirDeg ?? 215;
    this.hsScale = opts.hsScale ?? 0.9;
    this.choppiness = opts.choppiness ?? 0.72;
    this.detailSlope = 0.55;

    this.swellA = new Float32Array(this.count * 4);
    this.swellB = new Float32Array(this.count * 4);
    this.detailA = new Float32Array(this.detailCount * 4);
    this.detailB = new Float32Array(this.detailCount * 4);

    this._surface = { y: 0, vx: 0, vy: 0, vz: 0 };
    this.rebuild();
  }

  /** Recalcula o espectro (a cada mudança de vento / escala de onda). */
  rebuild() {
    const rng = mulberry32(this.seed);
    const U = Math.max(0.8, this.windSpeed);
    const dirRad = degToRad(this.windDirDeg);
    const hsTarget = clamp((0.21 * U * U) / G * this.hsScale, 0.02, 11);

    // ---- marulho principal (14 m … 300 m) ----
    const swell = spectralBand({
      rng,
      windSpeed: U,
      count: this.count,
      omegaMin: (2 * Math.PI) / 14,
      omegaMax: (2 * Math.PI) / 3.0,
      dirRad,
      targetHs: hsTarget,
      choppiness: this.choppiness,
      spreadBase: 0.30,
      crossFraction: 0.3,
      crossAngle: 1.05,
      crossAmp: 0.62,
    });

    // ---- ondulações finas (0.35 m … 10 m) : apenas normais ----
    const detail = spectralBand({
      rng,
      windSpeed: U,
      count: this.detailCount,
      omegaMin: (2 * Math.PI) / 2.6,
      omegaMax: (2 * Math.PI) / 0.35,
      dirRad,
      targetHs: 0,
      choppiness: 0.2,
      spreadBase: 0.75,
      normalizeBySlope: true,
      slopeTarget: this.detailSlope,
      crossFraction: 0.35,
      crossAngle: 1.4,
      crossAmp: 0.8,
    });

    this.swell = swell;
    this.detail = detail;

    // vetores planos para upload de uniforms
    let maxAmp = 0;
    let variance = 0;
    let steep = 0;
    for (let i = 0; i < this.count; i++) {
      const w = swell[i];
      this.swellA[i * 4 + 0] = w.k * w.dirX;
      this.swellA[i * 4 + 1] = w.k * w.dirZ;
      this.swellA[i * 4 + 2] = w.omega;
      this.swellA[i * 4 + 3] = w.phase;
      this.swellB[i * 4 + 0] = w.qx;
      this.swellB[i * 4 + 1] = w.qz;
      this.swellB[i * 4 + 2] = w.amp;
      this.swellB[i * 4 + 3] = 0;
      maxAmp += w.amp;
      variance += 0.5 * w.amp * w.amp;
      steep += w.k * w.amp;
    }
    for (let i = 0; i < this.detailCount; i++) {
      const w = detail[i];
      this.detailA[i * 4 + 0] = w.k * w.dirX;
      this.detailA[i * 4 + 1] = w.k * w.dirZ;
      this.detailA[i * 4 + 2] = w.omega;
      this.detailA[i * 4 + 3] = w.phase;
      this.detailB[i * 4 + 0] = 0;
      this.detailB[i * 4 + 1] = 0;
      this.detailB[i * 4 + 2] = w.amp;
      this.detailB[i * 4 + 3] = 0;
    }

    this.maxAmp = maxAmp;
    this.hs = 4 * Math.sqrt(Math.max(variance, 0));
    this.steepness = steep;
    this.peakPeriod = (2 * Math.PI * Math.max(U, 0.8)) / (0.877 * G);
    this.peakWavelength = ((2 * Math.PI) / (((0.877 * G) / Math.max(U, 0.8)) ** 2)) * G;

    // direção de propagação (para espuma / HUD)
    this.windDir = { x: Math.sin(dirRad), z: Math.cos(dirRad) };
    return this;
  }

  setWind(speed, dirDeg) {
    this.windSpeed = speed;
    if (dirDeg !== undefined) this.windDirDeg = dirDeg;
    return this.rebuild();
  }

  setHsScale(s) {
    this.hsScale = s;
    return this.rebuild();
  }

  setChoppiness(c) {
    this.choppiness = c;
    return this.rebuild();
  }

  /**
   * Altura da superfície em (x, z) no instante t.
   * Gerstner não é invertível analiticamente: iteramos o mapeamento
   * horizontal algumas vezes (converge muito rápido para ondas reais).
   */
  sampleHeight(x, z, t) {
    const n = this.count;
    const A = this.swell;
    let bx = x;
    let bz = z;

    for (let it = 0; it < 3; it++) {
      let dx = 0;
      let dz = 0;
      for (let i = 0; i < n; i++) {
        const w = A[i];
        const th = w.k * (w.dirX * bx + w.dirZ * bz) - w.omega * t + w.phase;
        const c = Math.cos(th);
        dx += w.qx * c;
        dz += w.qz * c;
      }
      bx = x + dx;
      bz = z + dz;
    }

    let y = 0;
    for (let i = 0; i < n; i++) {
      const w = A[i];
      const th = w.k * (w.dirX * bx + w.dirZ * bz) - w.omega * t + w.phase;
      y += w.amp * Math.sin(th);
    }
    return y;
  }

  /**
   * Altura + velocidade orbital da água (usada como velocidade do fluido no
   * arrasto hidrodinâmico). Reutiliza o objeto interno para evitar GC.
   */
  sampleSurface(x, z, t, out = this._surface, iterations = 3) {
    const n = this.count;
    const A = this.swell;
    let bx = x;
    let bz = z;

    for (let it = 0; it < iterations; it++) {
      let dx = 0;
      let dz = 0;
      for (let i = 0; i < n; i++) {
        const w = A[i];
        const th = w.k * (w.dirX * bx + w.dirZ * bz) - w.omega * t + w.phase;
        const c = Math.cos(th);
        dx += w.qx * c;
        dz += w.qz * c;
      }
      bx = x + dx;
      bz = z + dz;
    }

    let y = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    for (let i = 0; i < n; i++) {
      const w = A[i];
      const th = w.k * (w.dirX * bx + w.dirZ * bz) - w.omega * t + w.phase;
      const s = Math.sin(th);
      const c = Math.cos(th);
      y += w.amp * s;
      vy -= w.amp * w.omega * c;
      vx -= w.qx * w.omega * s;
      vz -= w.qz * w.omega * s;
    }

    out.y = y;
    out.vx = vx;
    out.vy = vy;
    out.vz = vz;
    return out;
  }
}
