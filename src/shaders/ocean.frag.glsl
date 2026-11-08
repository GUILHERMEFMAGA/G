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
  // Ondulações finas. A UV é girada para o referencial do VENTO e esticada
  // ao longo dele: onda de vento é alongada na direção em que sopra, não é
  // ruído redondo. Depois a inclinação volta para o mundo.
  vec2 crossWind = vec2(-uWindDir.y, uWindDir.x);
  vec2 wWarp = vec2(dot(vWorldPos.xz, uWindDir), dot(vWorldPos.xz, crossWind));
  float drift = uTime * 0.35;
  vec2 rd1 = texture2D(uRippleTex, wWarp * vec2(0.055, 0.145) + vec2(-drift * 0.004, drift * 0.010)).xy * 2.0 - 1.0;
  vec2 rd2 = texture2D(uRippleTex, wWarp * vec2(0.018, 0.048) - vec2(drift * 0.002, drift * 0.004)).xy * 2.0 - 1.0;
  vec2 ripW = rd1 * 0.65 + rd2 * 0.95;
  vec2 ripple = uWindDir * ripW.x + crossWind * ripW.y;

  // Atenuação por distância: as ondulações menores que um pixel não devem
  // perturbar o Fresnel rasante — senão o mar distante deixa de espelhar o céu.
  // perto da câmera o detalhe fino é o que quebra o espelho em facetas
  float nearBoost = 0.80 + 2.30 * exp(-dist * 0.055);
  slope = (slope * uDetailStrength + ripple * uRippleStrength * nearBoost) * detailFade;

  // Mar de longe: a malha polar chega ao longe com células grandes demais para
  // desenhar onda de 50 m, e aí o fundo do quadro virava um degradê chapado
  // ("não é nítido quando está longe"). Três senos longos (140-280 m) devolvem
  // a banda da ondulação lá no fundo — e são finos o bastante para não tremer.
  float farChop = smoothstep(45.0, 700.0, dist) * uDetailStrength;
  if (farChop > 0.002) {
    float far1 = cos(dot(vWorldPos.xz, uWindDir) * 0.031 + uTime * 0.62);
    float far2 = cos(dot(vWorldPos.xz, normalize(uWindDir + crossWind * 0.8)) * 0.022 + uTime * 0.47);
    float far3 = cos(dot(vWorldPos.xz, normalize(uWindDir * 0.5 - crossWind)) * 0.047 + uTime * 0.83);
    slope += (uWindDir * (far1 * 0.55 + far2 * 0.32) + crossWind * (far3 * 0.34)) * farChop * 0.105;
  }

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
  float microTilt = clamp(length(slope) * 2.2, 0.0, 0.48) + clamp(dist * 0.00002, 0.0, 0.24);
  float fresR = fres * mix(1.0, 0.42, microTilt);
  // Perto da câmera dá para resolver cada faceta da onda: elas se sombreiam
  // entre si e a média devolve MUITO menos céu que a Fresnel de superfície
  // lisa. De longe isso vira estatística e o espelho volta. Sem esse corte, o
  // mar de perto virava um lençol pálido de céu (era o que lavava a vista
  // padrão), enquanto a água real ali é funda e escura.
  fresR *= mix(0.30, 1.0, smoothstep(8.0, 150.0, dist));

  float hNorm = clamp(vHeight / max(uMaxAmp, 1e-3), -1.0, 1.0);
  float crest = clamp(hNorm * 0.5 + 0.5, 0.0, 1.0);

  // ---------------- corpo da água ----------------
  // manchas de profundidade: água rasa sobre bancos, mais clara e esverdeada
  float depthVar = texture2D(uFoamTex, vWorldPos.xz * 0.0035 + vec2(uTime * 0.0004)).b;
  float turbidity = smoothstep(0.42, 0.85, depthVar) * 0.55;
  vec3 body = mix(uDeepColor, uShallowColor, clamp(crest * 0.74 + turbidity, 0.0, 1.0));
  // relevo: encostas voltadas ao sol pegam mais luz, encostas afastadas escurecem
  vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-4, 0.0, 0.0));
  vec3 nH = normalize(vec3(N.x, 0.0, N.z) + vec3(1e-4, 0.0, 0.0));
  body *= 1.0 + 0.13 * dot(nH, sunH);
  vec3 skyAmbient = mix(uHorizonColor, uZenithColor, 0.55);
  // luz do céu espalhada: pequena, senão ela engole a cor do corpo d'água
  body += skyAmbient * (0.032 + 0.038 * N.y);
  // micro-sombreamento: onde a superfície se comprime (Jacobiano baixo) o vale
  // fica mais escuro — é isso que dá "textura" à água vista de cima, quando a
  // reflexão do céu já não tem contraste para mostrar a onda
  body *= 0.84 + 0.30 * clamp(vJacobian, 0.0, 1.4);
  // luz do sol espalhada nas faces da onda: a face voltada ao sol clareia, a
  // face de sombra escurece — é o que dá "relevo" ao mar visto por cima
  body *= 0.70 + 0.55 * clamp(dot(N, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  body *= 1.0 + 0.10 * clamp(dot(normalize(vec3(N.x, 0.0, N.z) + 1e-5), vec3(uWindDir.x, 0.0, uWindDir.y)), -1.0, 1.0);
  // contraste crista/vale: no real a crista é mais clara porque a luz atravessa
  // a lâmina d'água; o vale é fundo e escuro. Sem isso o mar de perto fica
  // uniforme, só com a cor chapada da água.
  body *= mix(0.78, 1.16, smoothstep(0.25, 0.95, hNorm * 0.5 + 0.5));

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
  uv += fineRefl * 0.017 * (1.0 - clamp(dist / 500.0, 0.0, 1.0));

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
  // O fallback tem que ter o MESMO brilho da reflexão planar: se ele for mais
  // escuro aparece uma costura diagonal no mar (onde o render target espelhado
  // acaba e o céu analítico assume).
  vec3 skyFallback = mix(uHorizonColor, uZenithColor, pow(clamp(R.y, 0.0, 1.0), 0.40));
  skyFallback += uSunColor * pow(clamp(dot(R, uSunDir), 0.0, 1.0), 220.0) * 6.0;
  // 62% da reflexão planar + 38% do céu analítico na direção da normal local:
  // é essa parcela que faz cada faceta da onda refletir um pedaço diferente do
  // céu e dá o "quebrado" do mar real em vez de um espelho liso.
  // A reflexão planar é a fonte principal (70%), mas 30% vêm do céu analítico na
  // direção da normal local. Antes eu zerava essa parcela quando o raio caía
  // abaixo do horizonte — era isso que deixava metade do mar sem estrutura.
  // Fora do frustum da câmera espelhada a UV é grampeada na borda do render
  // target — era isso que espalhava uma faixa de céu pálido sobre o mar (o
  // `valid` era calculado e nunca usado). Fora dali, céu analítico e pronto.
  float edgeFade = smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x)
                 * smoothstep(0.0, 0.12, uv.y) * smoothstep(1.0, 0.88, uv.y);
  edgeFade = clamp(edgeFade * valid, 0.0, 1.0);
  refl = mix(skyFallback, refl, 0.70 * edgeFade);
  // Atenuação da reflexão pelo corpo d'água: o que volta do céu atravessa a
  // superfície e é absorvido no caminho. De perto o mar é fundo e azul; só de
  // longe a reflexão volta inteira (é ali que ele fica prateado no horizonte).
  refl *= mix(vec3(0.46, 0.74, 0.92), vec3(1.0), smoothstep(6.0, 180.0, dist));

  // Caminho do sol na água: no real o brilho refletido NÃO é um lençol liso —
  // as micro-ondas quebram a reflexão em milhares de cintilações. Aqui a
  // parcela luminosa da reflexão é modulada por ruído de alta frequência.
  float sparkNoise = texture2D(uFoamTex, vWorldPos.xz * 5.5 + vec2(uTime * 0.06, uTime * 0.028)).r;
  float reflLum = dot(refl, vec3(0.299, 0.587, 0.114));
  float brightZone = smoothstep(0.18, 0.82, reflLum);
  // O céu refletido é pálido perto do horizonte. Deixar isso entrar inteiro
  // transforma o rasante num lençol leitoso; o contraste vem de escurecer a
  // parcela difusa e deixar só as cintilações em alta luz.
  refl *= 1.0 - brightZone * (0.62 - 1.05 * sparkNoise) * (0.65 + 0.35 * clamp(dist * 0.02, 0.0, 1.0));

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
  // borda irregular: espuma na linha d'água não é um anel desenhado a compasso
  float ringNoise = texture2D(uFoamTex, vWorldPos.xz * 0.55 + vec2(uTime * 0.015, -uTime * 0.011)).b;
  float ringFine = texture2D(uFoamTex, vWorldPos.xz * 1.9 + vec2(-uTime * 0.05, uTime * 0.03)).r;
  float eEdge = hullE + (ringNoise - 0.5) * 0.16 + (ringFine - 0.5) * 0.05;
  float contact = smoothstep(1.04, 0.92, eEdge) * smoothstep(0.80, 1.02, eEdge);
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

  // Três escalas no referencial do vento (as faixas de espuma são alongadas):
  //   lace  = a "renda" que desenha a linha de espuma
  //   fine  = as bolhas que a preenchem
  //   speck = o salpicado fino, só perto da câmera
  vec2 fWarp = vec2(dot(vWorldPos.xz, uWindDir), dot(vWorldPos.xz, crossWind));
  // As linhas de espuma ficavam perfeitamente paralelas ("fileiras"). Em mar
  // real a linha de crista serpenteia: deformar a UV com a própria ondulação
  // grande (rd2, já amostrada) custa zero e quebra o alinhamento.
  fWarp += vec2(rd2.x, rd2.y) * 3.6 + vec2(rd1.x, rd1.y) * 0.9;
  float lace = texture2D(uFoamTex, fWarp * vec2(0.105, 0.205) - vec2(drift * 0.012, 0.0)).b;
  lace *= lace * 1.35;
  float fine = texture2D(uFoamTex, fWarp * vec2(0.34, 0.52) - vec2(drift * 0.05, 0.0)).r;
  float speck = texture2D(uFoamTex, fWarp * vec2(0.95, 1.35) - vec2(drift * 0.14, 0.0)).a;
  float fineFade = 1.0 - clamp(dist * 0.006, 0.0, 0.9);
  float bubbles = lace * 0.42 + fine * (0.62 * fineFade) + speck * (0.18 * fineFade);

  // limiar estreito = borda nítida (espuma chapada de borda macia parece algodão)
  float t0 = 0.672 - 0.20 * crestGate;
  float foam = smoothstep(t0, t0 + 0.045, bubbles) * crestGate;
  // granulado: quebra o interior liso da mancha em espuma de bolha
  // quebra a mancha em grânulo: sem isso a renda de 12 m vira um disco branco
  // de borda macia (o "negócio branco passando" que aparecia na vista de cima)
  foam *= 0.28 + 1.30 * speck;

  // véu leve sobre cristas muito altas (mesmo sem compressão máxima)
  float heightGate = smoothstep(0.62, 1.00, hNorm) * crestGate;
  foam += heightGate * smoothstep(0.66, 0.86, bubbles) * 0.06;

  // estrutura fina: espuma real é uma malha de bolhas, não uma mancha chapada
  foam *= 0.45 + 0.85 * smoothstep(0.28, 0.80, fine);
  foam = clamp(foam, 0.0, 0.92);
  foam *= uFoamStrength;
  foam *= 1.0 - 0.5 * smoothstep(0.4, 0.95, ndv); // espuma clinada para a câmera some um pouco
  foam *= 0.55 + 0.45 * smoothstep(0.0, 30.0, dist);
  // De longe, a mancha de espuma vira um borrão branco passeando pelo mar —
  // parece sujeira na lente. A cobertura cai com a distância.
  foam *= mix(0.07, 1.0, 1.0 - smoothstep(80.0, 400.0, dist));
  // espuminha na linha d'água do casco (só perto do barco)
  foam += contact * (0.08 + 0.40 * smoothstep(0.30, 0.72, bubbles)) * (0.55 + 0.75 * ringNoise) * uBoatShadow;

  vec3 foamLit = uFoamColor * (0.35 + 0.75 * max(ndl, 0.0)) + skyAmbient * 0.35;
  foamLit *= 0.80 + 0.34 * lace;
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
