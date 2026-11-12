// Io, the heroine of STARMENDER: a fully procedural, posable character (no external assets).
// Local frame: +Y up, faces +Z, metres, origin = ground point between the feet in the standing pose.
// Everything that moves (hair, scarf, coat hem, skinned torso) is rebuilt on the CPU as a pure function
// of (pose, face, t, wind) so frames can be rendered in any order and the engine's hero mask matches.
import * as THREE from 'three';
import { toonMat, canvasTex } from './materials.js';
import { clamp, sat, lerp, smoothstep, fbm1, rng } from './lib.js';

const DEG = Math.PI / 180, TAU = Math.PI * 2;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UA = 0.215, FA = 0.19, TH = 0.34, SH = 0.33, ANK = 0.09, HEAD_S = 1.1;

// toonMat() adds direct light on the shadow side of the terminator (ramp + sss), where three's GGX / sheen
// visibility terms blow up at grazing view angles and bloom into fireflies. Same shading language, with the
// direct specular masked to the really lit side and clamped.
function ioMat(p) {
  const m = toonMat(p), base = m.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    base(shader, r);
    shader.fragmentShader = shader.fragmentShader
      .replace('vec3 irradiance = dotNL * directLight.color;', 'vec3 irradiance = dotNL * directLight.color;\n\tfloat specMask = smoothstep( 0.0, 0.12, toonNL );')
      .replace('sheenSpecularDirect += irradiance * BRDF_Sheen(', 'sheenSpecularDirect += specMask * irradiance * BRDF_Sheen(')
      .replace('reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;', 'reflectedLight.directSpecular += min( irradiance * specularBRDF * material.multiScatteringCompensation, vec3( 6.0 ) ) * specMask;');
  };
  m.customProgramCacheKey = () => 'toon-io';
  return m;
}

// ---------------------------------------------------------------- geometry helpers

// Smooth interpolation through [[x, y], ...] keys (Catmull-Rom, clamped ends).
function curve(ks) {
  const n = ks.length;
  return (x) => {
    if (x <= ks[0][0]) return ks[0][1];
    if (x >= ks[n - 1][0]) return ks[n - 1][1];
    let i = 0; while (x > ks[i + 1][0]) i++;
    const p0 = ks[Math.max(0, i - 1)], p1 = ks[i], p2 = ks[i + 1], p3 = ks[Math.min(n - 1, i + 2)];
    const dx = p2[0] - p1[0], t = (x - p1[0]) / dx;
    const m1 = (p2[1] - p0[1]) / (p2[0] - p0[0]) * dx, m2 = (p3[1] - p1[1]) / (p3[0] - p1[0]) * dx;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
  };
}

// Radius of a unit superellipse |x|^n + |z|^n = 1 at polar angle phi.
function sePolar(phi, n) {
  if (n === 2) return 1;
  return 1 / Math.pow(Math.pow(Math.abs(Math.sin(phi)), n) + Math.pow(Math.abs(Math.cos(phi)), n), 1 / n);
}

function gridNormals(g) {
  g.computeVertexNormals();
  const gr = g.userData.grid; if (!gr) return;
  const { nu, nv, closeU, closeV } = gr, cols = nu + 1, N = g.attributes.normal.array, P = g.attributes.position.array;
  const weld = (a, b) => {
    const x = N[a * 3] + N[b * 3], y = N[a * 3 + 1] + N[b * 3 + 1], z = N[a * 3 + 2] + N[b * 3 + 2], l = Math.hypot(x, y, z) || 1;
    N[a * 3] = N[b * 3] = x / l; N[a * 3 + 1] = N[b * 3 + 1] = y / l; N[a * 3 + 2] = N[b * 3 + 2] = z / l;
  };
  if (closeU) for (let j = 0; j <= nv; j++) weld(j * cols, j * cols + nu);
  if (closeV) for (let i = 0; i <= nu; i++) weld(i, nv * cols + i);
  for (const j of [0, nv]) { // collapsed rows (poles) share one normal
    const a = j * cols, b = a + (nu >> 1);
    if (Math.abs(P[a * 3] - P[b * 3]) + Math.abs(P[a * 3 + 1] - P[b * 3 + 1]) + Math.abs(P[a * 3 + 2] - P[b * 3 + 2]) > 1e-7) continue;
    let x = 0, y = 0, z = 0;
    for (let i = 0; i <= nu; i++) { x += N[(a + i) * 3]; y += N[(a + i) * 3 + 1]; z += N[(a + i) * 3 + 2]; }
    const l = Math.hypot(x, y, z) || 1;
    for (let i = 0; i <= nu; i++) { N[(a + i) * 3] = x / l; N[(a + i) * 3 + 1] = y / l; N[(a + i) * 3 + 2] = z / l; }
  }
  g.attributes.normal.needsUpdate = true;
}

// Parametric grid surface. fn(u, v, out[3], i, j). u wraps when closeU (seam vertices are duplicated for UVs).
function gridGeo(nu, nv, fn, o = {}) {
  const { closeU = true, closeV = false, orient = true, flip = false, uvScale = [1, 1], uvFn = null } = o;
  const cols = nu + 1, n = cols * (nv + 1), pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), p = [0, 0, 0], t = [0, 0];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const k = j * cols + i; fn(i / nu, j / nv, p, i, j);
    pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
    if (uvFn) { uvFn(i / nu, j / nv, p, t); uv[k * 2] = t[0]; uv[k * 2 + 1] = t[1]; } else { uv[k * 2] = i / nu * uvScale[0]; uv[k * 2 + 1] = j / nv * uvScale[1]; }
  }
  const idx = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1; idx.push(a, b, c, b, d, c); }
  let rev = flip;
  if (orient) { // face outward: signed volume about the centroid
    let cx = 0, cy = 0, cz = 0; for (let k = 0; k < n; k++) { cx += pos[k * 3]; cy += pos[k * 3 + 1]; cz += pos[k * 3 + 2]; } cx /= n; cy /= n; cz /= n;
    let vol = 0;
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const ax = pos[a] - cx, ay = pos[a + 1] - cy, az = pos[a + 2] - cz, bx = pos[b] - cx, by = pos[b + 1] - cy, bz = pos[b + 2] - cz, qx = pos[c] - cx, qy = pos[c + 1] - cy, qz = pos[c + 2] - cz;
      vol += ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx);
    }
    if (vol < 0) rev = !rev;
  }
  if (rev) for (let k = 0; k < idx.length; k += 3) { const s = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = s; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
  g.userData.grid = { nu, nv, closeU, closeV };
  gridNormals(g);
  return g;
}

// Re-evaluate the positions of a grid geometry in place.
function regrid(g, fn) {
  const { nu, nv } = g.userData.grid, cols = nu + 1, pos = g.attributes.position.array, p = [0, 0, 0];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { const k = (j * cols + i) * 3; fn(i / nu, j / nv, p, i, j); pos[k] = p[0]; pos[k + 1] = p[1]; pos[k + 2] = p[2]; }
  g.attributes.position.needsUpdate = true; gridNormals(g);
}

// Lathe-like loft along Y. rows: [y, rx, rz, cx, cz, n] (n = superellipse exponent).
function lathe(rw, seg = 24, o = {}) {
  return gridGeo(seg, rw.length - 1, (u, v, p, i, j) => {
    const r = rw[j], ph = u * TAU, k = sePolar(ph, r[5] || 2);
    p[0] = (r[3] || 0) + r[1] * k * Math.sin(ph); p[1] = r[0]; p[2] = (r[4] || 0) + r[2] * k * Math.cos(ph);
  }, o);
}

// Smooth rows from a few keys [y, rx, rz?, cx?, cz?, n?] (ascending y) with optional rounded end caps.
function rows(keys, nBody = 8, capLo = 0, capHi = 0, capN = 4) {
  const col = (c, d) => curve(keys.map((k) => [k[0], k[c] ?? (c === 2 ? k[1] : d)]));
  const f = [col(1, 0), col(2, 0), col(3, 0), col(4, 0), col(5, 2)];
  const y0 = keys[0][0], y1 = keys[keys.length - 1][0], out = [];
  const at = (y) => [y, f[0](y), f[1](y), f[2](y), f[3](y), f[4](y)];
  if (capLo > 0) { const b = at(y0); for (let i = capN; i >= 1; i--) { const ph = i / capN * Math.PI / 2; out.push([y0 - capLo * Math.sin(ph), b[1] * Math.cos(ph), b[2] * Math.cos(ph), b[3], b[4], b[5]]); } }
  for (let i = 0; i <= nBody; i++) out.push(at(lerp(y0, y1, i / nBody)));
  if (capHi > 0) { const b = at(y1); for (let i = 1; i <= capN; i++) { const ph = i / capN * Math.PI / 2; out.push([y1 + capHi * Math.sin(ph), b[1] * Math.cos(ph), b[2] * Math.cos(ph), b[3], b[4], b[5]]); } }
  return out;
}

function mirrorX(g) {
  const p = g.attributes.position.array; for (let i = 0; i < p.length; i += 3) p[i] = -p[i];
  const ix = g.index.array; for (let k = 0; k < ix.length; k += 3) { const s = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = s; }
  gridNormals(g); return g;
}

// Tube swept along a path. frame(v, F) fills F.c / F.n / F.b (centre, normal, binormal); sec(u, v, out[2]).
function sweepFn(frame, sec) {
  const F = { c: v3(), n: v3(), b: v3() }, s = [0, 0]; let lastJ = -1;
  return (u, v, p, i, j) => {
    if (j !== lastJ || i === 0) { frame(v, F); lastJ = j; }
    sec(u, v, s);
    p[0] = F.c.x + F.n.x * s[0] + F.b.x * s[1]; p[1] = F.c.y + F.n.y * s[0] + F.b.y * s[1]; p[2] = F.c.z + F.n.z * s[0] + F.b.z * s[1];
  };
}

// ---------------------------------------------------------------- head sculpt (head-local metres, before HEAD_S)

const HY0 = -0.045, HH = 0.225, HC = [0, HY0 + 0.6 * HH, -0.012]; // chin y, chin-to-crown height, cranium centre
const YE = HY0 + 0.40 * HH, YN = HY0 + 0.25 * HH, YM = HY0 + 0.135 * HH; // eye line, nose tip, mouth
const EYE = { x: 0.0375, w: 0.058, cy: 0.003 };
const cW = curve([[-0.012, 0], [0, 0.0095], [0.04, 0.027], [0.1, 0.047], [0.18, 0.063], [0.28, 0.0765], [0.38, 0.086], [0.5, 0.0918], [0.6, 0.094]]);
const cF = curve([[-0.012, 0.064], [0, 0.069], [0.04, 0.0755], [0.1, 0.0795], [0.17, 0.081], [0.24, 0.082], [0.32, 0.081], [0.42, 0.0795], [0.52, 0.0815], [0.6, 0.083]]);
const cB = curve([[-0.012, 0.064], [0, 0.056], [0.04, 0.04], [0.1, 0.012], [0.18, -0.03], [0.26, -0.065], [0.36, -0.092], [0.48, -0.107], [0.6, -0.112]]);
const cC = curve([[-0.012, 0.064], [0, 0.062], [0.06, 0.055], [0.14, 0.035], [0.24, 0.012], [0.36, -0.004], [0.6, -0.012]]);
const cN = curve([[-0.012, 2], [0.05, 2.1], [0.2, 2.5], [0.45, 2.6], [0.6, 2.3]]);
const HD = { W: 0, zF: 0, zB: 0, zc: 0, n: 2 };
function headDims(hy) {
  const d = HD;
  if (hy > 0.6) { const t = Math.min(1, (hy - 0.6) / 0.4), e = Math.sqrt(Math.max(0, 1 - t * t)); d.W = 0.094 * e; d.zc = -0.012; d.zF = -0.012 + 0.095 * e; d.zB = -0.012 - 0.1 * e; d.n = 2 + 0.3 * (1 - t) * (1 - t); }
  else { d.W = cW(hy); d.zF = cF(hy); d.zB = cB(hy); d.zc = cC(hy); d.n = cN(hy); }
  return d;
}
const gauss = (x, s) => Math.exp(-(x * x) / (s * s));
function faceBump(x, y) {
  const ax = Math.abs(x);
  const nose = 0.0062 * gauss(x, 0.0095) * (y > YN ? gauss(y - YN, 0.019) : gauss(y - YN, 0.0062));
  const socket = -0.0026 * gauss(ax - 0.038, 0.02) * gauss(y - YE, 0.019);
  const brow = 0.0011 * gauss(ax - 0.036, 0.03) * gauss(y - (YE + 0.03), 0.012);
  const lips = 0.0013 * gauss(x, 0.014) * gauss(y - YM, 0.008);
  const cheek = 0.0016 * gauss(ax - 0.046, 0.022) * gauss(y - (YE - 0.031), 0.02);
  return nose + socket + brow + lips + cheek;
}
function skull(a, hy, out, bumps = true) {
  const d = headDims(hy), s = Math.sin(a), c = Math.cos(a), front = c > 0;
  const n = front ? d.n : 2, r = sePolar(a, n);
  const x = d.W * r * s, y = HY0 + hy * HH;
  let z = d.zc + (front ? d.zF - d.zc : d.zc - d.zB) * r * c;
  if (bumps && front) z += faceBump(x, y) * smoothstep(0.15, 0.6, r * c);
  out[0] = x; out[1] = y; out[2] = z;
}
// Height of the face surface at (x, y), matching skull().
function faceZ(x, y) {
  const hy = (y - HY0) / HH, d = headDims(hy), q = Math.min(1, Math.abs(x) / Math.max(1e-6, d.W));
  const zn = Math.pow(Math.max(0, 1 - Math.pow(q, d.n)), 1 / d.n);
  return d.zc + (d.zF - d.zc) * zn + faceBump(x, y) * smoothstep(0.15, 0.6, zn);
}
// "Wig form": the surface the hair flows over (skull offset on top, a soft bob curtain below).
function wig(a, hy, lift, out) {
  skull(a, Math.max(hy, 0.55), out, false);
  let x = out[0], y = out[1], z = out[2];
  if (hy < 0.55) { const d = (0.55 - hy) / 0.55, tp = 1 - 0.1 * d * d; x *= tp; z = HC[2] + (z - HC[2]) * tp; y = HY0 + hy * HH; }
  let nx = x, ny = (y - HC[1]) * smoothstep(0.45, 0.7, hy), nz = z - HC[2];
  const l = Math.hypot(nx, ny, nz) || 1, off = 0.007 + lift;
  out[0] = x + nx / l * off; out[1] = y + ny / l * off; out[2] = z + nz / l * off;
}
// Normalised distance from the head's collision ellipsoid (cylinder below the cranium centre).
function headE(x, y, z) {
  const dy = Math.max(0, y - HC[1]) / 0.1, dz = (z - HC[2]) / (z > HC[2] ? 0.1 : 0.106);
  return Math.sqrt((x / 0.1) * (x / 0.1) + dy * dy + dz * dz);
}

// ---------------------------------------------------------------- painted textures

