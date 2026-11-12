// Bench for the heroine. Everything is driven by the query string so one render call = one contact sheet.
//   pose, pose2 + k (blend), yaw, pitch, dist, fov, tx, ty, tz (camera target), rig=sky|night, wind (m/s toward the
//   character's -Z), gust, scarfLen, scarfWrap, needle=1, ground=1, seat=1, floor=1, any face parameter, face=<preset>
//   lineup=yaw|pose|face|scarf|blend|k|wind  (+ n, sp, poses=a,b,c, faces=a,b,c)  -> several instances side by side
//   spin=1 : yaw advances 45 degrees per second of t
import * as THREE from 'three';
import { boot } from './boot.js';
import { defaultPost } from './engine.js';
import { toonMat, makeEnv, G } from './materials.js';
import { createIo } from './character.js';
import { createNeedle } from './needle.js';

const RIDE = new Set(['crouch', 'surf', 'reach', 'catch', 'tie', 'pull', 'rest']);
const FACES = {
  neutral: {}, half: { blink: 0.5 }, closed: { blink: 1 },
  surprise: { eyeWide: 1, mouthOpen: 0.6, browRaise: 1, pupil: 0.8 }, determined: { brow: 1, smile: -0.25, blink: 0.08 },
  smile: { smile: 0.75 }, grin: { smile: 1, mouthOpen: 0.5, blink: 1 }, worried: { brow: -1, smile: -0.5, browRaise: 0.4 },
  left: { lookX: 1 }, right: { lookX: -1 }, up: { lookY: 1, browRaise: 0.4 }, down: { lookY: -1, blink: 0.25 },
  tired: { smile: 0.6, blink: 0.32, brow: -0.4 }, awe: { eyeWide: 0.6, mouthOpen: 0.25, lookY: 0.7, reflect: 1, browRaise: 0.6 },
};
const FACE_KEYS = ['blink', 'lookX', 'lookY', 'brow', 'browRaise', 'smile', 'mouthOpen', 'eyeWide', 'pupil', 'blush', 'reflect'];

