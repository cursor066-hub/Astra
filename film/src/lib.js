// Small math / noise / easing toolkit shared by every module. Everything is a pure function of its inputs
// so any frame of the film can be rendered independently.
import * as THREE from 'three';

export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const sat = (x) => clamp(x, 0, 1);
export const lerp = (a, b, k) => a + (b - a) * k;
export const smoothstep = (a, b, x) => { const k = sat((x - a) / (b - a)); return k * k * (3 - 2 * k); };
export const smootherstep = (a, b, x) => { const k = sat((x - a) / (b - a)); return k * k * k * (k * (k * 6 - 15) + 10); };
export const remap = (x, a, b, c, d) => c + (d - c) * sat((x - a) / (b - a));
export const mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

export const ease = {
  linear: (k) => k,
  inQuad: (k) => k * k,
  outQuad: (k) => 1 - (1 - k) * (1 - k),
  inOutQuad: (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
  inCubic: (k) => k * k * k,
  outCubic: (k) => 1 - Math.pow(1 - k, 3),
  inOutCubic: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  inQuart: (k) => k * k * k * k,
  outQuart: (k) => 1 - Math.pow(1 - k, 4),
  inOutQuart: (k) => (k < 0.5 ? 8 * k * k * k * k : 1 - Math.pow(-2 * k + 2, 4) / 2),
  inExpo: (k) => (k <= 0 ? 0 : Math.pow(2, 10 * k - 10)),
  outExpo: (k) => (k >= 1 ? 1 : 1 - Math.pow(2, -10 * k)),
  inOutSine: (k) => -(Math.cos(Math.PI * k) - 1) / 2,
  outBack: (k) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); },
  outElastic: (k) => (k <= 0 ? 0 : k >= 1 ? 1 : Math.pow(2, -10 * k) * Math.sin((k * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};

// Deterministic RNG
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash1(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123; return s - Math.floor(s); }
export function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7 + 74.7) * 43758.5453123; return s - Math.floor(s); }

// Smooth 1D value noise in [-1, 1]
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return lerp(hash1(i + seed * 57.31), hash1(i + 1 + seed * 57.31), u) * 2 - 1;
}
export function fbm1(x, seed = 0, oct = 3) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise1(x, seed + i * 13.7); n += a; x *= 2.03; a *= 0.5; }
  return s / n;
}
// Smooth 2D value noise in [0, 1]
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return lerp(lerp(hash2(ix, iy), hash2(ix + 1, iy), ux), lerp(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux), uy);
}
export function fbm2(x, y, oct = 4) {
  let a = 0.5, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * noise2(x, y); n += a; x = x * 2.02 + 17.1; y = y * 2.02 + 9.3; a *= 0.5; }
  return s / n;
}

// Organic hand-held camera shake: returns Vector3 offsets (smooth, deterministic)
export function shake(t, amp = 1, freq = 1, seed = 0, out = new THREE.Vector3()) {
  return out.set(fbm1(t * freq, seed + 1.3), fbm1(t * freq, seed + 7.9), fbm1(t * freq, seed + 21.7)).multiplyScalar(amp);
}

export const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Piecewise key interpolation: keys = [[t, value], ...]; value number | number[]; optional easing per segment
export function keys(t, ks, easing = ease.inOutCubic) {
  if (t <= ks[0][0]) return ks[0][1];
  const last = ks[ks.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const k = (b[2] || easing)((t - a[0]) / (b[0] - a[0]));
      if (typeof a[1] === 'number') return lerp(a[1], b[1], k);
      return a[1].map((v, j) => lerp(v, b[1][j], k));
    }
  }
  return last[1];
}

// Catmull-Rom through points (array of Vector3) with uniform parameter u in [0,1]
export function spline(points, u, out = new THREE.Vector3()) {
  const n = points.length - 1;
  const p = sat(u) * n; let i = Math.min(Math.floor(p), n - 1); const f = p - i;
  const p0 = points[Math.max(i - 1, 0)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(i + 2, n)];
  const f2 = f * f, f3 = f2 * f;
  const c = (a, b, cc, d) => 0.5 * ((2 * b) + (-a + cc) * f + (2 * a - 5 * b + 4 * cc - d) * f2 + (-a + 3 * b - 3 * cc + d) * f3);
  return out.set(c(p0.x, p1.x, p2.x, p3.x), c(p0.y, p1.y, p2.y, p3.y), c(p0.z, p1.z, p2.z, p3.z));
}

// GLSL helpers shared by custom shaders
export const GLSL_NOISE = /* glsl */ `
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash31(vec3 p3){ p3 = fract(p3*0.1031); p3 += dot(p3, p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash21(i),hash21(i+vec2(1,0)),f.x), mix(hash21(i+vec2(0,1)),hash21(i+vec2(1,1)),f.x), f.y); }
float vnoise3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x), mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x), f.y),
             mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x), mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x), f.y), f.z); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.1,9.3); a*=0.5; } return s; }
float fbm3(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*vnoise3(p); p=p*2.03+vec3(17.1,9.3,5.7); a*=0.5; } return s; }
`;
