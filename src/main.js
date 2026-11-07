/**
 * OCEANO 3D — mar espectral em tempo real com física de flutuação.
 *
 * Pipeline por frame:
 *   1. física do barco (passo fixo de 1/120 s, acumulador) contra o mesmo campo
 *      de ondas que é desenhado;
 *   2. passe de reflexão (câmera espelhada, half-res, HDR) — em cadência
 *      reduzida quando o governador de quadro aperta;
 *   3. passe principal em HDR (céu + água + barco);
 *   4. passe final: exposição, ACES, vinheta e sRGB.
 *
 * Desempenho: a resolução de render é ajustada por um governador de quadro
 * (FrameGovernor) para manter o frame dentro do orçamento de 60 Hz, sem
 * oscilar. Nada é alocado dentro do loop.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { WaveField } from './waves/WaveField.js';
import { Ocean } from './ocean/Ocean.js';
import { Spray } from './ocean/Spray.js';
import { Sky } from './sky/Sky.js';
import { Atmosphere } from './sky/Atmosphere.js';
import { Boat } from './boat/Boat.js';
import { BoatPhysics } from './physics/BoatPhysics.js';
import { createFoamTexture, createRippleNormalTexture } from './util/textures.js';
import { FrameGovernor } from './util/Perf.js';
import { HUD } from './ui/HUD.js';
import { createGUI } from './ui/Gui.js';
import { beaufort, clamp, degToRad } from './util/math.js';

import postVertex from './shaders/post.vert.glsl?raw';
import postFragment from './shaders/post.frag.glsl?raw';

// ---------------------------------------------------------------------------
// Parâmetros
// ---------------------------------------------------------------------------
const params = {
  windSpeed: 10.5,
  windDir: 215,
  hsScale: 0.95,
  choppiness: 0.80,
  timeScale: 1,
  paused: false,

  foam: 0.8,
  foamThreshold: 0.88,
  sss: 1.0,
  detail: 1.0,
  roughness: 0.06,
  sunGlitter: 0.8,
  hullShadow: 1.0,

  hour: 14.2,
  cloudCover: 0.30,
  exposure: 1.12,
  vignette: 0.32,

  buoyancy: 1.0,
  drag: 1.0,
  keelDrag: 1.0,
  angularDamping: 1.1,
  windSail: 1.0,
  gravityScale: 1.0,
  showProbes: false,

  cameraMode: 'Órbita',
  fov: 52,
  cameraSmoothing: 1.0,

  autoQuality: true,
  targetFps: 50,
  resolutionScale: 1.0,
  reflectionScale: 0.45,
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  stencil: false,
  depth: true,
  powerPreference: 'high-performance',
});
const baseDpr = Math.min(window.devicePixelRatio || 1, 1.75);
let renderScale = 1;

renderer.setPixelRatio(baseDpr);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x05080c, 1);
// O tone mapping é feito no passe final: aqui tudo permanece linear (HDR).
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

const canFloat = renderer.extensions.has('EXT_color_buffer_float') ||
  renderer.extensions.has('EXT_color_buffer_half_float');
const hdrType = canFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
// MSAA custa memória de banda: 4 amostras em telas grandes e 2 em retina.
const msaaSamples = baseDpr > 1.5 ? 2 : 4;

const mainRT = new THREE.WebGLRenderTarget(2, 2, {
  type: hdrType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: true,
  stencilBuffer: false,
  samples: msaaSamples,
});

const reflRT = new THREE.WebGLRenderTarget(2, 2, {
  type: hdrType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: true,
  stencilBuffer: false,
});

// ---------------------------------------------------------------------------
// Cena
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(params.fov, window.innerWidth / window.innerHeight, 0.4, 42000);
const reflCam = new THREE.PerspectiveCamera(params.fov, window.innerWidth / window.innerHeight, 0.4, 42000);

const atmosphere = new Atmosphere({ hour: params.hour, cloudCover: params.cloudCover });
const waveField = new WaveField({
  windSpeed: params.windSpeed,
  windDirDeg: params.windDir,
  hsScale: params.hsScale,
  choppiness: params.choppiness,
});

const foamTexture = createFoamTexture(512);
const rippleTexture = createRippleNormalTexture(512);
const ocean = new Ocean({ waveField, foamTexture, rippleTexture });
const sky = new Sky({ radius: 21000 });
const spray = new Spray({ count: 2800 });
scene.add(spray.points);

const boat = new Boat({ renderer });
const physics = new BoatPhysics({ boat, waveField, heading: 0.62 });
boat.group.position.copy(physics.position);
boat.group.quaternion.copy(physics.quaternion);

const probesDebug = boat.createProbeDebug();
probesDebug.visible = false;

scene.add(sky.mesh);
scene.add(ocean.mesh);
scene.add(boat.group);

// luz direta do sol (o resto vem do environment map do céu)
const sunLight = new THREE.DirectionalLight(0xffffff, 2);
scene.add(sunLight);
scene.add(sunLight.target);

// ---------------------------------------------------------------------------
// Environment map (IBL) a partir do próprio céu
// ---------------------------------------------------------------------------
const envScene = new THREE.Scene();
const envSky = new Sky({ radius: 1200 });
envScene.add(envSky.mesh);
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileCubemapShader();
const envDummyCamera = new THREE.PerspectiveCamera();
let envTarget = null;

function rebuildEnvironment() {
  envSky.update(atmosphere, envDummyCamera, 0, waveField.windDir);
  const next = pmrem.fromScene(envScene, 0.02, 1, 5000);
  if (envTarget) envTarget.dispose();
  envTarget = next;
  scene.environment = envTarget.texture;
}

let envTimer = null;
function scheduleEnvironment(delay = 140) {
  clearTimeout(envTimer);
  envTimer = setTimeout(rebuildEnvironment, delay);
}

// ---------------------------------------------------------------------------
// Passe final
// ---------------------------------------------------------------------------
const postScene = new THREE.Scene();
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uScene: { value: null },
    uExposure: { value: params.exposure },
    uVignette: { value: params.vignette },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: postVertex,
  fragmentShader: postFragment,
  depthTest: false,
  depthWrite: false,
});
const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMaterial);
postQuad.frustumCulled = false;
postScene.add(postQuad);

// ---------------------------------------------------------------------------
// Câmera
// ---------------------------------------------------------------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.9;
controls.panSpeed = 0.6;
controls.minDistance = 6.5;
controls.maxDistance = 320;
controls.maxPolarAngle = Math.PI * 0.497;
controls.enablePan = false;
controls.screenSpacePanning = false;

const boatFocus = new THREE.Vector3().copy(boat.group.position).add(new THREE.Vector3(0, 1.0, 0));
const sunAzimuth = Math.atan2(atmosphere.sunDir.x, atmosphere.sunDir.z);
const viewAzimuth = sunAzimuth - degToRad(27);
const orbitRadius = 16.5;
camera.position.set(
  boat.group.position.x - Math.sin(viewAzimuth) * orbitRadius,
  2.45,
  boat.group.position.z - Math.cos(viewAzimuth) * orbitRadius
);
camera.lookAt(boatFocus);
controls.target.copy(boatFocus);
camera.updateProjectionMatrix();

const lookTarget = boatFocus.clone();
/** Alvo filtrado: o barco sobe e desce com as ondas; a câmera não precisa. */
const smoothFocus = boatFocus.clone();
const tmpVec = new THREE.Vector3();
const tmpVec2 = new THREE.Vector3();
const tmpVec3 = new THREE.Vector3();
const upVec = new THREE.Vector3(0, 1, 0);
const boatForward = new THREE.Vector3(1, 0, 0);
const boatHalfSize = new THREE.Vector2(boat.length * 0.5, boat.beam * 0.5);