boot(async (engine, q) => {
  const num = (k, d) => (q.has(k) ? parseFloat(q.get(k)) : d), str = (k, d) => q.get(k) || d;
  const rig = str('rig', 'sky'), lineup = str('lineup', '');
  const scene = new THREE.Scene();
  const bg = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 d; void main(){ d = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 d; void main(){ float h = normalize(d).y; vec3 c = mix(vec3(0.02,0.026,0.075), vec3(0.008,0.01,0.03), smoothstep(-0.2, 0.7, h)); gl_FragColor = vec4(c * ${rig === 'night' ? '0.6' : '1.0'}, 1.0); }` }));
  scene.add(bg);
  let bead = null;
  if (rig === 'night') {
    const key = new THREE.DirectionalLight(0x8fa8ff, 1.1); key.position.set(-0.4, 0.8, 0.3).multiplyScalar(6); shadowed(key);
    scene.add(key, new THREE.HemisphereLight(0x27306a, 0x0a0c1c, 1.0));
    scene.environment = makeEnv(engine.renderer, { top: 0x1a2250, horizon: 0x10163a, bottom: 0x05060f, sunColor: 0x000000, sunGain: 0 }); scene.environmentIntensity = 0.5;
    G.rimDir.value.set(-0.4, 0.8, -0.3).normalize(); G.rimColor.value.setRGB(0.45, 0.55, 1.0);
    bead = new THREE.PointLight(0xffc070, num('bead', 3), 3, 2);
    bead.add(new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 6, 2.5) })));
  } else {
    const key = new THREE.DirectionalLight(0xffd08a, 3.4); key.position.set(0.25, 1, 0.15).normalize().multiplyScalar(8); shadowed(key);
    scene.add(key, new THREE.HemisphereLight(0x2a3470, 0x10142e, 1.6));
    scene.environment = makeEnv(engine.renderer, {}); scene.environmentIntensity = 0.4;
    G.rimDir.value.set(0, 1, -0.3).normalize(); G.rimColor.value.setRGB(1.0, 0.8, 0.5);
  }
  function shadowed(l) {
    l.castShadow = true; l.shadow.mapSize.set(4096, 4096); l.shadow.bias = -0.0004; l.shadow.normalBias = 0.012;
    Object.assign(l.shadow.camera, { left: -4.5, right: 4.5, top: 2.6, bottom: -1.2, near: 0.5, far: 30 }); l.target.position.set(0, 0.6, 0); scene.add(l.target);
  }

  // ---- variants
  const base = { pose: str('pose', 'stand'), pose2: str('pose2', ''), k: num('k', 0.5), yaw: num('yaw', 0), wind: num('wind', 0), gust: num('gust', 0),
    scarfLen: num('scarfLen', 1), scarfWrap: num('scarfWrap', 1), face: { ...(FACES[str('face', 'neutral')] || {}) }, dt: 0 };
  for (const k of FACE_KEYS) if (q.has(k)) base.face[k] = num(k, 0);
  const n = num('n', 8); let vars = [base];
  const list = (k, d) => str(k, d).split(',');
  if (lineup === 'yaw') vars = q.has('yaws') ? list('yaws', '0').map((y) => ({ ...base, yaw: parseFloat(y) })) : Array.from({ length: n }, (_, i) => ({ ...base, yaw: base.yaw + i * 360 / n }));
  if (lineup === 'pose') vars = list('poses', 'stand,sitCup,lookUp,crouch,surf,reach,catch,tie,pull,rest').map((p) => ({ ...base, pose: p }));
  if (lineup === 'face') vars = list('faces', 'neutral,half,closed,surprise,determined,smile').map((f) => ({ ...base, face: { ...base.face, ...FACES[f] } }));
  if (lineup === 'scarf') vars = [[1, 1], [0.6, 1], [0.25, 1], [0, 1], [0, 0.66], [0, 0.33], [0, 0]].map(([l, w]) => ({ ...base, scarfLen: l, scarfWrap: w }));
  if (lineup === 'blend') vars = [['stand', 'lookUp'], ['crouch', 'surf'], ['surf', 'reach'], ['surf', 'catch'], ['surf', 'pull'], ['surf', 'tie']].map(([a, b]) => ({ ...base, pose: a, pose2: b, k: base.k }));
  if (lineup === 'k') vars = Array.from({ length: n }, (_, i) => ({ ...base, k: i / (n - 1) }));
  if (lineup === 'wind') vars = [0, 4, 12, 25, 45, 70].map((w) => ({ ...base, wind: w }));
  if (lineup === 'time') vars = Array.from({ length: n }, (_, i) => ({ ...base, dt: i * num('step', 0.12) }));
  const light = vars.length > 2 && !q.has('hi');
  const sp = num('sp', lineup === 'face' ? 0.34 : 0.9);
  const insts = vars.map((v, i) => {
    const io = createIo(light ? { faceRes: 1024, eyeRes: 768 } : {});
    const holder = new THREE.Group(); holder.position.x = (i - (vars.length - 1) / 2) * sp; holder.add(io.root); scene.add(holder);
    const ride = RIDE.has(v.pose) || RIDE.has(v.pose2);
    if (q.get('needle') === '1' || (ride && q.get('needle') !== '0')) holder.add(createNeedle().root);
    if (v.pose === 'sitCup' && q.get('seat') !== '0') {
      const roof = toonMat({ color: 0x4a3f52, roughness: 0.9, rim: 0.2 });
      for (const s of [-1, 1]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.04, 0.9), roof); m.rotation.x = s * 0.7; m.position.set(0, -0.02 - Math.sin(0.7) * 0.45, s * Math.cos(0.7) * 0.45); m.receiveShadow = true; m.castShadow = true; holder.add(m); }
    }
    return { io, holder, v };
  });
  if (q.get('ground') === '1') { const g = new THREE.Mesh(new THREE.CircleGeometry(6, 48), toonMat({ color: 0x343a62, roughness: 0.95, rim: 0 })); g.rotation.x = -Math.PI / 2; g.receiveShadow = true; scene.add(g); }
  if (bead) scene.add(bead);

  if (q.has('rim')) G.rimStrength.value = num('rim', 1);
  if (q.has('env')) scene.environmentIntensity = num('env', 0.4);
  if (q.has('key')) scene.traverse((o) => { if (o.isDirectionalLight) o.intensity *= num('key', 1); });
  const fov = num('fov', 20), cam = new THREE.PerspectiveCamera(fov, engine.width / engine.height, 0.05, 2000);
  const width = Math.max(vars.length * sp, 0.2), hf = Math.atan(Math.tan(fov * Math.PI / 360) * engine.width / engine.height);
  const autoDist = Math.max((width / 2) / Math.tan(hf) * 1.04, (num('h', lineup === 'face' ? 0.34 : 1.75) / 2) / Math.tan(fov * Math.PI / 360));
  const dist = num('dist', autoDist), pitch = num('pitch', 4) * Math.PI / 180;
  const target = new THREE.Vector3(num('tx', 0), num('ty', lineup === 'face' ? 1.33 : 0.78), num('tz', 0));
  const post = defaultPost(); post.bloom = num('bloom', 0.3); post.grain = 0; post.vignette = 0.12; post.mblur = 0; post.ca = 0; post.streak = 0.04;
  post.exposure = num('exposure', 1);
  const prev = new THREE.Matrix4(), wind = new THREE.Vector3();
  const camYawMode = vars.length === 1;
  return {
    duration: 10,
    frame(t) {
      const spin = q.get('spin') === '1' ? t * 45 : 0;
      let ms = 0;
      for (const { io, holder, v } of insts) {
        const yaw = (v.yaw + spin) * Math.PI / 180;
        holder.rotation.y = camYawMode ? 0 : -yaw;
        const P = io.POSES;
        const t0 = performance.now();
        io.setPose(v.pose2 ? io.blendPose(P[v.pose], P[v.pose2], v.k) : P[v.pose]);
        io.setFace(v.face);
        holder.updateMatrixWorld(true);
        wind.set(num('windx', 0), num('windy', 0), -v.wind).applyQuaternion(holder.quaternion);
        io.update(t + v.dt, { wind, gust: v.gust, scarfLen: v.scarfLen, scarfWrap: v.scarfWrap, floor: q.get('floor') === '1' ? 0 : undefined });
        ms += performance.now() - t0;
      }
      if (q.get('prof') === '1') console.log('warn-timing: setPose+setFace+update ms per instance', (ms / insts.length).toFixed(2));
      if (bead) { const io = insts[0].io; scene.updateMatrixWorld(true); io.anchors.cup.getWorldPosition(bead.position); bead.position.y += 0.015; bead.visible = insts[0].v.pose === 'sitCup' || q.get('bead') !== null; }
      const yaw = camYawMode ? (vars[0].yaw + spin) * Math.PI / 180 : 0;
      cam.position.set(target.x + dist * Math.sin(yaw) * Math.cos(pitch), target.y + dist * Math.sin(pitch), target.z + dist * Math.cos(yaw) * Math.cos(pitch));
      cam.lookAt(target); engine.viewProj(cam, prev);
      return { scene, camera: cam, post, prevVP: prev, frame: Math.round(t * 24) };
    },
  };
});
