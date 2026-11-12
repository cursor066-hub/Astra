// The tear in the sky: shared geometry maths (mirrored in JS and GLSL so meshes, shaders, the hero's
// flight path and the stitches all agree), plus the story timeline of the seam.
import * as THREE from 'three';
import { sat, lerp, smoothstep, ease } from './lib.js';

export const H = 2000;                       // altitude of the sky cloth (m). Village sits at y = 800.
export const TEAR = { xc: -145, half: 475, wmax: 11, x0: -620, x1: 330, margin: 4.5, ry: 7 };

// ---- timeline of the seam ---------------------------------------------------------------------------------
// Pierce events: phi is the corkscrew phase (even multiples of PI: up through the north lip (+z),
// odd multiples: down through the south lip (-z)).
export const PIERCES = [];
PIERCES.push({ t: 24.3, x: -560, phi: 0 });
for (let k = 1; k <= 17; k++) PIERCES.push({ t: 26.5 + 0.5 * (k - 1), x: -520 + 28 * (k - 1), phi: k * Math.PI });
export const GOLD_END = { t: 35.0, x: -44, phi: 18 * Math.PI };          // where the thread runs out (not a pierce)
export const RED_PIERCES = [];
for (let j = 0; j <= 7; j++) RED_PIERCES.push({ t: 43.0 + 0.5 * j, x: -44 + 47.4 * j, phi: (18 + j) * Math.PI, red: true });
export const FINAL_PIERCE = { t: 47.6, x: 338, phi: 27 * Math.PI, red: true, final: true };
export const POPS = [35.6, 35.9, 36.15, 36.35, 36.5, 36.62, 36.72, 36.8, 36.87, 36.93];
export const T = { threadOut: 35.0, whip: 35.2, catch: 38.2, knot: 41.6, redStart: 42.5, pull: 48.2, shut: 50.6 };
export const ALL_PIERCES = [...PIERCES, ...RED_PIERCES, FINAL_PIERCE];

export function seamZ(x) { return 3.0 * Math.sin(x * 0.011 + 3.7) + 1.4 * Math.sin(x * 0.027 + 1.1) + 0.6 * Math.sin(x * 0.071 + 5.3); }
export function baseW(x) {
  const u = (x - TEAR.xc) / TEAR.half; const s = Math.pow(sat(1 - u * u), 0.75);
  return TEAR.wmax * s * (0.86 + 0.1 * Math.sin(x * 0.017 + 2.0) + 0.06 * Math.sin(x * 0.043 + 0.5));
}
export function closeAmt(x, st) {
  let c = smoothstep(0, 70, st.front - x);
  c *= 1 - st.looseAmt * smoothstep(st.looseX0 - 30, st.looseX0, x) * (1 - smoothstep(st.looseX1 - 5, st.looseX1 + 25, x));
  return c;
}
export function gapW(x, st) {
  let w = baseW(x) * lerp(1, 0.07, closeAmt(x, st));
  w *= 1 - smoothstep(st.cinch - 90, st.cinch, x);
  return w;
}
// Height of the cloth. d = distance from the lip edge (>= 0), side = +1 north / -1 south.
export function clothY(x, z, d, side, st) {
  const t = st.t;
  let y = 7.0 * Math.sin(x * 0.0041 + t * 0.21 + Math.sin(z * 0.003) * 2.0) * Math.cos(z * 0.0052 - t * 0.17) + 3.0 * Math.sin(x * 0.013 - t * 0.4 + z * 0.009);
  const ok = gapW(x, st) / TEAR.wmax; const e = Math.exp(-d / 16);
  y += -ok * 6.0 * e * (0.75 + 0.25 * Math.sin(x * 0.05 + t * 1.3));
  y += st.flap * ok * e * (1.6 * Math.sin(x * 0.12 - t * 6.0 + side * 1.7 + d * 0.15) + 0.9 * Math.sin(x * 0.31 + t * 9.0 + side * 4.0));
  y += closeAmt(x, st) * 0.5 * Math.exp(-d / 7) * Math.sin(x * 0.2244);
  return H + y;
}
// Cloth height at an arbitrary world (x, z)
export function clothAt(x, z, st) {
  const lat = z - seamZ(x); const side = lat >= 0 ? 1 : -1;
  const d = Math.max(0, Math.abs(lat) - gapW(x, st));
  return clothY(x, z, d, side, st);
}