const SKIN = '#f6d2b8';
function drawKnit(c, W, H, cols, rws, rib) {
  c.fillStyle = '#505050'; c.fillRect(0, 0, W, H);
  const cw = W / cols, rh = H / rws;
  for (let i = 0; i < cols; i++) for (let r = -1; r <= rws; r++) for (const sg of [-1, 1]) {
    c.save(); c.translate((i + 0.5 + sg * 0.2) * cw, (r + 0.5) * rh); c.rotate(sg * 0.4);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, rh * 0.8);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#dddddd'); g.addColorStop(1, '#8c8c8c');
    c.fillStyle = g; c.beginPath(); c.ellipse(0, 0, cw * 0.2, rh * 0.74, 0, 0, TAU); c.fill(); c.restore();
  }
  if (rib) for (let i = 0; i <= cols; i++) { const g = c.createLinearGradient((i - 0.14) * cw, 0, (i + 0.14) * cw, 0); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(0,0,0,0.42)'); g.addColorStop(1, 'rgba(0,0,0,0)'); c.fillStyle = g; c.fillRect((i - 0.14) * cw, 0, 0.28 * cw, H); }
}
function drawWool(c, W, H) {
  c.fillStyle = '#909090'; c.fillRect(0, 0, W, H);
  const R = rng(5);
  for (let i = 0; i < 1400; i++) {
    const x = R() * W, y = R() * H, r = 3 + R() * 7, l = R() > 0.45;
    for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) {
      if (x + ox < -r || x + ox > W + r || y + oy < -r || y + oy > H + r) continue;
      const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, l ? 'rgba(255,255,255,0.55)' : 'rgba(30,30,30,0.4)'); g.addColorStop(1, l ? 'rgba(255,255,255,0)' : 'rgba(30,30,30,0)');
      c.fillStyle = g; c.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
}
function drawQuiltTile(c, W, H, bump) {
  c.fillStyle = bump ? '#b8b8b8' : '#27305e'; c.fillRect(0, 0, W, H);
  c.strokeStyle = bump ? '#2c2c2c' : '#181f48'; c.lineWidth = bump ? W * 0.05 : W * 0.018;
  if (bump) c.filter = `blur(${W * 0.028}px)`;
  c.beginPath();
  for (let k = -1; k <= 1; k++) { c.moveTo(k * W, 0); c.lineTo((k + 1) * W, H); c.moveTo((k + 1) * W, 0); c.lineTo(k * W, H); }
  c.stroke(); c.filter = 'none';
}
// Coat sheet: top half = torso (u around from the front, v up), bottom half = skirt.
function drawCoat(c, S, bump) {
  const half = S / 2, ND = 14;
  c.fillStyle = bump ? '#b4b4b4' : '#27305e'; c.fillRect(0, 0, S, S);
  if (!bump) { const g = c.createLinearGradient(0, 0, 0, S); g.addColorStop(0, 'rgba(70,84,150,0.22)'); g.addColorStop(0.5, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(8,10,30,0.3)'); c.fillStyle = g; c.fillRect(0, 0, S, S); }
  const region = (y0, y1, nV) => {
    c.save(); c.beginPath(); c.rect(0, y0, S, y1 - y0); c.clip();
    const dx = S / ND, span = (y1 - y0);
    c.lineWidth = bump ? S * 0.006 : S * 0.0017; c.strokeStyle = bump ? '#303030' : '#171d47';
    if (bump) c.filter = `blur(${S * 0.0035}px)`;
    c.beginPath();
    for (let k = -nV - 1; k <= ND + nV + 1; k++) { c.moveTo(k * dx, y0); c.lineTo((k + nV) * dx, y0 + span); c.moveTo(k * dx, y0); c.lineTo((k - nV) * dx, y0 + span); }
    c.stroke(); c.filter = 'none';
    if (!bump) { c.lineWidth = S * 0.0008; c.strokeStyle = 'rgba(96,112,190,0.35)'; c.setLineDash([S * 0.004, S * 0.004]); c.stroke(); c.setLineDash([]); }
    c.restore();
  };
  region(0, half, 8); region(half, S, 6);
  const pw = S * 0.02; // front placket, split across the u seam
  for (const x0 of [0, S - pw]) {
    c.fillStyle = bump ? '#d2d2d2' : '#222a56'; c.fillRect(x0, 0, pw, S);
    const xe = x0 === 0 ? pw : x0;
    c.fillStyle = bump ? '#404040' : '#141a40'; c.fillRect(xe - S * 0.0012, 0, S * 0.0024, S);
    if (!bump) { c.strokeStyle = 'rgba(120,136,210,0.5)'; c.lineWidth = S * 0.0008; c.setLineDash([S * 0.004, S * 0.003]); const xs = x0 === 0 ? pw * 0.6 : x0 + pw * 0.4; c.beginPath(); c.moveTo(xs, 0); c.lineTo(xs, S); c.stroke(); c.setLineDash([]); }
  }
  // hem band
  c.fillStyle = bump ? '#c8c8c8' : '#222a56'; c.fillRect(0, S * 0.955, S, S * 0.045);
  c.fillStyle = bump ? '#3c3c3c' : '#141a40'; c.fillRect(0, S * 0.953, S, S * 0.003);
}
function drawHair(c, W, H) {
  c.fillStyle = '#222a54'; c.fillRect(0, 0, W, H);
  let g = c.createLinearGradient(0, 0, W, 0); g.addColorStop(0, 'rgba(14,18,40,0.6)'); g.addColorStop(0.25, 'rgba(34,42,84,0)'); g.addColorStop(0.5, 'rgba(52,66,126,0)'); g.addColorStop(1, 'rgba(66,84,158,1)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const yOf = (hy) => H * (1 - (hy + 0.5) / 1.7);
  const band = (h0, h1, col, a) => {
    const y0 = yOf(h1), y1 = yOf(h0); g = c.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, `rgba(${col},0)`); g.addColorStop(0.22, `rgba(${col},${a})`); g.addColorStop(0.7, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g; c.fillRect(0, y0, W, y1 - y0);
  };
  band(0.76, 0.85, '132,160,246', 0.7); band(0.715, 0.745, '104,128,222', 0.42);
}

let TEX = null;
function getTex() {
  if (TEX) return TEX;
  const light = (src, amt) => canvasTex(src.image.width, src.image.height, (c, w, h) => { c.drawImage(src.image, 0, 0); c.fillStyle = `rgba(255,255,255,${amt})`; c.fillRect(0, 0, w, h); }, { repeat: true });
  const knitB = canvasTex(256, 256, (c, w, h) => drawKnit(c, w, h, 3, 4, true), { srgb: false, repeat: true });
  const fineB = canvasTex(256, 256, (c, w, h) => drawKnit(c, w, h, 6, 8, false), { srgb: false, repeat: true });
  const woolB = canvasTex(256, 256, drawWool, { srgb: false, repeat: true });
  TEX = {
    knitB, knitM: light(knitB, 0.8), fineB, fineM: light(fineB, 0.72), woolB, woolM: light(woolB, 0.8),
    quiltB: canvasTex(128, 128, (c, w, h) => drawQuiltTile(c, w, h, true), { srgb: false, repeat: true }),
    quiltM: canvasTex(128, 128, (c, w, h) => drawQuiltTile(c, w, h, false), { repeat: true }),
    coatB: canvasTex(1024, 1024, (c, w) => drawCoat(c, w, true), { srgb: false, repeat: true }),
    coatM: canvasTex(2048, 2048, (c, w) => drawCoat(c, w, false), { repeat: true }),
    hair: canvasTex(128, 1024, drawHair),
  };
  return TEX;
}

// ---- face
const FACE_DEF = { blink: 0, lookX: 0, lookY: 0, brow: 0, browRaise: 0, smile: 0, mouthOpen: 0, eyeWide: 0, pupil: 1, blush: 0.5, reflect: 0, reflectColor: [1.0, 0.78, 0.36] };

function paintFace(c, S, F) {
  const k = S / 0.26;
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.fillStyle = SKIN; c.fillRect(0, 0, S, S);
  c.setTransform(k, 0, 0, -k, S / 2, S * (1 - 0.065 / 0.26));
  const blob = (x, y, r, col, a) => { const g = c.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(0.5, `rgba(${col},${a * 0.55})`); g.addColorStop(1, `rgba(${col},0)`); c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2); };
  const sm = F.smile, op = F.mouthOpen;
  // soft form shading painted in: under-brow, under-lip, forehead under the fringe
  for (const sx of [-1, 1]) blob(sx * 0.038, YE + 0.017, 0.03, '214,146,128', 0.16);
  blob(0, YM - 0.012, 0.016, '214,146,128', 0.2);
  { const g = c.createLinearGradient(0, YE + 0.05, 0, YE + 0.09); g.addColorStop(0, 'rgba(206,140,130,0)'); g.addColorStop(1, 'rgba(206,140,130,0.3)'); c.fillStyle = g; c.fillRect(-0.13, YE + 0.05, 0.26, 0.08); }
  // blush from the cold
  const bl = F.blush;
  if (bl > 0.001) {
    for (const sx of [-1, 1]) {
      blob(sx * 0.047, YE - 0.027 + sm * 0.0015, 0.027, '240,118,104', 0.36 * bl);
      c.strokeStyle = `rgba(226,96,92,${0.34 * bl})`; c.lineWidth = 0.0007; c.lineCap = 'round';
      for (let i = -1; i <= 1; i++) { const x = sx * 0.047 + i * 0.0052, y = YE - 0.028 + sm * 0.0015; c.beginPath(); c.moveTo(x - 0.0017, y - 0.003); c.lineTo(x + 0.0017, y + 0.003); c.stroke(); }
    }
    blob(0, YN + 0.003, 0.012, '240,118,104', 0.22 * bl);
  }
  // nose: tiny under-shadow and a soft tip light
  c.fillStyle = 'rgba(186,104,92,0.62)'; c.beginPath(); c.ellipse(0.0018, YN - 0.0052, 0.0026, 0.0011, -0.25, 0, TAU); c.fill();
  blob(-0.0008, YN + 0.0012, 0.0035, '255,246,236', 0.5);
  // mouth
  const hw = 0.0098 + 0.0036 * Math.max(0, sm) + 0.0012 * op - 0.0012 * Math.max(0, -sm), cy = YM + sm * 0.0036;
  c.lineCap = 'round'; c.lineJoin = 'round';
  if (op < 0.04) {
    c.strokeStyle = '#96433f'; c.lineWidth = 0.0012;
    c.beginPath(); c.moveTo(-hw, cy); c.quadraticCurveTo(0, YM - 0.0009 - sm * 0.0058, hw, cy); c.stroke();
    c.strokeStyle = 'rgba(150,67,63,0.55)'; c.lineWidth = 0.0009; // corner ticks
    for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(sx * hw, cy); c.lineTo(sx * (hw + 0.0012), cy + 0.0006 + sm * 0.0012); c.stroke(); }
  } else {
    const d = op * 0.019 + 0.002, top = YM + 0.0012 * op - sm * 0.0026;
    c.beginPath(); c.moveTo(-hw, cy); c.quadraticCurveTo(0, top + 0.0012, hw, cy); c.bezierCurveTo(hw * 0.92, YM - d * 1.25, -hw * 0.92, YM - d * 1.25, -hw, cy); c.closePath();
    c.save(); c.clip();
    c.fillStyle = '#6a2226'; c.fillRect(-0.03, YM - 0.04, 0.06, 0.06);
    c.fillStyle = '#e27a74'; c.beginPath(); c.ellipse(0, YM - d * 0.98, hw * 0.66, d * 0.36, 0, 0, TAU); c.fill();
    if (op > 0.22) { c.fillStyle = '#fff7ee'; c.beginPath(); c.ellipse(0, top + 0.0022, hw * 0.92, 0.0026, 0, 0, TAU); c.fill(); }
    c.restore();
    c.strokeStyle = '#7c2f30'; c.lineWidth = 0.001; c.stroke();
  }
  c.strokeStyle = 'rgba(204,128,112,0.5)'; c.lineWidth = 0.001; // lower-lip shadow
  { const y = YM - 0.0048 - op * 0.019; c.beginPath(); c.moveTo(-0.0042, y); c.quadraticCurveTo(0, y - 0.0011, 0.0042, y); c.stroke(); }
  // brows
  const br = F.brow, by = YE + 0.0335 + 0.0065 * F.browRaise + 0.003 * F.eyeWide;
  c.fillStyle = '#20254c';
  for (const sx of [-1, 1]) {
    const x0 = 0.0175, x1 = 0.0595, yi = by - br * 0.0058, yo = by - 0.0022 + br * 0.0028, ym = by + 0.0042 - Math.abs(br) * 0.0012;
    const up = [], dn = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, x = lerp(x0, x1, t), y = (1 - t) * (1 - t) * yi + 2 * t * (1 - t) * ym + t * t * yo;
      const th = lerp(0.0016, 0.0004, Math.pow(t, 1.3)) * (0.75 + 0.25 * Math.sin(Math.PI * Math.min(1, t * 3)));
      up.push([sx * x, y + th]); dn.push([sx * x, y - th]);
    }
    c.beginPath(); c.moveTo(up[0][0], up[0][1]); for (const p of up) c.lineTo(p[0], p[1]); for (let i = dn.length - 1; i >= 0; i--) c.lineTo(dn[i][0], dn[i][1]); c.closePath(); c.fill();
  }
}

