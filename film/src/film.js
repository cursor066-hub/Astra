// STARMENDER — the film. Seventeen shots; every frame is a pure function of time.
import * as THREE from 'three';
import { boot, FPS } from './boot.js';
import { defaultPost, defaultClouds } from './engine.js';
import { G, makeEnv, canvasTex, toonMat } from './materials.js';
import { sat, lerp, smoothstep, ease, keys, fbm1, rng } from './lib.js';
import { createSkySet } from './skyset.js';
import { createGroundSet, HOUSE } from './groundset.js';
import { createNeedle, NEEDLE } from './needle.js';
import { FatLine, Sprites, createBead } from './prims.js';
import { H, TEAR, T, PIERCES, RED_PIERCES, FINAL_PIERCE, POPS, seamState, seamZ, gapW, clothAt, piercePoint } from './tear.js';
import { houseLocal, RIDGE_Y, T_LAUNCH, groundPos, groundDir, skyPos, skyKin } from './paths.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

boot(async (engine, q) => {
  const sky = createSkySet(engine), gs = createGroundSet(engine);
  let mod;
  if (q.get('stub')) mod = await import('./character_stub.js');
  else { try { mod = await import('./character_snapshot.js'); } catch (e) { console.warn('character.js missing, using stub: ' + e.message); mod = await import('./character_stub.js'); } }
  const io = mod.createIo(); const needle = createNeedle();
  if (!io.adjust && io.joints) { // small additive head / torso offsets on top of a pose (pitch + = nod down, yaw + = toward her left)
    const qa = new THREE.Quaternion(), ea = new THREE.Euler();
    io.adjust = ({ headPitch = 0, headYaw = 0, twist = 0 }) => { const J = io.joints;
      J.head.quaternion.multiply(qa.setFromEuler(ea.set(headPitch * 0.6, headYaw * 0.6, 0, 'YXZ'))); J.neck.quaternion.multiply(qa.setFromEuler(ea.set(headPitch * 0.4, headYaw * 0.4, 0, 'YXZ')));
      if (twist) { qa.setFromEuler(ea.set(0, twist * 0.5, 0, 'YXZ')); J.chest.quaternion.multiply(qa); J.spine.quaternion.multiply(qa); }
      io.root.updateMatrixWorld(true); };
  }
  const mount = new THREE.Group(); mount.add(needle.root);
  const envSky = makeEnv(engine.renderer, {});
  const envNight = makeEnv(engine.renderer, { top: 0x1a2250, horizon: 0x0c1030, bottom: 0x05060f, sunColor: 0xffc070, sunDir: V(0.3, 0.8, 0.5), sunGain: 2.0 });
  sky.scene.environment = envSky; sky.scene.environmentIntensity = 0.4;
  gs.scene.environment = envNight; gs.scene.environmentIntensity = 0.5;
  const cam = new THREE.PerspectiveCamera(40, engine.width / engine.height, 0.1, 60000);
  const yawQ = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), HOUSE.yaw);
  const R = (x, y, z, out = V()) => out.set(x, y, z).applyQuaternion(yawQ);   // house-local direction -> world

  // ------------------------------------------------------------------------------ shared props / fx
  const streamG = new FatLine(160, { width: 0.05, minPx: 1.5 * engine.k }); streamG.setRes(engine.width, engine.height); gs.scene.add(streamG.mesh);
  const fxG = new Sprites(600, { additive: true, minPx: 1.2 * engine.k }), vapG = new Sprites(160, { additive: false, soft: 1.3 });
  const fxS = new Sprites(400, { additive: true, minPx: 1.2 * engine.k }), vapS = new Sprites(120, { additive: false, soft: 1.3 });
  const yarn = new FatLine(80, { width: 0.012, minPx: 1.3 * engine.k }); yarn.setRes(engine.width, engine.height);
  for (const s of [fxG, vapG, fxS, vapS]) s.setRes(engine.width, engine.height);
  gs.scene.add(fxG.points, vapG.points); sky.scene.add(fxS.points, vapS.points, yarn.mesh);
  const bead = createBead({ radius: 0.022, thread: 0.11, frayed: true }); gs.scene.add(bead);
  const beadLampS = createBead({ radius: 0.026, thread: 0.55 }); // not used directly; hero beads come from the sky set
  const rnd = rng(31); const seeds = Array.from({ length: 600 }, () => [rnd(), rnd(), rnd(), rnd()]);

  // hero beads for the "sky is cloth" shot and the last close-up
  for (let i = 0; i < 80; i++) { const s = seeds[i]; const b = sky.addHeroBead(-814 + s[0] * 44, -80 + (s[1] - 0.5) * 5.5 + (s[1] > 0.5 ? 0.5 : -0.5), 0.22 + s[2] * 0.75, 0.02 + s[3] * 0.012, i * 2.4); b.amp = 0.06 + s[3] * 0.08; }

  // knot (macro shot): a trefoil that pulls tight, half gold thread, half red yarn
  const knot = (() => {
    const g = new THREE.Group(); g.visible = false; sky.scene.add(g);
    const goldM = new THREE.MeshBasicMaterial({ color: new THREE.Color(6.0, 4.1, 1.7) });
    const redM = toonMat({ color: 0xc8232c, roughness: 1.0, sheen: 1, sheenColor: 0xff9a80, emissive: 0x400806, rim: 1.2 });
    let mg = null, mr = null;
    const tre = (a, s, out) => out.set(Math.sin(a) + 2 * Math.sin(2 * a), Math.cos(a) - 2 * Math.cos(2 * a) + 3, -Math.sin(3 * a)).multiplyScalar(s);
    return { g, update(s, left, right) {
      // left/right: hand positions in g's local frame (x axis = hand to hand)
      const pg = [], pr = [], N = 44;
      pg.push(left.clone()); pg.push(left.clone().lerp(V(-s * 2.2, 0, 0), 0.6));
      for (let i = 0; i <= N; i++) { const a = Math.PI + i / N * Math.PI * 2; const p = tre(a, s, V()); (i <= N / 2 ? pg : pr).push(p); if (i === N / 2) pr.push(p.clone()); }
      pr.push(right.clone().lerp(V(s * 2.2, 0, 0), 0.6)); pr.push(right.clone());
      if (mg) { g.remove(mg, mr); mg.geometry.dispose(); mr.geometry.dispose(); }
      mg = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pg), 90, 0.0026, 6), goldM);
      mr = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pr), 90, 0.0052, 8), redM); mr.castShadow = true;
      g.add(mg, mr);
    } };
  })();

  // title card
  const title = (() => {
    const tex = canvasTex(2048, 256, (c, W, Hh) => { c.clearRect(0, 0, W, Hh); c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '300 92px "Noto Serif", "FreeSerif", "DejaVu Serif", serif'; const s = 'STARMENDER'; const sp = 58; let x = W / 2 - (s.length - 1) * sp / 2 * 1.0;
      for (const ch of s) { c.fillText(ch, x, Hh / 2); x += sp; } }, { srgb: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.125), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x000000 }));
    m.renderOrder = 999; m.frustumCulled = false; cam.add(m); m.visible = false; return m;
  })();
  gs.scene.add(cam);

  // ------------------------------------------------------------------------------ helpers
  const mB = new THREE.Matrix4(), vx = V(), vy = V(), vz = V();
  function placeMount(pos, fwd, up) { vz.copy(fwd).normalize(); vx.crossVectors(up, vz).normalize(); vy.crossVectors(vz, vx); mB.makeBasis(vx, vy, vz); mount.quaternion.setFromRotationMatrix(mB); mount.position.copy(pos); }
  function ride(scene) { if (mount.parent !== scene) scene.add(mount); if (io.root.parent !== mount) mount.add(io.root); io.root.position.set(0, 0, 0); io.root.quaternion.identity(); needle.root.position.set(0, 0, 0); needle.root.quaternion.identity(); mount.visible = true; }
  function onRoof(lx = -0.6) { if (io.root.parent !== gs.scene) gs.scene.add(io.root); if (mount.parent !== gs.scene) gs.scene.add(mount); io.root.position.copy(gs.ridgePoint(lx)); io.root.quaternion.copy(yawQ);
    mount.position.copy(gs.ridgePoint(2.6)).add(V(0, 0.07, 0)); mount.quaternion.copy(yawQ).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.0, Math.PI / 2, 0.05))); }
  const FACE0 = { blink: 0, lookX: 0, lookY: 0, brow: 0, browRaise: 0, smile: 0, mouthOpen: 0, eyeWide: 0, pupil: 1, blush: 0.6, reflect: 0, reflectColor: [1.0, 0.8, 0.45] };
  const face = (o) => io.setFace({ ...FACE0, ...o });
  const blinks = (t, times) => { let b = 0; for (const bt of times) b = Math.max(b, 1 - Math.abs(t - bt) / 0.09); return sat(b * 1.4); };
  const pose = (a, b, k, adj) => { const p = (b && k > 0) ? io.blendPose(io.POSES[a], io.POSES[b], sat(k)) : io.POSES[a]; io.setPose(p); if (adj && io.adjust) io.adjust(adj); };
  const wp = (o, out = V()) => o.getWorldPosition(out);
  const _fp = V(); const faceP = (out = V()) => { io.anchors.eyeL.getWorldPosition(out); io.anchors.eyeR.getWorldPosition(_fp); return out.lerp(_fp, 0.5); };
  function camLook(pos, look, fov, roll = 0, near = 0.3, far = 60000) { cam.position.copy(pos); cam.up.set(0, 1, 0); cam.lookAt(look); if (roll) cam.rotateZ(roll); cam.fov = fov; cam.near = near; cam.far = far; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true); }
  const sh = (t, amp, freq, seed) => V(fbm1(t * freq, seed + 1.3), fbm1(t * freq, seed + 7.9), fbm1(t * freq, seed + 21.7)).multiplyScalar(amp);
  const wind = V(), tA = V(), tB = V(), tC = V(), tD = V(), K = skyKin(30), K2 = skyKin(30);
  const eyeW = (out = V()) => needle.eye.getWorldPosition(out);
  function gapLight(p, st, out = V()) { const xg = Math.min(300, Math.max(p.x + 30, st.front + 60)); return out.set(xg, H + 4, seamZ(xg)).sub(p).normalize(); }
  function skyRig({ keyDir, keyI = 3.2, keyCol = 0xffd08a, hemiI = 1.6, hemiSky = 0x2a3470, hemiGnd = 0x10142e, rim = 1, rimCol = [1.0, 0.8, 0.5], rimDir, env = 0.4, target }) {
    sky.aimKey(target, keyDir, keyI, keyCol); sky.hemi.intensity = hemiI; sky.hemi.color.set(hemiSky); sky.hemi.groundColor.set(hemiGnd);
    G.rimStrength.value = rim; G.rimColor.value.setRGB(...rimCol); G.rimDir.value.copy(rimDir || keyDir).normalize(); sky.scene.environmentIntensity = env;
  }
  function groundRig({ keyI = 0.35, hemiI = 1.0, rim = 0.6, rimCol = [0.55, 0.65, 1.0], rimDir = V(0, 1, -0.4), lamp = 0, lampPos, env = 0.5, focus }) {
    gs.key.intensity = keyI; gs.hemi.intensity = hemiI; G.rimStrength.value = rim; G.rimColor.value.setRGB(...rimCol); G.rimDir.value.copy(rimDir).normalize();
    gs.lamp.intensity = lamp; if (lampPos) gs.lamp.position.copy(lampPos); gs.scene.environmentIntensity = env; return focus;
  }
  function nightGrade(p) { p.exposure = 1.15; p.contrast = 1.08; p.saturation = 1.1; p.shadowTint = [0.0, 0.006, 0.03]; p.highTint = [1.05, 1.0, 0.93]; p.bloom = 0.6; }
  function skyGrade(p) { p.exposure = 1.0; p.contrast = 1.07; p.saturation = 1.1; p.shadowTint = [0.002, 0.006, 0.03]; p.highTint = [1.05, 1.0, 0.92]; p.bloom = 0.5; p.fog.density = 0.000022; p.fog.color = [0.012, 0.018, 0.05]; p.fog.sunColor = [0.3, 0.16, 0.08]; }
  function cloudsFor(p, o = {}) { p.clouds = Object.assign(defaultClouds(), { y0: 1150, y1: 1480, cover: 0.46, bandGain: 2.2, bandBase: 0.2, band: [0, 240, -620, 330], lightCol: [1.5, 1.0, 0.5] }, o); return p.clouds; }
  const idle = (t) => { needle.setThread(1); needle.setSpin(0); needle.setThreadColor(new THREE.Color(1.0, 0.72, 0.3), 3.0); knot.g.visible = false; title.visible = false; bead.visible = false; };
  function vapor(sys, t, t0, origin, dir, n = 14, life = 1.6, seedOff = 0, size = 0.11) {
    for (let i = 0; i < n; i++) { const s = seeds[i + seedOff]; const age = t - t0 - s[0] * 0.35; if (age < 0 || age > life) continue; const k = age / life;
      sys.push(origin.x + dir.x * age * (0.25 + s[1] * 0.2) + (s[2] - 0.5) * 0.08 * k, origin.y + dir.y * age * 0.3 + 0.06 * k + (s[3] - 0.5) * 0.05 * k, origin.z + dir.z * age * (0.25 + s[1] * 0.2) + (s[1] - 0.5) * 0.08 * k,
        size * (0.4 + 1.2 * k), 0.62, 0.7, 0.9, 0.13 * Math.sin(Math.PI * Math.sqrt(k))); }
  }

  // ------------------------------------------------------------------------------ the shots
  const S = [];
  const shot = (id, t0, t1, def) => S.push({ id, t0, t1, ...def });

  // ---- S01: a star in the palm ------------------------------------------------------------------------------
  const beadPos = V(), cupW = V();
  function beadAt(t, out) {
    wp(io.anchors.cup, cupW); const rest = tA.copy(cupW).add(V(0, 0.022, 0));
    if (t < 0.9) return out.copy(rest).add(R(-1.6, 9, 17)).addScaledVector(R(-0.09, 0.5, 0.86), (0.9 - t) * 40);
    if (t < 1.6) { const k = (t - 0.9) / 0.7; const s = 1 - Math.pow(1 - k, 2.3); return out.copy(rest).add(R(-1.6, 9, 17).multiplyScalar(1 - s)); }
    const a = t - 1.6; return out.copy(rest).add(V(0, 0.03 * Math.abs(Math.sin(a * 10)) * Math.exp(-a * 5.5), 0));
  }
  shot('S01', 0, 4, {
    scene: gs.scene,
    hero(t) {
      idle(t); onRoof(); pose('sitCup');
      const land = smoothstep(1.55, 1.75, t);
      face({ lookY: -0.65, blink: Math.max(blinks(t, [0.5, 2.9]), 0.25 * (1 - land)), eyeWide: 0.45 * land * (1 - smoothstep(2.6, 3.8, t) * 0.5), browRaise: 0.5 * land, mouthOpen: 0.18 * land });
      io.update(t, { wind: wind.copy(R(0.5, 0, -1)).multiplyScalar(2.2), gust: 0.2, scarfLen: 1, scarfWrap: 1 });
      bead.visible = true; beadAt(t, beadPos); bead.position.copy(beadPos); bead.rotation.set(0.5 + t * (t < 1.6 ? 9 : 0), 0.4, 0.9 * Math.exp(-Math.max(0, t - 1.6) * 3) + 0.25);
    },
    cam(t) {
      wp(io.anchors.cup, cupW); const k = ease.inOutSine(sat((t - 1.7) / 2.3));
      const pos = tA.copy(cupW).add(R(lerp(0.66, 0.50, k), lerp(0.13, 0.08, k), lerp(0.20, 0.12, k))).add(sh(t, 0.004, 0.5, 1));
      camLook(pos, tB.copy(cupW).add(V(0, 0.06, 0)).add(sh(t, 0.003, 0.7, 5)), 30, 0, 0.05, 30000);
    },
    fx(t, C) {
      const p = C.post; nightGrade(p); p.exposure = 1.25;
      const a = t - 1.6; const flash = a > 0 ? 5 * Math.exp(-a * 6) : 0; const pulse = a > 0 ? 2.3 + 0.5 * Math.sin(a * 6.9) * Math.exp(-a * 0.5) + flash : 0.6 * smoothstep(1.2, 1.6, t);
      groundRig({ keyI: 0.25, lamp: pulse * 0.05, lampPos: tA.copy(beadPos).add(V(0, 0.035, 0)), rim: 0.5 });
      gs.update(t, cam, { tearT: 5, fallGain: 0.25, starGain: 1 });
      p.focus = cam.position.distanceTo(cupW); p.aperture = 30; p.maxCoc = 34; p.fade = smoothstep(0.0, 0.9, t); p.mblur = 0.5;
      // the star's streak, landing sparkle, her breath
      streamG.begin();
      if (t > 0.7 && t < 1.75) for (let i = 0; i <= 18; i++) { const tt = t - (1 - i / 18) * 0.16; beadAt(tt, tA); const al = (i / 18) * (1 - smoothstep(1.6, 1.75, t)); streamG.push(tA.x, tA.y, tA.z, 5 * al, 3.6 * al, 1.8 * al, i === 0 ? 0 : 1); }
      streamG.end();
      fxG.begin(); fxG.push(beadPos.x, beadPos.y, beadPos.z, 0.10 + 0.05 * flash, 2.2, 1.6, 0.8, 0.5);
      if (a > 0 && a < 0.9) for (let i = 0; i < 22; i++) { const s = seeds[i]; const k = a / (0.4 + s[3] * 0.5); if (k > 1) continue; const an = s[0] * 6.283;
        fxG.push(beadPos.x + Math.cos(an) * 0.12 * (1 - Math.exp(-a * 6)) * (0.4 + s[1]), beadPos.y + 0.1 * (1 - Math.exp(-a * 5)) * s[2] - 0.1 * a * a, beadPos.z + Math.sin(an) * 0.12 * (1 - Math.exp(-a * 6)) * (0.4 + s[1]), 0.006 + 0.006 * s[3], 6, 4.4, 2.2, 1 - k); }
      fxG.end();
      vapG.begin(); const m = faceP(tA).add(R(0, -0.05, 0.12)); vapor(vapG, t, 0.25, m, R(0, -0.4, 1), 12, 1.5, 100, 0.07); vapor(vapG, t, 2.5, m, R(0, -0.3, 1), 10, 1.4, 130, 0.06); vapG.end();
    },
  });

  // ---- S02: her eyes ----------------------------------------------------------------------------------------
  shot('S02', 4, 7.5, {
    scene: gs.scene,
    hero(t) {
      idle(t); onRoof();
      const up = ease.inOutCubic(sat((t - 5.25) / 0.7));
      pose('sitCup', null, 0, { headPitch: -0.85 * up, headYaw: 0.12 * up });
      face({ lookY: lerp(-0.7, 0.75, ease.inOutCubic(sat((t - 5.2) / 0.3))), lookX: 0.1 * up, blink: blinks(t, [4.55, 5.15]), eyeWide: 0.75 * smoothstep(5.3, 5.8, t), browRaise: 0.8 * smoothstep(5.3, 5.8, t),
        mouthOpen: 0.3 * smoothstep(5.4, 6.0, t), pupil: lerp(1.0, 0.74, smoothstep(5.6, 7.0, t)), reflect: smoothstep(5.9, 6.9, t) });
      io.update(t, { wind: wind.copy(R(0.5, 0, -1)).multiplyScalar(2.5 + 2 * up), gust: 0.25, scarfLen: 1, scarfWrap: 1 });
      bead.visible = true; beadAt(t, beadPos); bead.position.copy(beadPos); bead.rotation.set(0.5, 0.4, 0.25);
    },
    cam(t) {
      const eye = wp(io.anchors.eyeL, tA), head = faceP(tB);
      const k = ease.inOutCubic(sat((t - 5.7) / 1.55)); const d0 = R(0.30, -0.07, 0.72), d1 = R(0.085, -0.035, 0.21);
      const tgt = tC.copy(head).add(V(0, 0.0, 0)).lerp(eye, sat(0.35 + k)); const off = tD.copy(d0).lerp(d1, k);
      camLook(tC.clone().add(off).add(sh(t, 0.003 * (1 - k * 0.7), 0.5, 3)), tgt, lerp(25, 13.5, k), 0, 0.03, 30000);
    },
    fx(t, C) {
      const p = C.post; nightGrade(p); p.exposure = 1.1;
      const gold = smoothstep(5.4, 7.0, t);
      groundRig({ keyI: 0.25 + 0.75 * gold, lamp: 0.34 + 0.04 * Math.sin(t * 6.9), lampPos: tA.copy(beadPos).add(V(0, 0.035, 0)), rim: 0.6 + 0.6 * gold, rimCol: [lerp(0.55, 1.0, gold), lerp(0.65, 0.8, gold), lerp(1.0, 0.5, gold)], rimDir: R(0.2, 1, 0.5) });
      gs.update(t, cam, { tearT: 5, fallGain: 0.6 });
      p.focus = cam.position.distanceTo(wp(io.anchors.eyeL, tA)); p.aperture = 24; p.maxCoc = 30; p.mblur = 0.4;
      streamG.begin(); streamG.end(); fxG.begin(); fxG.push(beadPos.x, beadPos.y, beadPos.z, 0.10, 2.2, 1.6, 0.8, 0.5); fxG.end();
      vapG.begin(); const m = faceP(tA).add(R(0, -0.05, 0.12)); vapor(vapG, t, 5.9, m, R(0, 0.3, 1), 12, 1.5, 160, 0.06); vapG.end();
    },
  });

  // ---- S03: the tear ----------------------------------------------------------------------------------------
  shot('S03', 7.5, 11.5, {
    scene: gs.scene,
    hero(t) {
      idle(t); onRoof(); pose('lookUp');
      face({ lookY: 0.7, eyeWide: 0.5, browRaise: 0.6, mouthOpen: 0.2 });
      const g = 7 + 7 * smoothstep(7.5, 10.5, t) + 3 * fbm1(t * 0.8, 3);
      io.update(t, { wind: wind.copy(R(0.35, 0.05, -1)).multiplyScalar(g), gust: 0.6, scarfLen: 1, scarfWrap: 1 });
      bead.visible = false;
    },
    cam(t) {
      const k = ease.inOutSine(sat((t - 7.5) / 4.0));
      const pos = houseLocal(lerp(2.0, 1.4, k), RIDGE_Y - lerp(1.15, 0.75, k), lerp(-3.9, -3.3, k), tA).add(sh(t, 0.02, 0.4, 9));
      const toTear = tB.copy(gs.tearCenter).add(V(-60, 0, 0)).sub(pos).normalize(); const toHer = faceP(tC).sub(pos).normalize();
      const dir = toHer.lerp(toTear, lerp(0.42, 0.5, k)).normalize();
      camLook(pos, tD.copy(pos).addScaledVector(dir, 100), lerp(58, 54, k), -0.2, 0.3, 60000);
    },
    fx(t, C) {
      const p = C.post; nightGrade(p); p.exposure = 1.1;
      groundRig({ keyI: 1.1, rim: 1.3, rimCol: [1.0, 0.8, 0.5], rimDir: tA.copy(gs.tearCenter).sub(io.root.position).normalize() });
      gs.update(t, cam, { tearT: 9, fallGain: 1, glow: 1.0, wide: 2.0, starGain: 0.75 });
      cloudsFor(p, { cover: 0.36, steps: 48 }); p.clouds.wind.set(0.3 + t * 0.006, 0, 0.1);
      p.fog.density = 0.00012; p.fog.falloff = 0.0012; p.fog.base = 800; p.fog.color = [0.02, 0.03, 0.075];
      p.rays.strength = 0.2; p.rays.pos.copy(gs.tearCenter).add(V(-80, 0, 0)); p.rays.len = 0.8; p.bloom = 0.32; p.streak = 0.04;
      p.focus = 12; p.aperture = 0; p.mblur = 0.6;
      streamG.begin(); streamG.end(); fxG.begin(); fxG.end(); vapG.begin(); vapG.end();
    },
  });

  // ---- S04: launch ------------------------------------------------------------------------------------------
  const gp = V(), gd = V();
  function groundHero(t) {
    groundPos(t, gp); groundDir(t, gd);
    const tr = t < T_LAUNCH ? 0.012 * smoothstep(11.5, 12.2, t) : 0; gp.add(V(fbm1(t * 30, 1) * tr, fbm1(t * 30, 2) * tr, 0));
    ride(gs.scene); placeMount(gp, gd, V(0, 1, 0));
  }
  function streamer(line, fn, t, n = 60, span = 1.2, gain = 5) {
    line.begin(); for (let i = 0; i <= n; i++) { const k = i / n; const p = fn(t - (1 - k) * span, tA); if (i === n) eyeW(p); line.push(p.x, p.y, p.z, 1.0 * gain, 0.7 * gain, 0.28 * gain, k * k); } line.end();
  }
  shot('S04', 11.5, 14.5, {
    scene: gs.scene,
    hero(t) {
      idle(t); groundHero(t);
      const k = ease.inOutCubic(sat((t - T_LAUNCH + 0.05) / 0.5)); pose('crouch', 'surf', k);
      face({ brow: 0.8, lookY: 0.3, mouthOpen: 0.1 * k });
      const sp = t < T_LAUNCH ? 3 : Math.min(105, 130 * (t - T_LAUNCH));
      io.update(t, { wind: wind.copy(gd).multiplyScalar(-sp).add(R(0.3, 0, -1).multiplyScalar(6)), gust: 0.5, scarfLen: 1, scarfWrap: 1 });
      needle.setThreadColor(new THREE.Color(1.0, 0.72, 0.3), 3.0 + 4 * smoothstep(11.5, 12.2, t));
    },
    cam(t) {
      groundPos(t - 0.05, tA); const a = Math.max(0, t - T_LAUNCH), k = ease.outCubic(sat(a / 2.0));
      const pos = houseLocal(lerp(3.3, 4.2, k), RIDGE_Y + lerp(0.5, 0.9, k), lerp(1.9, 0.6, k), tB).add(sh(t, 0.015 + 0.06 * Math.exp(-a * 3) * (a > 0 ? 1 : 0), 6, 4));
      const look = tC.copy(tA).add(V(0, t < T_LAUNCH ? 0.75 : 0.5, 0));
      camLook(pos, look, lerp(36, 24, smoothstep(0.3, 2.3, a)), 0.04, 0.2, 60000);
    },
    fx(t, C) {
      const p = C.post; nightGrade(p); p.exposure = 1.12;
      groundRig({ keyI: 1.2, rim: 1.4, rimCol: [1.0, 0.8, 0.5], rimDir: tA.copy(gs.tearCenter).sub(gp).normalize(), lamp: 0.7 + 1.2 * smoothstep(11.5, 12.2, t), lampPos: eyeW(tB).add(V(0, 0.3, 0)), focus: gp });
      gs.update(t, cam, { tearT: 9, fallGain: 1, glow: 1.2, focus: gp, wide: 2.0, starGain: 0.75 });
      cloudsFor(p, { cover: 0.36, steps: 44 }); p.clouds.wind.set(0.3 + t * 0.006, 0, 0.1);
      p.fog.density = 0.00012; p.fog.falloff = 0.0012; p.fog.base = 800; p.fog.color = [0.02, 0.03, 0.075];
      p.focus = cam.position.distanceTo(gp); p.aperture = t < T_LAUNCH ? 9 : 4; p.mblur = 1; p.rays.strength = 0.35; p.rays.pos.copy(gs.tearCenter);
      if (t > T_LAUNCH) streamer(streamG, (tt, o) => groundPos(Math.max(tt, T_LAUNCH), o), t, 50, 0.9); else { streamG.begin(); streamG.end(); }
      // snow: a nervous swirl while the needle charges, then a blast ring
      fxG.begin(); vapG.begin(); const base = houseLocal(0, RIDGE_Y + 0.1, 0.1, tB); const a = t - T_LAUNCH;
      for (let i = 0; i < 150; i++) { const s = seeds[i]; const an = s[0] * 6.283 + t * (2 + s[1] * 3);
        if (a < 0) { const rr = 0.3 + s[2] * 0.9; const al = smoothstep(11.5, 12.0, t) * 0.5; vapG.push(base.x + Math.cos(an) * rr, base.y + 0.1 + s[3] * 0.5, base.z + Math.sin(an) * rr, 0.05 + s[1] * 0.07, 0.75, 0.8, 1.0, al * 0.35); }
        else if (a < 1.6) { const rr = (1 - Math.exp(-a * 4)) * (2 + s[2] * 7); const k = a / (0.7 + s[3] * 0.9); if (k > 1) continue;
          vapG.push(base.x + Math.cos(an) * rr, base.y + 0.2 + s[3] * 1.6 * (1 - Math.exp(-a * 3)) - a * a * 0.5, base.z + Math.sin(an) * rr, 0.12 + 0.5 * k * s[1], 0.75, 0.8, 1.0, 0.3 * (1 - k)); }
      }
      fxG.end(); vapG.end();
    },
  });

  // ---- S05: through the clouds ------------------------------------------------------------------------------
  shot('S05', 14.5, 18.0, {
    scene: gs.scene,
    hero(t) {
      idle(t); groundHero(t); pose('surf');
      face({ brow: 0.7, lookY: 0.2, blink: blinks(t, [15.75]) });
      io.update(t, { wind: wind.copy(gd).multiplyScalar(-48), gust: 0.6, scarfLen: 1, scarfWrap: 1 });
    },
    cam(t) {
      groundPos(t, tA); const out = 15.6;
      if (t < out) { const k = (t - 14.5) / 1.1; camLook(tB.copy(tA).add(V(lerp(5.5, 4.0, k), lerp(2.6, 1.4, k), lerp(3.6, 5.2, k))).add(sh(t, 0.08, 5, 2)), tC.copy(tA).add(V(0, 0.8, 0)), 40, 0.1, 0.3, 60000); }
      else { const a = t - out; groundDir(t, tC); const sep = 13 * a * a;
        tB.copy(tA).addScaledVector(tC, -sep).add(V(4.0 + 1.5 * a, 1.4 - 0.5 * a, 5.2 + 1.2 * a));
        camLook(tB.add(sh(t, 0.05, 3, 2)), tC.copy(tA).add(V(0, 0.8, 0)), lerp(40, 24, smoothstep(0, 2.4, a)), 0.1 * (1 - smoothstep(0, 1.5, a)), 0.3, 60000); }
    },
    fx(t, C) {
      const p = C.post; nightGrade(p); p.exposure = lerp(0.95, 1.1, smoothstep(15.5, 16.2, t));
      groundRig({ keyI: 2.6, rim: 1.5, rimCol: [1.0, 0.8, 0.5], rimDir: tA.copy(gs.tearCenter).sub(gp).normalize(), env: 0.6, hemiI: 1.3 });
      gs.update(t, cam, { tearT: 9, fallGain: 1, glow: 1.3, focus: gp, wide: 2.0, starGain: 0.75 });
      cloudsFor(p, { y0: 1040, y1: 1335, cover: 0.74, dens: 3.0, steps: 64, minStep: 5, sigma: 0.02, bandBase: 0.55, bandGain: 1.6, hazeK: 0.00003 }); p.clouds.wind.set(0.3, 0, 0.1);
      p.fog.density = 0.00006; p.fog.color = [0.02, 0.03, 0.075];
      p.focus = cam.position.distanceTo(gp); p.aperture = 3; p.mblur = 1; p.rays.strength = 0.3 * smoothstep(15.6, 16.4, t); p.rays.pos.copy(gs.tearCenter);
      streamer(streamG, groundPos, t, 50, 0.6);
      fxG.begin(); fxG.end(); vapG.begin(); vapG.end();
    },
  });

  // ---- sky hero staging -------------------------------------------------------------------------------------
  function skyHero(t, { windScale = 1, scarfLen = 1, scarfWrap = 1, gust = 0.5, roll = 0 } = {}) {
    skyKin(t, K); ride(sky.scene);
    if (roll) { tA.copy(K.up).applyAxisAngle(K.fwd, roll); K.up.copy(tA); }
    placeMount(K.pos, K.fwd, K.up);
    io.update(t, { wind: wind.copy(K.fwd).multiplyScalar(-Math.max(4, K.speed * windScale)), gust, scarfLen, scarfWrap });
    mount.updateMatrixWorld(true);
    return K;
  }
  const lookPt = V();

  // ---- S06: the sky is cloth --------------------------------------------------------------------------------
  shot('S06', 18.0, 20.5, {
    scene: sky.scene,
    hero(t) {
      idle(t); const k = ease.inOutCubic(sat((t - 18.0) / 0.9)); pose('surf', 'reach', k);
      face({ lookY: 0.75 * k, lookX: -0.1, eyeWide: 0.45 * k, browRaise: 0.6 * k, mouthOpen: 0.2 * k, smile: 0.25 * k, blink: blinks(t, [19.3]) });
      skyHero(t, { windScale: 0.9, gust: 0.25 });
      // beads swing as her hand brushes past
      const hx = wp(io.anchors.palmR, tA).x;
      for (const b of sky.heroBeads) { if (b.kickT < 0 || b.kickT > 30) { /* fixed per bead: when the hand passes */ } const tk = 18 + (b.x + 812 - 0.15) / 14; b.kick = 0.55 * Math.exp(-Math.abs(b.z + 80.6) * 1.1); b.kickT = tk; }
    },
    cam(t) {
      skyKin(t, K2); const k = (t - 18) / 2.5;
      const pos = tA.copy(K2.pos).add(V(lerp(3.3, 2.3, k), lerp(0.25, 0.75, k), lerp(-2.4, -3.0, k))).add(sh(t, 0.01, 0.6, 7));
      camLook(pos, tB.copy(K2.pos).add(V(0.25, 1.38, 0)), 34, -0.05, 0.1, 60000);
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); p.exposure = 1.25; p.bloom = 0.55;
      const hand = wp(io.anchors.palmR, tA);
      skyRig({ target: K.pos, keyDir: gapLight(K.pos, K.st, tB).add(V(0, 0.25, 0)).normalize(), keyI: 1.5, hemiI: 1.5, rim: 1.4, rimDir: tC.set(1, 0.3, 0.6) });
      sky.lamp.position.copy(K.pos).add(V(0.2, 1.2, -0.4)); sky.lamp.intensity = 1.2; sky.lamp.distance = 6;
      sky.update(t, cam, { hero: K.pos, trail: (tt, o) => (tt > t - 1e-3 ? eyeW(o) : skyPos(tt, K.st, o).add(V(-1.4, -0.03, 0))), lamp: tB.copy(K.pos).add(V(0.3, 1.0, -0.5)), lampGain: 1.6, amb: 1.5, starGain: 1.1 });
      p.focus = cam.position.distanceTo(hand); p.aperture = 13; p.maxCoc = 26; p.mblur = 0.5;
      fxS.begin(); const tk = t - 18.6; if (tk > 0) for (let i = 0; i < 20; i++) { const s = seeds[i + 40]; const age = (tk * 1.2 + s[0]) % 1; fxS.push(hand.x - age * 0.5 - s[1] * 0.1, hand.y + 0.06 - age * age * 0.5, hand.z + (s[2] - 0.5) * 0.14, 0.008, 3, 2.2, 1.2, (1 - age) * 0.7); } fxS.end();
      vapS.begin(); vapS.end(); yarn.begin(); yarn.end();
    },
  });

  // ---- S07: canyon of light ---------------------------------------------------------------------------------
  shot('S07', 20.5, 23.0, {
    scene: sky.scene,
    hero(t) { idle(t); pose('surf'); face({ brow: 0.6 }); skyHero(t, { gust: 0.5 }); },
    cam(t) {
      const k = ease.inOutSine((t - 20.5) / 2.5); skyKin(t, K2);
      const pos = tA.set(lerp(-905, -868, k), H - lerp(58, 50, k), lerp(-178, -160, k)).add(sh(t, 0.25, 0.3, 11));
      camLook(pos, tB.set(-330, H - 12, 4).lerp(K2.pos, 0.12), 42, 0.03, 1, 80000);
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); p.exposure = 1.05; p.bloom = 0.45; p.streak = 0.05;
      skyRig({ target: K.pos, keyDir: gapLight(K.pos, K.st, tB), keyI: 3.0, rim: 1.6 });
      sky.lamp.intensity = 0;
      sky.update(t, cam, { hero: K.pos, trail: (tt, o) => (tt > t - 1e-3 ? eyeW(o) : skyPos(Math.max(tt, 20.5), K.st, o)), curtainGain: 1.1 });
      cloudsFor(p, { steps: 64, cover: 0.5, minStep: 8, hazeK: 0.00009 }); p.clouds.wind.set(0.3 + t * 0.004, 0, 0.1);
      p.focus = 200; p.aperture = 0; p.mblur = 0.8;
      fxS.begin(); fxS.end(); vapS.begin(); vapS.end(); yarn.begin(); yarn.end();
    },
  });

  // ---- S08: first stitch ------------------------------------------------------------------------------------
  const P0 = V();
  shot('S08', 23.0, 26.0, {
    scene: sky.scene,
    hero(t) { idle(t); pose('surf'); face({ brow: 1, mouthOpen: 0.3, blink: t > 24.3 ? 0.45 : 0 }); skyHero(t, { windScale: t > 24.3 ? 2.2 : 1, gust: 0.7 }); },
    cam(t) {
      skyKin(t, K2); piercePoint(PIERCES[0], K2.st, P0);
      if (t < 24.3 + 1 / 48) { const k = (t - 23) / 1.3; // chase from behind / below, rushing at the lip
        const pos = tA.copy(K2.pos).addScaledVector(K2.fwd, -lerp(7.5, 4.6, k)).add(V(0, lerp(-1.6, -2.4, k), lerp(-3.0, -1.5, k))).add(sh(t, 0.06 + 0.1 * k, 7, 13));
        camLook(pos, tB.copy(K2.pos).addScaledVector(K2.fwd, 3).add(V(0, 0.8, 0)), lerp(46, 58, k), 0.12 * k, 0.2, 60000);
      } else { const k = (t - 24.3) / 1.7; // above the cloth: she breaches into the light
        const sun = sky.U.uSun.value; const pos = tA.copy(P0).add(V(-sun.x * lerp(9, 11, k) + 2.5 * k, lerp(1.0, 1.8, k), -sun.z * lerp(9, 11, k))).add(sh(t, 0.03, 0.8, 17));
        camLook(pos, tB.copy(K2.pos).lerp(P0, 0.18).add(V(0.5, 0.8, 0)), lerp(46, 40, k), -0.05, 0.2, 60000);
      }
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); const above = t >= 24.3 + 1 / 48;
      const hit = Math.exp(-Math.abs(t - 24.3) * 14);
      if (!above) { p.exposure = 1.05; skyRig({ target: K.pos, keyDir: gapLight(K.pos, K.st, tB), keyI: 3.6, rim: 1.8 }); p.flash = 0.9 * hit; }
      else { p.exposure = 0.42; p.bloom = 0.18; p.bloomThreshold = 1.6; p.streak = 0.05; p.saturation = 1.05; p.shadowTint = [0.01, 0.004, 0.0]; p.fog.density = 0.00004; p.fog.color = [1.0, 0.7, 0.36]; p.fog.sunColor = [1.6, 1.25, 0.8]; p.fog.sunDir.copy(sky.U.uSun.value); p.fog.sunPow = 4;
        skyRig({ target: K.pos, keyDir: tB.copy(sky.U.uSun.value).add(V(0, 0.25, 0)).normalize(), keyI: 5.0, keyCol: 0xffd9a0, hemiI: 1.6, hemiSky: 0xffe0a0, hemiGnd: 0xb07a3a, rim: 2.2, rimCol: [1.0, 0.9, 0.7], rimDir: tC.set(0, 1, -0.3), env: 1.0 }); p.flash = 0.6 * hit; }
      sky.lamp.intensity = 0;
      sky.update(t, cam, { hero: K.pos, eye: eyeW(tA), trail: (tt, o) => (tt > t - 1e-3 ? eyeW(o) : skyPos(tt, K.st, o)), lintGain: above ? 2.5 : 1.2, curtainGain: above ? 0 : 1 });
      p.focus = cam.position.distanceTo(K.pos); p.aperture = above ? 5 : 3; p.mblur = above ? 0.6 : 1.0; p.maxBlur = 60;
      fxS.begin(); fxS.end(); vapS.begin(); vapS.end(); yarn.begin(); yarn.end();
    },
  });

  // ---- S09: whipstitch --------------------------------------------------------------------------------------
  shot('S09', 26.0, 31.0, {
    scene: sky.scene,
    hero(t) { idle(t); pose('surf'); face({ brow: 1, mouthOpen: 0.15 }); needle.setThread(lerp(1, 0.55, (t - 26) / 5)); needle.setSpin(t * 30); skyHero(t, { windScale: 0.6, gust: 0.8 }); },
    cam(t) {
      skyKin(t, K2); const x = K2.pos.x;
      if (t < 28.5) { // inside the slit, looking down the seam: half night, half light
        const cx = x - lerp(46, 36, (t - 26) / 2.5); const st = K2.st; const cz = seamZ(cx);
        const pos = tA.set(cx, clothAt(cx, cz, st) - 1.2 + 0.8 * Math.sin(t * 1.3), cz + 0.6 * Math.sin(t * 0.9)).add(sh(t, 0.12, 4, 21));
        const ax = tB.set(x + 12, clothAt(x + 12, seamZ(x + 12), st) - 0.5, seamZ(x + 12)).lerp(K2.pos, 0.35);
        camLook(pos, ax, 60, 0.12 * Math.sin((t - 26) * 1.6), 0.3, 60000);
      } else { // riding with her: the world barrel-rolls
        const k = (t - 28.5) / 2.5; skyKin(t - 0.018, K);
        const up = tC.copy(K.up).lerp(V(0, 1, 0), 0.35).normalize();
        const pos = tA.copy(K.pos).addScaledVector(K.fwd, -lerp(4.2, 3.4, k)).addScaledVector(up, 1.9).add(sh(t, 0.05, 6, 23));
        cam.position.copy(pos); cam.up.copy(up); cam.lookAt(tB.copy(K2.pos).addScaledVector(K2.fwd, 6).addScaledVector(K2.up, 0.9));
        cam.fov = 56; cam.near = 0.2; cam.far = 60000; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      }
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); const st = K.st; const above = K.pos.y > clothAt(K.pos.x, K.pos.z, st);
      const camAbove = cam.position.y > clothAt(cam.position.x, cam.position.z, st) + 0.2 && Math.abs(cam.position.z - seamZ(cam.position.x)) > gapW(cam.position.x, st);
      let hit = 0; for (const pc of PIERCES) hit = Math.max(hit, Math.exp(-Math.abs(t - pc.t) * 16));
      const hy = sat((K.pos.y - clothAt(K.pos.x, K.pos.z, st)) / 3 * 0.5 + 0.5);    // 0 below .. 1 above
      p.exposure = t < 28.5 ? 0.6 : lerp(0.95, 0.42, hy); p.bloom = t < 28.5 ? 0.3 : lerp(0.45, 0.18, hy); p.bloomThreshold = lerp(1.0, 1.6, hy); p.flash = 0.3 * hit; p.ca = 0.002;
      skyRig({ target: K.pos, keyDir: above ? tB.set(0.2, 1, 0.2).normalize() : gapLight(K.pos, st, tB), keyI: lerp(3.4, 5.5, hy), keyCol: 0xffd9a0, hemiI: lerp(1.6, 2.2, hy), hemiSky: above ? 0xffe0a0 : 0x2a3470, hemiGnd: above ? 0xb07a3a : 0x10142e, rim: 1.8, env: lerp(0.4, 0.9, hy) });
      if (hy > 0.5) { p.fog.density = 0.00004 * (t < 28.5 ? 0 : 1); p.fog.color = [1.0, 0.7, 0.36]; p.fog.sunColor = [1.6, 1.25, 0.8]; p.fog.sunDir.copy(sky.U.uSun.value); p.fog.sunPow = 4; }
      sky.lamp.intensity = 0;
      sky.update(t, cam, { hero: K.pos, eye: eyeW(tA), lintGain: 1.6, curtainGain: 0.55 });
      p.focus = cam.position.distanceTo(K.pos); p.aperture = t < 28.5 ? 0 : 3; p.mblur = 1.0; p.maxBlur = 64;
      fxS.begin(); fxS.end(); vapS.begin(); vapS.end(); yarn.begin(); yarn.end();
    },
  });

  // ---- S10: half mended -------------------------------------------------------------------------------------
  shot('S10', 31.0, 34.0, {
    scene: sky.scene,
    hero(t) { idle(t); pose('surf'); face({ brow: 1 }); needle.setThread(lerp(0.55, 0.12, (t - 31) / 3)); skyHero(t, { windScale: 0.6 }); },
    cam(t) {
      const k = ease.inOutSine((t - 31) / 3);
      const pos = tA.set(lerp(-640, -600, k), lerp(1500, 1530, k), lerp(-560, -530, k)).add(sh(t, 0.5, 0.25, 31));
      camLook(pos, tB.set(-120, H - 60, 10), 46, 0.05, 2, 90000);
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); p.exposure = 1.1; p.bloom = 0.5; p.streak = 0.06;
      skyRig({ target: K.pos, keyDir: gapLight(K.pos, K.st, tB), keyI: 3.2, rim: 1.6 }); sky.lamp.intensity = 0;
      sky.update(t, cam, { hero: K.pos, eye: eyeW(tA), curtainGain: 1.25, threadGain: 1.3 });
      const c = cloudsFor(p, { steps: 56, cover: 0.52, bandGain: 2.8, bandBase: 0.16 }); c.wind.set(0.3 + t * 0.004, 0, 0.1); c.band = [seamZ(100), 230, K.st.front + 40, 330];
      p.fog.density = 0.00003; p.focus = 600; p.aperture = 0; p.mblur = 0.7;
      fxS.begin(); fxS.end(); vapS.begin(); vapS.end(); yarn.begin(); yarn.end();
    },
  });

  // ---- S11: out of thread -----------------------------------------------------------------------------------
  shot('S11', 34.0, 37.0, {
    scene: sky.scene,
    hero(t) {
      idle(t); const turn = smoothstep(35.25, 35.7, t);
      pose('surf', 'tie', 0.35 * turn, { headYaw: 2.1 * turn, headPitch: -0.15 * turn, twist: 0.5 * turn });
      face({ eyeWide: 0.9 * turn, browRaise: 0.9 * turn, brow: 1 - 1.6 * turn, mouthOpen: 0.45 * turn, lookX: 0, pupil: 1 - 0.25 * turn, blink: blinks(t, [35.22]) });
      const left = sat((35.0 - t) / 1.0); needle.setThread(0.12 * left); needle.setSpin(-(40 * Math.min(t, 35.0) - 14 * Math.pow(Math.max(0, t - 34.0), 2) * (t < 35 ? 1 : 0)) - (t >= 35 ? (35 * 40 - 14) + 26 * (1 - Math.exp(-(t - 35) * 3)) / 3 : 0));
      skyHero(t, { windScale: t < 35 ? 0.6 : 1.0, gust: 0.8 });
    },
    cam(t) {
      skyKin(t, K2);
      if (t < 35.3) { // on the spool, low behind her boots
        const k = (t - 34) / 1.3; mount.updateMatrixWorld(true);
        const sp = needle.spool.getWorldPosition(tB);
        const pos = tA.copy(sp).addScaledVector(K2.fwd, -lerp(1.15, 0.85, k)).addScaledVector(K2.up, lerp(0.42, 0.3, k)).addScaledVector(tC.crossVectors(K2.up, K2.fwd), lerp(0.75, 0.55, k)).add(sh(t, 0.012, 9, 33));
        cam.position.copy(pos); cam.up.copy(K2.up).lerp(V(0, 1, 0), 0.3).normalize(); cam.lookAt(tB.addScaledVector(K2.fwd, 0.25));
        cam.fov = 40; cam.near = 0.05; cam.far = 60000; cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      } else { // in front of her, looking back down the failing seam
        const k = (t - 35.3) / 1.7; const head = faceP(tB);
        const pos = tA.copy(head).add(V(lerp(2.0, 1.6, k), lerp(-0.12, -0.05, k), lerp(-1.0, -0.75, k))).add(sh(t, 0.012, 3, 35));
        camLook(pos, tC.copy(head).add(V(-0.35, -0.08, 0.15)), lerp(36, 32, k), -0.07, 0.1, 60000);
      }
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); p.exposure = 1.08; let pop = 0; for (const pt of POPS) pop = Math.max(pop, Math.exp(-Math.max(0, t - pt) * 9) * (t >= pt ? 1 : 0));
      const st = K.st; const close = t < 35.3;
      skyRig({ target: K.pos, keyDir: close ? gapLight(K.pos, st, tB) : tB.set(-0.75, 0.6, -0.25).normalize(), keyI: close ? 3.2 : 2.2 + 3.0 * pop, rim: 1.6 + 1.5 * pop, rimDir: close ? undefined : tC.set(-1, 0.5, -0.2) });
      sky.lamp.intensity = 0; p.flash = 0.22 * pop;
      const end = t > T.whip ? sky.whipEnd(t, st, tD) : null;
      sky.update(t, cam, { hero: K.pos, eye: eyeW(tA), goldEnd: end, lintGain: 1.4 + 2 * pop, edgeGain: 1 + 1.2 * pop, curtainGain: 0.8 });
      if (close) { p.focus = cam.position.distanceTo(needle.spool.getWorldPosition(tA)); p.aperture = 10; p.mblur = 1; }
      else { p.focus = cam.position.distanceTo(faceP(tA)); p.aperture = 9; p.mblur = 0.6; }
      fxS.begin();
      if (t > 35.0 && t < 35.6) { const e = eyeW(tA); for (let i = 0; i < 14; i++) { const s = seeds[i + 70]; const a = t - 35.0; fxS.push(e.x + (s[0] - 0.5) * a * 2, e.y + (s[1] - 0.3) * a * 1.5 - a * a * 2, e.z + (s[2] - 0.5) * a * 2, 0.012, 5, 3.6, 1.6, 1 - a / 0.6); } }
      fxS.end(); vapS.begin(); vapS.end(); yarn.begin(); yarn.end();
    },
  });

  // ---- S12: the catch ---------------------------------------------------------------------------------------
  const goldHand = V();
  shot('S12', 37.0, 40.0, {
    scene: sky.scene,
    hero(t) {
      idle(t); needle.setThread(0);
      const reach = ease.inOutCubic(sat((t - 37.15) / 0.8)), rel = ease.inOutCubic(sat((t - 38.35) / 0.9));
      if (rel <= 0) pose('surf', 'catch', reach); else pose('catch', 'tie', rel, { headYaw: -0.5 * rel, headPitch: 0.25 * rel });
      const dec = smoothstep(39.0, 39.8, t);
      face({ brow: lerp(-0.3, 1, sat(reach - rel * 0.6 + dec)), eyeWide: 0.5 * (1 - rel), mouthOpen: 0.4 * reach * (1 - rel), lookX: -0.6 * rel * (1 - dec * 0.5), lookY: -0.35 * rel, blink: blinks(t, [38.75]) });
      skyHero(t, { windScale: 0.35, gust: 0.7 });
    },
    cam(t) {
      skyKin(t, K2);
      if (t < 38.6) { const k = (t - 37) / 1.6; // side-on tracking, slightly below, the loose thread ahead of her
        const pos = tA.copy(K2.pos).add(V(lerp(-2.5, -4.5, k), lerp(-1.2, -0.4, k), lerp(-7.5, -6.0, k))).add(sh(t, 0.03, 2, 41));
        camLook(pos, tB.copy(K2.pos).add(V(-1.6 + k, 1.1, 0)), lerp(44, 38, k), 0.08, 0.2, 60000);
      } else { const k = (t - 38.6) / 1.4; const head = faceP(tB);
        const pos = tA.copy(head).addScaledVector(K2.fwd, lerp(1.05, 0.8, k)).add(tC.crossVectors(K2.up, K2.fwd).multiplyScalar(lerp(-0.75, -0.55, k))).add(V(0, lerp(-0.12, -0.02, k), 0)).add(sh(t, 0.006, 1.5, 43));
        camLook(pos, tC.copy(head).add(V(0, -0.03, 0)), lerp(30, 26, k), 0.05, 0.05, 60000);
      }
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); p.exposure = 1.12; p.saturation = 1.05; const st = K.st;
      const cu = t >= 38.6;
      skyRig({ target: K.pos, keyDir: gapLight(K.pos, st, tB).add(V(0, 0.2, 0)).normalize(), keyI: cu ? 2.6 : 3.0, rim: 1.7, hemiI: 1.7 });
      // loose end drifts into her mitten and stays there
      const palm = wp(io.anchors.palmR, tC); sky.whipEnd(t, st, goldHand).lerp(palm, smoothstep(37.5, T.catch, t));
      sky.lamp.position.copy(palm).add(V(0, 0.14, 0.05)); sky.lamp.intensity = 0.1 * smoothstep(T.catch - 0.1, T.catch + 0.2, t); sky.lamp.distance = 4;
      sky.update(t, cam, { hero: K.pos, goldEnd: goldHand, lintGain: 2.0, edgeGain: 1.4, curtainGain: 0.7 });
      p.focus = cam.position.distanceTo(cu ? faceP(tA) : K.pos); p.aperture = cu ? 12 : 4; p.maxCoc = 26; p.mblur = 0.45;
      p.flash = 0.25 * Math.exp(-Math.abs(t - T.catch) * 18);
      fxS.begin(); const a = t - T.catch; if (a > 0 && a < 0.8) for (let i = 0; i < 26; i++) { const s = seeds[i + 90]; const an = s[0] * 6.283, k = a / (0.3 + s[3] * 0.5); if (k > 1) continue;
        fxS.push(palm.x + Math.cos(an) * s[1] * 0.5 * (1 - Math.exp(-a * 5)), palm.y + (s[2] - 0.4) * 0.5 * (1 - Math.exp(-a * 5)) - a * a, palm.z + Math.sin(an) * s[1] * 0.5 * (1 - Math.exp(-a * 5)), 0.012, 6, 4.2, 1.8, 1 - k); }
      fxS.end(); vapS.begin(); vapS.end(); yarn.begin(); yarn.end();
    },
  });

  // ---- S13: red to gold -------------------------------------------------------------------------------------
  shot('S13', 40.0, 42.5, {
    scene: sky.scene,
    hero(t) {
      idle(t); needle.setThread(0); pose('tie');
      face({ lookY: -0.6, brow: 0.8, blink: blinks(t, [40.9]) });
      skyHero(t, { windScale: 1.6, gust: 0.5 });
    },
    cam(t) {
      const cup = wp(io.anchors.cup, tB); skyKin(t, K2); const k = ease.inOutSine((t - 40) / 2.5);
      const side = tC.crossVectors(K2.up, K2.fwd);
      const pos = tA.copy(cup).addScaledVector(K2.fwd, lerp(0.50, 0.40, k)).addScaledVector(side, lerp(0.16, 0.05, k)).add(V(0, lerp(0.10, 0.06, k), 0)).add(sh(t, 0.002, 1.2, 51));
      const j = 0.004 * Math.exp(-Math.max(0, t - T.knot) * 9) * (t >= T.knot ? Math.sin((t - T.knot) * 70) : 0);
      camLook(pos, tC.copy(cup).add(V(0, 0.0 + j, 0)), 30, 0.03, 0.03, 60000);
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); p.exposure = 0.9; const st = K.st;
      const pl = wp(io.anchors.palmL, tA).clone(), pr = wp(io.anchors.palmR, tB).clone(), cup = wp(io.anchors.cup, tC).clone();
      skyRig({ target: K.pos, keyDir: gapLight(K.pos, st, tD).add(V(0, 0.3, 0)).normalize(), keyI: 2.4, rim: 1.6, hemiI: 1.8 });
      sky.lamp.position.copy(cup).add(V(0, 0.05, 0.05)); sky.lamp.intensity = 0.05 + 0.07 * Math.exp(-Math.abs(t - T.knot) * 10); sky.lamp.distance = 3;
      sky.update(t, cam, { hero: K.pos, goldEnd: pl, lintGain: 2.0, edgeGain: 1.3, curtainGain: 0.7 });
      // knot frame: x from left mitten to right mitten
      knot.g.visible = true; knot.g.position.copy(cup).add(V(0, 0.035, 0));
      const xa = pr.clone().sub(pl).normalize(), ya = V(0, 1, 0), za = xa.clone().cross(ya).normalize(); ya.crossVectors(za, xa);
      knot.g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xa, ya, za)); knot.g.updateMatrixWorld(true);
      const kt = sat((t - 40.3) / (T.knot - 40.3)); const s = lerp(0.03, 0.0052, t < T.knot ? ease.inQuad(kt) * 0.8 : 0.8 + 0.2 * ease.outBack(sat((t - T.knot) / 0.18)));
      knot.update(s, knot.g.worldToLocal(pl.clone().add(V(0, 0.03, 0))), knot.g.worldToLocal(pr.clone().add(V(0, 0.03, 0))));
      p.focus = cam.position.distanceTo(cup); p.aperture = 26; p.maxCoc = 34; p.mblur = 0.3; p.flash = 0.12 * Math.exp(-Math.abs(t - T.knot) * 20);
      fxS.begin(); const a = t - T.knot; if (a > 0 && a < 0.7) for (let i = 0; i < 24; i++) { const s2 = seeds[i + 120]; const an = s2[0] * 6.283, k = a / (0.25 + s2[3] * 0.45); if (k > 1) continue;
        fxS.push(knot.g.position.x + Math.cos(an) * s2[1] * 0.1 * (1 - Math.exp(-a * 7)), knot.g.position.y + (s2[2] - 0.35) * 0.1 * (1 - Math.exp(-a * 7)) - a * a * 0.3, knot.g.position.z + Math.sin(an) * s2[1] * 0.1 * (1 - Math.exp(-a * 7)), 0.004, 6, s2[0] > 0.5 ? 4 : 1.2, s2[0] > 0.5 ? 1.8 : 0.8, 1 - k); }
      fxS.end(); vapS.begin(); vapS.end(); yarn.begin(); yarn.end();
    },
  });

  // ---- S14: the red run -------------------------------------------------------------------------------------
  const RC = new THREE.Color(1.0, 0.1, 0.08);
  const scarfLenAt = (t) => 1 - smoothstep(42.6, 46.4, t), scarfWrapAt = (t) => 1 - smoothstep(46.2, 47.3, t);
  function yarnLine(t, gain = 3.5) { // red yarn feeding from the unravelling scarf into the needle's eye
    yarn.begin(); const a = wp(scarfLenAt(t) > 0.03 ? io.anchors.scarfTipL : io.anchors.neck, tA), b = eyeW(tB); const N = 18;
    for (let i = 0; i <= N; i++) { const k = i / N, s = Math.sin(Math.PI * k); yarn.push(lerp(a.x, b.x, k) + Math.sin(k * 7 + t * 14) * 0.08 * s, lerp(a.y, b.y, k) - 0.25 * s + Math.cos(k * 5 + t * 11) * 0.06 * s, lerp(a.z, b.z, k) + Math.sin(k * 6 - t * 12) * 0.08 * s, 1.0 * gain, 0.1 * gain, 0.08 * gain, 1); }
    yarn.end();
  }
  shot('S14', 42.5, 47.0, {
    scene: sky.scene,
    hero(t) {
      idle(t); needle.setThread(0.3); needle.setThreadColor(RC, 2.6); needle.setSpin(t * 34); pose('surf');
      face({ brow: 1, mouthOpen: 0.35, eyeWide: 0.2 });
      skyHero(t, { windScale: 0.5, gust: 1, scarfLen: scarfLenAt(t), scarfWrap: scarfWrapAt(t) });
    },
    cam(t) {
      skyKin(t, K2); const st = K2.st; const x = K2.pos.x;
      if (t < 44.5) { // ahead of her under the cloth, she corkscrews toward the lens
        const k = (t - 42.5) / 2.0; const cx = x + lerp(26, 15, k); const cz = seamZ(cx) + lerp(-3, 4, k);
        const pos = tA.set(cx, clothAt(cx, cz, st) - lerp(7.5, 5.5, k), cz).add(sh(t, 0.1, 5, 61));
        camLook(pos, tB.copy(K2.pos).lerp(tC.set(x, clothAt(x, seamZ(x), st) - 2, seamZ(x)), 0.45), lerp(52, 46, k), 0.1 * Math.sin((t - 42.5) * 2.2), 0.3, 60000);
      } else { // racing alongside in profile
        const k = (t - 44.5) / 2.5; const cx = x + lerp(-12, 6, k); const cz = seamZ(x) - lerp(30, 22, k);
        const pos = tA.set(cx, H - lerp(10, 6, k), cz).add(sh(t, 0.15, 4, 63));
        camLook(pos, tB.set(x + 12, clothAt(x, seamZ(x), st) - 1.5, seamZ(x)).lerp(K2.pos, 0.3), lerp(50, 44, k), -0.06, 0.3, 60000);
      }
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); const st = K.st; let hit = 0; for (const pc of RED_PIERCES) hit = Math.max(hit, Math.exp(-Math.abs(t - pc.t) * 16));
      const hy = sat((K.pos.y - clothAt(K.pos.x, K.pos.z, st)) / 3 * 0.5 + 0.5);
      p.exposure = 0.82; p.bloom = 0.45; p.flash = 0.3 * hit; p.ca = 0.002; p.saturation = 1.14;
      skyRig({ target: K.pos, keyDir: hy > 0.5 ? tB.set(0.2, 1, 0.2).normalize() : gapLight(K.pos, st, tB), keyI: lerp(3.4, 5.2, hy), rim: 1.9, hemiI: lerp(1.6, 2.1, hy), env: lerp(0.4, 0.8, hy) });
      sky.lamp.intensity = 0;
      sky.update(t, cam, { hero: K.pos, eye: eyeW(tA), lintGain: 1.2, curtainGain: 0.3, threadGain: 1.15 });
      yarnLine(t);
      p.focus = cam.position.distanceTo(K.pos); p.aperture = 0; p.mblur = 1.0; p.maxBlur = 64;
      fxS.begin(); fxS.end(); vapS.begin(); vapS.end();
    },
  });

  // ---- S15: the pull ----------------------------------------------------------------------------------------
  const hands = V(), PF = V();
  shot('S15', 47.0, 52.0, {
    scene: sky.scene,
    hero(t) {
      idle(t); needle.setThread(0); needle.setThreadColor(RC, 2.6);
      const brace = ease.inOutCubic(sat((t - 47.75) / 0.5)), haul = ease.inOutSine(sat((t - T.pull) / 2.4)), done = ease.inOutCubic(sat((t - T.shut - 0.15) / 1.0));
      if (done > 0) pose('pull', 'tie', done * 0.8, { headPitch: 0.25 * done }); else pose('surf', 'pull', brace);
      const strain = Math.sin(haul * Math.PI) * 0.5 + haul * 0.5;
      face({ brow: 1 - 1.6 * done, blink: Math.max(0.55 * strain * (1 - done), blinks(t, [51.3])), mouthOpen: 0.5 * (brace - done * 0.7) + 0.1, eyeWide: 0, smile: -0.4 * strain * (1 - done) });
      const k = skyHero(t, { windScale: t < 47.6 ? 0.5 : 0.25, gust: 1 - done * 0.8, scarfLen: 0, scarfWrap: scarfWrapAt(t), roll: 0 });
      // lean with the strain: tug the whole rig a little
      mount.rotateX(-0.10 * strain * (1 - done) + 0.012 * Math.sin(t * 31) * strain * (1 - done)); mount.updateMatrixWorld(true);
    },
    cam(t) {
      skyKin(t, K2); const st = K2.st; piercePoint(FINAL_PIERCE, st, PF);
      if (t < 48.2) { const k = (t - 47) / 1.2; // under the tear's tip: she plunges down through the cloth
        const pos = tA.copy(PF).add(V(lerp(22, 20, k), lerp(-16, -15, k), lerp(-16, -13, k))).add(sh(t, 0.1, 4, 71));
        camLook(pos, tB.copy(PF).add(V(-2, -2, 0)).lerp(K2.pos, 0.55), lerp(50, 44, k), 0.08, 0.3, 60000);
      } else if (t < 49.55) { const k = (t - 48.2) / 1.35; const head = faceP(tB); // low front three-quarter on the strain
        const pos = tA.copy(head).add(V(lerp(-2.3, -1.9, k), lerp(-0.75, -0.6, k), lerp(1.5, 1.2, k))).add(sh(t, 0.012 + 0.012 * k, 9, 73));
        camLook(pos, tC.copy(head).add(V(0.1, -0.12, 0)), lerp(36, 32, k), -0.1, 0.1, 60000);
      } else { const k = sat((t - 49.55) / 2.45); // behind her, down the whole seam as it zips shut
        const pos = tA.copy(K2.pos).add(V(lerp(9, 13, k), lerp(-2.2, -3.4, k), lerp(-5.5, -7, k))).add(sh(t, 0.05 * (1 - smoothstep(50.6, 51.2, t)), 5, 75));
        camLook(pos, tB.set(lerp(40, -60, k), H - lerp(4, 9, k), seamZ(0) + 2), lerp(40, 36, k), 0.04, 0.3, 80000);
      }
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); const st = K.st; const dark = smoothstep(T.shut - 0.25, T.shut + 0.05, t);
      const hit = Math.exp(-Math.abs(t - 47.6) * 14), slam = Math.exp(-Math.max(0, t - T.shut) * 5) * (t >= T.shut ? 1 : 0);
      p.exposure = lerp(1.05, 1.5, smoothstep(T.shut, T.shut + 1.2, t)); p.flash = 0.6 * hit + 0.5 * Math.exp(-Math.abs(t - T.shut) * 22); p.saturation = lerp(1.12, 1.0, dark); p.bloom = lerp(0.5, 0.7, dark);
      const kd = gapLight(K.pos, st, tB).add(V(-0.4, 0.25, 0)).normalize();
      skyRig({ target: K.pos, keyDir: kd, keyI: lerp(3.4, 0.5, dark), keyCol: dark > 0.5 ? 0x9fb4ff : 0xffd08a, rim: lerp(1.9, 0.9, dark), rimCol: [lerp(1.0, 0.55, dark), lerp(0.8, 0.68, dark), lerp(0.5, 1.0, dark)], rimDir: tC.set(-0.6, 0.7, 0.2), hemiI: lerp(1.7, 1.3, dark) });
      const pl = wp(io.anchors.palmL, tA), pr = wp(io.anchors.palmR, tD); hands.copy(pl).lerp(pr, 0.5);
      sky.lamp.intensity = 0;
      sky.update(t, cam, { hero: K.pos, eye: eyeW(tC), redEnd: hands, redSag: 0.05 + 1.5 * smoothstep(T.shut + 0.1, T.shut + 1.0, t), lintGain: 1.6 * (1 - dark), curtainGain: 0.9 * (1 - dark), threadGain: lerp(1.2, 0.5, smoothstep(T.shut, T.shut + 1.2, t)), seamGlow: lerp(0.6, 0.12, smoothstep(T.shut, T.shut + 1.3, t)),
        ripples: [{ x: PF.x - 30, z: PF.z, t: T.shut, s: 3.0 }], swing: { x: PF.x, z: PF.z, t: T.shut, s: 0.9 * (t >= T.shut ? 1 : 0) }, starGain: lerp(1, 1.5, dark), amb: lerp(1, 1.5, dark) });
      if (t < 47.6) yarnLine(t); else { yarn.begin(); yarn.end(); }
      const cu = t >= 48.2 && t < 49.55;
      if (t >= 49.55 || t < 48.2) { const c = cloudsFor(p, { steps: 36, cover: 0.5, bandGain: 2.4 * (1 - dark), bandBase: 0.2 }); c.wind.set(0.5, 0, 0.1); c.band = [seamZ(0), 230, -620, Math.min(330, st.cinch)]; }
      p.focus = cam.position.distanceTo(cu ? faceP(tA) : K.pos); p.aperture = cu ? 9 : 0; p.mblur = cu ? 0.5 : 0.9;
      fxS.begin(); fxS.end(); vapS.begin(); vapS.end();
    },
  });

  // ---- S16: bare neck ---------------------------------------------------------------------------------------
  const lampBead = sky.addHeroBead(0, 0, 1.55, 0.03, 0.7); lampBead.amp = 0.1;
  shot('S16', 52.0, 55.5, {
    scene: sky.scene,
    hero(t) {
      idle(t); needle.setThread(0); needle.setThreadColor(RC, 2.0); pose('rest');
      const up = ease.inOutCubic(sat((t - 53.3) / 0.8));
      if (io.adjust) io.adjust({ headPitch: lerp(0.3, -0.45, up), headYaw: lerp(-0.15, 0.2, up) });
      face({ lookY: lerp(-0.6, 0.6, up), lookX: lerp(-0.2, 0.25, up), smile: 0.75 * smoothstep(53.9, 55.0, t), brow: -0.35 * (1 - up), blink: Math.max(blinks(t, [52.7, 54.2]), 0.3 * (1 - smoothstep(52.0, 53.0, t))), mouthOpen: 0.18 * (1 - smoothstep(52.3, 53.6, t)), eyeWide: 0.1 * up, blush: 0.9 });
      skyHero(54.0, { windScale: 0, gust: 0.15, scarfLen: 0, scarfWrap: 0 });
      io.update(t, { wind: wind.set(-2.5, 0, 0.6), gust: 0.2, scarfLen: 0, scarfWrap: 0 });
      // the bead that hangs beside her
      const hd = faceP(tA); lampBead.x = hd.x - 0.34; lampBead.z = hd.z + 0.22; lampBead.hang = clothAt(lampBead.x, lampBead.z, K.st) - (hd.y + 0.07); lampBead.kick = 0.25; lampBead.kickT = 53.2;
    },
    cam(t) {
      const head = faceP(tB); const k = ease.inOutSine((t - 52) / 3.5);
      const pos = tA.copy(head).add(V(lerp(-0.42, -0.3, k), lerp(-0.1, -0.04, k), lerp(1.5, 1.12, k))).add(sh(t, 0.004, 0.7, 81));
      camLook(pos, tC.copy(head).add(V(-0.07, -0.05, 0)), 27, 0.03, 0.05, 60000);
    },
    fx(t, C) {
      const p = C.post; skyGrade(p); p.exposure = 1.45; p.saturation = 1.02; p.bloom = 0.65; p.shadowTint = [0.0, 0.008, 0.035]; p.highTint = [1.02, 1.0, 0.98];
      skyRig({ target: K.pos, keyDir: tB.set(-0.5, 0.8, 0.45).normalize(), keyI: 0.9, keyCol: 0xa9bcff, rim: 1.0, rimCol: [0.55, 0.68, 1.0], rimDir: tC.set(0.6, 0.6, -0.5), hemiI: 1.5, env: 0.3 });
      sky.update(t, cam, { hero: K.pos, threadGain: 0.5, seamGlow: 0.1, lintGain: 0, curtainGain: 0, starGain: 1.5, amb: 1.6 });
      const bp = lampBead.g.position; sky.lamp.position.copy(bp); sky.lamp.intensity = 0.9; sky.lamp.distance = 5; sky.lamp.color.set(0xffc880);
      p.focus = cam.position.distanceTo(faceP(tA)) - 0.08; p.aperture = 16; p.maxCoc = 28; p.mblur = 0.3;
      fxS.begin(); fxS.push(bp.x, bp.y, bp.z, 0.14, 2.0, 1.5, 0.8, 0.5); fxS.end();
      vapS.begin(); const m = faceP(tA).add(V(0, -0.06, 0.13)); vapor(vapS, t, 52.35, m, V(-0.3, 0.1, 1), 14, 1.7, 200, 0.07); vapor(vapS, t, 54.4, m, V(-0.2, 0.2, 1), 10, 1.4, 230, 0.05); vapS.end();
      // a last tail of red yarn in her mitten
      yarn.begin(); const a = wp(io.anchors.palmR, tB); for (let i = 0; i <= 10; i++) { const k = i / 10; yarn.push(a.x + 0.02 + k * 0.10 + Math.sin(k * 5 + t * 2) * 0.012, a.y + 0.03 + Math.sin(k * 3.1) * 0.05 - k * k * 0.16, a.z + 0.03 + k * 0.05, 2.2, 0.22, 0.17, 1); } yarn.end();
    },
  });

  // ---- S17: a new constellation -----------------------------------------------------------------------------
  shot('S17', 55.5, 60.0, {
    scene: gs.scene,
    hero(t) {
      idle(t); if (io.root.parent) io.root.parent.remove(io.root); if (mount.parent) mount.parent.remove(mount);
      bead.visible = true; bead.position.copy(gs.ridgePoint(-0.6)).add(V(0.0, 0.016, 0.03)); bead.rotation.set(0.3, 0.2, 1.2);
    },
    cam(t) {
      const k = ease.inOutSine((t - 55.5) / 4.5);
      const pos = houseLocal(lerp(0.15, 0.5, k), RIDGE_Y + lerp(0.30, 0.95, k), lerp(-1.5, -2.5, k), tA).add(sh(t, 0.006, 0.4, 91));
      const toSeam = tB.copy(gs.tearCenter).add(V(-40, 0, 0)).sub(pos).normalize(); const toBead = tC.copy(bead.position).sub(pos).normalize();
      camLook(pos, tD.copy(pos).addScaledVector(toBead.lerp(toSeam, lerp(0.70, 0.78, k)).normalize(), 100), lerp(52, 50, k), -0.03, 0.1, 60000);
    },
    fx(t, C) {
      const p = C.post; nightGrade(p); p.exposure = 1.25; p.bloom = 0.7;
      groundRig({ keyI: 0.3, rim: 0.7, lamp: 0.12 + 0.02 * Math.sin(t * 3.1), lampPos: tA.copy(bead.position).add(V(0, 0.05, 0)) });
      gs.key.color.set(0x9fb4ff);
      gs.update(t, cam, { tearT: 58, seam: 1, fallGain: 0, starGain: 0.8, tearGain: 0 });
      cloudsFor(p, { cover: 0.3, steps: 40, lightCol: [0.25, 0.3, 0.5], bandGain: 0, bandBase: 1 }); p.clouds.wind.set(0.9, 0, 0.3);
      p.fog.density = 0.00012; p.fog.falloff = 0.0012; p.fog.base = 800; p.fog.color = [0.02, 0.03, 0.075];
      const rack = ease.inOutCubic(sat((t - 56.2) / 1.6)); p.focus = lerp(cam.position.distanceTo(bead.position), 1e5, Math.pow(rack, 6)); p.aperture = 12; p.maxCoc = 30; p.mblur = 0.4;
      p.fade = 1 - smoothstep(59.2, 59.95, t);
      // she glides home: a small warm spark descending from the seam
      const hk = sat((t - 55.5) / 5.5); const sp = tA.copy(gs.tearCenter).add(V(-120, 0, 0)).lerp(houseLocal(60, 60, 260, tB), 0.25 + 0.5 * hk); sp.y -= 300 * hk * hk; sp.x += Math.sin(hk * 5) * 40;
      streamG.begin(); for (let i = 0; i <= 12; i++) { const k = i / 12; streamG.push(sp.x + (1 - k) * 22, sp.y + (1 - k) * 26, sp.z - (1 - k) * 16, 2.4, 0.6 + 1.0 * k, 0.3 + 0.3 * k, k * k); } streamG.end();
      fxG.begin(); fxG.push(sp.x, sp.y, sp.z, 5, 3, 2.1, 1.1, 1); fxG.push(bead.position.x, bead.position.y, bead.position.z, 0.11, 2.2, 1.6, 0.8, 0.5); fxG.end(); vapG.begin(); vapG.end();
      title.visible = true; const ta = smoothstep(57.0, 58.2, t) * (1 - smoothstep(59.0, 59.7, t)); title.material.color.setRGB(0.95 * ta, 0.86 * ta, 0.7 * ta);
      const dist = 2.0, hh = 2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2); title.scale.setScalar(hh * 1.15); title.position.set(0, -hh * 0.33, -dist);
    },
  });

  // ------------------------------------------------------------------------------ frame
  const prevVP = new THREE.Matrix4(); const only = q.get('shot');
  return {
    duration: 60,
    frame(t) {
      t = Math.min(Math.max(t, 0), 59.999);
      const s = S.find((x) => t >= x.t0 && t < x.t1) || S[S.length - 1];
      const C = { post: defaultPost(), t };
      G.time.value = t;
      s.hero(t, C);
      s.scene.updateMatrixWorld(true);
      const dt = 0.5 / FPS; s.cam(Math.max(t - dt, s.t0), C); engine.viewProj(cam, prevVP);
      s.cam(t, C); s.fx(t, C);
      return { scene: s.scene, camera: cam, post: C.post, prevVP, frame: Math.round(t * FPS) };
    },
  };
});
