/** Painel de instrumentos: números "reais" de bordo atualizados a 6 Hz. */

export class HUD {
  constructor() {
    this.el = {
      wind: document.getElementById('hud-wind'),
      beaufort: document.getElementById('hud-beaufort'),
      hs: document.getElementById('hud-hs'),
      tp: document.getElementById('hud-tp'),
      wave: document.getElementById('hud-wave'),
      speed: document.getElementById('hud-speed'),
      roll: document.getElementById('hud-roll'),
      pitch: document.getElementById('hud-pitch'),
      draft: document.getElementById('hud-draft'),
      hour: document.getElementById('hud-hour'),
      mass: document.getElementById('hud-mass'),
      fps: document.getElementById('hud-fps'),
      quality: document.getElementById('hud-quality'),
    };
    this.acc = 0;
    this.fpsSmooth = 60;
  }

  update(dt, data) {
    this.acc += dt;
    this.fpsSmooth += (data.fps - this.fpsSmooth) * Math.min(1, dt * 4);
    if (this.acc < 1 / 6) return;
    this.acc = 0;

    const e = this.el;
    const set = (node, text) => {
      if (node) node.textContent = text;
    };

    set(e.wind, `${data.wind.toFixed(1)} m/s`);
    set(e.beaufort, `${data.beaufort.force} · ${data.beaufort.name}`);
    set(e.hs, `${data.hs.toFixed(2)} m`);
    set(e.tp, `${data.tp.toFixed(1)} s`);
    set(e.wave, `${data.wave >= 0 ? '+' : ''}${data.wave.toFixed(2)} m`);
    set(e.speed, `${data.knots.toFixed(1)} kn`);
    set(e.roll, `${data.roll.toFixed(1)}°`);
    set(e.pitch, `${data.pitch.toFixed(1)}°`);
    set(e.draft, `${data.draft.toFixed(2)} m`);
    set(e.hour, formatHour(data.hour));
    set(e.mass, `${(data.mass / 1000).toFixed(1)} t`);
    set(e.fps, `${Math.round(this.fpsSmooth)}`);
    if (e.quality) set(e.quality, data.quality || '—');
  }
}

export function formatHour(h) {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
