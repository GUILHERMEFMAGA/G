/**
 * Física de corpo rígido com 6 graus de liberdade para o veleiro.
 *
 * Forças modeladas:
 *   • gravidade no centro de massa;
 *   • empuxo de Arquimedes distribuído em sondas volumétricas dentro do casco —
 *     é isso que faz o barco boiar, adernar e cabecear de forma correta;
 *   • arrasto hidrodinâmico quadrático por sonda, relativo à velocidade
 *     ORBITAL da água (a água não está parada: as ondas empurram o barco);
 *   • resistência lateral da quilha (evita derrapagem, gera banda);
 *   • força do vento nas velas, aplicada acima do centro de massa (gera banda);
 *   • propulsão e leme do piloto automático/manual.
 *
 * Integração semi-implícita de Euler com sub-passos fixos (estabilidade).
 */

import * as THREE from 'three';
import { RHO_WATER, RHO_AIR, G, clamp } from '../util/math.js';

const KNOT = 1.943844;

export class BoatPhysics {
  constructor({ boat, waveField, heading = 0.5 }) {
    this.boat = boat;
    this.waveField = waveField;

    this.position = new THREE.Vector3(0, 0.15, 0);
    this.quaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      heading
    );
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();

    this.mass = boat.mass;
    this.rho = RHO_WATER;
    this.gravity = G;

    // Lastro da quilha: parte da massa fica concentrada no bulbo, abaixo do
    // centro de massa. É o que dá o momento restaurador que reendireita o barco.
    this.ballastMass = boat.mass * 0.45;
    this.ballastLocal = new THREE.Vector3(0.15, -1.15, 0);

    const m = this.mass;
    const B = boat.beam;
    const L = boat.length;
    const D = boat.depth;

    // tensores de inércia (aproximação de caixa + contribuição do quilhe)
    this.inertia = new THREE.Vector3(
      (m * (B * B + D * D)) / 12 + 0.32 * m * 1.45 * 1.45, // roll  (X)
      (m * (L * L + B * B)) / 12, // yaw   (Y)
      (m * (L * L + D * D)) / 12 // pitch (Z)
    );

    this._surf = { y: 0, vx: 0, vy: 0, vz: 0 };
    this._F = new THREE.Vector3();
    this._T = new THREE.Vector3();
    this._r = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._vp = new THREE.Vector3();
    this._rel = new THREE.Vector3();
    this._wind = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._qInv = new THREE.Quaternion();
    this._dq = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._keelVec = new THREE.Vector3();
    this._tb = new THREE.Vector3();
    this._ab = new THREE.Vector3();
    this._alpha = new THREE.Vector3();

