varying vec3 vDir;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  vec4 clip = projectionMatrix * viewMatrix * wp;
  gl_Position = clip;
}
