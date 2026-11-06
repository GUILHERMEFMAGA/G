import GUI from 'lil-gui';

/**
 * Controles. Cada alteração relevante avisa o main.js através de callbacks
 * para que o espectro de ondas ou a atmosfera sejam reconstruídos.
 */
export function createGUI(params, cb) {
  const gui = new GUI({ title: 'CONTROLES' });

  // ---------------------------------------------------------------- mar
  const fSea = gui.addFolder('Mar & vento');
  fSea
    .add(params, 'windSpeed', 0, 25, 0.1)
    .name('Vento (m/s)')
    .onChange(() => cb.onWind());
  fSea
    .add(params, 'windDir', 0, 360, 1)
    .name('Direção (°)')
    .onChange(() => cb.onWind());
  fSea
    .add(params, 'hsScale', 0.15, 2.5, 0.01)
    .name('Altura das ondas')
    .onChange(() => cb.onWind());
  fSea
    .add(params, 'choppiness', 0, 1.1, 0.01)
    .name('Cristas (choppiness)')
    .onChange(() => cb.onWind());
  fSea.add(params, 'timeScale', 0, 2, 0.05).name('Velocidade do tempo');
  fSea.add(params, 'paused').name('Pausar mar');
  fSea.add({ seed: () => cb.onReseed() }, 'seed').name('Regerar mar');

  // ---------------------------------------------------------------- água
  const fWater = gui.addFolder('Água');
  fWater.add(params, 'foam', 0, 2.5, 0.01).name('Espuma');
  fWater.add(params, 'foamThreshold', 0.2, 1.0, 0.01).name('Limiar de espuma');
  fWater.add(params, 'sss', 0, 3, 0.01).name('Translucidez das cristas');
  fWater.add(params, 'detail', 0, 2.5, 0.01).name('Ondulação fina');
  fWater.add(params, 'roughness', 0.01, 0.3, 0.005).name('Rugosidade');
  fWater.add(params, 'sunGlitter', 0, 2, 0.02).name('Brilho do sol');
  fWater.close();

  // ---------------------------------------------------------------- céu
  const fSky = gui.addFolder('Céu & luz');
  fSky
    .add(params, 'hour', 0, 24, 0.05)
    .name('Hora do dia')
    .onChange(() => cb.onSky());
  fSky
    .add(params, 'cloudCover', 0, 1, 0.01)
    .name('Nebulosidade')
    .onChange(() => cb.onSky());
  fSky.add(params, 'exposure', 0.4, 2.5, 0.01).name('Exposição');
  fSky.add(params, 'vignette', 0, 0.8, 0.01).name('Vinheta');
  fSky.close();

  // ---------------------------------------------------------------- física
  const fPhys = gui.addFolder('Física do barco');
  fPhys.add(params, 'buoyancy', 0.5, 1.5, 0.01).name('Empuxo (Archimedes)');
  fPhys.add(params, 'drag', 0.2, 3, 0.01).name('Arrasto hidrodinâmico');
  fPhys.add(params, 'keelDrag', 0.1, 4, 0.05).name('Resistência da quilha');
  fPhys.add(params, 'angularDamping', 0, 3, 0.01).name('Amortecimento angular');
  fPhys.add(params, 'windSail', 0, 2.5, 0.01).name('Força do vento nas velas');
  fPhys.add(params, 'gravityScale', 0.3, 2, 0.01).name('Gravidade (×9,81)');
  fPhys.add(params, 'showProbes').name('Mostrar sondas de flutuação');
  fPhys.add({ reset: () => cb.onResetBoat() }, 'reset').name('Reposicionar barco');
  fPhys.close();

  // ---------------------------------------------------------------- câmera
  const fCam = gui.addFolder('Câmera');
  fCam
    .add(params, 'cameraMode', ['Órbita', 'Perseguição', 'Cinema'])
    .name('Modo')
    .onChange((v) => cb.onCameraMode(v));
  fCam.add(params, 'fov', 35, 90, 1).name('Campo de visão').onChange(() => cb.onFov());
  fCam.close();

  return gui;
}