    this.time = 0;
    this.speedKnots = 0;
    this.roll = 0;
    this.pitch = 0;
    this.draft = 0;
    this.submergedFraction = 0;
  }

  setHeading(angle) {
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
  }

  reset() {
    this.position.set(0, 0.15, 0);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
  }

  update(dt, time, params, input = {}) {
    const clamped = Math.min(dt, 0.05);
    const steps = clamp(Math.ceil(clamped / (1 / 120)), 1, 8);
    const h = clamped / steps;
    for (let s = 0; s < steps; s++) this.integrate(h, time, params, input);
    this.readout();
  }

  integrate(h, time, params, input) {
    const { waveField, boat } = this;
    const q = this.quaternion;
    const gAccel = this.gravity * params.gravityScale;
    const F = this._F.set(0, -gAccel * (this.mass - this.ballastMass), 0);
    const T = this._T.set(0, 0, 0);
    const r = this._r;
    const p = this._p;
    const vp = this._vp;
    const rel = this._rel;
    const surf = this._surf;

    // peso do lastro (aplicado no bulbo, gera o momento de reendireitamento)
    {
      const gb = -gAccel * this.ballastMass;
      F.y += gb;
      const rb = this._r.copy(this.ballastLocal).applyQuaternion(q);
      T.x -= rb.z * gb;
      T.z += rb.x * gb;
    }

    const buoyancy = this.rho * this.gravity * params.buoyancy;
    const dragK = 0.5 * this.rho * params.drag;

    // ---------------- empuxo + arrasto por sonda ----------------
    let submerged = 0;
    let probeCount = 0;
    for (let i = 0; i < boat.probes.length; i++) {
      const probe = boat.probes[i];
      r.copy(probe.local).applyQuaternion(q);
      p.copy(this.position).add(r);
      waveField.sampleSurface(p.x, p.z, time, surf, 2);

      const sub = clamp((surf.y - p.y) / probe.size + 0.5, 0, 1);
      if (sub <= 0.001) continue;
      probeCount++;
      submerged += sub;

      // Arquimedes — força vertical, torque = r × F
      const fb = buoyancy * probe.volume * sub;
      F.y += fb;
      T.x -= r.z * fb;
      T.z += r.x * fb;

      // arrasto relativo à água em movimento
      vp.copy(this.angularVelocity).cross(r).add(this.velocity);
      rel.set(vp.x - surf.vx, vp.y - surf.vy, vp.z - surf.vz);
      const sp = rel.length();
      if (sp > 1e-4) {
        const k = dragK * probe.area * sp * sub;
        const fx = -rel.x * k;
        const fy = -rel.y * k;
        const fz = -rel.z * k;
        F.x += fx;
        F.y += fy;
        F.z += fz;
        T.x += r.y * fz - r.z * fy;
        T.y += r.z * fx - r.x * fz;
        T.z += r.x * fy - r.y * fx;
      }
    }
    this.submergedFraction = boat.probes.length ? submerged / boat.probes.length : 0;

    const fwd = this._fwd.set(1, 0, 0).applyQuaternion(q);
    const right = this._right.set(0, 0, 1).applyQuaternion(q);

    // ---------------- resistência lateral da quilha ----------------
    const lateralSpeed = this.velocity.dot(right);
    const keelForce = -lateralSpeed * params.keelDrag * this.mass;
    const keelVec = this._keelVec.copy(right).multiplyScalar(keelForce);
    F.add(keelVec);
    r.set(0.25, -1.05, 0).applyQuaternion(q);
    T.add(this._tmp.copy(r).cross(keelVec));

    // ---------------- vento nas velas ----------------
    const windSpeed = params.windSail > 0 ? waveField.windSpeed * params.windSail : 0;
    if (windSpeed > 0.01) {
      const wd = waveField.windDir;
      this._wind.set(wd.x * windSpeed, 0, wd.z * windSpeed);
      rel.copy(this.velocity).sub(this._wind);
      const relSpeed = rel.length();
      if (relSpeed > 1e-3) {
        const area = boat.equipment.sailArea * 1.1;
        const k = 0.5 * RHO_AIR * 1.15 * area * relSpeed;
        const fx = -rel.x * k;
        const fz = -rel.z * k;
        F.x += fx;
        F.z += fz;
        // ponto de aplicação alto: gera banda
        r.set(0.4, 1.7, 0).applyQuaternion(q);
        T.x += r.y * fz - r.z * 0;
        T.y += r.z * fx - r.x * fz;
        T.z += r.x * 0 - r.y * fx;
      }
    }

    // ---------------- propulsão e leme ----------------
    const thrust = input.thrust || 0;
    if (thrust !== 0) {
      F.addScaledVector(fwd, thrust * this.mass * 2.1);
      // torque de banda do hélice deslocado do eixo
      T.y += thrust * this.mass * 0.015;
    }
    const rudder = input.rudder || 0;
    if (rudder !== 0) {
      const forwardSpeed = this.velocity.dot(fwd);
      const eff = clamp(Math.abs(forwardSpeed) * 0.45 + 0.35, 0, 3.2);
      T.y += -rudder * this.mass * 0.55 * eff * (forwardSpeed < -0.2 ? -1 : 1);
    }

    // ---------------- amortecimento angular ----------------
    const iAvg = (this.inertia.x + this.inertia.y + this.inertia.z) / 3;
    T.addScaledVector(this.angularVelocity, -params.angularDamping * iAvg);

    // ---------------- integração ----------------
    this.velocity.addScaledVector(F, h / this.mass);
    // arrasto do ar no movimento geral (bem pequeno)
    this.velocity.multiplyScalar(1 - 0.02 * h);

    this._qInv.copy(q).invert();
    this._tb.copy(T).applyQuaternion(this._qInv);
    this._ab.set(
      this._tb.x / this.inertia.x,
      this._tb.y / this.inertia.y,
      this._tb.z / this.inertia.z
    );
    this._alpha.copy(this._ab).applyQuaternion(q);
    this.angularVelocity.addScaledVector(this._alpha, h);

    const wlen = this.angularVelocity.length();
    if (wlen > 7) this.angularVelocity.multiplyScalar(7 / wlen);

    this.position.addScaledVector(this.velocity, h);

    if (wlen > 1e-7) {
      this._axis.copy(this.angularVelocity).normalize();
      this._dq.setFromAxisAngle(this._axis, wlen * h);
      q.premultiply(this._dq).normalize();
    }
  }

  readout() {
    const fwd = this._fwd.set(1, 0, 0).applyQuaternion(this.quaternion);
    const right = this._right.set(0, 0, 1).applyQuaternion(this.quaternion);
    const up = this._up.set(0, 1, 0).applyQuaternion(this.quaternion);

    this.pitch = (Math.asin(clamp(fwd.y, -1, 1)) * 180) / Math.PI;
    this.roll = (-Math.atan2(right.y, up.y) * 180) / Math.PI;
    this.speedKnots = this.velocity.length() * KNOT;

    const p = this._p.set(0.25, -1.42, 0).applyQuaternion(this.quaternion).add(this.position);
    this.draft = Math.max(0, -p.y);

    this.boat.group.position.copy(this.position);
    this.boat.group.quaternion.copy(this.quaternion);
  }

  /** Altura da água sob o centro do barco (usada no HUD). */
  waterHeight(time) {
    return this.waveField.sampleHeight(this.position.x, this.position.z, time);
  }
}