// One eye, painted in "eye space": origin at the eye centre, +x toward the temple, y up (metres).
// side = +1 for her left eye (head +X), -1 for the right; screen-fixed details are un-mirrored with it.
// em = true paints the emissive layer instead (catch-lights, the reflected tear, a faint iris glow) on black.
function paintEye(c, S, side, F, em) {
  const sc = S / EYE.w;
  c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
  if (em) { c.fillStyle = '#000'; c.fillRect(0, 0, S, S); } else c.clearRect(0, 0, S, S);
  c.setTransform(sc, 0, 0, -sc, S / 2, S / 2 + EYE.cy * sc);
  const b = sat(F.blink), wide = F.eyeWide, sm = Math.max(0, F.smile), L2 = (p, q, k) => [lerp(p[0], q[0], k), lerp(p[1], q[1], k)];
  const Ci = [-0.0195, -0.0045], Co = [0.0212, -0.0002];
  const u1o = [-0.0165, 0.018 + 0.0045 * wide - 0.0014 * sm], u2o = [0.0105, 0.0238 + 0.0045 * wide - 0.0014 * sm];
  const l1o = [0.0178, -0.0168 - 0.0016 * wide + 0.0036 * sm], l2o = [-0.0128, -0.0178 - 0.0016 * wide + 0.0036 * sm];
  const arc = lerp(-0.0125, 0.0035, smoothstep(0.25, 0.8, sm)); // closed line: gentle sag, or a happy arc when smiling
  const k1 = [-0.012, arc], k2 = [0.012, arc + 0.001];
  const U1 = L2(u1o, k1, b), U2 = L2(u2o, k2, b), L1 = L2(l1o, k2, b * 0.4), Lw = L2(l2o, k1, b * 0.4);
  const bez = (t, P0, P1, P2, P3) => { const m = 1 - t; return [m * m * m * P0[0] + 3 * m * m * t * P1[0] + 3 * m * t * t * P2[0] + t * t * t * P3[0], m * m * m * P0[1] + 3 * m * m * t * P1[1] + 3 * m * t * t * P2[1] + t * t * t * P3[1]]; };
  const upperPath = () => { c.beginPath(); c.moveTo(Ci[0], Ci[1]); c.bezierCurveTo(U1[0], U1[1], U2[0], U2[1], Co[0], Co[1]); };
  const openPath = () => { upperPath(); c.bezierCurveTo(L1[0], L1[1], Lw[0], Lw[1], Ci[0], Ci[1]); c.closePath(); };
  const R = 0.0149 * (1 - 0.07 * wide), sqx = 1 - 0.07 * Math.abs(F.lookX);
  const ix = side * F.lookX * 0.0058 + 0.0006, iy = 0.0026 + F.lookY * 0.0046 - 0.0006 * sm;
  const irisClip = () => { c.translate(ix, iy); c.scale(sqx, 1); c.beginPath(); c.arc(0, 0, R * 0.955, 0, TAU); c.clip(); };
  const streak = (a) => { // the tear in the sky, mirrored in the upper iris: a thin bowed sliver with a hot core
    if (a < 0.003) return;
    c.save(); irisClip(); c.globalCompositeOperation = 'lighter';
    const col = F.reflectColor, rgb = `${Math.round(sat(col[0]) * 255)},${Math.round(sat(col[1]) * 255)},${Math.round(sat(col[2]) * 255)}`;
    const pth = (w0) => {
      const P = [], Q = [], n = 28;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = side * lerp(-0.26, 0.86, t) * R, y = lerp(0.03, 0.6, t) * R + Math.sin(t * Math.PI) * R * 0.08 + Math.sin(t * 23 + 1.3) * R * 0.014 + Math.sin(t * 9 + 0.5) * R * 0.02;
        const w = w0 * R * Math.pow(Math.sin(Math.PI * (0.03 + 0.94 * t)), 0.6) * (0.7 + 0.3 * Math.sin(t * 13 + 0.4));
        P.push([x - side * w * 0.45, y + w * 0.9]); Q.push([x + side * w * 0.45, y - w * 0.9]);
      }
      c.beginPath(); c.moveTo(P[0][0], P[0][1]); for (const p of P) c.lineTo(p[0], p[1]); for (let i = Q.length - 1; i >= 0; i--) c.lineTo(Q[i][0], Q[i][1]); c.closePath();
    };
    c.fillStyle = `rgba(${rgb},${0.14 * a})`; pth(0.17); c.fill();
    c.fillStyle = `rgba(${rgb},${0.3 * a})`; pth(0.08); c.fill();
    c.fillStyle = `rgba(${rgb},${0.85 * a})`; pth(0.034); c.fill();
    c.fillStyle = `rgba(255,250,232,${0.9 * a})`; pth(0.013); c.fill();
    c.restore();
  };
  const lights = (k) => { // catch-lights, fixed on screen-left for both eyes
    const hx = -side, cl = (x, y, rx, ry, rot, a) => { c.save(); c.translate(ix + x, iy + y); c.rotate(rot); c.scale(rx, ry); const g2 = c.createRadialGradient(0, 0, 0, 0, 0, 1); g2.addColorStop(0, `rgba(255,255,255,${a})`); g2.addColorStop(0.86, `rgba(255,255,255,${a})`); g2.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = g2; c.beginPath(); c.arc(0, 0, 1, 0, TAU); c.fill(); c.restore(); };
    cl(hx * R * 0.4, R * 0.43, R * 0.25, R * 0.185, hx * 0.5, k);
    cl(-hx * R * 0.44, -R * 0.47, R * 0.11, R * 0.095, 0, k * 0.88);
    cl(hx * R * 0.1, R * 0.7, R * 0.055, R * 0.045, 0, k * 0.7);
  };
  if (em) {
    if (b >= 0.985) return;
    c.save(); openPath(); c.clip();
    c.save(); irisClip(); const ge = c.createRadialGradient(0, -R * 0.45, 0, 0, -R * 0.2, R); ge.addColorStop(0, 'rgb(66,38,8)'); ge.addColorStop(1, 'rgb(12,5,1)'); c.fillStyle = ge; c.fillRect(-R, -R, 2 * R, 2 * R); c.restore();
    streak(F.reflect); lights(0.8);
    c.restore(); return;
  }
  if (b < 0.985) {
    c.save(); openPath(); c.clip();
    c.fillStyle = '#fcf6f0'; c.fillRect(-0.03, -0.03, 0.06, 0.06);
    let g = c.createLinearGradient(0, U2[1], 0, U2[1] - 0.026); g.addColorStop(0, 'rgba(92,80,128,0.55)'); g.addColorStop(1, 'rgba(92,80,128,0)'); c.fillStyle = g; c.fillRect(-0.03, -0.03, 0.06, 0.06);
    for (const [x, a] of [[-0.02, 0.2], [0.022, 0.26]]) { g = c.createRadialGradient(x, -0.002, 0, x, -0.002, 0.012); g.addColorStop(0, `rgba(170,120,120,${a})`); g.addColorStop(1, 'rgba(170,120,120,0)'); c.fillStyle = g; c.fillRect(-0.03, -0.03, 0.06, 0.06); }
    // ---- iris
    c.save(); c.translate(ix, iy); c.scale(sqx, 1);
    c.beginPath(); c.arc(0, 0, R, 0, TAU); c.clip();
    g = c.createRadialGradient(0, -R * 0.12, R * 0.1, 0, 0, R);
    g.addColorStop(0, '#ffd067'); g.addColorStop(0.42, '#f2a93b'); g.addColorStop(0.74, '#cf7222'); g.addColorStop(0.93, '#a8501a'); g.addColorStop(1, '#7a3310');
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 2 * R);
    const rnd = rng(31); c.lineCap = 'round';
    for (let i = 0; i < 230; i++) { // radial fibres
      const a = rnd() * TAU, r0 = R * (0.34 + rnd() * 0.16), r1 = R * (0.58 + rnd() * 0.38), li = rnd() > 0.42;
      c.strokeStyle = li ? `rgba(255,228,150,${0.08 + rnd() * 0.22})` : `rgba(116,48,12,${0.1 + rnd() * 0.22})`; c.lineWidth = R * (0.007 + rnd() * 0.018);
      const a2 = a + (rnd() - 0.5) * 0.09, rm = (r0 + r1) / 2, am = a + (rnd() - 0.5) * 0.05;
      c.beginPath(); c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); c.quadraticCurveTo(Math.cos(am) * rm, Math.sin(am) * rm, Math.cos(a2) * r1, Math.sin(a2) * r1); c.stroke();
    }
    for (let i = 0; i < 30; i++) { // crypts near the collarette
      const a = rnd() * TAU, r = R * (0.5 + rnd() * 0.14); c.fillStyle = `rgba(128,54,14,${0.12 + rnd() * 0.16})`;
      c.beginPath(); c.ellipse(Math.cos(a) * r, Math.sin(a) * r, R * 0.035, R * 0.014, a, 0, TAU); c.fill();
    }
    g = c.createRadialGradient(0, -R * 0.62, 0, 0, -R * 0.5, R * 0.8); // lower glow crescent
    g.addColorStop(0, 'rgba(255,236,160,0.85)'); g.addColorStop(0.5, 'rgba(255,214,120,0.36)'); g.addColorStop(1, 'rgba(255,214,120,0)');
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 2 * R);
    g = c.createLinearGradient(0, R, 0, -R * 0.2); g.addColorStop(0, 'rgba(58,18,10,0.78)'); g.addColorStop(0.45, 'rgba(70,22,10,0.4)'); g.addColorStop(1, 'rgba(70,22,10,0)'); // upper depth
    c.fillStyle = g; c.fillRect(-R, -R, 2 * R, 2 * R);
    c.strokeStyle = 'rgba(64,22,10,0.5)'; c.lineWidth = R * 0.2; c.beginPath(); c.arc(0, 0, R * 0.93, 0, TAU); c.stroke(); // limbal ring
    c.strokeStyle = 'rgba(46,14,8,0.92)'; c.lineWidth = R * 0.085; c.beginPath(); c.arc(0, 0, R * 0.965, 0, TAU); c.stroke();
    const Rp = R * 0.4 * F.pupil;
    c.strokeStyle = 'rgba(255,206,120,0.34)'; c.lineWidth = R * 0.026; c.beginPath(); c.arc(0, 0, Rp * 1.3, 0, TAU); c.stroke(); // collarette
    g = c.createRadialGradient(0, 0, Rp * 0.6, 0, 0, Rp * 1.12); g.addColorStop(0, '#120807'); g.addColorStop(0.78, '#1b0b08'); g.addColorStop(1, 'rgba(60,20,8,0)');
    c.fillStyle = g; c.beginPath(); c.arc(0, 0, Rp * 1.12, 0, TAU); c.fill();
    c.restore();
    // ---- soft shadow cast by the upper lid
    g = c.createLinearGradient(Ci[0], 0, Co[0], 0); g.addColorStop(0, 'rgba(36,18,44,0)'); g.addColorStop(0.24, 'rgba(36,18,44,0.44)'); g.addColorStop(0.8, 'rgba(36,18,44,0.44)'); g.addColorStop(1, 'rgba(36,18,44,0)');
    c.filter = `blur(${(S * 0.0042).toFixed(1)}px)`; upperPath(); c.lineCap = 'butt'; c.strokeStyle = g; c.lineWidth = 0.0086; c.stroke(); c.filter = 'none';
    streak(F.reflect * 0.9); lights(0.97);
    c.restore();
  }
  // ---- lash line: tapered, with a small wing and three slender outer lashes
  const NP = 44, lo = [], hi = [], nr = [];
  for (let i = 0; i <= NP; i++) {
    const t = i / NP, p = bez(t, Ci, U1, U2, Co), q = bez(Math.min(1, t + 0.01), Ci, U1, U2, Co), p0 = bez(Math.max(0, t - 0.01), Ci, U1, U2, Co);
    let nx = -(q[1] - p0[1]), ny = q[0] - p0[0]; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
    const th = (0.00055 + 0.0019 * smoothstep(0, 0.42, t) + 0.0008 * smoothstep(0.6, 1, t)) * (1 - 0.2 * b);
    lo.push([p[0] - nx * 0.0005, p[1] - ny * 0.0005]); hi.push([p[0] + nx * th, p[1] + ny * th]); nr.push([nx, ny]);
  }
  let g = c.createLinearGradient(Ci[0], 0, Co[0] + 0.005, 0); g.addColorStop(0, '#3a2a3c'); g.addColorStop(0.28, '#16162c'); g.addColorStop(0.85, '#16162c'); g.addColorStop(1, '#2c1c2c');
  c.fillStyle = g; c.beginPath(); c.moveTo(lo[0][0], lo[0][1]);
  for (const p of lo) c.lineTo(p[0], p[1]);
  c.quadraticCurveTo(Co[0] + 0.003, Co[1] - 0.0004, Co[0] + 0.0054, Co[1] + lerp(0.0034, -0.002, b));
  c.quadraticCurveTo(Co[0] + 0.0028, Co[1] + 0.0012, hi[NP][0], hi[NP][1]);
  for (let i = hi.length - 1; i >= 0; i--) c.lineTo(hi[i][0], hi[i][1]);
  c.closePath(); c.fill();
  for (const [t, len, lean] of [[0.7, 0.0024, 0.25], [0.82, 0.0032, 0.55], [0.92, 0.0035, 0.9]]) {
    const i = Math.round(t * NP), p = hi[i], n = nr[i], tx = n[1], ty = -n[0];
    let dx = n[0] * (1 - 1.7 * b) + lean, dy = n[1] * (1 - 1.5 * b); const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const hw = 0.001, bx = p[0] - n[0] * 0.0004, by = p[1] - n[1] * 0.0004, tipx = bx + dx * len, tipy = by + dy * len;
    c.beginPath(); c.moveTo(bx - tx * hw, by - ty * hw);
    c.quadraticCurveTo(bx - tx * hw * 0.3 + dx * len * 0.5 - tx * 0.0003, by - ty * hw * 0.3 + dy * len * 0.5 - ty * 0.0003, tipx, tipy);
    c.quadraticCurveTo(bx + tx * hw * 0.9 + dx * len * 0.45, by + ty * hw * 0.9 + dy * len * 0.45, bx + tx * hw * 1.3, by + ty * hw * 1.3);
    c.closePath(); c.fill();
  }
  // lower lid: a soft line on the outer third; crease above the lid
  c.lineCap = 'round';
  g = c.createLinearGradient(Co[0], 0, -0.004, 0); g.addColorStop(0, 'rgba(74,36,42,0.7)'); g.addColorStop(1, 'rgba(74,36,42,0)');
  c.strokeStyle = g; c.lineWidth = 0.00085; c.beginPath(); c.moveTo(Co[0], Co[1]); c.bezierCurveTo(L1[0], L1[1], Lw[0], Lw[1], Ci[0], Ci[1]); c.stroke();
  const cr = 0.0042 - 0.003 * b + 0.001 * wide;
  g = c.createLinearGradient(-0.018, 0, 0.02, 0); g.addColorStop(0, 'rgba(176,100,88,0)'); g.addColorStop(0.3, `rgba(176,100,88,${0.55 * (1 - 0.5 * b)})`); g.addColorStop(0.8, `rgba(176,100,88,${0.45 * (1 - 0.5 * b)})`); g.addColorStop(1, 'rgba(176,100,88,0)');
  c.strokeStyle = g; c.lineWidth = 0.0007; c.beginPath(); c.moveTo(Ci[0] + 0.003, Ci[1] + cr + 0.002); c.bezierCurveTo(U1[0] + 0.002, U1[1] + cr + 0.0015, U2[0], U2[1] + cr + 0.001, Co[0] - 0.001, Co[1] + cr + 0.003); c.stroke();
}

// ---------------------------------------------------------------- the character

