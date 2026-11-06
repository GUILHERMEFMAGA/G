/**
 * Teste de bancada da física de flutuação (sem navegador).
 * Simula o barco em mar parado e em mar de vento e imprime os estados.
 * Uso: npm run test:physics
 */

// stub mínimo de canvas para as texturas procedurais
const ctxStub = new Proxy(
  {},
  {
    get: (target, prop) => (prop in target ? target[prop] : () => {}),
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  }
);
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
};

const THREE = await import('three');
const { Boat } = await import('../src/boat/Boat.js');
const { WaveField } = await import('../src/waves/WaveField.js');
const { BoatPhysics } = await import('../src/physics/BoatPhysics.js');

const params = {
  buoyancy: 1,
  drag: 1,
  keelDrag: 1,
  angularDamping: 1.1,
  windSail: 1,
  gravityScale: 1,
};

function simulate(label, { windSpeed, seconds = 60, thrust = 0, rudder = 0 }) {
  const waveField = new WaveField({ windSpeed, windDirDeg: 215 });
  const boat = new Boat({ renderer: null });
  const physics = new BoatPhysics({ boat, waveField, heading: 0.62 });

  console.log(`\n--- ${label} ---`);
  console.log(
    `massa ${(boat.mass / 1000).toFixed(2)} t | sondas ${boat.probes.length} | deslocamento ${boat.displacement.toFixed(2)} m³`
  );
  console.log(
    `Hs=${waveField.hs.toFixed(2)} m | Tp=${waveField.peakPeriod.toFixed(1)} s | Λp=${waveField.peakWavelength.toFixed(0)} m | maxAmp=${waveField.maxAmp.toFixed(2)}`
  );

  const dt = 1 / 60;
  let t = 0;
  const t0 = performance.now();
  const samples = [];
  for (let i = 0; i < seconds * 60; i++) {
    t += dt;
    physics.update(dt, t, params, { thrust, rudder });
    if (i % 6 === 0) samples.push({ t, y: physics.position.y, roll: physics.roll, pitch: physics.pitch });
  }
  const elapsed = performance.now() - t0;

  const tail = samples.filter((s) => s.t > seconds * 0.6);
  const stat = (key) => {
    const arr = tail.map((s) => s[key]);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    return `média ${mean.toFixed(2)} | min ${min.toFixed(2)} | max ${max.toFixed(2)}`;
  };

  console.log(`  altura y   : ${stat('y')}`);
  console.log(`  banda      : ${stat('roll')}`);
  console.log(`  caturro    : ${stat('pitch')}`);
  console.log(
    `  calado     : ${physics.draft.toFixed(2)} m | submerso ${(physics.submergedFraction * 100).toFixed(0)}% | velocidade ${physics.speedKnots.toFixed(2)} kn`
  );
  console.log(`  custo      : ${(elapsed / (seconds * 60)).toFixed(3)} ms por passo de física`);

  const bad =
    !Number.isFinite(physics.position.y) ||
    !Number.isFinite(physics.roll) ||
    Math.abs(physics.position.y) > 30 ||
    physics.speedKnots > 60;
  if (bad) {
    console.log('  ⚠️  resultado instável!');
    process.exitCode = 1;
  }
  return { boat, physics, waveField };
}

simulate('mar calmo (vento 0,3 m/s)', { windSpeed: 0.3, seconds: 40 });
simulate('brisa fresca (vento 10,5 m/s)', { windSpeed: 10.5, seconds: 60 });
simulate('tempestade (vento 20 m/s)', { windSpeed: 20, seconds: 60 });
simulate('com propulsão (vento 10,5 m/s, W)', { windSpeed: 10.5, seconds: 60, thrust: 1 });

// validação do campo de ondas
const wf = new WaveField({ windSpeed: 10.5 });
let maxH = -Infinity;
let minH = Infinity;
for (let i = 0; i < 4000; i++) {
  const h = wf.sampleHeight((i % 97) * 3.1, Math.floor(i / 97) * 3.7, 12.3);
  if (h > maxH) maxH = h;
  if (h < minH) minH = h;
}
console.log(
  `\nCampo de ondas: amplitude observada ${minH.toFixed(2)} … ${maxH.toFixed(2)} m (Hs teórico ${wf.hs.toFixed(2)} m, soma das amplitudes ${wf.maxAmp.toFixed(2)} m)`
);
