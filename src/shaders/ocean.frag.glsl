// ---------------------------------------------------------------------------
// Oceano — fragmento
// Modelo fisicamente inspirado:
//   * reflexão planar (render target com a câmera espelhada) + Fresnel (Schlick)
//   * espalhamento subsuperficial (luz atravessando as cristas)
//   * especular do sol com distribuição GGX
//   * espuma a partir do Jacobiano do mapeamento de Gerstner (compressão da
//     superfície) modulada por ruído de vento
//   * perspectiva atmosférica em direção ao horizonte
// ---------------------------------------------------------------------------

#define PI 3.14159265359

uniform float uTime;
uniform vec3 uCameraPos;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;

uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSssColor;
uniform vec3 uFoamColor;

uniform float uSssStrength;
uniform float uFoamStrength;
uniform float uFoamThreshold;
uniform float uRoughness;
uniform float uDetailStrength;
uniform float uMaxAmp;
uniform float uHazeDistance;
uniform float uReflectionStrength;
uniform float uSunSpecular;
uniform vec2 uWindDir;

uniform vec4 uDetA[ND];
uniform vec4 uDetB[ND];

uniform sampler2D uReflection;
uniform sampler2D uFoamTex;
uniform sampler2D uRippleTex;
uniform float uRippleStrength;
uniform vec2 uBoatPos;
uniform vec2 uBoatFwd;
uniform vec2 uBoatSize;
uniform float uBoatShadow;
uniform mat4 uReflectionMatrix;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vBaseXZ;
varying float vJacobian;
varying float vHeight;

