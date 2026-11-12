// Pure kinematics for the hero: where the needle is at any film time (ground flight and sky flight).
import * as THREE from 'three';
import { sat, lerp, smoothstep, ease, spline } from './lib.js';
import { H, TEAR, T, PIERCES, FINAL_PIERCE, seamState, seamZ, gapW, clothAt, stitchPathPos, piercePoint } from './tear.js';
import { HOUSE } from './groundset.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const a = V(), b = V(), c = V(), d = V();

// ---------------------------------------------------------------- ground / cloud flight (shots S04, S05)
const yawM = new THREE.Matrix4().makeRotationY(HOUSE.yaw);
export const houseLocal = (x, y, z, out = V()) => out.set(x, y, z).applyMatrix4(yawM).add(a.set(HOUSE.x, HOUSE.y, HOUSE.z));
export const RIDGE_Y = HOUSE.ridgeY + 0.36;
const LAUNCH_DIR = V(0.04, 0.84, 0.54).normalize().applyMatrix4(yawM);
const CLIMB_DIR = V(-0.25, 0.75, 0.6).normalize();
export const T_LAUNCH = 12.2;

export function groundPos(t, out = V()) {
  if (t < 14.5) {
    const p0 = houseLocal(0, RIDGE_Y + 0.5, 0.1, out);
    const tau = Math.max(0, t - T_LAUNCH), t1 = 0.8, acc = 130;
    const s = tau < t1 ? 0.5 * acc * tau * tau : 0.5 * acc * t1 * t1 + acc * t1 * (tau - t1);
    return p0.addScaledVector(LAUNCH_DIR, s);
  }
  return out.set(-470, 1120, -560).addScaledVector(CLIMB_DIR, 170 * (t - 14.5));
}
export function groundDir(t, out = V()) {
  if (t < 14.5) { const k = ease.outCubic(sat((t - T_LAUNCH + 0.15) / 0.45)); return out.set(0, 0.12, 1).applyMatrix4(yawM).lerp(LAUNCH_DIR, k).normalize(); }
  return out.copy(CLIMB_DIR);
}

// ---------------------------------------------------------------- sky flight
const hover = V(), catchP = V();
function hoverPoint(st, out) { const x = -30; const z = seamZ(x) + 14; return out.set(x, clothAt(x, z, st) - 7, z); }
export function catchPoint(st, out) { const p = piercePoint(PIERCES[17], st, out); return out.set(p.x - 8, p.y - 18, p.z + 10); }
const S12 = [V(), V(), V(), V(), V()];

export function skyPos(t, st, out = V()) {
  if (t < 20.5) { const x = -812 + 14 * (t - 18), z = -80 + 0.5 * (t - 18); return out.set(x, clothAt(x, z, st) - 1.97 + 0.03 * Math.sin(t * 2.1), z); }
  if (t < 23.0) { const k = (t - 20.5) / 2.5; const x = lerp(-778, -618, k), z = lerp(-74, seamZ(-618) - 24, ease.inOutSine(k)); return out.set(x, clothAt(x, z, st) - lerp(11, 8, k) + Math.sin(k * 6) * 1.2, z); }
  if (t < 24.3) {
    const k = Math.pow((t - 23.0) / 1.3, 1.25);
    const zs = seamZ(-618) - 24; a.set(-618, clothAt(-618, zs, st) - 8, zs); piercePoint(PIERCES[0], st, d);
    b.copy(a).add(c.set(34, -7, 4)); c.copy(d).add(V(-7, -20, -5));
    const u = 1 - k; return out.set(0, 0, 0).addScaledVector(a, u * u * u).addScaledVector(b, 3 * u * u * k).addScaledVector(c, 3 * u * k * k).addScaledVector(d, k * k * k);
  }
  if (t <= 34.75) return stitchPathPos(t, st, out);
  if (t < 37.0) { // out of thread: peel away from the corkscrew and coast to a hover under the north lip
    const h = 0.01; stitchPathPos(34.75, st, a); stitchPathPos(34.75 - h, st, b); b.subVectors(a, b).multiplyScalar(1 / h); // velocity
    hoverPoint(st, c); const D = 1.7, k = sat((t - 34.75) / D), k2 = k * k, k3 = k2 * k;
    return out.set(0, 0, 0).addScaledVector(a, 2 * k3 - 3 * k2 + 1).addScaledVector(b, (k3 - 2 * k2 + k) * D * 0.55).addScaledVector(c, -2 * k3 + 3 * k2);
  }
  if (t < 42.5) { // dive, catch the loose end, swing back up to the seam
    hoverPoint(st, S12[0]); catchPoint(st, S12[2]); S12[2].y -= 1.6; S12[2].z -= 0.6;
    S12[1].lerpVectors(S12[0], S12[2], 0.5); S12[1].y += 2.5; S12[1].z += 3;
    stitchPathPos(42.5, st, S12[4]); S12[3].set(S12[2].x - 9, S12[2].y + 2.5, S12[2].z - 7);
    let u;
    if (t < T.catch) u = 0.5 * Math.pow((t - 37.0) / (T.catch - 37.0), 1.6);
    else u = 0.5 + 0.5 * ease.outCubic(sat((t - T.catch) / 2.6));
    return spline(S12, u, out);
  }
  if (t <= 47.6) return stitchPathPos(t, st, out);
  // after the last pierce: brake below the cloth east of the seam's end, then get dragged back a little by the pull
  piercePoint(FINAL_PIERCE, st, a);
  const k = ease.outCubic(sat((t - 47.6) / 0.75)); const pull = ease.inOutSine(sat((t - T.pull) / (T.shut - T.pull)));
  return out.set(a.x + 15 * k + 4.5 * pull, a.y - 11.5 * k - 1.2 * pull + 0.25 * Math.sin(t * 1.3) * smoothstep(50.6, 52, t), a.z + 3 * k);
}

