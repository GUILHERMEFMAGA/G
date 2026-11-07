// ---------------------------------------------------------------------------
// Céu — gradiente atmosférico, halo de Mie, disco solar, nuvens e estrelas.
// Tudo em radiância linear (a conversão para sRGB acontece no passe final).
// ---------------------------------------------------------------------------

uniform vec3 uSunDir;
uniform vec3 uSunRadiance; // cor do sol já multiplicada pela intensidade
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;
uniform vec3 uSunsetColor;
uniform vec3 uCloudLitColor;
uniform vec3 uCloudShadowColor;
uniform float uWarmth;
uniform float uCloudCover;
uniform vec2 uCloudOffset;
uniform float uNightFactor;

varying vec3 vDir;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    v += amp * vnoise(p);
    p = p * 2.03 + 17.1;
    amp *= 0.5;
  }
  return v;
}

void main() {
  vec3 dir = normalize(vDir);
  float y = dir.y;

  // gradiente base do céu
  float up = pow(clamp(y, 0.0, 1.0), 0.48);
  vec3 col = mix(uHorizonColor, uZenithColor, up);

  // banda quente de nascer/pôr do sol (dependente do azimute)
  float az = clamp(dot(normalize(dir.xz + vec2(1e-5)), normalize(uSunDir.xz + vec2(1e-5))), 0.0, 1.0);
  float band = exp(-abs(y) * 6.5) * pow(az, 2.2);
  col = mix(col, uSunsetColor, clamp(band * uWarmth, 0.0, 0.95));

  // halo solar (aproximação de espalhamento de Mie)
  float mu = clamp(dot(dir, uSunDir), 0.0, 1.0);
  float glow = pow(mu, 4.0) * 0.26 + pow(mu, 42.0) * 0.75 + pow(mu, 900.0) * 2.8;
  col += uSunRadiance * glow * 0.30;

  // disco solar — pequeno e muito intenso: alimenta os brilhos na água
  float disk = smoothstep(0.99991, 0.999965, mu);
  col += uSunRadiance * disk * 18.0;

  // nuvens (projeção em domo, duas camadas)
  if (y > -0.01 && uCloudCover > 0.001) {
    vec2 cp = dir.xz / (max(y, 0.0) * 1.30 + 0.22);
    vec2 drift = uCloudOffset * 0.010;
    float n = fbm(cp * 0.85 + drift);
    float n2 = fbm(cp * 2.30 - drift * 1.7);
    float cloudField = n * 0.80 + n2 * 0.32;
    float edge = 0.72 - uCloudCover * 0.34;
    float dens = smoothstep(edge, edge + 0.085, cloudField);
    dens *= smoothstep(-0.01, 0.10, y);

    vec3 cloudCol = mix(uCloudShadowColor, uCloudLitColor, smoothstep(0.25, 0.85, n));
    cloudCol += uSunRadiance * pow(mu, 10.0) * 0.20;
    col = mix(col, cloudCol, clamp(dens * 0.92, 0.0, 1.0));
  }

  // estrelas
  if (uNightFactor > 0.005 && y > 0.02) {
    vec2 sp = dir.xz / max(y, 0.02);
    float s = hash21(floor(sp * 150.0));
    float star = smoothstep(0.9972, 1.0, s) * smoothstep(0.02, 0.28, y);
    col += vec3(0.85, 0.92, 1.0) * star * uNightFactor * 1.4;
  }

  // Abaixo do horizonte o céu não existe: no reflexo (e em qualquer ângulo
  // rasante) o que aparece é o próprio mar. Sem isso, o reflexo da metade
  // inferior da esfera de céu lavava a água com uma chapa azul-clara.
  float below = smoothstep(0.004, -0.020, y);
  vec3 seaFar = mix(uHorizonColor * 0.42, uZenithColor * 0.55, 0.35);
  col = mix(col, seaFar, below);

  // haze junto ao horizonte
  col = mix(col, uHorizonColor * 1.02, exp(-max(y, 0.0) * 26.0) * 0.34);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