// ---------------------------------------------------------------------------
// Entrada do usuário
// ---------------------------------------------------------------------------
const keys = new Set();
const input = { thrust: 0, rudder: 0 };

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    params.paused = !params.paused;
    e.preventDefault();
    return;
  }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// ---------------------------------------------------------------------------
// HUD + GUI
// ---------------------------------------------------------------------------
const hud = new HUD();
const underwaterEl = document.getElementById('underwater');
const loaderEl = document.getElementById('loader');

function refreshWaves() {
  waveField.windSpeed = params.windSpeed;
  waveField.windDirDeg = params.windDir;
  waveField.hsScale = params.hsScale;
  waveField.choppiness = params.choppiness;
  waveField.rebuild();
}

const governor = new FrameGovernor({ enabled: params.autoQuality, targetFps: params.targetFps });

const gui = createGUI(params, {
  onWind: refreshWaves,
  onReseed: () => {
    waveField.seed = Math.floor(Math.random() * 1e6);
    refreshWaves();
  },
  onSky: () => {
    atmosphere.update(params.hour, params.cloudCover);
    scheduleEnvironment(120);
  },
  onResetBoat: () => {
    physics.reset();
    physics.setHeading(0.62);
  },
  onCameraMode: (mode) => {
    if (mode === 'Órbita') {
      controls.target.copy(boat.group.position).add(upVec);
      controls.enabled = true;
    }
  },
  onFov: () => {
    camera.fov = params.fov;
    camera.updateProjectionMatrix();
  },
  onQualityMode: (auto) => {
    governor.setEnabled(auto);
    renderScale = governor.scale;
    resize();
  },
  onResolution: (s) => {
    governor.setManualScale(s);
    if (!params.autoQuality) {
      renderScale = s;
      resize();
    }
  },
});
gui.domElement.style.pointerEvents = 'auto';

