/**
 * Governador de quadro.
 *
 * O custo de um frame depende do número de pixels: em telas grandes, com
 * devicePixelRatio alto e reflexão planar, a GPU pode levar 30 ms num frame e
 * 8 ms no seguinte. Em vez de travar em "qualidade máxima" (engasgos) ou
 * "qualidade mínima" (imagem mole), a resolução é ajustada em degraus para
 * manter o gasto por frame dentro do orçamento de 60 Hz.
 *
 * Tudo é histerese + cooldown: só muda de degrau quando a mediana de uma janela
 * inteira de frames passa (ou fica bem abaixo) do alvo. Isso evita o efeito
 * "bomba" de subir e descer de resolução a cada frame.
 */

const SCALES = [1.0, 0.9, 0.8, 0.7, 0.62, 0.55];

export class FrameGovernor {
  constructor({ targetFps = 60, enabled = true, scale = 1.0, windowMs = 420 } = {}) {
    this.targetMs = 1000 / targetFps;
    this.enabled = enabled;
    this.manualScale = scale;

    this.scaleIndex = 0;
    this.scale = SCALES[0];

    this._frames = new Float32Array(120);
    this._count = 0;
    this._head = 0;

    this._windowStart = 0;
    this._windowFrames = 0;
    this._windowSum = 0;
    this._cooldown = 0;
    this._slowStreak = 0;
    this._fastStreak = 0;

    this.ms = 16.7;
    this.p95 = 16.7;
    this.fps = 60;
    this.changed = false;

    // Cadência constante (todo quadro) com resolução variável: alternar entre
    // "com/sem reflexão" faz o custo do quadro oscilar em dobro, e o olho lê
    // isso como travamento. Resolução menor todo quadro é lisa.
    this.reflectionScale = 0.5;
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) {
      this.scaleIndex = 0;
      this.scale = this.manualScale;
      this.reflectionScale = 0.5;
      this.changed = true;
    }
  }

  setManualScale(s) {
    this.manualScale = s;
    if (!this.enabled) {
      this.scale = s;
      this.changed = true;
    }
  }

  /** Mediana (aproximada por ordenação parcial) da janela atual. */
  _median() {
    const n = this._count;
    if (n === 0) return this.targetMs;
    const arr = Array.prototype.slice.call(this._frames, 0, n).sort((a, b) => a - b);
    return arr[Math.floor(n * 0.5)];
  }

  _percentile(p) {
    const n = this._count;
    if (n === 0) return this.targetMs;
    const arr = Array.prototype.slice.call(this._frames, 0, n).sort((a, b) => a - b);
    return arr[Math.min(n - 1, Math.floor(n * p))];
  }

  /**
   * Alimenta o governador com o tempo do frame (ms).
   * Retorna true quando a escala mudou (aí o chamador redimensiona os alvos).
   */
  update(frameMs) {
    this.changed = false;

    this._frames[this._head] = frameMs;
    this._head = (this._head + 1) % this._frames.length;
    if (this._count < this._frames.length) this._count++;

    this.ms += (frameMs - this.ms) * 0.1;
    this.fps = 1000 / Math.max(this.ms, 0.001);

    this._windowSum += frameMs;
    this._windowFrames++;
    this._cooldown = Math.max(0, this._cooldown - frameMs);

    if (this._windowSum < this._windowBudget()) return this.changed;
    this._windowStart += this._windowSum;
    this._windowSum = 0;
    this._windowFrames = 0;

    const median = this._median();
    this.p95 = this._percentile(0.95);

    if (!this.enabled) return this.changed;

    const slow = this.targetMs * 1.08;
    const fast = this.targetMs * 0.74;

    if (median > slow) {
      this._slowStreak++;
      this._fastStreak = 0;
    } else if (median < fast) {
      this._fastStreak++;
      this._slowStreak = 0;
    } else {
      this._slowStreak = 0;
      this._fastStreak = 0;
    }

    if (this._cooldown > 0) return this.changed;

    if (this._slowStreak >= 2 && this.scaleIndex < SCALES.length - 1) {
      this.scaleIndex++;
      this._apply();
    } else if (this._fastStreak >= 5 && this.scaleIndex > 0) {
      this.scaleIndex--;
      this._apply();
    }

    return this.changed;
  }

  _windowBudget() {
    return 1000;
  }

  _apply() {
    this.scale = SCALES[this.scaleIndex];
    // abaixo de 0.85 a reflexão também cai de resolução (0.5 -> 0.34)
    this.reflectionScale = this.scale >= 0.85 ? 0.5 : 0.34;
    this._slowStreak = 0;
    this._fastStreak = 0;
    this._cooldown = 900;
    this.changed = true;
  }

  /** Rótulo curto para o HUD. */
  get label() {
    if (!this.enabled) return `${Math.round(this.scale * 100)}% fixo`;
    return `${Math.round(this.scale * 100)}%`;
  }
}

/**
 * Cronômetro de seções: mede o custo de física, reflexão e cena principal
 * usando queries de GPU quando disponíveis (EXT_disjoint_timer_query_webgl2).
 * Sem a extensão, cai para tempo de CPU entre marcos — que já basta para achar
 * o gargalo grosso.
 */
export class SectionTimer {
  constructor(renderer) {
    this.renderer = renderer;
    this.gl = renderer.getContext();
    this.enabled = false;
    this.sections = { physics: 0, reflection: 0, scene: 0, post: 0 };
    this._frames = 0;

    const ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.ext = ext;
    this.pending = [];
  }

  begin() {
    if (!this.ext) return null;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    return q;
  }

  end(q) {
    if (!this.ext || !q) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(q);
  }

  /** Coleta as queries prontas (nunca bloqueia o pipeline). */
  poll(label = 'scene') {
    if (!this.ext) return 0;
    const disjoint = this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    let total = 0;
    while (this.pending.length) {
      const q = this.pending[0];
      const available = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE);
      if (!available) break;
      this.pending.shift();
      if (!disjoint) {
        total += this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) / 1e6;
      }
      this.gl.deleteQuery(q);
    }
    if (total) this.sections[label] = this.sections[label] * 0.85 + total * 0.15;
    return total;
  }
}