float ggxDistribution(float ndh, float a) {
  float a2 = a * a;
  float d = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

float smithG(float ndl, float ndv, float k) {
  float g1 = ndl / (ndl * (1.0 - k) + k);
  float g2 = ndv / (ndv * (1.0 - k) + k);
  return g1 * g2;
}

void main() {
  vec3 toCam = uCameraPos - vWorldPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);

  // ---------------- ondulações finas (por pixel) ----------------
  float detailFade = exp(-dist * 0.0012);
  vec2 slope = vec2(0.0);
  for (int i = 0; i < ND; i++) {
    vec4 A = uDetA[i];
    vec4 B = uDetB[i];
    float th = A.x * vBaseXZ.x + A.y * vBaseXZ.y - A.z * uTime + A.w;
    slope += vec2(B.z * A.x, B.z * A.y) * cos(th);
  }
  // ondulações de alta frequência vindas de um mapa de normais (duas escalas)
  vec2 rd1 = texture2D(uRippleTex, vWorldPos.xz * 0.135 + vec2(uTime * 0.006, uTime * 0.004)).xy * 2.0 - 1.0;
  vec2 rd2 = texture2D(uRippleTex, vWorldPos.xz * 0.042 - vec2(uTime * 0.003, uTime * 0.0022)).xy * 2.0 - 1.0;
  vec2 ripple = rd1 * 0.65 + rd2 * 0.9;

  // Atenuação por distância: as ondulações menores que um pixel não devem
  // perturbar o Fresnel rasante — senão o mar distante deixa de espelhar o céu.
  float nearBoost = 0.75 + 1.35 * exp(-dist * 0.05);
  slope = (slope * uDetailStrength + ripple * uRippleStrength * nearBoost) * detailFade;

  vec3 N = normalize(vNormal);
  // normais vindas de um mapeamento esticado precisam ser reforçadas perto das cristas
  float stretch = clamp(vJacobian, 0.25, 1.6);
  N = normalize(vec3(N.x - slope.x * stretch, N.y, N.z - slope.y * stretch));

  if (!gl_FrontFacing) N = -N;

  float ndv = clamp(dot(N, V), 0.0, 1.0);
  // Fresnel de superfície lisa. Numa superfície com rugosidade, as microfacés
  // inclinadas refletem MENOS no rasante — é por isso que o mar real fica mais
  // escuro que o céu no horizonte em vez de virar um espelho leitoso.
  float fres = clamp(0.02 + 0.98 * pow(1.0 - ndv, 5.0), 0.0, 1.0);
  float microTilt = clamp(length(slope) * 1.6, 0.0, 0.42) + clamp(dist * 0.00002, 0.0, 0.22);
  float fresR = fres * mix(1.0, 0.58, microTilt);

  float hNorm = clamp(vHeight / max(uMaxAmp, 1e-3), -1.0, 1.0);
  float crest = clamp(hNorm * 0.5 + 0.5, 0.0, 1.0);

  // ---------------- corpo da água ----------------
  vec3 body = mix(uDeepColor, uShallowColor, crest * 0.55);
  vec3 skyAmbient = mix(uHorizonColor, uZenithColor, 0.55);
  body += skyAmbient * (0.085 + 0.075 * N.y);
  // micro-sombreamento: onde a superfície se comprime (Jacobiano baixo) o vale
  // fica mais escuro — é isso que dá "textura" à água vista de cima, quando a
  // reflexão do céu já não tem contraste para mostrar a onda
  body *= 0.90 + 0.20 * clamp(vJacobian, 0.0, 1.4);
  // luz do sol espalhada nas faces da onda: a face voltada ao sol clareia, a
  // face de sombra escurece — é o que dá "relevo" ao mar visto por cima
  body *= 0.84 + 0.32 * clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  body *= 1.0 + 0.10 * clamp(dot(normalize(vec3(N.x, 0.0, N.z) + 1e-5), vec3(uWindDir.x, 0.0, uWindDir.y)), -1.0, 1.0);

  // espalhamento subsuperficial: luz que atravessa a onda na direção da câmera
  float sss = pow(clamp(dot(V, -uSunDir), 0.0, 1.0), 3.0);
  sss *= smoothstep(-0.35, 0.95, hNorm);
  sss *= 1.0 - 0.55 * ndv;
  body += uSssColor * sss * uSssStrength * 0.75;

  // ---------------- reflexão planar ----------------
  float distortion = 0.075 * (1.0 - clamp(dist / 2200.0, 0.0, 1.0));
  vec4 clip = uReflectionMatrix * vec4(vWorldPos, 1.0);
  vec2 uv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
  uv += vec2(N.x, N.z) * distortion;
  // segunda escala de distorção: quebra os reflexos grandes (nuvens) em
  // manchas de onda, que é como o mar real devolve o céu
  vec2 fineRefl = texture2D(uRippleTex, vWorldPos.xz * 0.62 + vec2(uTime * 0.022, -uTime * 0.017)).xy * 2.0 - 1.0;
  uv += fineRefl * 0.024 * (1.0 - clamp(dist / 500.0, 0.0, 1.0));

  vec3 refl = vec3(0.0);
  float valid = 0.0;
  if (clip.w > 0.0) {
    vec2 uvc = clamp(uv, vec2(0.002), vec2(0.998));
    refl = texture2D(uReflection, uvc).rgb;
    float insideX = step(0.002, uv.x) * step(uv.x, 0.998);
    float insideY = step(0.002, uv.y) * step(uv.y, 0.998);
    valid = insideX * insideY;
  }

  // fallback: gradiente de céu na direção refletida
  vec3 R = reflect(-V, N);
  vec3 skyFallback = mix(uHorizonColor, uZenithColor, pow(clamp(R.y, 0.0, 1.0), 0.40));
  skyFallback += uSunColor * pow(clamp(dot(R, uSunDir), 0.0, 1.0), 220.0) * 6.0;
  // 62% da reflexão planar + 38% do céu analítico na direção da normal local:
  // é essa parcela que faz cada faceta da onda refletir um pedaço diferente do
  // céu e dá o "quebrado" do mar real em vez de um espelho liso.
  // A reflexão planar é a fonte principal (70%), mas 30% vêm do céu analítico na
  // direção da normal local. Antes eu zerava essa parcela quando o raio caía
  // abaixo do horizonte — era isso que deixava metade do mar sem estrutura.
  refl = mix(skyFallback, refl, 0.70);

  // Caminho do sol na água: no real o brilho refletido NÃO é um lençol liso —
  // as micro-ondas quebram a reflexão em milhares de cintilações. Aqui a
  // parcela luminosa da reflexão é modulada por ruído de alta frequência.
  float sparkNoise = texture2D(uFoamTex, vWorldPos.xz * 5.5 + vec2(uTime * 0.06, uTime * 0.028)).r;
  float reflLum = dot(refl, vec3(0.299, 0.587, 0.114));
  float brightZone = smoothstep(0.35, 0.95, reflLum);
  refl *= 1.0 - brightZone * (0.42 - 0.80 * sparkNoise) * (0.55 + 0.45 * clamp(dist * 0.02, 0.0, 1.0));

  vec3 col = mix(body, refl * uReflectionStrength, fresR);

  // ---------------- especular do sol (GGX) ----------------
  vec3 H = normalize(uSunDir + V);
  float ndl = max(dot(N, uSunDir), 0.0);
  float ndh = max(dot(N, H), 0.0);
  float vdh = max(dot(V, H), 0.0);

  float roughness = clamp(uRoughness + dist * 0.000045, 0.02, 0.45);
  float a = roughness * roughness;
  float D = ggxDistribution(ndh, a);
  float Gs = smithG(ndl, ndv, a * 0.5);
  float Fs = 0.02 + 0.98 * pow(1.0 - vdh, 5.0);
  float spec = (D * Gs * Fs) / max(4.0 * ndl * ndv, 1e-3);
  // sombra de contato / oclusão do casco: a água imediatamente em volta do
  // barco recebe menos luz direta (aproximação da oclusão real do casco).
  // referencial do barco: elipse do casco em (comprimento, boca)
  vec2 relBoat = vWorldPos.xz - uBoatPos;
  float bAlong = dot(relBoat, uBoatFwd);
  float bAcross = dot(relBoat, vec2(-uBoatFwd.y, uBoatFwd.x));
  vec2 bq = vec2(bAlong / (uBoatSize.x + 0.9), bAcross / (uBoatSize.y + 0.75));
  float hullE = length(bq);
  float hullAO = exp(-pow(max(hullE - 0.62, 0.0) * 2.0, 2.0)) * uBoatShadow;
  // faixa de contato: a água encostada no casco (linha d'água + respingo)
  float contact = smoothstep(1.02, 0.90, hullE) * smoothstep(0.82, 1.00, hullE);
  spec *= 1.0 - 0.85 * hullAO;

  // Dispersão cromática no brilho do sol: nas bordas do reflexo especular as
  // componentes se separam, como a luz atravessando um prisma. O núcleo
  // continua branco; só a franja ganha cor.
  float dev = clamp((1.0 - vdh) * 34.0, 0.0, 1.0);
  vec3 prism = vec3(
    0.60 + 0.75 * smoothstep(0.45, 1.00, dev),
    0.60 + 0.75 * (1.0 - abs(dev - 0.5) * 2.0),
    0.60 + 0.75 * smoothstep(0.55, 0.00, dev)
  );
  vec3 specTint = mix(vec3(1.0), prism, 0.7);
  col += uSunColor * spec * ndl * uSunSpecular * (1.0 - fresR * 0.7) * specTint;
  col *= 1.0 - 0.26 * hullAO;

  // ---------------- espuma ----------------
  // A espuma nasce onde a superfície se comprime (Jacobiano < 1): é ali que a
  // crista "quebra". O ruído em três escalas quebra a mancha em bolhas.
  float crestGate = 1.0 - smoothstep(uFoamThreshold - 0.10, uFoamThreshold, vJacobian);

  float fine = texture2D(uFoamTex, vWorldPos.xz * 0.42 - uWindDir * uTime * 0.20).r;
  float mid = texture2D(uFoamTex, vWorldPos.xz * 0.115 - uWindDir * uTime * 0.05).g;
  float coarse = texture2D(uFoamTex, vWorldPos.xz * 0.016 - uWindDir * uTime * 0.007).b;
  float bubbles = fine * 0.55 + mid * 0.5 + coarse * 0.28;

  float t0 = 0.66 - 0.24 * crestGate;
  float foam = smoothstep(t0, t0 + 0.09, bubbles) * crestGate;

  // véu leve sobre cristas muito altas (mesmo sem compressão máxima)
  float heightGate = smoothstep(0.55, 0.95, hNorm) * crestGate;
  foam += heightGate * smoothstep(0.58, 0.78, bubbles) * 0.55;

  // estrutura fina: espuma real é uma malha de bolhas, não uma mancha chapada
  foam *= 0.45 + 0.85 * smoothstep(0.28, 0.80, fine);
  foam = clamp(foam, 0.0, 0.95);
  foam *= uFoamStrength;
  foam *= 1.0 - 0.5 * smoothstep(0.4, 0.95, ndv); // espuma clinada para a câmera some um pouco
  foam *= 0.55 + 0.45 * smoothstep(0.0, 30.0, dist);
  // espuminha na linha d'água do casco (só perto do barco)
  foam += contact * (0.16 + 0.34 * smoothstep(0.30, 0.72, bubbles)) * uBoatShadow;

  vec3 foamLit = uFoamColor * (0.35 + 0.75 * max(ndl, 0.0)) + skyAmbient * 0.35;
  foamLit *= 0.82 + 0.30 * mid;
  col = mix(col, foamLit, clamp(foam, 0.0, 1.0));

  // ---------------- perspectiva atmosférica ----------------
  float haze = 1.0 - exp(-pow(dist / uHazeDistance, 1.35));
  // a névoa usa a própria cor refletida do céu para não criar costura no horizonte
  vec3 hazeColor = mix(uHorizonColor, refl, 0.75);
  col = mix(col, hazeColor, clamp(haze, 0.0, 0.86));

  // ---------------- vista de baixo d'água ----------------
  if (!gl_FrontFacing) {
    float upness = clamp(dot(-N, V), 0.0, 1.0);
    float snell = smoothstep(0.35, 0.95, upness);
    vec3 deep = uDeepColor * 2.6 + uSssColor * 0.12;
    vec3 above = mix(uHorizonColor, uZenithColor, 0.5) * 0.85;
    col = mix(deep, above, snell);
    col += uSssColor * 0.18 * crest;
    col = mix(col, uHorizonColor * 0.35, 1.0 - exp(-dist * 0.02));
  }

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