// ---------------------------------------------------------------------------
// Render alvo / resize
// ---------------------------------------------------------------------------
function resizeTargets() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = baseDpr * renderScale;
  const pw = Math.max(2, Math.floor(w * dpr));
  const ph = Math.max(2, Math.floor(h * dpr));
  mainRT.setSize(pw, ph);
  const rs = params.autoQuality ? governor.reflectionScale : params.reflectionScale;
  reflRT.setSize(Math.max(2, Math.floor(pw * rs)), Math.max(2, Math.floor(ph * rs)));
  postMaterial.uniforms.uResolution.value.set(pw, ph);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(baseDpr * renderScale);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  resizeTargets();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const FIXED_STEP = 1 / 120;
let simTime = 137.4;
let elapsed = 0;
let simAccumulator = 0;
let wasUnderwater = false;
let frameIndex = 0;
let reflectionMatrix = new THREE.Matrix4().identity();
let lastFrameTime = performance.now();
let prevBowHeight = 0;
let sprayImpact = 0;

const stats = {
  fps: 50,
  ms: 16.7,
  quality: '100%',
  wind: params.windSpeed,
  hs: waveField.hs,
  tp: waveField.peakPeriod,
  wave: 0,
  knots: 0,
  roll: 0,
  pitch: 0,
  draft: 0,
  hour: params.hour,
  mass: boat.mass,
  beaufort: beaufort(params.windSpeed),
};

function updateCameraRig(dt) {
  const mode = params.cameraMode;
  const boatPos = boat.group.position;
  const smoothing = params.cameraSmoothing;

  // o alvo segue o barco, mas o sobe-e-desce das ondas é filtrado:
  // sem isso a câmera "treme" junto com o casco.
  const hRate = 1 - Math.exp(-dt * (10.0 * smoothing + 0.001));
  const vRate = 1 - Math.exp(-dt * (2.6 * smoothing + 0.001));
  smoothFocus.x += (boatPos.x - smoothFocus.x) * hRate;
  smoothFocus.z += (boatPos.z - smoothFocus.z) * hRate;
  smoothFocus.y += (boatPos.y + 1.0 - smoothFocus.y) * vRate;

  if (mode === 'Órbita') {
    controls.enabled = true;
    tmpVec.copy(smoothFocus);
    tmpVec2.copy(tmpVec).sub(controls.target);
    camera.position.add(tmpVec2); // a câmera acompanha a deriva do barco
    controls.target.copy(tmpVec);
    controls.update();
    if (camera.position.y < 0.45) camera.position.y = 0.45;
  } else if (mode === 'Perseguição') {
    controls.enabled = false;
    tmpVec3.set(1, 0, 0).applyQuaternion(boat.group.quaternion);
    tmpVec3.y = 0;
    tmpVec3.normalize();
    tmpVec.copy(smoothFocus)
      .addScaledVector(tmpVec3, -14.5)
      .add(tmpVec2.set(0, 3.6, 0));
    camera.position.lerp(tmpVec, 1 - Math.exp(-dt * 2.0));
    lookTarget.lerp(tmpVec2.copy(smoothFocus).add(tmpVec3.set(0, 0.3, 0)), 1 - Math.exp(-dt * 3.4));
    camera.lookAt(lookTarget);
  } else {
    controls.enabled = false;
    const t = elapsed;
    const az = t * 0.11;
    tmpVec.copy(boatPos).add(
      tmpVec2.set(-Math.sin(az) * 17.5, 3.6 + Math.sin(t * 0.19) * 1.4, -Math.cos(az) * 17.5)
    );
    camera.position.lerp(tmpVec, 1 - Math.exp(-dt * 1.4));
    lookTarget.lerp(tmpVec2.copy(boatPos).add(tmpVec3.set(0, 1.1, 0)), 1 - Math.exp(-dt * 3.0));
    camera.lookAt(lookTarget);
  }
}