export function createIo(opts = {}) {
  const faceRes = opts.faceRes || 2048, eyeRes = opts.eyeRes || 1536, faceShadows = !!opts.faceShadows;
  const T = getTex();
  const root = new THREE.Group(); root.name = 'io';
  const J = {};
  const joint = (name, parent, p) => { const g = new THREE.Group(); g.name = name; g.position.set(p[0], p[1], p[2]); parent.add(g); J[name] = g; return g; };
  joint('hips', root, [0, 0.80, 0]); joint('spine', J.hips, [0, 0.10, 0]); joint('chest', J.spine, [0, 0.12, 0]);
  joint('neck', J.chest, [0, 0.175, -0.008]); joint('head', J.neck, [0, 0.096, 0.008]);
  for (const [S, sx] of [['L', 1], ['R', -1]]) {
    joint('clav' + S, J.chest, [sx * 0.03, 0.145, 0]); joint('arm' + S, J['clav' + S], [sx * 0.092, -0.007, -0.004]);
    joint('fore' + S, J['arm' + S], [0, -UA, 0]); joint('hand' + S, J['fore' + S], [0, -FA, 0]);
    joint('fing' + S, J['hand' + S], [0, -0.058, 0]); joint('thumb' + S, J['hand' + S], [-sx * 0.004, -0.026, 0.034]);
    joint('thigh' + S, J.hips, [sx * 0.076, -0.04, 0]); joint('shin' + S, J['thigh' + S], [0, -TH, 0]); joint('foot' + S, J['shin' + S], [0, -SH, 0]);
  }
  const JN = Object.keys(J);
  const HIPS0 = [0, 0.80, 0];

  // ---- materials
  const mats = {
    skin: ioMat({ color: 0xf6d2b8, sss: 0x8a3524, roughness: 0.62, rim: 0.7, rampLo: -0.35, rampHi: 0.3, shade: 0.2 }),
    coat: ioMat({ map: T.coatM, bumpMap: T.coatB, bumpScale: 1.2, roughness: 0.85, sheen: 0.25, sheenColor: 0x6076d0, sheenRoughness: 0.6, rim: 0.7 }),
    sleeve: ioMat({ map: T.quiltM, bumpMap: T.quiltB, bumpScale: 1.2, roughness: 0.85, sheen: 0.25, sheenColor: 0x6076d0, sheenRoughness: 0.6, rim: 0.7 }),
    lining: ioMat({ color: 0x1a2047, roughness: 0.9, side: THREE.DoubleSide, rim: 0.2 }),
    wool: ioMat({ color: 0xe6d9c3, map: T.woolM, bumpMap: T.woolB, bumpScale: 1.0, roughness: 1.0, sheen: 0.5, sheenColor: 0xfff6e4, sheenRoughness: 0.8, sss: 0x6a4a30, rim: 0.6 }),
    mitten: ioMat({ color: 0xe8dcc6, map: T.fineM, bumpMap: T.fineB, bumpScale: 0.8, roughness: 1.0, sheen: 0.5, sheenColor: 0xfff6e4, sheenRoughness: 0.7, sss: 0x6a4a30, rim: 0.6 }),
    scarf: ioMat({ color: 0xc8232c, map: T.knitM, bumpMap: T.knitB, bumpScale: 1.3, roughness: 0.95, sheen: 0.22, sheenColor: 0xc03c38, sheenRoughness: 0.7, sss: 0x6a0810, rim: 0.6 }),
    scarfEnd: ioMat({ color: 0xc8232c, roughness: 0.95, sheen: 0.22, sheenColor: 0xc03c38, sheenRoughness: 0.7, sss: 0x6a0810, rim: 0.6, side: THREE.DoubleSide }),
    trouser: ioMat({ color: 0x2a2c38, roughness: 0.9, rim: 0.5 }),
    boot: ioMat({ color: 0x9a6a3c, roughness: 0.52, clearcoat: 0.25, clearcoatRoughness: 0.5, sss: 0x4a2a12, rim: 0.7 }),
    sole: ioMat({ color: 0x3a2a20, roughness: 0.85, rim: 0.3 }),
    belt: ioMat({ color: 0x6b4226, roughness: 0.5, clearcoat: 0.2, clearcoatRoughness: 0.5, rim: 0.6 }),
    brass: ioMat({ color: 0xd8a24a, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.4, rim: 0.5 }),
    glass: ioMat({ color: 0x0a1228, metalness: 0.6, roughness: 0.12, clearcoat: 0.6, clearcoatRoughness: 0.1, envMapIntensity: 1.3, rim: 0.8, rimPower: 2.4 }),
    hair: ioMat({ map: T.hair, roughness: 0.56, sss: 0x16224e, rim: 0.9, rimPower: 3.2, envMapIntensity: 0.5, side: THREE.DoubleSide }),
  };
  const M = (geo, mat, parent, dyn = false) => {
    const m = new THREE.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; m.layers.enable(1); if (dyn) m.frustumCulled = false; parent.add(m); return m;
  };

  // ---- legs, boots
  const pelvis = M(lathe(rows([[-0.075, 0.1, 0.082], [0, 0.11, 0.088], [0.05, 0.105, 0.085]], 6, 0.035, 0.02), 20), mats.trouser, J.hips);
  const bootFoot = gridGeo(22, 18, (u, v, p) => {
    const z = lerp(-0.068, 0.158, 0.5 - 0.5 * Math.cos(Math.PI * v)), ph = u * TAU, k = sePolar(ph, 3);
    const w = bootW(z), top = bootTop(z), bot = -0.072, cy = (top + bot) / 2, ry = (top - bot) / 2;
    p[0] = w * k * Math.sin(ph); p[1] = cy + ry * k * Math.cos(ph); p[2] = z;
  }, { uvScale: [2, 2] });
  const bootSole = gridGeo(22, 14, (u, v, p) => {
    const z = lerp(-0.071, 0.161, 0.5 - 0.5 * Math.cos(Math.PI * v)), ph = u * TAU, k = sePolar(ph, 5);
    const w = bootW(lerp(-0.068, 0.158, (z + 0.071) / 0.232)) + 0.004 * Math.sin(Math.PI * v);
    p[0] = w * k * Math.sin(ph); p[1] = -0.078 + 0.012 * k * Math.cos(ph); p[2] = z;
  });
  for (const [S, sx] of [['L', 1], ['R', -1]]) {
    M(lathe(rows([[-TH, 0.054], [-0.2, 0.06], [-0.06, 0.068], [0, 0.07]], 8, 0.054, 0.07), 18), mats.trouser, J['thigh' + S]);
    M(lathe(rows([[-0.2, 0.047], [-0.1, 0.05], [0, 0.054]], 5, 0, 0.054), 18), mats.trouser, J['shin' + S]);
    M(lathe(rows([[-SH, 0.055], [-0.25, 0.055], [-0.17, 0.058], [-0.13, 0.06]], 6, 0.055, 0), 20), mats.boot, J['shin' + S]);
    M(lathe(rows([[-0.178, 0.054], [-0.168, 0.066], [-0.146, 0.073], [-0.124, 0.071], [-0.111, 0.06], [-0.104, 0.046]], 10), 22, { uvScale: [3, 0.6] }), mats.wool, J['shin' + S]);
    M(bootFoot, mats.boot, J['foot' + S]); M(bootSole, mats.sole, J['foot' + S]);
  }

  // ---- arms, cuffs, mittens
  const mitSkins = [];
  for (const [S, sx] of [['L', 1], ['R', -1]]) {
    M(lathe(rows([[-UA, 0.047], [-0.1, 0.051], [0, 0.055]], 7, 0.047, 0.055), 18, { uvScale: [6, 4] }), mats.sleeve, J['arm' + S]);
    M(lathe(rows([[-0.165, 0.044], [-0.08, 0.046], [0, 0.047]], 5, 0, 0.047), 18, { uvScale: [6, 3] }), mats.sleeve, J['fore' + S]);
    M(lathe(rows([[-0.203, 0.038], [-0.194, 0.051], [-0.17, 0.058], [-0.145, 0.055], [-0.132, 0.043]], 10), 22, { uvScale: [3, 0.6] }), mats.wool, J['fore' + S]);
    const mg = lathe(rows([[-0.108, 0.013, 0.028, -0.002, -0.002, 2.4], [-0.092, 0.018, 0.038, -0.001, -0.001, 2.6], [-0.07, 0.021, 0.043, 0, 0, 2.8], [-0.045, 0.022, 0.0435, 0, 0, 2.8], [-0.02, 0.022, 0.039, 0, 0, 2.6], [0, 0.021, 0.033, 0, 0, 2.4], [0.02, 0.021, 0.031, 0, 0, 2.2]], 22, 0.011, 0, 5), 28, { uvScale: [10, 6] });
    const tg = lathe(rows([[-0.05, 0.0105], [-0.03, 0.0125], [0, 0.0145]], 6, 0.0105, 0.012), 14, { uvScale: [4, 3] }); tg.rotateX(-0.76);
    if (sx < 0) { mirrorX(mg); mirrorX(tg); }
    const mm = M(mg, mats.mitten, J['hand' + S], true); M(tg, mats.mitten, J['thumb' + S]);
    mitSkins.push({ mesh: mm, bones: [J['hand' + S], J['fing' + S]], w: (x, y, z, o) => { const f = smoothstep(-0.04, -0.076, y); o[0] = 1 - f; o[1] = f; } });
  }

  // ---- torso (skinned over hips / spine / chest), in hips-local coordinates
  const torsoRows = rows([[-0.03, 0.116, 0.097, 0, 0, 2.3], [0.09, 0.112, 0.092, 0, 0, 2.3], [0.17, 0.12, 0.098, 0, 0.002, 2.3], [0.25, 0.124, 0.102, 0, 0.004, 2.4], [0.32, 0.127, 0.096, 0, 0, 2.4], [0.365, 0.108, 0.08, 0, -0.004, 2.2], [0.39, 0.075, 0.064, 0, -0.006, 2], [0.405, 0.05, 0.05, 0, -0.008, 2]], 26, 0, 0.01, 2);
  const torso = M(lathe(torsoRows, 40, { uvFn: (u, v, p, t) => { t[0] = u; t[1] = 0.5 + 0.5 * sat((p[1] + 0.03) / 0.445); } }), mats.coat, J.hips, true);
  const torsoW = (x, y, z, o) => { o[2] = smoothstep(0.17, 0.27, y); o[0] = 1 - smoothstep(0.05, 0.15, y); o[1] = Math.max(0, 1 - o[0] - o[2]); };
  const torsoFrontZ = curve(torsoRows.map((r) => [r[0], r[2] + (r[4] || 0)]));

  // belt, buckle, pouch (rigid with the hips)
  M(gridGeo(10, 56, sweepFn((v, F) => {
    const a = v * TAU, k = sePolar(a, 2.3); F.c.set(0.1205 * k * Math.sin(a), 0.088, 0.1005 * k * Math.cos(a)); F.n.set(Math.sin(a) / 0.12, 0, Math.cos(a) / 0.1).normalize(); F.b.set(0, 1, 0);
  }, (u, v, s) => { const ph = u * TAU, k = sePolar(ph, 4); s[0] = 0.0075 * k * Math.cos(ph); s[1] = 0.024 * k * Math.sin(ph); }), { closeV: true }), mats.belt, J.hips);
  { const b = M(new THREE.TorusGeometry(0.021, 0.0048, 8, 4).rotateZ(Math.PI / 4).scale(1.15, 1.35, 1), mats.brass, J.hips); b.position.set(0, 0.088, 0.109);
    const pg = lathe(rows([[-0.036, 0.03, 0.017, 0, 0, 5], [0, 0.034, 0.021, 0, 0, 5], [0.036, 0.032, 0.019, 0, 0, 5]], 5, 0.007, 0.006), 20);
    const pouch = M(pg, mats.belt, J.hips); pouch.position.set(-0.126, 0.036, -0.012); pouch.rotation.y = -Math.PI / 2 - 0.12;
    const flap = M(lathe(rows([[-0.002, 0.034, 0.023, 0, 0.001, 5], [0.022, 0.036, 0.024, 0, 0.001, 5], [0.04, 0.034, 0.022, 0, 0, 5]], 4, 0.006, 0.006), 20), mats.boot, pouch);
    const stud = M(new THREE.SphereGeometry(0.0055, 12, 8), mats.brass, pouch); stud.position.set(0, 0.004, 0.0245); }
  // gold toggles with leather keepers down the front
  for (const [y, par, py] of [[0.31, J.chest, 0.22], [0.245, J.chest, 0.22], [0.18, J.spine, 0.10]]) {
    const z = torsoFrontZ(y) + 0.006;
    const bar = M(new THREE.CapsuleGeometry(0.0068, 0.03, 6, 12).rotateZ(Math.PI / 2), mats.brass, par); bar.position.set(0.004, y - py, z + 0.004);
    const keep = M(lathe(rows([[-0.007, 0.03, 0.004, 0, 0, 3], [0.007, 0.03, 0.004, 0, 0, 3]], 2, 0.003, 0.003), 14), mats.belt, par); keep.position.set(-0.02, y - py, z - 0.002);
  }

  // ---- neck, collar
  M(lathe(rows([[-0.07, 0.042], [-0.01, 0.0345], [0.08, 0.034], [0.12, 0.036]], 6), 18), mats.skin, J.neck);
  const collarPts = [[0.02, 0.082, 0.106], [0.036, 0.122, 0.096], [0.06, 0.158, 0.05], [0.069, 0.176, -0.006], [0.05, 0.186, -0.056], [0, 0.19, -0.076]];
  const collarCurve = new THREE.CatmullRomCurve3([...collarPts.map((p) => v3(p[0], p[1], p[2])), ...collarPts.slice(0, -1).reverse().map((p) => v3(-p[0], p[1], p[2]))]);
  let collarFluff = 1;
  const collarFn = sweepFn((v, F) => {
    collarCurve.getPoint(v, F.c); const tg = collarCurve.getTangent(v);
    F.n.set(F.c.x, 0.35 * 0.07, F.c.z + 0.008).normalize(); F.n.addScaledVector(tg, -F.n.dot(tg)).normalize(); F.b.crossVectors(tg, F.n);
    F.c.addScaledVector(F.n, 0.006 * (collarFluff - 1));
  }, (u, v, s) => { const r = 0.0205 * (0.5 + 0.5 * Math.pow(Math.sin(Math.PI * v), 0.45)) * collarFluff, ph = u * TAU; s[0] = r * Math.cos(ph); s[1] = r * 1.15 * Math.sin(ph); });
  const collar = M(gridGeo(14, 44, collarFn, { uvScale: [2, 8] }), mats.wool, J.chest, true);

  // ---- head
  const headG = new THREE.Group(); headG.scale.setScalar(HEAD_S); J.head.add(headG);
  const faceCv = document.createElement('canvas'); faceCv.width = faceCv.height = faceRes;
  const faceTex = new THREE.CanvasTexture(faceCv); faceTex.colorSpace = THREE.SRGBColorSpace; faceTex.anisotropy = 8;
  const faceMat = ioMat({ map: faceTex, sss: 0x8a3524, roughness: 0.62, rim: 0.7, rampLo: -0.35, rampHi: 0.3, shade: 0.2 });
  M(gridGeo(112, 84, (u, v, p) => skull(TAU * u - 0.45 * Math.sin(TAU * u), -0.012 + 1.012 * v, p), { uvFn: (u, v, p, t) => { t[0] = 0.5 + p[0] / 0.26; t[1] = (p[1] + 0.065) / 0.26; } }), faceMat, headG).receiveShadow = faceShadows;
  for (const sx of [-1, 1]) { const e = M(lathe(rows([[-0.024, 0.006, 0.008], [0, 0.011, 0.016], [0.024, 0.007, 0.01]], 6, 0.004, 0.004), 12), mats.skin, headG); e.position.set(sx * 0.091, YE - 0.006, -0.014); e.rotation.set(0.15, sx * 0.3, sx * -0.12); }
  const eyes = [];
  for (const sx of [1, -1]) {
    const cv = document.createElement('canvas'); cv.width = cv.height = eyeRes;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const ecv = document.createElement('canvas'); ecv.width = ecv.height = eyeRes >> 1;
    const etex = new THREE.CanvasTexture(ecv); etex.colorSpace = THREE.SRGBColorSpace; etex.anisotropy = 8;
    const x0 = sx * EYE.x - EYE.w / 2, y0 = YE + EYE.cy - EYE.w / 2;
    const geo = gridGeo(22, 22, (u, v, p) => { p[0] = x0 + u * EYE.w; p[1] = y0 + v * EYE.w; p[2] = faceZ(p[0], p[1]) + 0.0005; }, { closeU: false, orient: false, uvFn: (u, v, p, t) => { t[0] = sx > 0 ? u : 1 - u; t[1] = v; } });
    const mat = ioMat({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 0.3, rim: 0, emissive: 0xffffff, emissiveMap: etex, emissiveIntensity: 1.0, rampLo: -0.35, rampHi: 0.3, shade: 0.2 });
    const mesh = M(geo, mat, headG); mesh.castShadow = false; mesh.receiveShadow = faceShadows; mesh.renderOrder = 2;
    eyes.push({ cv, ctx: cv.getContext('2d'), tex, ectx: ecv.getContext('2d'), etex, side: sx, key: '' });
  }
  const faceCtx = faceCv.getContext('2d');
  let faceKey = '';
  function setFace(f = {}) {
    const F = { ...FACE_DEF, ...f };
    const q = (x) => Math.round(x * 500) / 500;
    const fk = [F.smile, F.mouthOpen, F.brow, F.browRaise, F.blush, F.eyeWide].map(q).join(',');
    if (fk !== faceKey) { faceKey = fk; paintFace(faceCtx, faceRes, F); faceTex.needsUpdate = true; }
    const ek = [F.blink, F.lookX, F.lookY, F.eyeWide, F.pupil, F.smile, F.reflect, ...F.reflectColor].map(q).join(',');
    for (const e of eyes) if (e.key !== ek) { e.key = ek; paintEye(e.ctx, eyeRes, e.side, F, false); e.tex.needsUpdate = true; paintEye(e.ectx, eyeRes >> 1, e.side, F, true); e.etex.needsUpdate = true; }
  }

  // ---- goggles pushed up into the fringe
  {
    const tmp = [0, 0, 0], tmp2 = [0, 0, 0];
    const housing = lathe(rows([[0, 0.0285], [0.012, 0.031], [0.021, 0.0295]], 4, 0, 0), 26);
    const glassG = lathe(rows([[0.017, 0.0265], [0.0205, 0.019], [0.0225, 0.0001]], 6), 26);
    const centers = [];
    for (const sx of [-1, 1]) {
      const a = sx * 23 * DEG; wig(a, 0.815, 0.01, tmp); wig(a, 0.815, 0.03, tmp2);
      const g = new THREE.Group(); g.position.set(tmp[0], tmp[1], tmp[2]);
      const ax = v3(tmp2[0] - tmp[0], tmp2[1] - tmp[1], tmp2[2] - tmp[2]).normalize().lerp(v3(sx * 0.1, 0.45, 0.9).normalize(), 0.45).normalize();
      g.quaternion.setFromUnitVectors(v3(0, 1, 0), ax); headG.add(g); centers.push(g.position.clone());
      M(housing, mats.brass, g); M(glassG, mats.glass, g);
      const rim = M(new THREE.TorusGeometry(0.0282, 0.0042, 10, 30).rotateX(Math.PI / 2), mats.brass, g); rim.position.y = 0.0205;
      const pad = M(new THREE.TorusGeometry(0.029, 0.005, 8, 26).rotateX(Math.PI / 2), mats.belt, g); pad.position.y = 0.001;
    }
    const br = M(new THREE.CapsuleGeometry(0.0045, 0.014, 4, 10).rotateZ(Math.PI / 2), mats.brass, headG); br.position.copy(centers[0]).add(centers[1]).multiplyScalar(0.5); br.position.z += 0.011; br.position.y += 0.006;
    // strap around the back of the head
    const a0 = 46 * DEG, sp = (v, out, lift) => { const a = a0 + (TAU - 2 * a0) * v, h = 0.8 - 0.2 * Math.pow(Math.sin(Math.PI * v), 1.2); wig(a, h, lift, out); };
    M(gridGeo(8, 60, sweepFn((v, F) => {
      sp(v, tmp, 0.0125); F.c.set(tmp[0], tmp[1], tmp[2]); sp(v, tmp2, 0.03); F.n.set(tmp2[0] - tmp[0], tmp2[1] - tmp[1], tmp2[2] - tmp[2]).normalize();
      sp(Math.min(1, v + 0.01), tmp, 0.0125); sp(Math.max(0, v - 0.01), tmp2, 0.0125); const tg = v3(tmp[0] - tmp2[0], tmp[1] - tmp2[1], tmp[2] - tmp2[2]).normalize();
      F.b.crossVectors(tg, F.n).normalize();
    }, (u, v, s) => { const ph = u * TAU, k = sePolar(ph, 4); s[0] = 0.0032 * k * Math.cos(ph); s[1] = 0.0105 * k * Math.sin(ph); })), mats.belt, headG);
  }

  // ---- hair: scalp cap + chunky clumps (one dynamic mesh)
  const hairline = (a) => { let d = Math.abs(((a / DEG) % 360 + 540) % 360 - 180); return d < 48 ? 0.79 : d < 82 ? lerp(0.79, 0.34, smoothstep(48, 82, d)) : lerp(0.34, 0.2, smoothstep(82, 125, d)); };
  M(gridGeo(72, 18, (u, v, p) => { const a = u * TAU, hy = lerp(hairline(a), 1, v); wig(a, hy, -0.0055 * (1 - smoothstep(0, 0.3, v)), p); }, { uvFn: (u, v, p, t) => { t[0] = 0.3; t[1] = ((p[1] - HY0) / HH + 0.5) / 1.7; } }), mats.hair, headG);
  const hair = { clumps: [], pos: [], uv: [], idx: [], ringC: [], ringT: [], ringB: [], ringE: [] };
  const SEC = [[-1, 0], [-0.7, 0.75], [0, 1], [0.7, 0.75], [1, 0], [0.6, -0.35], [0, -0.45], [-0.6, -0.35]];
  const HR = rng(20241), rr = (a, b) => a + (b - a) * HR();
  function addClump(o) {
    const K = o.K || 12, Mv = SEC.length, base = hair.pos.length / 3, ring0 = hair.ringC.length / 3, C = [], tmp = [0, 0, 0];
    for (let k = 0; k <= K; k++) {
      const s = k / K;
      if (o.path) o.path(s, tmp);
      else wig((o.a0 + (o.a1 - o.a0) * s + (o.bow || 0) * Math.sin(Math.PI * s)) * DEG, o.h0 + (o.h1 - o.h0) * Math.pow(s, o.pw || 1), lerp(o.l0, o.l1, s) + (o.flick || 0) * Math.pow(smoothstep(0.55, 1, s), 2), tmp);
      C.push(v3(tmp[0], tmp[1], tmp[2]));
    }
    for (let k = 0; k <= K; k++) {
      const s = k / K, c = C[k], Tn = C[Math.min(K, k + 1)].clone().sub(C[Math.max(0, k - 1)]).normalize();
      const N = o.nrm ? o.nrm.clone() : c.y >= HC[1] ? v3(c.x, c.y - HC[1], c.z - HC[2]) : v3(c.x, 0, c.z - HC[2]);
      N.addScaledVector(Tn, -N.dot(Tn)).normalize(); const B = v3().crossVectors(Tn, N);
      const w = o.w * lerp(0.32, 1, smoothstep(0, 0.34, s)) * (1 - 0.97 * Math.pow(smoothstep(0.5, 1, s), 1.4));
      const th = o.th * lerp(0.1, 1, smoothstep(0, 0.5, s)) * (1 - 0.85 * smoothstep(0.6, 1, s));
      hair.ringC.push(c.x, c.y, c.z); hair.ringT.push(Tn.x, Tn.y, Tn.z); hair.ringB.push(B.x, B.y, B.z); hair.ringE.push(headE(c.x, c.y, c.z));
      for (let m = 0; m < Mv; m++) {
        const bc = SEC[m][0], nc = SEC[m][1], x = c.x + B.x * w * bc + N.x * th * nc, y = c.y + B.y * w * bc + N.y * th * nc, z = c.z + B.z * w * bc + N.z * th * nc;
        hair.pos.push(x, y, z); hair.uv.push(s, ((y - HY0) / HH + 0.5 + 0.03 * Math.abs(bc)) / 1.7);
      }
    }
    const ix = [];
    for (let k = 0; k < K; k++) for (let m = 0; m < Mv; m++) { const a = base + k * Mv + m, b = base + k * Mv + (m + 1) % Mv, c = a + Mv, d = b + Mv; ix.push(a, b, c, b, d, c); }
    { // orient outward
      const P = hair.pos, cc = C[K >> 1]; let vol = 0;
      for (let k = 0; k < ix.length; k += 3) { const a = ix[k] * 3, b = ix[k + 1] * 3, c = ix[k + 2] * 3;
        const ax = P[a] - cc.x, ay = P[a + 1] - cc.y, az = P[a + 2] - cc.z, bx = P[b] - cc.x, by = P[b + 1] - cc.y, bz = P[b + 2] - cc.z, qx = P[c] - cc.x, qy = P[c + 1] - cc.y, qz = P[c + 2] - cc.z;
        vol += ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx); }
      if (vol < 0) for (let k = 0; k < ix.length; k += 3) { const s = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = s; }
    }
    for (const i of ix) hair.idx.push(i);
    hair.clumps.push({ base, ring0, K, Mv, flex: o.flex ?? 0.7, grav: o.grav ?? 1, lift: o.lift || 0, phase: HR() * TAU });
  }
  for (let i = 0; i < 14; i++) { const a = 76 + i * (208 / 13); addClump({ a0: a + rr(-3, 3) - 10, a1: a + rr(-7, 7), h0: 0.965, h1: rr(0.05, 0.16), w: 0.036, th: 0.012, l0: 0.001, l1: 0.004, flick: -0.004, flex: 0.9, K: 13, bow: 6 }); }
  for (let i = 0; i < 13; i++) { const a = 84 + i * (192 / 12); addClump({ a0: a + rr(-4, 4) - 16, a1: a + rr(-12, 12), h0: 0.975, h1: rr(0.2, 0.44), w: 0.038, th: 0.014, l0: 0.004, l1: 0.014, flick: 0.012, flex: 0.7, K: 11, bow: 9 }); }
  for (let i = 0; i < 8; i++) { const a = i * 45 + 68 + rr(-8, 8); addClump({ a0: a - 24, a1: a + rr(-12, 12), h0: 0.995, h1: rr(0.46, 0.72), w: 0.04, th: 0.013, l0: 0.005, l1: 0.02, flick: 0.012, flex: 0.45, K: 10, bow: 12 }); }
  for (const [a, h, w] of [[-52, 0.5, 0.027], [-35, 0.58, 0.026], [-19, 0.535, 0.025], [-4, 0.63, 0.022], [11, 0.545, 0.026], [28, 0.6, 0.025], [46, 0.51, 0.027]])
    addClump({ a0: a * 0.8, a1: a + 5, h0: 0.96, h1: h, w, th: 0.011, l0: 0.003, l1: 0.007, flick: 0.004, flex: 0.5, lift: 0.8, K: 11, bow: 3 });
  for (const sx of [-1, 1]) addClump({ a0: sx * 60, a1: sx * 64, h0: 0.96, h1: 0.3, w: 0.024, th: 0.011, l0: 0.003, l1: 0.008, flick: 0.004, flex: 0.7, K: 12 });
  for (const sx of [-1, 1]) addClump({ a0: sx * 66, a1: sx * 70, h0: 0.95, h1: -0.33, w: 0.019, th: 0.011, l0: 0.004, l1: 0.01, flick: 0.006, flex: 1.0, K: 16 });
  { // cowlick
    const top = [0, 0, 0]; wig(0, 0.99, 0, top);
    const P0 = v3(0.004, top[1] - 0.004, -0.022), P1 = v3(0.01, top[1] + 0.05, -0.04), P2 = v3(0.022, top[1] + 0.072, 0.012), P3 = v3(0.03, top[1] + 0.046, 0.05);
    const cb = new THREE.CubicBezierCurve3(P0, P1, P2, P3), tv = v3();
    addClump({ path: (s, out) => { cb.getPoint(s, tv); out[0] = tv.x; out[1] = tv.y; out[2] = tv.z; }, nrm: v3(0.2, 0.6, -0.75), w: 0.009, th: 0.006, flex: 0.55, grav: 0.3, K: 12 });
  }
  const hairGeo = new THREE.BufferGeometry();
  const hairRest = new Float32Array(hair.pos);
  hairGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(hair.pos), 3)); hairGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(hair.uv), 2)); hairGeo.setIndex(hair.idx); hairGeo.computeVertexNormals();
  M(hairGeo, mats.hair, headG, true);
  const ringC = new Float32Array(hair.ringC), ringT = new Float32Array(hair.ringT), ringB = new Float32Array(hair.ringB), ringE = new Float32Array(hair.ringE);

  // ---- coat skirt (dynamic A-line hem draped over the legs), hips-local
  const SK = { NC: 56, NR: 12, y0: 0.088, H: 0.325 };
  function skirtRest(c, r, out) {
    const a = c / SK.NC * TAU, s = r / SK.NR, fl = Math.pow(s, 0.92), k = sePolar(a, lerp(2.3, 2.0, s));
    const flute = 1 + 0.045 * s * s * Math.sin(a * 7 + 0.6) + 0.018 * s * Math.sin(a * 13 + 2.0);
    out[0] = lerp(0.119, 0.205, fl) * flute * k * Math.sin(a); out[1] = SK.y0 - SK.H * s; out[2] = lerp(0.099, Math.cos(a) > 0 ? 0.168 : 0.192, fl) * flute * k * Math.cos(a);
  }
  const skN = SK.NC * (SK.NR + 1), skRest = new Float32Array(skN * 3), skCur = new Float32Array(skN * 3), skTmp = new Float32Array(skN * 3);
  { const p = [0, 0, 0]; for (let r = 0; r <= SK.NR; r++) for (let c = 0; c < SK.NC; c++) { skirtRest(c, r, p); skRest.set(p, (r * SK.NC + c) * 3); } }
  const skCols = SK.NC + 1, skGrid = skCols * (SK.NR + 1), skVerts = skGrid * 2 + skCols * 2;
  const skGeo = new THREE.BufferGeometry();
  {
    const uv = new Float32Array(skVerts * 2), idx = [];
    for (let r = 0; r <= SK.NR; r++) for (let c = 0; c <= SK.NC; c++) { const k = r * skCols + c; uv[k * 2] = c / SK.NC; uv[k * 2 + 1] = 0.5 * (1 - r / SK.NR); uv[(skGrid + k) * 2] = c / SK.NC; uv[(skGrid + k) * 2 + 1] = 0.5 * (1 - r / SK.NR); }
    for (let c = 0; c <= SK.NC; c++) { uv[(skGrid * 2 + c) * 2] = c / SK.NC; uv[(skGrid * 2 + c) * 2 + 1] = 0.005; uv[(skGrid * 2 + skCols + c) * 2] = c / SK.NC; uv[(skGrid * 2 + skCols + c) * 2 + 1] = 0.0; }
    for (let r = 0; r < SK.NR; r++) for (let c = 0; c < SK.NC; c++) { const a = r * skCols + c, b = a + 1, d = a + skCols, e = d + 1; idx.push(a, d, b, b, d, e); }
    const nOuter = idx.length;
    for (let r = 0; r < SK.NR; r++) for (let c = 0; c < SK.NC; c++) { const a = skGrid + r * skCols + c, b = a + 1, d = a + skCols, e = d + 1; idx.push(a, b, d, b, e, d); }
    for (let c = 0; c < SK.NC; c++) { const a = skGrid * 2 + c, b = a + 1, d = a + skCols, e = d + 1; idx.push(a, d, b, b, d, e); }
    skGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skVerts * 3), 3)); skGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(skVerts * 3), 3));
    skGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); skGeo.setIndex(idx);
    skGeo.addGroup(0, nOuter, 0); skGeo.addGroup(nOuter, idx.length - nOuter, 1);
  }
  M(skGeo, [mats.coat, mats.lining], J.hips, true);

  // ---- scarf: neck wrap (chest-local), knot, two streaming tails (root-local)
  let wrapAmt = 1;
  const wrapPath = (pu, out) => {
    const th = Math.PI + 4 * Math.PI * pu, cb = smoothstep(0.3, 0.7, pu), wob = 1 + 0.04 * Math.sin(th * 2.3 + 0.7);
    const rx = lerp(0.08, 0.069, cb) * wob, rz = (Math.cos(th) > 0 ? lerp(0.094, 0.084, cb) : lerp(0.083, 0.071, cb)) * wob;
    out.set(rx * Math.sin(th), lerp(0.146, 0.183, cb) + 0.016 * (1 - Math.cos(th)) / 2 + 0.003 * Math.sin(th * 3 + 1), rz * Math.cos(th) - 0.004);
  };
  const wA = v3(), wB = v3();
  const wrapFn = sweepFn((v, F) => {
    const pu = 0.5 + (v - 0.5) * wrapAmt;
    wrapPath(pu, F.c); wrapPath(pu + 0.002, wA); wrapPath(pu - 0.002, wB); const tg = wA.sub(wB).normalize();
    F.n.set(F.c.x, 0, F.c.z + 0.004).normalize(); F.n.addScaledVector(tg, -F.n.dot(tg)).normalize(); F.b.crossVectors(tg, F.n);
  }, (u, v, s) => {
    const pu = 0.5 + (v - 0.5) * wrapAmt, e = Math.sqrt(sat(Math.min(v, 1 - v) / 0.06)) * (0.55 + 0.45 * smoothstep(0, 0.35, wrapAmt)), ph = u * TAU;
    s[0] = 0.021 * (1 + 0.12 * Math.sin(pu * 37)) * e * Math.cos(ph); s[1] = 0.0245 * (1 + 0.1 * Math.sin(pu * 29 + 2)) * e * Math.sin(ph);
  });
  const wrap = M(gridGeo(14, 128, wrapFn, { uvScale: [3, 20] }), mats.scarf, J.chest, true);
  const knot = M(lathe(rows([[-0.03, 0.03, 0.02], [0, 0.042, 0.027], [0.028, 0.03, 0.02]], 6, 0.012, 0.012), 16, { uvScale: [3, 1.5] }), mats.scarf, J.chest);
  knot.position.set(0, 0.19, -0.088); knot.rotation.x = -0.25; knot.scale.setScalar(0.85);
  const TN = 44, TU = 12, FRN = 7;
  const fringe = () => { // tassels at the free end
    const g = new THREE.BufferGeometry(), ix = [];
    for (let i = 0; i < FRN; i++) { const b = i * 5; ix.push(b, b + 1, b + 4, b + 1, b + 2, b + 4, b + 2, b + 3, b + 4, b + 3, b, b + 4); }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(FRN * 15), 3)); g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(FRN * 10).fill(0.37), 2)); g.setIndex(ix);
    return { geo: g, mesh: M(g, mats.scarfEnd, root, true) };
  };
  const tails = [0, 1].map((i) => {
    const geo = gridGeo(TU, TN + 1, (u, v, p) => { p[0] = Math.sin(u * TAU) * 0.05; p[1] = -v; p[2] = Math.cos(u * TAU) * 0.01; }, { uvScale: [5, 27] });
    const sx = i ? -1 : 1;
    return { geo, mesh: M(geo, mats.scarf, root, true), P: [], sx, len: i ? 1.2 : 1.3, phase: i ? 2.4 : 0.3, seed: 3 + i * 7,
      rootL: v3(sx * 0.02, 0.186 - i * 0.006, -0.094 - i * 0.012), dirL: v3(sx * 0.2, -0.78, -0.58).normalize(), F: [], fr: fringe() };
  });
  for (const tl of tails) for (let k = 0; k <= TN; k++) { tl.P.push(v3()); tl.F.push({ t: v3(), n: v3(), b: v3() }); }

  // ---- anchors
  const mk = (parent, x = 0, y = 0, z = 0) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent.add(o); return o; };
  const anchors = {
    head: J.head, neck: J.neck, chest: J.chest, hips: J.hips, handL: J.handL, handR: J.handR,
    palmL: mk(J.handL, -0.022, -0.05, 0), palmR: mk(J.handR, 0.022, -0.05, 0),
    footL: mk(J.footL, 0, -ANK, 0.045), footR: mk(J.footR, 0, -ANK, 0.045),
    eyeL: mk(headG, EYE.x, YE, faceZ(EYE.x, YE) + 0.001), eyeR: mk(headG, -EYE.x, YE, faceZ(EYE.x, YE) + 0.001),
    cup: mk(root), scarfTipL: mk(root), scarfTipR: mk(root),
  };
  anchors.palmL.rotation.z = Math.PI / 2; anchors.palmR.rotation.z = -Math.PI / 2;

  // ---- CPU skinning (rig is at rest here)
  root.updateMatrixWorld(true);
  function makeSkin(mesh, home, bones, weightOf) {
    const g = mesh.geometry, rest = g.attributes.position.array.slice(), n = rest.length / 3, nb = bones.length, w = new Float32Array(n * nb), o = [0, 0, 0];
    for (let i = 0; i < n; i++) { o[0] = o[1] = o[2] = 0; weightOf(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2], o); let s = 0; for (let b = 0; b < nb; b++) s += o[b]; for (let b = 0; b < nb; b++) w[i * nb + b] = o[b] / s; }
    const h0 = home.matrixWorld.clone().invert(), restInv = bones.map((b) => new THREE.Matrix4().multiplyMatrices(h0, b.matrixWorld).invert());
    const ms = bones.map(() => new THREE.Matrix4()), hi = new THREE.Matrix4();
    return () => {
      hi.copy(home.matrixWorld).invert();
      for (let b = 0; b < nb; b++) ms[b].multiplyMatrices(hi, bones[b].matrixWorld).multiply(restInv[b]);
      const p = g.attributes.position.array;
      for (let i = 0; i < n; i++) {
        const x = rest[i * 3], y = rest[i * 3 + 1], z = rest[i * 3 + 2]; let ox = 0, oy = 0, oz = 0;
        for (let b = 0; b < nb; b++) { const wt = w[i * nb + b]; if (wt === 0) continue; const e = ms[b].elements; ox += wt * (e[0] * x + e[4] * y + e[8] * z + e[12]); oy += wt * (e[1] * x + e[5] * y + e[9] * z + e[13]); oz += wt * (e[2] * x + e[6] * y + e[10] * z + e[14]); }
        p[i * 3] = ox; p[i * 3 + 1] = oy; p[i * 3 + 2] = oz;
      }
      g.attributes.position.needsUpdate = true; gridNormals(g);
    };
  }
  const skins = [makeSkin(torso, J.hips, [J.hips, J.spine, J.chest], torsoW), ...mitSkins.map((s) => makeSkin(s.mesh, s.bones[0], s.bones, s.w))];

  // ---------------------------------------------------------------- poses (authored with IK, stored as joint quaternions)
  const AX = { x: v3(1, 0, 0), y: v3(0, 1, 0), z: v3(0, 0, 1) }, tq = new THREE.Quaternion();
  const qOf = (r) => {
    const q = new THREE.Quaternion(); if (!r) return q;
    if (Array.isArray(r[0])) { for (const [ax, deg] of r) q.multiply(tq.setFromAxisAngle(AX[ax], deg * DEG)); return q; }
    return q.setFromEuler(new THREE.Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'YXZ'));
  };
  const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion()), wp = (o) => o.getWorldPosition(v3());
  const basisQ = (X, Y, Z) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
  function limb(upper, lower, l1, l2, target, pole, zs) {
    const P = wp(upper), dv = target.clone().sub(P), d = clamp(dv.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.9995), dir = dv.normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pp = pole.clone().addScaledVector(dir, -pole.dot(dir)); if (pp.lengthSq() < 1e-8) pp.set(0.3, 0.2, 1).addScaledVector(dir, -pp.dot(dir)); pp.normalize();
    const E = P.clone().addScaledVector(dir, a).addScaledVector(pp, h), Tg = P.clone().addScaledVector(dir, d);
    const setBone = (bone, from, to) => {
      const Y = from.clone().sub(to).normalize(), Z = pp.clone().multiplyScalar(zs); Z.addScaledVector(Y, -Z.dot(Y)).normalize();
      bone.quaternion.copy(wq(bone.parent).invert().multiply(basisQ(v3().crossVectors(Y, Z), Y, Z)));
    };
    setBone(upper, P, E); setBone(lower, E, Tg);
  }
  function buildPose(s) {
    for (const n of JN) J[n].quaternion.identity();
    J.hips.position.fromArray(s.hips.p); J.hips.quaternion.copy(qOf(s.hips.r));
    for (const n of ['spine', 'chest', 'neck', 'head', 'clavL', 'clavR']) if (s[n]) J[n].quaternion.copy(qOf(s[n]));
    if (s.look) { // aim the face along a root-space direction, sharing the turn between neck and head
      const Z = v3(...s.look).normalize(), X = v3().crossVectors(AX.y, Z).normalize(), Y = v3().crossVectors(Z, X);
      const want = basisQ(X, Y, Z).multiply(tq.setFromAxisAngle(AX.z, (s.lookRoll || 0) * DEG).clone());
      const ql = wq(J.chest).invert().multiply(want);
      J.neck.quaternion.identity().slerp(ql, s.neckShare ?? 0.45); J.head.quaternion.copy(J.neck.quaternion).invert().multiply(ql);
    }
    for (const [S, sx] of [['L', 1], ['R', -1]]) {
      const f = s['foot' + S];
      if (f) {
        const fq = new THREE.Quaternion().setFromEuler(new THREE.Euler((f.pitch || 0) * DEG, (f.yaw || 0) * DEG, (f.roll || 0) * DEG, 'YXZ'));
        const ankle = v3(...f.p).add(v3(0, ANK, -0.045).applyQuaternion(fq));
        const pole = f.knee ? v3(...f.knee) : v3(0, 0.25, 1).applyQuaternion(fq);
        limb(J['thigh' + S], J['shin' + S], TH, SH, ankle, pole, 1);
        J['foot' + S].quaternion.copy(wq(J['shin' + S]).invert().multiply(fq));
      }
      let h = s['hand' + S]; if (typeof h === 'function') h = h();
      if (h) {
        const rel = h.rel ? J[h.rel] : null; if (rel) rel.updateWorldMatrix(true, false);
        const pt = (a) => { const v = v3(...a); return rel ? v.applyMatrix4(rel.matrixWorld) : v; };
        const dr = (a) => { const v = v3(...a).normalize(); return rel ? v.applyQuaternion(wq(rel)) : v; };
        limb(J['arm' + S], J['fore' + S], UA, FA, pt(h.p), h.elbow ? dr(h.elbow) : v3(sx * 0.35, -0.2, -1), -1);
        if (h.f) {
          const Y = dr(h.f).negate(), X = dr(h.n).multiplyScalar(-sx); X.addScaledVector(Y, -X.dot(Y)).normalize();
          J['hand' + S].quaternion.copy(wq(J['fore' + S]).invert().multiply(basisQ(X, Y, v3().crossVectors(X, Y))));
        }
        J['fing' + S].quaternion.setFromAxisAngle(AX.z, -sx * (h.curl ?? 15) * DEG);
        const th = h.thumb || [15, 10];
        J['thumb' + S].quaternion.setFromAxisAngle(AX.y, -sx * th[1] * DEG).multiply(tq.setFromAxisAngle(AX.x, -th[0] * DEG));
      }
    }
    const q = {}; for (const n of JN) q[n] = J[n].quaternion.toArray();
    return { hp: J.hips.position.toArray(), q, seat: s.seat || 0, seatAxis: s.seatAxis || 'x' };
  }

  const ropeDir = v3(0.05, 0.5, 0.86).normalize();
  const grip = (sx, along) => () => { // wrist + hand frame for a fist closed around the hauling line (evaluated once the torso is posed)
    J.chest.updateWorldMatrix(true, false); const ropeP = v3(-0.085, 0.085, 0.15).applyMatrix4(J.chest.matrixWorld);
    const n = v3(-sx, 0.05, -0.1); n.addScaledVector(ropeDir, -n.dot(ropeDir)).normalize();
    const f = sx > 0 ? v3().crossVectors(ropeDir, n) : v3().crossVectors(n, ropeDir);
    const P = ropeP.clone().addScaledVector(ropeDir, along).addScaledVector(f, -0.045).addScaledVector(n, -0.022);
    return { p: P.toArray(), f: f.toArray(), n: n.toArray(), curl: 82, thumb: [5, 55], elbow: [sx * 0.7, -0.7, -0.2] };
  };
  const SPEC = {
    stand: { hips: { p: [0.012, 0.795, 0], r: [0, 0, 2.5] }, spine: [1, 0, -2], chest: [-1, 0, -1.5], neck: [2, 0, 0], head: [-2, 4, 1.5],
      footL: { p: [0.088, 0, 0.045], yaw: 14 }, footR: { p: [-0.07, 0, 0.02], yaw: -16 },
      handL: { p: [0.215, 0.775, 0.02], f: [0.05, -1, 0.12], n: [-1, 0, 0.1], elbow: [0.4, 0, -1], curl: 18 },
      handR: { p: [-0.205, 0.78, 0.035], f: [-0.03, -1, 0.15], n: [1, 0, 0.15], elbow: [-0.4, 0, -1], curl: 22 } },
    sitCup: { seat: 1, hips: { p: [0, 0.108, 0], r: [-12, 0, 0] }, spine: [20, 0, 0], chest: [16, 0, 0], neck: [12, 0, 0], head: [16, 0, 0],
      footL: { p: [0.1, -0.35, 0.42], yaw: 8, pitch: 12, knee: [0.25, 1, 0.4] }, footR: { p: [-0.1, -0.35, 0.4], yaw: -8, pitch: 12, knee: [-0.25, 1, 0.4] },
      handL: { p: [0.052, 0.335, 0.235], f: [-0.25, 0.12, 1], n: [-0.42, 0.9, -0.05], elbow: [0.8, -0.5, -0.4], curl: 28, thumb: [25, 0] },
      handR: { p: [-0.052, 0.335, 0.235], f: [0.25, 0.12, 1], n: [0.42, 0.9, -0.05], elbow: [-0.8, -0.5, -0.4], curl: 28, thumb: [25, 0] } },
    lookUp: { hips: { p: [0, 0.797, -0.01], r: [-3, 0, 0] }, spine: [-5, 0, 0], chest: [-8, 0, 0], look: [0.06, 0.82, 0.57],
      footL: { p: [0.085, 0, 0.03], yaw: 12 }, footR: { p: [-0.085, 0, 0], yaw: -14 },
      handR: { p: [-0.035, 1.085, 0.135], f: [0.55, 0.75, -0.1], n: [0.15, -0.1, -1], elbow: [-0.8, -0.6, -0.2], curl: 70, thumb: [10, 40] },
      handL: { p: [0.27, 0.8, 0], f: [0.3, -1, 0.1], n: [-1, -0.2, 0.2], elbow: [0.5, 0, -1], curl: 10 } },
    crouch: { hips: { p: [0, 0.33, -0.05], r: [['x', 30], ['y', -42], ['x', 8]] }, spine: [22, 0, 0], chest: [16, 8, 0], look: [-0.05, 0.12, 1],
      footL: { p: [0, 0, 0.24], yaw: -30, knee: [-0.35, 0.5, 1] }, footR: { p: [0, 0, -0.22], yaw: -72, knee: [-1, 0.6, 0.15] },
      handL: { p: [0.03, 0.115, 0.45], f: [0, -0.9, 0.4], n: [0, -0.4, -0.9], elbow: [0.6, 0.6, -0.5], curl: 12, thumb: [30, 0] },
      handR: { p: [-0.26, 0.42, -0.33], f: [-0.4, -0.6, -0.7], n: [0.6, -0.6, 0.2], elbow: [-0.6, 0.5, -0.8], curl: 30 } },
    surf: { hips: { p: [-0.01, 0.66, -0.03], r: [['x', 12], ['y', -62], ['x', 10]] }, spine: [10, 6, 0], chest: [8, 10, 0], look: [0, 0.02, 1], neckShare: 0.5,
      footL: { p: [0, 0, 0.3], yaw: -42, knee: [-0.5, 0.2, 1] }, footR: { p: [0, 0, -0.35], yaw: -82, knee: [-1, 0.2, -0.25] },
      handL: { p: [0.05, 0.8, 0.47], f: [0, -0.3, 1], n: [0, -1, -0.2], elbow: [0.3, -0.9, -0.3], curl: 15 },
      handR: { p: [-0.2, 0.92, -0.47], f: [-0.3, -0.2, -1], n: [0.2, -1, 0], elbow: [-0.3, -0.7, -0.5], curl: 20 } },
    reach: { hips: { p: [-0.01, 0.735, 0], r: [['x', -4], ['y', -50], ['x', -4]] }, spine: [-6, 0, -3], chest: [-10, 6, -4], look: [-0.12, 0.9, 0.28], neckShare: 0.5, clavR: [0, 0, -22],
      footL: { p: [0, 0, 0.3], yaw: -42, knee: [-0.5, 0.2, 1] }, footR: { p: [0, 0, -0.35], yaw: -82, knee: [-1, 0.2, -0.25] },
      handR: { p: [-0.09, 1.62, -0.08], f: [0, 0.55, -0.83], n: [0, 0.83, 0.55], elbow: [-0.6, 0, -0.8], curl: 4, thumb: [30, 0] },
      handL: { p: [0.2, 0.86, 0.3], f: [0.3, -0.6, 0.7], n: [0, -0.8, -0.5], elbow: [0.6, -0.5, -0.5], curl: 15 } },
    catch: { hips: { p: [-0.01, 0.7, 0.14], r: [['x', 30], ['y', -25], ['x', 6]] }, spine: [4, 8, 0], chest: [-2, 12, 0], look: [0.05, 0.55, 0.83], clavR: [0, 0, -18],
      footL: { p: [0, 0, 0.3], yaw: -35, knee: [-0.3, 0.3, 1] }, footR: { p: [0, 0.05, -0.36], yaw: -60, pitch: 35, knee: [-0.6, -0.2, 0.6] },
      handR: { p: [-0.02, 1.4, 0.75], f: [0, 0.85, 0.5], n: [0, -0.5, 0.85], elbow: [-0.6, -0.6, -0.4], curl: 2, thumb: [35, 0] },
      handL: { p: [0.22, 0.8, -0.22], f: [0.2, -0.3, -1], n: [-0.3, -0.9, 0.2], elbow: [0.5, 0.3, -0.8], curl: 25 } },
    tie: { hips: { p: [-0.01, 0.71, -0.02], r: [['x', 2], ['y', -55]] }, spine: [8, 0, 0], chest: [6, 8, 0], neck: [16, 0, 0], head: [20, 4, 0],
      footL: { p: [0, 0, 0.3], yaw: -42, knee: [-0.5, 0.2, 1] }, footR: { p: [0, 0, -0.35], yaw: -82, knee: [-1, 0.2, -0.25] },
      handL: { rel: 'chest', p: [0.125, 0.015, 0.2], f: [-0.25, 0.1, 1], n: [-1, -0.15, -0.2], elbow: [0.8, -0.6, -0.2], curl: 78, thumb: [5, 50] },
      handR: { rel: 'chest', p: [-0.125, 0.015, 0.2], f: [0.25, 0.1, 1], n: [1, -0.15, -0.2], elbow: [-0.8, -0.6, -0.2], curl: 78, thumb: [5, 50] } },
    pull: { hips: { p: [0, 0.62, -0.15], r: [['x', -30], ['y', -35]] }, spine: [-4, 0, 0], chest: [-4, -10, 0], look: [0, 0.5, 0.86],
      footL: { p: [0, 0.01, 0.36], yaw: -30, pitch: -6, knee: [-0.3, 0.3, 1] }, footR: { p: [0, 0, -0.36], yaw: -75, knee: [-1, 0.3, 0] },
      handL: grip(1, 0.21), handR: grip(-1, 0.0) },
    rest: { seat: 1, seatAxis: 'z', hips: { p: [-0.015, 0.108, 0], r: [['y', 90], ['x', -6]] }, spine: [12, 0, 2], chest: [8, 0, 2], neck: [4, 0, 0], head: [-4, -12, 6], clavL: [0, 0, -6], clavR: [0, 0, 6],
      footL: { p: [0.4, -0.3, -0.085], yaw: 96, pitch: 25, knee: [1, 0.3, 0] }, footR: { p: [0.38, -0.31, 0.08], yaw: 84, pitch: 30, knee: [1, 0.3, 0] },
      handL: { p: [0.17, 0.205, -0.07], f: [1, -0.15, 0.2], n: [0, -1, 0], elbow: [-0.3, -0.3, -1], curl: 25 },
      handR: { p: [0.16, 0.205, 0.06], f: [1, -0.15, -0.2], n: [0, -1, 0], elbow: [-0.3, -0.3, 1], curl: 25 } },
  };
  const POSES = {}; for (const k in SPEC) POSES[k] = buildPose(SPEC[k]);

  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  function blendPose(a, b, k) {
    k = sat(k); const q = {};
    for (const n of JN) { qa.fromArray(a.q[n]); qb.fromArray(b.q[n]); q[n] = qa.slerp(qb, k).toArray(); }
    return { hp: [lerp(a.hp[0], b.hp[0], k), lerp(a.hp[1], b.hp[1], k), lerp(a.hp[2], b.hp[2], k)], q, seat: lerp(a.seat || 0, b.seat || 0, k), seatAxis: (a.seat || 0) >= (b.seat || 0) ? a.seatAxis : b.seatAxis };
  }
  let cur = POSES.stand;
  const tA = v3(), tB = v3(), tC = v3(), tD = v3(), rootInv = new THREE.Matrix4(), mTmp = new THREE.Matrix4();
  const toRoot = (obj, x, y, z, out) => out.set(x, y, z).applyMatrix4(obj.matrixWorld).applyMatrix4(rootInv);
  function placeCup() {
    rootInv.copy(root.matrixWorld).invert();
    toRoot(anchors.palmL, 0, 0.03, 0, tA); toRoot(anchors.palmR, 0, 0.03, 0, tB);
    anchors.cup.position.copy(tA).add(tB).multiplyScalar(0.5);
  }
  function setPose(p) {
    cur = p;
    J.hips.position.fromArray(p.hp); for (const n of JN) J[n].quaternion.fromArray(p.q[n]);
    root.updateMatrixWorld(true); placeCup();
  }

  // ---------------------------------------------------------------- per-frame secondary motion
  const UP = v3(0, 1, 0), ZERO = v3();
  const cap = (Q, A, B, rA, rB) => { // push Q out of a tapered capsule A-B
    const abx = B.x - A.x, aby = B.y - A.y, abz = B.z - A.z, l2 = abx * abx + aby * aby + abz * abz;
    const t = l2 > 1e-9 ? sat(((Q.x - A.x) * abx + (Q.y - A.y) * aby + (Q.z - A.z) * abz) / l2) : 0;
    const cx = A.x + abx * t, cy = A.y + aby * t, cz = A.z + abz * t, r = lerp(rA, rB, t), dx = Q.x - cx, dy = Q.y - cy, dz = Q.z - cz, d = Math.hypot(dx, dy, dz);
    if (d < r && d > 1e-6) { const k = r / d; Q.set(cx + dx * k, cy + dy * k, cz + dz * k); return true; }
    return false;
  };
  const hInv = new THREE.Matrix4(), gL = v3(), wL = v3(), kL = [v3(), v3()], aL = [v3(), v3()], hipJ = [v3(0.076, -0.04, 0), v3(-0.076, -0.04, 0)];
  const pN = v3(), pO = v3(), Q = v3(), Pp = v3(), D = v3(), belly = v3(0, -0.02, 0), bellyB = v3(0, 0.1, 0);
  function updateSkirt(t, wind, gust) {
    const { NC, NR } = SK, U = wind.length(), wAmt = 1 - Math.exp(-U / 26);
    hInv.copy(J.hips.matrixWorld).invert();
    gL.set(0, -1, 0).transformDirection(hInv); if (U > 1e-3) wL.copy(wind).transformDirection(hInv); else wL.set(0, 0, 0);
    ['L', 'R'].forEach((S, i) => { kL[i].setFromMatrixPosition(J['shin' + S].matrixWorld).applyMatrix4(hInv); aL[i].setFromMatrixPosition(J['foot' + S].matrixWorld).applyMatrix4(hInv); });
    const seat = cur.seat || 0, sAx = cur.seatAxis || 'x', sR = sAx === 'x' ? 0.085 : 0.06;
    if (seat > 0.01) { // the thing she sits on: a rounded ridge (along X) or the needle (along Z)
      const ay = -sR - (1 - seat) * 0.6;
      pN.set(sAx === 'x' ? -1.2 : 0, ay, sAx === 'x' ? 0 : -1.2).applyMatrix4(root.matrixWorld).applyMatrix4(hInv); pO.set(sAx === 'x' ? 1.2 : 0, ay, sAx === 'x' ? 0 : 1.2).applyMatrix4(root.matrixWorld).applyMatrix4(hInv);
    }
    const collide = (q) => {
      let hit = false;
      for (let i = 0; i < 2; i++) { hit = cap(q, hipJ[i], kL[i], 0.082, 0.066) || hit; hit = cap(q, kL[i], aL[i], 0.064, 0.062) || hit; }
      hit = cap(q, belly, bellyB, 0.112, 0.1) || hit;
      if (seat > 0.01) hit = cap(q, pN, pO, sR + 0.01, sR + 0.01) || hit;
      return hit;
    };
    const om = 3 + 15 * wAmt;
    for (let c = 0; c < NC; c++) {
      Pp.set(skRest[c * 3], skRest[c * 3 + 1], skRest[c * 3 + 2]); skCur.set([Pp.x, Pp.y, Pp.z], c * 3);
      const a = c / NC * TAU, rx = Math.sin(a), rz = Math.cos(a), lee = sat(rx * wL.x + rz * wL.z + 0.3);
      for (let r = 1; r <= NR; r++) {
        const k = (r * NC + c) * 3, k0 = k - NC * 3, s = r / NR;
        const sx = skRest[k] - skRest[k0], sy = skRest[k + 1] - skRest[k0 + 1], sz = skRest[k + 2] - skRest[k0 + 2], seg = Math.hypot(sx, sy, sz);
        const fl = Math.sin(t * om + c * 0.9 - s * 3.2) * (0.02 + 0.2 * wAmt * lee + 0.12 * gust * wAmt) * s;
        D.set(sx / seg + (gL.x) * 0.9 * s + wL.x * wAmt * 0.55 * s * (0.4 + lee) + rx * fl,
          sy / seg + (gL.y + 1) * 0.9 * s + wL.y * wAmt * 0.55 * s + 0,
          sz / seg + (gL.z) * 0.9 * s + wL.z * wAmt * 0.55 * s * (0.4 + lee) + rz * fl).normalize();
        Q.copy(Pp).addScaledVector(D, seg);
        for (let it = 0; it < 2; it++) if (collide(Q)) { D.copy(Q).sub(Pp); if (D.lengthSq() > 1e-10) Q.copy(Pp).addScaledVector(D.normalize(), seg); }
        collide(Q);
        skCur[k] = Q.x; skCur[k + 1] = Q.y; skCur[k + 2] = Q.z; Pp.copy(Q);
      }
    }
    for (let pass = 0; pass < 2; pass++) { // relax neighbouring columns
      skTmp.set(skCur);
      for (let r = 1; r <= NR; r++) for (let c = 0; c < NC; c++) { const k = (r * NC + c) * 3, l = (r * NC + (c + NC - 1) % NC) * 3, m = (r * NC + (c + 1) % NC) * 3; for (let e = 0; e < 3; e++) skCur[k + e] = 0.5 * skTmp[k + e] + 0.25 * (skTmp[l + e] + skTmp[m + e]); }
    }
    const P = skGeo.attributes.position.array, Nn = skGeo.attributes.normal.array;
    for (let r = 0; r <= NR; r++) for (let c = 0; c <= NC; c++) {
      const cc = c % NC, k = (r * NC + cc) * 3, kl = (r * NC + (cc + NC - 1) % NC) * 3, kr = (r * NC + (cc + 1) % NC) * 3, ku = (Math.max(0, r - 1) * NC + cc) * 3, kd = (Math.min(NR, r + 1) * NC + cc) * 3;
      const ax = skCur[kr] - skCur[kl], ay = skCur[kr + 1] - skCur[kl + 1], az = skCur[kr + 2] - skCur[kl + 2], bx = skCur[kd] - skCur[ku], by = skCur[kd + 1] - skCur[ku + 1], bz = skCur[kd + 2] - skCur[ku + 2];
      let nx = by * az - bz * ay, ny = bz * ax - bx * az, nz = bx * ay - by * ax; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const o = (r * skCols + c) * 3, i = (skGrid + r * skCols + c) * 3, th = 0.011 * smoothstep(0, 0.15, r / NR) + 0.002;
      P[o] = skCur[k]; P[o + 1] = skCur[k + 1]; P[o + 2] = skCur[k + 2]; Nn[o] = nx; Nn[o + 1] = ny; Nn[o + 2] = nz;
      P[i] = skCur[k] - nx * th; P[i + 1] = skCur[k + 1] - ny * th; P[i + 2] = skCur[k + 2] - nz * th; Nn[i] = -nx; Nn[i + 1] = -ny; Nn[i + 2] = -nz;
      if (r === NR) { const h1 = (skGrid * 2 + c) * 3, h2 = (skGrid * 2 + skCols + c) * 3;
        P[h1] = P[o]; P[h1 + 1] = P[o + 1]; P[h1 + 2] = P[o + 2]; P[h2] = P[i]; P[h2 + 1] = P[i + 1]; P[h2 + 2] = P[i + 2];
        let hx = bx, hy = by, hz = bz; const hl = Math.hypot(hx, hy, hz) || 1; Nn[h1] = Nn[h2] = hx / hl; Nn[h1 + 1] = Nn[h2 + 1] = hy / hl; Nn[h1 + 2] = Nn[h2 + 2] = hz / hl; }
    }
    skGeo.attributes.position.needsUpdate = true; skGeo.attributes.normal.needsUpdate = true;
  }

  const hgInv = new THREE.Matrix4(), hq = new THREE.Quaternion(), hOff = v3(), hT = v3(), hD = v3(), hPD = v3(), hC = v3();
  const hCol = [{ c: v3(), r: 0 }, { c: v3(), r: 0 }, { c: v3(), r: 0 }, { c: v3(), r: 0 }];
  function updateHair(t, wind, gust, wrapK) {
    const U = wind.length(), wAmt = 1 - Math.exp(-U / 28);
    hgInv.copy(headG.matrixWorld).invert();
    gL.set(0, -1, 0).transformDirection(hgInv); if (U > 1e-3) wL.copy(wind).transformDirection(hgInv); else wL.set(0, 0, 0);
    const dgx = gL.x, dgy = gL.y + 1, dgz = gL.z;
    const setCol = (i, obj, x, y, z, r) => { hCol[i].c.set(x, y, z).applyMatrix4(obj.matrixWorld).applyMatrix4(hgInv); hCol[i].r = r / HEAD_S; };
    setCol(0, J.chest, 0, 0.185, 0, lerp(0.066, 0.108, wrapK)); setCol(1, J.chest, 0, 0.07, 0, 0.132); setCol(2, J.armL, 0, 0, 0, 0.07); setCol(3, J.armR, 0, 0, 0, 0.07);
    const P = hairGeo.attributes.position.array, om = 2.2 + 15 * wAmt;
    for (const cl of hair.clumps) {
      const { K, Mv } = cl;
      for (let k = 0; k <= K; k++) {
        const s = k / K, o = (cl.ring0 + k) * 3, flex = cl.flex * Math.pow(s, 1.3);
        hT.set(ringT[o], ringT[o + 1], ringT[o + 2]);
        const side = Math.sin(t * om + cl.phase - s * 2.6) * (0.035 + 0.2 * wAmt + 0.25 * gust * wAmt) * flex;
        const wk = wAmt * flex * 1.5, gk = cl.grav * s * 0.95;
        hD.set(hT.x + dgx * gk + wL.x * wk + ringB[o] * side, hT.y + dgy * gk + wL.y * wk + ringB[o + 1] * side + cl.lift * wAmt * flex, hT.z + dgz * gk + wL.z * wk + ringB[o + 2] * side).normalize();
        if (k === 0) hC.set(ringC[o], ringC[o + 1], ringC[o + 2]);
        else {
          const seg = Math.hypot(ringC[o] - ringC[o - 3], ringC[o + 1] - ringC[o - 2], ringC[o + 2] - ringC[o - 1]);
          hPD.add(hD).normalize(); hC.addScaledVector(hPD, seg);
          const tgt = Math.min(ringE[cl.ring0 + k], 1.03), e = headE(hC.x, hC.y, hC.z);
          if (e < tgt) { const f = tgt / Math.max(e, 1e-4); hC.x *= f; hC.z = HC[2] + (hC.z - HC[2]) * f; if (hC.y > HC[1]) hC.y = HC[1] + (hC.y - HC[1]) * f; }
          for (const col of hCol) { const dx = hC.x - col.c.x, dy = hC.y - col.c.y, dz = hC.z - col.c.z, d = Math.hypot(dx, dy, dz), rr2 = col.r + 0.006; if (d < rr2 && d > 1e-6) { const f = rr2 / d; hC.set(col.c.x + dx * f, col.c.y + dy * f, col.c.z + dz * f); } }
        }
        hPD.copy(hD);
        hq.setFromUnitVectors(hT, hD);
        const rcx = ringC[o], rcy = ringC[o + 1], rcz = ringC[o + 2];
        for (let m = 0; m < Mv; m++) {
          const vi = (cl.base + k * Mv + m) * 3;
          hOff.set(hairRest[vi] - rcx, hairRest[vi + 1] - rcy, hairRest[vi + 2] - rcz).applyQuaternion(hq);
          P[vi] = hC.x + hOff.x; P[vi + 1] = hC.y + hOff.y; P[vi + 2] = hC.z + hOff.z;
        }
      }
    }
    hairGeo.attributes.position.needsUpdate = true; hairGeo.computeVertexNormals();
  }

  const tCol = [], tP = v3(), tDir = v3(), tFree = v3(), e1 = v3(), e2 = v3(), tBack = v3(), tRootD = v3(), gR = v3(), wR = v3();
  for (let i = 0; i < 8; i++) tCol.push({ c: v3(), r: 0 });
  function updateTails(t, wind, gust, len, floor) {
    const U = wind.length(), wk = 1 - Math.exp(-U / 14);
    rootInv.copy(root.matrixWorld).invert();
    gR.set(0, -1, 0).transformDirection(rootInv); if (U > 1e-3) wR.copy(wind).transformDirection(rootInv); else wR.set(0, 0, 0);
    const sc = (i, obj, x, y, z, r) => { toRoot(obj, x, y, z, tCol[i].c); tCol[i].r = r; };
    sc(0, J.chest, 0, 0.06, 0, 0.12); sc(1, J.spine, 0, 0.02, 0, 0.116); sc(2, J.hips, 0, -0.07, 0, 0.165); sc(3, J.hips, 0, -0.2, 0, 0.212);
    sc(4, headG, 0, 0.085, -0.01, 0.128); sc(5, J.armL, 0, 0, 0, 0.068); sc(6, J.armR, 0, 0, 0, 0.068); sc(7, J.chest, 0, 0.17, 0, 0.085);
    let floorY = -1e9;
    if (floor !== undefined && floor !== null) { tA.setFromMatrixPosition(root.matrixWorld); floorY = floor - tA.y + 0.012; }
    tBack.set(0, 0.3, -1).transformDirection(J.chest.matrixWorld).transformDirection(rootInv);
    for (const tl of tails) {
      const L = tl.len * len; tl.mesh.visible = len > 0.012;
      toRoot(J.chest, tl.rootL.x, tl.rootL.y, tl.rootL.z, tP);
      tRootD.copy(tl.dirL).transformDirection(J.chest.matrixWorld).transformDirection(rootInv);
      tFree.copy(gR).addScaledVector(wR, U / 8).normalize();
      e1.copy(gR).negate().addScaledVector(tFree, tFree.dot(gR)); tC.copy(tBack).addScaledVector(tFree, -tBack.dot(tFree)); e1.addScaledVector(tC, 0.25).normalize();
      e2.crossVectors(tFree, e1);
      tFree.addScaledVector(e2, tl.sx * lerp(0.05, 0.09, wk)).normalize();
      const amp = lerp(0.1, 0.72, wk) * (1 + 0.6 * gust), om = TAU * lerp(0.35, 4.4, wk), lam = lerp(1.7, 0.66, wk), seg = L / TN;
      tl.P[0].copy(tP);
      for (let i = 0; i < TN; i++) {
        const s = (i + 0.5) / TN, sm = s * L, env = 0.25 + 0.75 * s, ph = TAU * sm / lam - om * t + tl.phase;
        const a1 = amp * env * (Math.sin(ph) + 0.35 * Math.sin(2.3 * ph + 1.7)) + gust * 0.45 * env * fbm1(t * 2.1 - sm * 1.5, tl.seed) + (1 - wk) * 0.1 * Math.sin(sm * 4.1 + tl.phase * 1.3);
        const a2 = amp * 0.5 * env * Math.sin(0.63 * ph + 2.1 + tl.phase * 2) + gust * 0.3 * env * fbm1(t * 1.7 - sm * 1.2, tl.seed + 5) + (1 - wk) * 0.08 * Math.sin(sm * 2.7 + tl.phase * 2.1);
        tDir.copy(tFree).addScaledVector(e1, a1).addScaledVector(e2, a2).normalize();
        tDir.lerp(tRootD, 1 - smoothstep(0, 0.17, sm)).normalize();
        tP.addScaledVector(tDir, seg);
        if (sm > 0.07) for (const col of tCol) { const dx = tP.x - col.c.x, dy = tP.y - col.c.y, dz = tP.z - col.c.z, d = Math.hypot(dx, dy, dz); if (d < col.r && d > 1e-6) { const f = col.r / d; tP.set(col.c.x + dx * f, col.c.y + dy * f, col.c.z + dz * f); } }
        if (tP.y < floorY) { // lie on the floor, trailing behind her
          tP.addScaledVector(tDir, -seg); tDir.y = Math.max(0, tDir.y); tDir.addScaledVector(tBack, 0.7); tDir.y = Math.max(0, tDir.y) * 0.2; tDir.normalize();
          tP.addScaledVector(tDir, seg); tP.y = Math.max(tP.y, floorY);
        }
        tl.P[i + 1].copy(tP);
      }
      // frames: parallel-transported normal with a slow travelling twist
      tA.copy(tBack);
      for (let i = 0; i <= TN; i++) {
        const F = tl.F[i], s = i / TN;
        F.t.copy(tl.P[Math.min(TN, i + 1)]).sub(tl.P[Math.max(0, i - 1)]).normalize();
        tA.addScaledVector(F.t, -tA.dot(F.t)); if (tA.lengthSq() < 1e-8) tA.copy(UP).addScaledVector(F.t, -F.t.y); tA.normalize();
        const tw = (0.5 * Math.sin(TAU * s * 1.3 - om * 0.35 * t + tl.phase * 3) * (0.3 + 0.7 * wk) + tl.sx * 0.25) * smoothstep(0.05, 0.4, s);
        tB.crossVectors(F.t, tA);
        F.n.copy(tA).multiplyScalar(Math.cos(tw)).addScaledVector(tB, Math.sin(tw)); F.b.crossVectors(F.t, F.n);
      }
      const hwFull = lerp(0.05, 0.062, wk);
      { // fringe
        const Fe = tl.F[TN], ce = tl.P[TN], fk = smoothstep(0.9, 1, len), fp = tl.fr.geo.attributes.position.array; let o = 0;
        tl.fr.mesh.visible = tl.mesh.visible && fk > 0.02;
        const crl = (0.55 + 0.3 * Math.sin(7 + tl.phase * 2)) * lerp(1, 0.35, wk) * tl.sx;
        for (let i = 0; i < FRN; i++) {
          const off = hwFull * (-0.84 + 0.28 * i), up = crl * off * off / hwFull, wob = Math.sin(om * t * 1.3 + i * 1.9 + tl.phase) * 0.012 * (0.3 + wk);
          const cx = ce.x + Fe.b.x * off + Fe.n.x * up, cy = ce.y + Fe.b.y * off + Fe.n.y * up, cz = ce.z + Fe.b.z * off + Fe.n.z * up;
          for (const [db, dn] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { fp[o++] = cx + Fe.b.x * 0.0068 * db + Fe.n.x * 0.0036 * dn; fp[o++] = cy + Fe.b.y * 0.0068 * db + Fe.n.y * 0.0036 * dn; fp[o++] = cz + Fe.b.z * 0.0068 * db + Fe.n.z * 0.0036 * dn; }
          const fl = (0.05 + 0.02 * Math.sin(i * 2.3)) * fk;
          fp[o++] = cx + Fe.t.x * fl + Fe.n.x * wob + gR.x * 0.012 * (1 - wk); fp[o++] = cy + Fe.t.y * fl + Fe.n.y * wob + gR.y * 0.012 * (1 - wk); fp[o++] = cz + Fe.t.z * fl + Fe.n.z * wob + gR.z * 0.012 * (1 - wk);
        }
        tl.fr.geo.attributes.position.needsUpdate = true; tl.fr.geo.computeVertexNormals();
      }
      regrid(tl.geo, (u, v, p, i, j) => {
        const jj = Math.min(TN, j), F = tl.F[jj], c = tl.P[jj], s = jj / TN, sm = s * L;
        const open = smoothstep(0.02, 0.24, sm), endK = j > TN ? 0 : 1 - 0.35 * smoothstep(0.93, 1, s) * (len < 0.98 ? 1 : 0);
        const hw = lerp(0.026, hwFull, open) * endK, ht = lerp(0.02, 0.0065, open) * endK, ph = u * TAU, k = sePolar(ph, 3.2);
        const crl = open * (0.55 + 0.3 * Math.sin(s * 7 + tl.phase * 2)) * lerp(1, 0.35, wk) * tl.sx;
        const a = hw * k * Math.sin(ph), b = ht * k * Math.cos(ph) + crl * a * a / Math.max(hw, 1e-4), ex = j > TN ? 0.004 : 0;
        p[0] = c.x + F.b.x * a + F.n.x * b + F.t.x * ex; p[1] = c.y + F.b.y * a + F.n.y * b + F.t.y * ex; p[2] = c.z + F.b.z * a + F.n.z * b + F.t.z * ex;
      });
      (tl.sx > 0 ? anchors.scarfTipL : anchors.scarfTipR).position.copy(tl.P[TN]);
    }
  }

  let lastWrap = -1;
  function updateWrap(w) {
    if (Math.abs(w - lastWrap) < 1e-4) return;
    lastWrap = w; wrapAmt = Math.max(w, 0.001); wrap.visible = w > 0.015;
    if (wrap.visible) regrid(wrap.geometry, wrapFn);
    const ks = smoothstep(0.7, 1, w); knot.visible = ks > 0.02; knot.scale.setScalar(Math.max(0.02, ks) * 0.85);
    collarFluff = lerp(1.38, 1.0, smoothstep(0.1, 0.8, w)); regrid(collar.geometry, collarFn);
  }

  const bq = new THREE.Quaternion();
  function update(t = 0, o = {}) {
    const wind = o.wind || ZERO, gust = o.gust || 0, len = sat(o.scarfLen ?? 1), w = sat(o.scarfWrap ?? 1);
    const br = Math.sin(t * 1.9);
    J.chest.quaternion.fromArray(cur.q.chest).multiply(bq.setFromAxisAngle(AX.x, -0.014 * br));
    J.clavL.quaternion.fromArray(cur.q.clavL).multiply(bq.setFromAxisAngle(AX.z, 0.012 * br));
    J.clavR.quaternion.fromArray(cur.q.clavR).multiply(bq.setFromAxisAngle(AX.z, -0.012 * br));
    root.updateWorldMatrix(true, true);
    for (const s of skins) s();
    updateSkirt(t, wind, gust);
    updateWrap(w);
    updateHair(t, wind, gust, w);
    updateTails(t, wind, gust, len, o.floor);
    placeCup();
  }

  setPose(POSES.stand); setFace({}); update(0, {});
  return { root, POSES, blendPose, setPose, setFace, update, anchors, joints: J };

  function bootW(z) { return BOOT_W(z); }
  function bootTop(z) { return BOOT_T(z); }
}
const BOOT_W = curve([[-0.068, 0.0], [-0.062, 0.026], [-0.04, 0.042], [0, 0.046], [0.06, 0.052], [0.11, 0.05], [0.14, 0.039], [0.154, 0.02], [0.158, 0]]);
const BOOT_T = curve([[-0.068, -0.045], [-0.06, -0.01], [-0.04, 0.02], [0, 0.03], [0.035, 0.0], [0.07, -0.028], [0.11, -0.04], [0.14, -0.048], [0.158, -0.062]]);
