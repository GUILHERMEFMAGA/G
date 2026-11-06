# OCEANO 3D — mar realista com física de flutuação

Simulação em tempo real de mar aberto no navegador: ondas geradas a partir de um
espectro de vento (JONSWAP), superfície renderizada com reflexão planar, Fresnel,
espuma e espalhamento subsuperficial — e um veleiro de 6 toneladas que **flutua de
verdade**, com 6 graus de liberdade, empuxo de Arquimedes distribuído e lastro de
quilha.

Tudo é procedural: nenhuma textura, modelo 3D ou mapa de ambiente é baixado.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # build de produção em dist/
npm run check    # valida a sintaxe dos shaders GLSL
npm run test:physics  # simula a física no terminal e imprime o comportamento
```

---

## O que está acontecendo

### 1. O mar vem de um espectro de energia, não de senoides aleatórias

`src/waves/WaveField.js` constrói o mar a partir do espectro **JONSWAP** (o modelo
clássico de mares gerados por vento), discretizado em 16 componentes de Gerstner
para a geometria e mais 14 para as ondulações finas.

Cada componente obedece à **relação de dispersão de águas profundas** `ω² = g·k`:
ondas longas viajam mais rápido que as curtas. É isso que dá ao mar o seu
comportamento característico (e é o que faz as cristas "correrem" na direção do
vento). A altura significativa é calibrada pela fórmula de mar totalmente
desenvolvido `Hs ≈ 0,21·U²/g`, com vento de 10,5 m/s → **Hs = 2,12 m, período de
pico 7,7 s, comprimento de pico 92 m** (valores mostrados no HUD).

Extras físicos implementados:

- **espalhamento direcional** (leque que abre nas ondas curtas);
- **mar cruzado**: 30 % da energia vem de um sistema secundário a ~60°, o que
  quebra as cristas paralelas e deixa o mar convincente;
- **choppiness**: achatamento das cristas por deslocamento horizontal, limitado a
  λ/4π por componente para a superfície não se auto-intersectar;
- **inversão do mapeamento de Gerstner** por iteração, para consultar a altura da
  água em qualquer ponto (é o que a física usa).

### 2. A física do barco usa o MESMO campo de ondas

`src/physics/BoatPhysics.js` — corpo rígido com 6 GDL, integração semi-implícita
com sub-passos fixos de 1/120 s.

| Força | Modelo |
| --- | --- |
| Gravidade | peso no centro de massa |
| Empuxo | **120 sondas volumétricas** dentro do casco; cada uma submersa gera `ρ·g·V` e torque `r × F` |
| Arrasto | quadrático por sonda, relativo à **velocidade orbital da água** (as ondas empurram o barco, não é um fluido parado) |
| Quilha | resistência lateral que impede a derrapagem e gera banda |
| Vento | força nas velas aplicada acima do centro de massa → banda |
| Lastro | 45 % da massa no bulbo da quilha → momento restaurador que reendireita |

A massa é calibrada automaticamente a partir das sondas para que a linha d'água de
projeto caia em `y = 0`: uma vez que empuxo e massa escalam juntos, o equilíbrio e
a dinâmica não mudam — só o valor físico da massa (6,0 t, deslocamento 5,85 m³).

Resultados medidos (`npm run test:physics`):

| Cenário | Arfagem (heave) | Banda (roll) | Caturro (pitch) |
| --- | --- | --- | --- |
| Mar calmo | ±0,02 m | ±0,07° | −1,4° (trim estático) |
| Brisa 10,5 m/s | −0,7 … +1,0 m | −3 … −11° (banda pelo vento) | −7 … +3° |
| Vendaval 20 m/s (Hs 7,7 m) | ±3,2 m | −4 … −15° | −12 … +7° |

Custo: **~0,25 ms por frame** de simulação (120 sondas × 16 ondas × 2 sub-passos).

### 3. Renderização

Pipeline por frame (tudo em HDR linear, tone mapping só no fim):

1. física;
2. **passe de reflexão** — câmera espelhada no plano d'água, render target half-res;
3. passe principal (céu + água + barco) em `HalfFloat` com MSAA 4×;
4. passe final: exposição, ACES filmic, vinheta, sRGB e dithering.

Shader da água (`src/shaders/ocean.frag.glsl`):

- deslocamento de Gerstner e **normais analíticas** no vértice, com o **Jacobiano**
  do mapeamento para detectar cristas comprimidas (onde a espuma nasce);
- reflexão planar amostrada em espaço de tela com distorção pelas normais;
- **Fresnel de Schlick** (F0 = 0,02); as ondulações finas são atenuadas com a
  distância justamente para não destruir o Fresnel rasante e o mar distante
  continuar espelhando o céu;
- espalhamento subsuperficial (luz atravessando as cristas);
- especular do sol por **GGX** com rugosidade crescente na distância (anti-aliasing);
- espuma: Jacobiano + ruído fBm tileável em três escalas + véu sobre cristas altas;
- perspectiva atmosférica que se funde com o céu no horizonte.

O céu (`src/shaders/sky.frag.glsl`) tem gradiente atmosférico, halo de Mie, disco
solar, nuvens em duas camadas e estrelas. A malha do oceano é **polar e acompanha a
câmera** (densa perto, até 26 km no horizonte), então o detalhe se concentra onde
importa.

---

## Controles

- **Arrastar** orbita · **scroll** dá zoom
- **W / S** acelera / ré · **A / D** leme · **Espaço** pausa o mar
- Painel à direita: vento (m/s), direção, altura das ondas, cristas, hora do dia,
  nebulosidade, espuma, translucidez, ondulação fina, todas as constantes da
  física (empuxo, arrasto, quilha, gravidade) e o modo de câmera.

## Estrutura

```
index.html            HUD + canvas
src/main.js           loop, passes de render, câmera, entrada
src/style.css         HUD e painel de controles
src/waves/WaveField.js    espectro JONSWAP + avaliação CPU das ondas
src/ocean/Ocean.js        malha polar + material da água
src/sky/{Sky,Atmosphere}.js   domo celeste e modelo de luz do dia
src/boat/Boat.js          casco loftado, convés, cabine, mastro, velas, sondas
src/physics/BoatPhysics.js  corpo rígido, empuxo, arrasto, vento, leme
src/shaders/*.glsl        ocean, sky, post
src/util/{math,textures}.js  constantes, PRNG, texturas procedurais
scripts/check.js          validação estática dos shaders
scripts/testPhysics.js    bancada de teste da física (sem navegador)
```

## Notas

- `window.__oceano` expõe os sistemas (parâmetros, física, atmosfera) para inspeção
  no console do navegador.
- Requer WebGL2. Em GPUs sem `EXT_color_buffer_float` o pipeline cai para 8 bits
  automaticamente (menos brilho especular, mas funciona).
