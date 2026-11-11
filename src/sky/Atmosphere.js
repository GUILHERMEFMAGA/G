/**
 * Modelo atmosférico simplificado.
 *
 * A partir da hora do dia calcula a direção do sol e uma paleta de radiâncias
 * lineares (céu, horizonte, nuvens, sol) usada pelo céu, pela água e pelas
 * luzes da cena. Valores em unidades lineares — o tone mapping ACES do passe
 * final é quem "revela" a imagem.
 */

import * as THREE from 'three';
import { clamp, smoothstep, degToRad } from '../util/math.js';

const C = (r, g, b) => new THREE.Color(r, g, b);

const NIGHT_ZENITH = C(0.004, 0.007, 0.020);
const DAY_ZENITH = C(0.045, 0.160, 0.485);
const DUSK_ZENITH = C(0.040, 0.072, 0.220);

const NIGHT_HORIZON = C(0.010, 0.016, 0.038);
const DAY_HORIZON = C(0.310, 0.455, 0.760);
const DUSK_HORIZON = C(0.280, 0.330, 0.520);

const SUN_LOW = C(1.0, 0.36, 0.12);
const SUN_HIGH = C(1.0, 0.955, 0.890);
const SUNSET = C(1.05, 0.42, 0.12);

export class Atmosphere {
  constructor({ cloudCover = 0.35, hour = 17.4 } = {}) {
    this.hour = hour;
    this.cloudCover = cloudCover;

    this.sunDir = new THREE.Vector3(0.6, 0.3, 0.4).normalize();
    this.sunColor = new THREE.Color(1, 1, 1);
    this.sunRadiance = new THREE.Color(1, 1, 1);
    this.sunIntensity = 1;
    this.zenith = new THREE.Color();
    this.horizon = new THREE.Color();
    this.sunset = SUNSET.clone();
    this.cloudLit = new THREE.Color();
    this.cloudShadow = new THREE.Color();
    this.ambient = new THREE.Color();
    this.dayFactor = 1;
    this.nightFactor = 0;
    this.warmth = 0;

    this.update(hour, cloudCover);
  }

  update(hour, cloudCover = this.cloudCover) {
    this.hour = clamp(hour, 0, 24);
    this.cloudCover = cloudCover;

    // ---- posição do sol ----
    const t = clamp((this.hour - 6) / 12, 0, 1);
    let elevation;
    if (this.hour >= 6 && this.hour <= 18) {
      elevation = Math.sin(t * Math.PI) * degToRad(68);
    } else {
      const night = this.hour < 6 ? 6 - this.hour : this.hour - 18;
      elevation = -Math.min(1, night / 5.5) * degToRad(42);
    }
    const azimuth = degToRad(-95 + 190 * t);

    const ce = Math.cos(elevation);
    this.sunDir.set(ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth)).normalize();

    const sinEl = this.sunDir.y;
    this.dayFactor = smoothstep(-0.10, 0.16, sinEl);
    this.nightFactor = 1 - smoothstep(-0.20, 0.02, sinEl);
    this.warmth = (1 - smoothstep(0.05, 0.42, sinEl)) * smoothstep(-0.22, 0.0, sinEl);

    // ---- paleta ----
    const day = this.dayFactor;

    this.zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, day);
    this.zenith.lerp(DUSK_ZENITH, this.warmth * 0.38);

    this.horizon.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, day);
    this.horizon.lerp(DUSK_HORIZON, this.warmth * 0.30);

    this.sunColor.copy(SUN_LOW).lerp(SUN_HIGH, smoothstep(0.03, 0.42, sinEl));
    this.sunIntensity =
      3.4 * smoothstep(-0.02, 0.08, sinEl) * (0.26 + 0.74 * smoothstep(0.02, 0.6, sinEl));
    this.sunRadiance.copy(this.sunColor).multiplyScalar(this.sunIntensity);

    this.ambient.copy(this.zenith).lerp(this.horizon, 0.5);

    this.cloudLit
      .copy(this.sunRadiance)
      .multiplyScalar(0.26)
      .add(this.ambient.clone().multiplyScalar(0.95));
    this.cloudShadow.copy(this.ambient).multiplyScalar(0.55);

    return this;
  }

  /** Cor de fundo do horizonte usada na névoa atmosférica da água. */
  getHorizonColor(out = new THREE.Color()) {
    return out.copy(this.horizon);
  }

  /** Fator de luminosidade para colorir a água sem "brilhar" à noite. */
  get daylight() {
    return 0.12 + 0.88 * this.dayFactor;
  }
}