export const TEAR_GLSL = /* glsl */ `
uniform float uT; uniform float uFront; uniform vec3 uLoose; uniform float uCinch; uniform float uFlap; uniform vec4 uPierce[6];
const float SKY_H = ${H.toFixed(1)}; const float WMAX = ${TEAR.wmax.toFixed(1)};
float seamZ(float x){ return 3.0*sin(x*0.011+3.7)+1.4*sin(x*0.027+1.1)+0.6*sin(x*0.071+5.3); }
float baseW(float x){ float u=(x-(${TEAR.xc.toFixed(1)}))/${TEAR.half.toFixed(1)}; float s=pow(clamp(1.0-u*u,0.0,1.0),0.75);
  return WMAX*s*(0.86+0.1*sin(x*0.017+2.0)+0.06*sin(x*0.043+0.5)); }
float closeAmt(float x){ float c=smoothstep(0.0,70.0,uFront-x);
  c*=1.0-uLoose.z*smoothstep(uLoose.x-30.0,uLoose.x,x)*(1.0-smoothstep(uLoose.y-5.0,uLoose.y+25.0,x)); return c; }
float gapW(float x){ float w=baseW(x)*mix(1.0,0.07,closeAmt(x)); w*=1.0-smoothstep(uCinch-90.0,uCinch,x); return w; }
float clothY(float x, float z, float d, float side){
  float y=7.0*sin(x*0.0041+uT*0.21+sin(z*0.003)*2.0)*cos(z*0.0052-uT*0.17)+3.0*sin(x*0.013-uT*0.4+z*0.009);
  float ok=gapW(x)/WMAX; float e=exp(-d/16.0);
  y+=-ok*6.0*e*(0.75+0.25*sin(x*0.05+uT*1.3));
  y+=uFlap*ok*e*(1.6*sin(x*0.12-uT*6.0+side*1.7+d*0.15)+0.9*sin(x*0.31+uT*9.0+side*4.0));
  y+=closeAmt(x)*0.5*exp(-d/7.0)*sin(x*0.2244);
  for(int i=0;i<6;i++){ vec4 p=uPierce[i]; if(p.w!=0.0){ float r=length(vec2(x-p.x,z-p.y)); float ph=r-p.z*55.0;
      y+=p.w*(2.4*exp(-p.z*1.5)*exp(-ph*ph/90.0)*smoothstep(0.0,6.0,r)+1.6*exp(-p.z*5.0)*exp(-r*r/40.0)); } }
  return SKY_H+y;
}
`;

// ---- seam state as a function of film time --------------------------------------------------------------------
function seg(list, t) { for (let k = list.length - 2; k >= 0; k--) if (t >= list[k].t) return k; return 0; }
const GOLD_PATH = [...PIERCES, GOLD_END];
const RED_PATH = [{ t: 42.5, x: -66, phi: 17.35 * Math.PI }, ...RED_PIERCES];

export function heroX(t) {
  if (t < 24.3) return -560 - (24.3 - t) * 40;
  if (t <= 35.0) { const k = seg(GOLD_PATH, t), a = GOLD_PATH[k], b = GOLD_PATH[k + 1]; return lerp(a.x, b.x, sat((t - a.t) / (b.t - a.t))); }
  if (t < 42.5) return -44;
  if (t <= 46.5) { const k = seg(RED_PATH, t), a = RED_PATH[k], b = RED_PATH[k + 1]; return lerp(a.x, b.x, sat((t - a.t) / (b.t - a.t))); }
  return lerp(RED_PIERCES[7].x, FINAL_PIERCE.x, smoothstep(46.5, 47.6, t));
}

export function seamState(t) {
  const st = { t, front: -900, looseX0: 0, looseX1: 0, looseAmt: 0, cinch: 900, flap: 1 };
  if (t >= 24.3) st.front = heroX(Math.min(t, 47.6)) - 18;
  if (t > 35.0 && t < 43.0) st.front = -44 - 18;
  if (t >= 47.6) st.front = lerp(338 - 18, 520, smoothstep(47.6, 48.6, t));
  // popped (loosened) stitches
  let n = 0; for (const p of POPS) n += smoothstep(p, p + 0.07, t);
  st.looseX0 = -72 - 28 * n; st.looseX1 = -62;
  st.looseAmt = 0.62 * smoothstep(35.45, 35.7, t) * (1 - smoothstep(42.55, 43.5, t));
  // the pull: a closing wave racing west from the hero
  if (t >= T.pull) { const u = sat((t - T.pull) / (T.shut - T.pull)); st.cinch = 430 - 1300 * Math.pow(u, 2.3); }
  st.flap = 1 - 0.75 * smoothstep(T.shut - 0.3, T.shut + 0.6, t);
  return st;
}