function renderReflectionPass() {
  const camPos = camera.position;
  tmpVec.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const target = tmpVec2.copy(camPos).addScaledVector(tmpVec, 120);

  reflCam.position.set(camPos.x, -camPos.y, camPos.z);
  const up = tmpVec3.set(0, 1, 0).applyQuaternion(camera.quaternion);
  reflCam.up.set(up.x, -up.y, up.z);
  reflCam.lookAt(target.x, -target.y, target.z);
  reflCam.projectionMatrix.copy(camera.projectionMatrix);
  reflCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  reflCam.updateMatrixWorld(true);

  sky.mesh.position.copy(reflCam.position);
  ocean.mesh.visible = false;
  probesDebug.visible = false;
  const sprayWasVisible = spray.points.visible;
  spray.points.visible = false;

  renderer.setRenderTarget(reflRT);
  renderer.render(scene, reflCam);

  ocean.mesh.visible = true;
  // o respingo volta a aparecer depois do passe espelhado
  spray.points.visible = sprayWasVisible;
  reflectionMatrix.multiplyMatrices(reflCam.projectionMatrix, reflCam.matrixWorldInverse);
}

function animate(now) {
  requestAnimationFrame(animate);

  const frameStart = now ?? performance.now();
  const rawMs = frameStart - lastFrameTime;
  lastFrameTime = frameStart;
  const dtRaw = Math.min(Math.max(rawMs, 0.0005) / 1000, 0.1);
  elapsed += dtRaw;
  frameIndex++;

  // ---------------- governador de quadro ----------------
  // 50 fps é o alvo do projeto: o orçamento é 20 ms, não 16,7 ms.
  if (governor.targetMs !== 1000 / params.targetFps) governor.setTargetFps(params.targetFps);
  const changed = governor.update(rawMs);
  if (changed && params.autoQuality) {
    renderScale = governor.scale;
    resizeTargets();
  }
  stats.fps = governor.fps;
  stats.targetFps = params.targetFps;
  stats.ms = governor.ms;
  stats.quality = governor.label;

  const dt = params.paused ? 0 : dtRaw * params.timeScale;
  simTime += dt;

  // ---------------- física (passo fixo, acumulador) ----------------
  input.thrust = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 0.55 : 0);
  input.rudder = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  simAccumulator = Math.min(simAccumulator + dt, 0.25);
  let steps = 0;
  while (simAccumulator >= FIXED_STEP && steps < 6) {
    physics.update(FIXED_STEP, simTime, params, input);
    simAccumulator -= FIXED_STEP;
    steps++;
  }
  if (steps === 0 && dt > 0) physics.readout();

  boat.group.position.copy(physics.position);
  boat.group.quaternion.copy(physics.quaternion);
  boatForward.set(1, 0, 0).applyQuaternion(physics.quaternion);
  boatForward.y = 0;
  if (boatForward.lengthSq() < 1e-6) boatForward.set(1, 0, 0);
  boatForward.normalize();
  boat.updateInterior(dtRaw, atmosphere.daylight);
  boat.updateMechanics(dtRaw, input.rudder, physics.velocity.length());

  // ---------------- respingo da proa (partículas na GPU) ----------------
  const bowX = boat.group.position.x + boatForward.x * boat.length * 0.5;
  const bowZ = boat.group.position.z + boatForward.z * boat.length * 0.5;
  const bowHeight = waveField.sampleHeight(bowX, bowZ, simTime);
  if (dtRaw > 0) {
    const waterRate = (bowHeight - prevBowHeight) / dtRaw;
    prevBowHeight = bowHeight;
    // quanto a água "sobe" em relação ao casco: é isso que arremessa o spray
    const relRate = waterRate - physics.velocity.y;
    const targetImpact = clamp(relRate / 2.2, 0, 1);
    sprayImpact += (targetImpact - sprayImpact) * Math.min(1, dtRaw * 7);
  }
  spray.update({
    boatPosition: boat.group.position,
    boatQuaternion: physics.quaternion,
    halfLength: boat.length * 0.5,
    speed: physics.velocity.length(),
    impact: sprayImpact,
    time: simTime,
    camera,
    light: atmosphere.horizon,
    pixelHeight: renderer.domElement.height,
  });

  // ---------------- atmosfera / luz ----------------
  sunLight.color.copy(atmosphere.sunColor);
  sunLight.intensity = atmosphere.sunIntensity * 0.85;
  sunLight.position.copy(atmosphere.sunDir).multiplyScalar(300);
  sunLight.target.position.copy(boat.group.position);

  // ---------------- câmera ----------------
  updateCameraRig(dtRaw);

  // câmera submersa?
  const surfaceAtCamera = waveField.sampleHeight(camera.position.x, camera.position.z, simTime);
  const underwater = camera.position.y < surfaceAtCamera;
  if (underwater !== wasUnderwater) {
    wasUnderwater = underwater;
    underwaterEl.classList.toggle('on', underwater);
    ocean.material.side = underwater ? THREE.DoubleSide : THREE.FrontSide;
  }

  // ---------------- reflexão ----------------
  // Sempre no mesmo quadro (cadência constante = frame time constante). O que
  // o governador reduz é a RESOLUÇÃO da reflexão, não a frequência.
  sky.update(atmosphere, camera, simTime, waveField.windDir);
  renderReflectionPass();

  // ---------------- água ----------------
  ocean.update({
    time: simTime,
    camera,
    atmosphere,
    reflectionTexture: reflRT.texture,
    reflectionMatrix,
    boatPosition: boat.group.position,
    boatForward: boatForward,
    boatSize: boatHalfSize,
    params,
  });

  // ---------------- render ----------------
  sky.mesh.position.copy(camera.position);
  renderer.setRenderTarget(mainRT);
  renderer.render(scene, camera);

  postMaterial.uniforms.uScene.value = mainRT.texture;
  postMaterial.uniforms.uExposure.value = params.exposure;
  postMaterial.uniforms.uVignette.value = params.vignette;
  renderer.setRenderTarget(null);
  renderer.render(postScene, postCamera);

  // ---------------- HUD ----------------
  stats.wind = waveField.windSpeed;
  stats.hs = waveField.hs;
  stats.tp = waveField.peakPeriod;
  stats.beaufort = beaufort(waveField.windSpeed);
  stats.wave = physics.waterHeight(simTime);
  stats.knots = physics.speedKnots;
  stats.roll = physics.roll;
  stats.pitch = physics.pitch;
  stats.draft = physics.draft;
  stats.hour = params.hour;
  stats.mass = boat.mass;
  hud.update(dtRaw, stats);

  probesDebug.visible = params.showProbes;
  if (loaderEl && !loaderEl.classList.contains('hidden')) {
    loaderEl.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.__oceano = { params, waveField, boat, physics, atmosphere, ocean, camera, renderer, governor, controls, scene };
}

atmosphere.update(params.hour, params.cloudCover);
refreshWaves();
rebuildEnvironment();
sky.update(atmosphere, camera, simTime, waveField.windDir);

// resolve o barco já flutuando de forma estável antes do primeiro frame
for (let i = 0; i < 120; i++) physics.update(1 / 60, simTime + i / 60, params, {});
boat.group.position.copy(physics.position);
boat.group.quaternion.copy(physics.quaternion);

camera.lookAt(boatFocus);
controls.target.copy(boatFocus);
smoothFocus.copy(boatFocus);

// Compila todos os programas antes do primeiro quadro: sem engasgo na
// primeira interação (o pior travamento é sempre o de compilar shader).
camera.layers.enableAll();
try {
  renderer.compile(scene, camera);
  renderer.compile(postScene, postCamera);
} catch (err) {
  console.warn('pré-compilação de shaders indisponível', err);
}
sky.update(atmosphere, camera, simTime, waveField.windDir);

lastFrameTime = performance.now();
requestAnimationFrame(animate);
