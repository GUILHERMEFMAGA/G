/**
 * Verificação estática dos shaders (GLSL ES 1.0).
 *
 * O parser não expande macros, então substituímos os #define antes de analisar
 * e filtramos os identificadores embutidos do GLSL/three.js. Qualquer outro
 * "variável indefinida" indica erro de digitação em uniform/attribute — o tipo
 * de erro que só apareceria no console do navegador.
 *
 * Uso: npm run check
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@shaderfrog/glsl-parser';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shaderDir = join(root, 'src', 'shaders');

const BUILTINS = new Set([
  // vértice
  'position', 'normal', 'uv', 'uv1', 'uv2', 'color', 'tangent',
  'modelMatrix', 'modelViewMatrix', 'projectionMatrix', 'viewMatrix', 'normalMatrix',
  'cameraPosition', 'isOrthographic', 'instanceMatrix',
  // fragmento
  'gl_FragColor', 'gl_FragData', 'gl_FragCoord', 'gl_FrontFacing', 'gl_PointCoord', 'gl_PointSize',
  'gl_Position', 'gl_VertexID', 'gl_InstanceID', 'gl_DepthRange',
  // funções e tipos
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt',
  'inversesqrt', 'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix',
  'step', 'smoothstep', 'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward',
  'reflect', 'refract', 'texture2D', 'texture2DProj', 'textureCube', 'dFdx', 'dFdy', 'fwidth',
  'float', 'int', 'bool', 'void', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2',
  'bvec3', 'bvec4', 'mat2', 'mat3', 'mat4', 'sampler2D', 'samplerCube', 'true', 'false',
  'return', 'if', 'else', 'for', 'while', 'break', 'continue', 'discard',
]);

// macros usadas nos shaders (o parser não as expande)
const MACROS = { NW: '16', ND: '14', PI: '3.14159265359' };

function expandMacros(src) {
  return src.replace(/#define\s+(\w+)\s+([^\n]+)/g, (line, name, value) => {
    MACROS[name] = value.trim();
    return '';
  }).replace(/\b(NW|ND|PI)\b/g, (m) => MACROS[m] ?? m);
}

const files = readdirSync(shaderDir).filter((f) => f.endsWith('.glsl'));
let failures = 0;

for (const file of files) {
  const raw = readFileSync(join(shaderDir, file), 'utf8');
  const source = `precision highp float;\nprecision highp int;\n${expandMacros('#define NW 16\n#define ND 14\n' + raw)}`;
  const stage = file.includes('.vert') ? 'vertex' : 'fragment';

  const messages = [];
  const originalWarn = console.warn;
  console.warn = (...args) => messages.push(args.join(' '));
  let error = ctxError();
  function ctxError() {
    try {
      parse(source, { stage });
      return null;
    } catch (err) {
      return err.message;
    }
  }
  console.warn = originalWarn;

  const unknown = new Set();
  for (const m of messages) {
    const match = /undefined variable: "([^"]+)"/.exec(m);
    if (match && !BUILTINS.has(match[1])) unknown.add(match[1]);
  }

  if (error || unknown.size) {
    failures++;
    console.log(`  FAIL ${file}`);
    if (error) console.log(`        erro de sintaxe: ${error}`);
    for (const u of unknown) console.log(`        identificador indefinido: ${u}`);
  } else {
    console.log(`  ok   ${file}`);
  }
}

console.log(
  failures === 0
    ? '\nShaders válidos: sintaxe ok e nenhum identificador indefinido.'
    : `\n${failures} shader(s) com problema.`
);
process.exit(failures === 0 ? 0 : 1);