// ---- hero corkscrew path -----------------------------------------------------------------------------------------
const tmp = new THREE.Vector3();
function arcScale(a) { return a.t === 24.3 ? 2.6 : 1.0; }
// Position on the stitching corkscrew at path time tau, evaluated against seam state st (so old
// parts of the path follow the lips as they close).
export function helixPos(tau, st, out = new THREE.Vector3()) {
  let a, b;
  if (tau <= 35.0) { const k = seg(GOLD_PATH, tau); a = GOLD_PATH[k]; b = GOLD_PATH[k + 1]; }
  else { const k = seg(RED_PATH, tau); a = RED_PATH[k]; b = RED_PATH[k + 1]; }
  const f = sat((tau - a.t) / (b.t - a.t));
  const phi = lerp(a.phi, b.phi, f), x = lerp(a.x, b.x, f);
  const R = gapW(x, st) + TEAR.margin, Ry = TEAR.ry * (1 + (arcScale(a) - 1) * Math.sin(Math.PI * f));
  const z = seamZ(x) + R * Math.cos(phi);
  const yc = clothAt(x, seamZ(x) + Math.sign(Math.cos(phi) || 1) * R, st);
  return out.set(x, yc + Ry * Math.sin(phi), z);
}
// Final loop: down-pierce at 46.5, up through the slit, high over the top, plunge through the cloth beyond the tip.
export function finalLoopPos(tau, st, out = new THREE.Vector3()) {
  const a = RED_PIERCES[7], f = sat((tau - 46.5) / 1.1);
  const x = lerp(a.x, FINAL_PIERCE.x, f * f * (3 - 2 * f) * 0.6 + f * 0.4);
  const phi = Math.PI + f * 2 * Math.PI;                       // starts going down on the south side, ends going down on the centre line
  const R = (gapW(a.x, st) + TEAR.margin) * (1 - f);            // spirals in to the seam line
  const Ry = TEAR.ry * (1 + 2.2 * smoothstep(0.35, 0.75, f) * (1 - smoothstep(0.75, 1.0, f)) * 1.0);
  const yc = clothAt(x, seamZ(x), st);
  return out.set(x, yc + Ry * Math.sin(phi), seamZ(x) + R * Math.cos(phi));
}
export function stitchPathPos(tau, st, out) { return tau > 46.5 ? finalLoopPos(Math.min(tau, 47.6), st, out) : helixPos(tau, st, out); }

// Anchored pierce point of event p under seam state st
export function piercePoint(p, st, out = new THREE.Vector3()) {
  if (p.final) return out.set(p.x, clothAt(p.x, seamZ(p.x), st), seamZ(p.x));
  const side = Math.cos(p.phi) > 0 ? 1 : -1; const z = seamZ(p.x) + side * (gapW(p.x, st) + TEAR.margin);
  return out.set(p.x, clothAt(p.x, z, st), z);
}

// Thread centre line at path time tau as seen at film time t: follows the flown path while fresh, then
// pulls tight into straight stitches between pierce points (alternately just above / below the cloth).
const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pl = new THREE.Vector3();
export function threadPoint(tau, t, st, out = new THREE.Vector3()) {
  const list = tau <= 35.0 ? GOLD_PATH : (tau > 46.5 ? [RED_PIERCES[7], FINAL_PIERCE] : RED_PATH);
  const k = seg(list, tau), a = list[k], b = list[k + 1];
  const f = sat((tau - a.t) / (b.t - a.t));
  stitchPathPos(tau, st, pl);
  // tight chord
  if (a === RED_PATH[0]) pa.copy(stitchPathPos(a.t, st, pa)); else piercePoint(a, st, pa);
  if (b === GOLD_END) stitchPathPos(b.t, st, pb); else piercePoint(b, st, pb);
  const under = Math.sin(lerp(a.phi, b.phi, 0.5)) < 0;
  const x = lerp(pa.x, pb.x, f);
  const slack = 1 - closeAmt(x, st);
  const lift = Math.sin(Math.PI * f) * (0.7 + (under ? 5.0 : 1.5) * slack * sat((t - tau) * 2));
  out.lerpVectors(pa, pb, f); out.y += under ? -lift : lift;
  if (under && slack > 0.01) { out.z += Math.sin(Math.PI * f) * slack * 1.6 * Math.sin(t * 3.1 + a.t * 7.0); out.x -= Math.sin(Math.PI * f) * slack * 2.0; }
  const age = t - tau;
  const tight = ease.inOutCubic(sat((age - 0.18) / 0.85));
  return out.lerpVectors(pl, out, tight);
}
