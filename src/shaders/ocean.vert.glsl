// ---------------------------------------------------------------------------
// Oceano — vértice
// Malha polar que acompanha a câmera; o deslocamento é calculado em espaço de
// mundo com as componentes de Gerstner vindas do espectro JONSWAP.
// ---------------------------------------------------------------------------

uniform float uTime;
uniform vec4 uSwellA[NW]; // (kx, kz, omega, phase)
uniform vec4 uSwellB[NW]; // (qx, qz, amp, -)

varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vBaseXZ;
varying float vJacobian;
varying float vHeight;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 xz = wp.xz;

  vec3 disp = vec3(0.0);

  // derivadas do mapeamento P(x,z): T = dP/dx, B = dP/dz
  float dPxdx = 1.0;
  float dPydx = 0.0;
  float dPzdx = 0.0;
  float dPxdz = 0.0;
  float dPydz = 0.0;
  float dPzdz = 1.0;

  for (int i = 0; i < NW; i++) {
    vec4 A = uSwellA[i];
    vec4 B = uSwellB[i];

    float theta = A.x * xz.x + A.y * xz.y - A.z * uTime + A.w;
    float s = sin(theta);
    float c = cos(theta);

    disp.x -= B.x * c;
    disp.z -= B.y * c;
    disp.y += B.z * s;

    dPxdx += B.x * A.x * s;
    dPzdx += B.y * A.x * s;
    dPydx += B.z * A.x * c;

    dPxdz += B.x * A.y * s;
    dPzdz += B.y * A.y * s;
    dPydz += B.z * A.y * c;
  }

  vec3 T = vec3(dPxdx, dPydx, dPzdx);
  vec3 Bm = vec3(dPxdz, dPydz, dPzdz);
  vec3 n = normalize(cross(Bm, T));

  vec3 worldPos = vec3(xz.x + disp.x, disp.y, xz.y + disp.z);

  vWorldPos = worldPos;
  vNormal = n;
  vBaseXZ = xz;
  vHeight = disp.y;
  // Jacobiano: < 1 significa superfície comprimida -> crista que "quebra"
  vJacobian = dPxdx * dPzdz - dPxdz * dPzdx;

  gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
}