const p0 = V(), p1 = V(), ax = V(), wUp = V(0, 1, 0), tmpF = V(), tmpU = V();
/** Position, forward, up and speed of the needle in the sky at time t. */
export function skyKin(t, out = { pos: V(), fwd: V(), up: V(), speed: 0, st: null }) {
  const st = seamState(t); out.st = st; const h = 1 / 120;
  skyPos(t, st, out.pos); skyPos(t + h, st, p1); skyPos(t - h, st, p0);
  tmpF.subVectors(p1, p0).multiplyScalar(1 / (2 * h)); out.speed = tmpF.length();
  if (out.speed > 0.5) out.fwd.copy(tmpF).normalize(); else out.fwd.set(1, 0, 0);
  // corkscrew: head points at the seam axis (like a barrel roll); elsewhere stay upright with a little bank
  const x = out.pos.x; ax.set(x, clothAt(x, seamZ(x), st), seamZ(x)).sub(out.pos); const dAxis = ax.length(); ax.normalize();
  let w = 0;
  if (t > 25.3 && t < 35.4) w = smoothstep(25.3, 26.4, t) * (1 - smoothstep(34.7, 35.4, t));
  if (t > 42.5 && t < 47.9) w = smoothstep(42.5, 43.0, t) * (1 - smoothstep(46.5, 47.2, t));
  tmpU.copy(wUp).lerp(ax, w * 0.9);
  if (t >= 37 && t < 40) tmpU.addScaledVector(V(0, 0, 1), -0.35 * Math.sin(Math.PI * sat((t - 37) / 2.6)));          // bank into the dive
  if (t >= 47.6) { // face back along the seam (west) for the pull
    const k = ease.inOutCubic(sat((t - 47.6) / 0.7)); out.fwd.lerp(V(-1, 0.1, -0.05), k).normalize(); tmpU.copy(wUp);
  }
  if (t >= 35.2 && t < 37) { const k = smoothstep(35.2, 36.6, t); out.fwd.lerp(V(0.95, 0.0, -0.3), k).normalize(); }
  if (t >= 38.6 && t < 42.5) { const k = smoothstep(38.6, 40.0, t); out.fwd.lerp(V(0.9, 0.12, 0.35), k).normalize(); }
  // orthonormalise
  tmpU.addScaledVector(out.fwd, -tmpU.dot(out.fwd)); if (tmpU.lengthSq() < 1e-4) tmpU.set(0, 0, 1).addScaledVector(out.fwd, -out.fwd.z);
  out.up.copy(tmpU.normalize());
  return out;
}
