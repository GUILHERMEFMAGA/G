// ---------------------------------------------------------------------------
// Passe final: exposição, tone mapping ACES, vinheta e dithering.
// A cena é renderizada em HDR linear; aqui ela vira imagem de tela.
// ---------------------------------------------------------------------------

uniform sampler2D uScene;
uniform float uExposure;
uniform float uVignette;
uniform vec2 uResolution;

varying vec2 vUv;

const mat3 ACES_IN = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777
);

const mat3 ACES_OUT = mat3(
  1.60475, -0.10208, -0.00327,
  -0.53108, 1.10813, -0.07276,
  -0.07367, -0.00605, 1.07602
);

vec3 acesFilmic(vec3 x) {
  vec3 v = ACES_IN * x;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(ACES_OUT * (a / b), 0.0, 1.0);
}

vec3 toSRGB(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 col = texture2D(uScene, vUv).rgb;

  col *= uExposure;
  col = acesFilmic(col);

  // vinheta suave
  vec2 p = vUv * 2.0 - 1.0;
  float vig = smoothstep(1.45, 0.30, length(p * vec2(0.92, 1.0)));
  col *= mix(1.0 - uVignette, 1.0, vig);

  col = toSRGB(col);

  // dithering: evita banding nos gradientes do céu
  float dither = (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  col += dither;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
