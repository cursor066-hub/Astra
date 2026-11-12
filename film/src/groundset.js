// GROUND SET: the mountain village under the night sky. The sky here is the same cloth plane as in the
// sky set, ray-cast analytically in a dome shader (tear, glow, stars, and later the stitched constellation).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLSL_NOISE, rng, sat, lerp, smoothstep, fbm2, noise2 } from './lib.js';
import { toonMat, canvasTex } from './materials.js';
import { FatLine, Sprites } from './prims.js';
import { H, TEAR, TEAR_GLSL, ALL_PIERCES, seamState, seamZ, gapW } from './tear.js';

export const HOUSE = { x: -420, y: 800, z: -820, yaw: 0.323, ridgeY: 7.2, w: 9, d: 7, wallH: 4.2, rise: 3.0 };

export function terrainH(x, z) {
  const lx = x - HOUSE.x, lz = z - HOUSE.z, r = Math.hypot(lx, lz);
  const shelf = 1 - smoothstep(120, 420, r);
  const base = 800 - 0.6 + (fbm2(lx * 0.012 + 3, lz * 0.012 + 7, 3) - 0.5) * 5 - Math.max(0, lz) * 0.035;
  const rid = (a, b) => { const n = fbm2(a, b, 5); return 1 - Math.abs(n * 2 - 1); };
  const mtn = Math.pow(rid(lx * 0.00038 + 1.7, lz * 0.00038 + 4.1), 2.2) * 900 * smoothstep(900, 4600, r)
    + Math.pow(rid(lx * 0.0016 + 8.3, lz * 0.0016 + 2.9), 1.5) * 170 * smoothstep(500, 2500, r) + (fbm2(lx * 0.003, lz * 0.003, 4) - 0.5) * 90 * smoothstep(150, 900, r);
  const valley = -300 * smoothstep(200, 1300, lz) * (1 - smoothstep(1800, 4200, r)) - 190 * smoothstep(250, 1000, r) * (1 - smoothstep(1200, 3200, r));
  return lerp(800 + valley + mtn, base, shelf);
}

function gableHouse(w, d, h, rise, over = 0.5) {
  // returns { walls, roof } geometries in local space (ridge along X), y=0 at ground
  const body = new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);
  const hw = w / 2, hd = d / 2, ow = hw + over, od = hd + over, y0 = h - over * rise / hd * 0.3, y1 = h + rise;
  // gable end walls
  const gp = [], add = (...v) => gp.push(...v);
  for (const sx of [-1, 1]) { const x = sx * hw; if (sx > 0) add(x, h, -hd, x, y1, 0, x, h, hd); else add(x, h, hd, x, y1, 0, x, h, -hd); }
  const gable = new THREE.BufferGeometry(); gable.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3)); gable.computeVertexNormals();
  const bodyNI = body.toNonIndexed(); bodyNI.deleteAttribute('uv');
  const walls = mergeGeometries([bodyNI, gable]);
  // roof slabs with thickness
  const th = 0.22; const rp = [], ruv = [];
  const quad = (a, b, c, dd, ua, ub, uc, ud) => { rp.push(...a, ...b, ...c, ...a, ...c, ...dd); ruv.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud); };
  const L = Math.hypot(od, y1 - y0);
  for (const sz of [-1, 1]) {
    const A = [-ow, y0, sz * od], B = [ow, y0, sz * od], C = [ow, y1, 0], D = [-ow, y1, 0];
    const up = (p) => [p[0], p[1] + th, p[2]];
    if (sz > 0) quad(up(A), up(B), up(C), up(D), [0, 0], [2 * ow, 0], [2 * ow, L], [0, L]); else quad(up(B), up(A), up(D), up(C), [0, 0], [2 * ow, 0], [2 * ow, L], [0, L]);
    if (sz > 0) quad(B, A, D, C, [0, 0], [1, 0], [1, 1], [0, 1]); else quad(A, B, C, D, [0, 0], [1, 0], [1, 1], [0, 1]);
    if (sz > 0) quad(A, B, up(B), up(A), [0, 0], [1, 0], [1, 0.1], [0, 0.1]); else quad(B, A, up(A), up(B), [0, 0], [1, 0], [1, 0.1], [0, 0.1]);
  }
  const roof = new THREE.BufferGeometry(); roof.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3)); roof.setAttribute('uv', new THREE.Float32BufferAttribute(ruv, 2)); roof.computeVertexNormals();
  return { walls, roof };
}

export function createGroundSet(engine) {
  const scene = new THREE.Scene(); const r = rng(4242);
  const U = { uT: { value: 0 }, uFront: { value: -900 }, uLoose: { value: new THREE.Vector3() }, uCinch: { value: 900 }, uFlap: { value: 1 }, uPierce: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) } };

  // ---------------------------------------------------------------- sky: the cloth plane seen from far below
  const NP = ALL_PIERCES.length;
  const seamPts = ALL_PIERCES.map((p) => new THREE.Vector3(p.x, p.final ? 0 : (Math.cos(p.phi) > 0 ? 1 : -1), p.red ? 1 : 0));
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { ...U, uCam: { value: new THREE.Vector3() }, uPix: { value: 0.001 }, uStarGain: { value: 1 }, uTearGain: { value: 1 }, uSeam: { value: 0 }, uSeamPts: { value: seamPts }, uZig: { value: 40 }, uWide: { value: 1 }, uHorizon: { value: new THREE.Color(0.03, 0.045, 0.11) }, uGlow: { value: 1 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: /* glsl */ `
      varying vec3 vDir; uniform vec3 uCam; uniform float uPix, uStarGain, uTearGain, uSeam, uZig, uGlow, uWide; uniform vec3 uHorizon; uniform vec3 uSeamPts[${NP}];
      ${TEAR_GLSL}
      ${GLSL_NOISE}
      float segd(vec2 p, vec2 a, vec2 b){ vec2 pa=p-a, ba=b-a; float h=clamp(dot(pa,ba)/dot(ba,ba),0.0,1.0); return length(pa-ba*h); }
      void main(){
        vec3 d=normalize(vDir); vec3 col;
        float el=d.y;
        if(el>0.004){
          float tt=(SKY_H-uCam.y)/el; vec3 hp=uCam+d*tt; float x=hp.x, z=hp.z;
          float lat=z-seamZ(x); float w=gapW(x)*uWide*(1.0+0.3*sin(x*0.09+1.0)+0.18*sin(x*0.23+2.0)); float dd=abs(lat)-w; float ok=min(w/WMAX,1.3);
          float m1=fbm(hp.xz*0.0011+3.0), m2=fbm(hp.xz*0.0045+11.0);
          vec3 base=mix(vec3(0.006,0.009,0.03),vec3(0.022,0.03,0.09),smoothstep(0.25,0.75,m1));
          base+=vec3(0.02,0.005,0.032)*smoothstep(0.5,0.85,m2);
          col=base*1.25;
          // stars: glass beads, one per cell of the cloth
          float pr=tt*uPix;                         // metres per pixel at the hit
          for(int L=0;L<2;L++){ float cs=L==0?0.030:0.085; float sk=el+0.55; vec2 sg=d.xz/sk/cs; vec2 id=floor(sg); vec2 f=fract(sg);
            vec2 rnd=hash22(id+float(L)*71.0); float has=step(L==0?0.72:0.55,hash21(id*2.3+9.1+float(L)*5.0));
            float mag=pow(hash21(id*1.7+3.1+float(L)),L==0?4.0:2.0);
            vec2 c=(0.15+0.7*rnd); vec2 dl=(f-c)*cs*sk; float ang2=dot(dl,dl); float sr=uPix*(L==0?1.0:1.45);
            float tw=0.7+0.3*sin(uT*(1.5+rnd.x*3.0)+rnd.y*40.0);
            float keep=smoothstep(2.0,14.0,dd+(1.0-ok)*20.0);
            vec3 sc=mix(vec3(1.0,0.86,0.62),vec3(0.72,0.84,1.0),step(0.6,rnd.y));
            col+=sc*(exp(-ang2/(sr*sr))*(0.25+2.8*mag)+exp(-ang2/(sr*sr*9.0))*0.1*mag)*tw*uStarGain*keep*has*smoothstep(0.02,0.2,el); }
          // the tear
          if(dd<0.0){ float n=fbm(hp.xz*0.08+vec2(uT*0.3,0.0)); vec3 realm=mix(vec3(2.6,1.75,0.85),vec3(5.0,4.0,2.6),n)*1.5; col=realm*0.7*uTearGain*smoothstep(0.0,max(pr,0.8),-dd+pr*0.5); }
          else { col+=vec3(1.0,0.30,0.09)*ok*exp(-dd/9.0)*1.6*uTearGain; col+=vec3(1.0,0.72,0.38)*ok*exp(-dd/2.5)*3.0*uTearGain; col+=vec3(0.6,0.3,0.14)*ok*exp(-dd/70.0)*0.1*uTearGain*uGlow; }
          // the mended seam as a constellation (zigzag exaggerated so it reads from the ground)
          if(uSeam>0.0){ vec2 prev=vec2(0.0);
            float lw=max(pr*1.1,1.4);
            for(int i=0;i<${NP};i++){ vec3 sp=uSeamPts[i]; vec2 cur=vec2(sp.x+10.0*sin(sp.x*1.7), seamZ(sp.x)+sp.y*uZig*(0.8+0.4*fract(sin(sp.x*12.9898)*43758.5)));
              vec3 sc=sp.z>0.5?vec3(1.0,0.16,0.10):vec3(1.0,0.74,0.36);
              float tw=0.78+0.22*sin(uT*2.1+sp.x*0.37);
              float dp=length(hp.xz-cur); col+=sc*(exp(-dp*dp/(lw*lw*1.2))*5.5+exp(-dp*dp/(lw*lw*12.0))*0.25)*tw*uSeam;
              if(i>0){ float ds=segd(hp.xz,prev,cur); col+=sc*exp(-ds*ds/(lw*lw*0.45))*0.4*uSeam; }
              prev=cur; } }
          float hz=smoothstep(0.16,0.0,el); col=mix(col,uHorizon,hz*hz);
        } else { col=uHorizon*mix(1.0,0.45,smoothstep(0.0,0.4,-el)); }
        gl_FragColor=vec4(col,1.0); }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), skyMat); dome.frustumCulled = false; dome.renderOrder = -10; scene.add(dome);

  // ---------------------------------------------------------------- terrain
  // night snow: lit by the sky's cool ambience, only kissed by the gold of the tear (keeps the land from going beige)
  const terrainMat = new THREE.ShaderMaterial({
    uniforms: { uKeyDir: { value: new THREE.Vector3(0, 1, 0) }, uKeyGain: { value: 0.3 }, uAmb: { value: 1 } },
    vertexShader: 'attribute vec3 color; varying vec3 vN; varying vec3 vC; void main(){ vN = normal; vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vN; varying vec3 vC; uniform vec3 uKeyDir; uniform float uKeyGain, uAmb;
      void main(){ vec3 N = normalize(vN); float h = N.y * 0.5 + 0.5; vec3 amb = mix(vec3(0.012, 0.018, 0.05), vec3(0.075, 0.11, 0.27), h) * uAmb;
        float nl = max(dot(N, uKeyDir), 0.0); gl_FragColor = vec4(vC * (amb + vec3(1.0, 0.72, 0.42) * nl * uKeyGain), 1.0); }`,
  });
  { const N = 240, S = 11000; const g = new THREE.PlaneGeometry(S, S, N, N); g.rotateX(-Math.PI / 2);
    const p = g.attributes.position; const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      // concentrate resolution near the village
      let lx = p.getX(i) / (S / 2), lz = p.getZ(i) / (S / 2);
      lx = Math.sign(lx) * Math.pow(Math.abs(lx), 1.9) * (S / 2); lz = Math.sign(lz) * Math.pow(Math.abs(lz), 1.9) * (S / 2);
      const x = HOUSE.x + lx, z = HOUSE.z + lz; p.setXYZ(i, x, terrainH(x, z), z);
    }
    g.computeVertexNormals(); const n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const slope = n.getY(i); const snow = smoothstep(0.62, 0.86, slope + (noise2(p.getX(i) * 0.02, p.getZ(i) * 0.02) - 0.5) * 0.2);
      col[i * 3] = lerp(0.07, 0.62, snow); col[i * 3 + 1] = lerp(0.075, 0.68, snow); col[i * 3 + 2] = lerp(0.10, 0.82, snow);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const terrain = new THREE.Mesh(g, terrainMat); scene.add(terrain); }

  // ---------------------------------------------------------------- village
  const wallsG = [], roofsG = [], winP = [], winC = [];
  const tint = (g, c) => { const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), e4 = new THREE.Euler();
  const lanternPts = [];
  function addWindow(mat, lx, ly, lz, w, h, ry, lit) {
    const c = lit ? [3.4 + r() * 2.0, 1.9 + r() * 1.0, 0.7 + r() * 0.4] : [0.03, 0.04, 0.08];
    const hw = w / 2, hh = h / 2; const cs = Math.cos(ry), sn = Math.sin(ry);
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, -hh], [hw, hh], [-hw, hh]];
    for (const [a, b] of corners) { const v = new THREE.Vector3(lx + a * cs, ly + b, lz - a * sn).applyMatrix4(mat); winP.push(v.x, v.y, v.z); winC.push(...c); }
  }
  function addHouse(x, z, yaw, w, d, h, rise, hero = false) {
    const y = hero ? HOUSE.y : terrainH(x, z) - 0.4;
    const { walls, roof } = gableHouse(w, d, h, rise, hero ? 0.6 : 0.45);
    m4.compose(new THREE.Vector3(x, y, z), q4.setFromEuler(e4.set(0, yaw, 0)), new THREE.Vector3(1, 1, 1));
    const wc = [0.20 + r() * 0.08, 0.16 + r() * 0.05, 0.14 + r() * 0.04];
    wallsG.push(tint(walls.applyMatrix4(m4), wc));
    if (!hero) { roof.deleteAttribute('uv'); roofsG.push(tint(roof.applyMatrix4(m4), [0.5, 0.56, 0.72])); }
    const ch = new THREE.BoxGeometry(0.8, rise + 1.4, 0.8).translate(hero ? -w * 0.4 : w * 0.28, h + rise * 0.5 + 0.2, d * 0.18).toNonIndexed(); ch.deleteAttribute('uv');
    wallsG.push(tint(ch.applyMatrix4(m4), [0.16, 0.13, 0.12]));
    // windows on the long walls and gables
    const nW = Math.max(2, Math.round(w / 2.6));
    for (const sz of [-1, 1]) for (let i = 0; i < nW; i++) { const lx = (i + 0.5) / nW * w - w / 2; addWindow(m4, lx, h * 0.52, sz * (d / 2 + 0.03), 0.85, 1.15, sz > 0 ? 0 : Math.PI, r() < 0.62); }
    for (const sx of [-1, 1]) { addWindow(m4, sx * (w / 2 + 0.03), h * 0.52, 0, 0.9, 1.15, sx > 0 ? Math.PI / 2 : -Math.PI / 2, r() < 0.6); addWindow(m4, sx * (w / 2 + 0.03), h + rise * 0.38, 0, 0.6, 0.7, sx > 0 ? Math.PI / 2 : -Math.PI / 2, r() < 0.5); }
    return { x, y, z, yaw, w, d, h, rise, m: m4.clone() };
  }
  const houses = [];
  const hero = addHouse(HOUSE.x, HOUSE.z, HOUSE.yaw, HOUSE.w, HOUSE.d, HOUSE.wallH, HOUSE.rise, true);
  // a street winding away downhill in front of the hero house, plus scattered homes
  for (let i = 0; i < 64; i++) {
    let x, z, ok = false, tries = 0;
    while (!ok && tries++ < 40) {
      const a = (r() - 0.5) * 2.6 + HOUSE.yaw * 0.0, dist = 16 + Math.pow(r(), 0.8) * 330;
      x = HOUSE.x + Math.sin(a) * dist + (r() - 0.5) * 30; z = HOUSE.z + Math.cos(a) * dist * (r() < 0.82 ? 1 : -0.5);
      ok = houses.every((h) => Math.hypot(h.x - x, h.z - z) > 13) && Math.hypot(x - HOUSE.x, z - HOUSE.z) > 15;
    }
    if (!ok) continue;
    houses.push(addHouse(x, z, r() * Math.PI, 6 + r() * 4, 5 + r() * 2.5, 3.4 + r() * 1.8, 2.2 + r() * 1.4));
  }
  const wallMesh = new THREE.Mesh(mergeGeometries(wallsG), toonMat({ vertexColors: true, roughness: 0.9, rim: 0.25 })); wallMesh.castShadow = wallMesh.receiveShadow = true; scene.add(wallMesh);
  const roofMesh = new THREE.Mesh(mergeGeometries(roofsG), toonMat({ vertexColors: true, roughness: 0.85, rim: 0.5, rimPower: 2.0 })); roofMesh.castShadow = roofMesh.receiveShadow = true; scene.add(roofMesh);
  const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(winP, 3)); wg.setAttribute('color', new THREE.Float32BufferAttribute(winC, 3));
  const winMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }); scene.add(new THREE.Mesh(wg, winMat));

  // hero roof: shingles with snow, a ridge beam to sit on
  { const { roof } = gableHouse(HOUSE.w, HOUSE.d, HOUSE.wallH, HOUSE.rise, 0.6);
    const tex = canvasTex(1024, 1024, (c, W, Hh) => {
      c.fillStyle = '#39405e'; c.fillRect(0, 0, W, Hh); const rows = 14, cols = 12, rr = rng(9);
      for (let j = 0; j < rows; j++) for (let i = -1; i < cols; i++) {
        const x = (i + (j % 2) * 0.5) * W / cols, y = Hh - (j + 1) * Hh / rows, w = W / cols, h = Hh / rows;
        const k = rr(); c.fillStyle = `rgb(${52 + k * 26},${58 + k * 26},${88 + k * 30})`;
        c.beginPath(); c.moveTo(x + 2, y); c.lineTo(x + w - 2, y); c.lineTo(x + w - 2, y + h * 0.75); c.quadraticCurveTo(x + w / 2, y + h * 1.12, x + 2, y + h * 0.75); c.closePath(); c.fill();
        c.strokeStyle = 'rgba(8,10,24,0.75)'; c.lineWidth = 3; c.stroke();
        // snow settled on each shingle's upper lip
        c.fillStyle = `rgba(214,226,255,${0.35 + rr() * 0.5})`; c.beginPath(); c.ellipse(x + w / 2, y + h * 0.12, w * 0.46, h * (0.10 + rr() * 0.16), 0, 0, 6.283); c.fill();
      }
      const g = c.createLinearGradient(0, 0, 0, Hh); g.addColorStop(0, 'rgba(225,234,255,0.92)'); g.addColorStop(0.16, 'rgba(225,234,255,0.5)'); g.addColorStop(0.4, 'rgba(225,234,255,0.0)'); c.fillStyle = g; c.fillRect(0, 0, W, Hh);
    }, { repeat: true });
    tex.repeat.set(1 / 4.2, 1 / 5.2);
    const mesh = new THREE.Mesh(roof, toonMat({ map: tex, roughness: 0.8, rim: 0.6, rimPower: 2.2 })); mesh.applyMatrix4(hero.m); mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(HOUSE.w + 1.3, 0.2, 0.42), toonMat({ color: 0xcfd9f2, roughness: 0.9, rim: 0.6 })); beam.position.set(0, HOUSE.ridgeY + 0.22, 0); beam.applyMatrix4(hero.m); beam.castShadow = beam.receiveShadow = true; scene.add(beam);
    // soft snow cap along the ridge
    const snow = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, HOUSE.w + 0.9, 6, 16).rotateZ(Math.PI / 2).scale(1, 0.5, 1.25), toonMat({ color: 0xdfe8ff, roughness: 1.0, rim: 0.7, sss: 0x3355aa })); snow.position.set(0, HOUSE.ridgeY + 0.3, 0); snow.applyMatrix4(hero.m); snow.receiveShadow = true; scene.add(snow);
  }

  // lantern strings between neighbouring houses
  { const pts = []; const near = houses.filter((h) => Math.hypot(h.x - HOUSE.x, h.z - HOUSE.z) < 260);
    for (let i = 0; i < near.length; i++) { const a = near[i]; let best = null, bd = 1e9;
      for (const b of near) { if (b === a) continue; const d = Math.hypot(a.x - b.x, a.z - b.z); if (d < bd && d > 12 && r() < 0.8) { bd = d; best = b; } }
      if (!best || bd > 70) continue;
      const n = Math.max(5, Math.round(bd / 3.2)); const ya = a.y + a.h + 0.4, yb = best.y + best.h + 0.4;
      for (let k = 1; k < n; k++) { const f = k / n; pts.push(new THREE.Vector3(lerp(a.x, best.x, f), lerp(ya, yb, f) - Math.sin(Math.PI * f) * bd * 0.07, lerp(a.z, best.z, f))); } }
    const lm = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), pts.length);
    const c = new THREE.Color(); pts.forEach((p, i) => { m4.makeTranslation(p.x, p.y, p.z); lm.setMatrixAt(i, m4); const k = r(); c.setRGB(4.5 + k * 2.5, 2.2 + k * 1.4, 0.7 + k * 0.5); lm.setColorAt(i, c); });
    lm.frustumCulled = false; scene.add(lm); lanternPts.push(...pts); }

  // pines
  { const tiers = [0, 1, 2].map((i) => new THREE.ConeGeometry(2.2 - i * 0.55, 3.6, 7).translate(0, 2.6 + i * 2.1, 0).toNonIndexed());
    const g = mergeGeometries(tiers); g.deleteAttribute('uv'); const n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const up = g.attributes.normal.getY(i) > 0.3 ? 1 : 0; const yy = g.attributes.position.getY(i); const s = up * smoothstep(1.0, 3.0, (yy % 2.1)); col[i * 3] = lerp(0.03, 0.5, s * 0.6); col[i * 3 + 1] = lerp(0.06, 0.56, s * 0.6); col[i * 3 + 2] = lerp(0.07, 0.72, s * 0.6); }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const N = 520; const im = new THREE.InstancedMesh(g, toonMat({ vertexColors: true, roughness: 0.95, rim: 0.3 }), N); let k = 0;
    for (let i = 0; i < N * 4 && k < N; i++) { const a = r() * 6.283, d = 26 + Math.pow(r(), 0.6) * 900; const x = HOUSE.x + Math.cos(a) * d, z = HOUSE.z + Math.sin(a) * d;
      if (houses.some((h) => Math.hypot(h.x - x, h.z - z) < 9)) continue; if (noise2(x * 0.01, z * 0.01) < 0.42 && d < 400) continue;
      const s = 0.7 + r() * 1.1; m4.compose(new THREE.Vector3(x, terrainH(x, z) - 0.5, z), q4.setFromEuler(e4.set(0, r() * 6.28, 0)), new THREE.Vector3(s, s * (0.9 + r() * 0.5), s)); im.setMatrixAt(k++, m4); }
    im.count = k; im.castShadow = true; im.frustumCulled = false; scene.add(im); }

  // ---------------------------------------------------------------- falling stars
  const falls = new FatLine(600, { width: 0.5, minPx: 1.3 * engine.k }); falls.setRes(engine.width, engine.height); scene.add(falls.mesh);
  const glints = new Sprites(400, { additive: true, minPx: 2.2 * engine.k, soft: 2.2 }); glints.setRes(engine.width, engine.height); scene.add(glints.points);
  const fallSeeds = Array.from({ length: 70 }, () => ({ x: lerp(-580, 300, r()), ph: r(), period: 2.8 + r() * 5, dx: (r() - 0.5) * 0.5 - 0.15, dz: (r() - 0.3) * -0.7, sp: 240 + r() * 240, s: 0.5 + r() * 0.9, len: 0.12 + r() * 0.1 }));

  // ---------------------------------------------------------------- lights
  const key = new THREE.DirectionalLight(0xffc880, 1.2); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 120 }); key.shadow.bias = -0.0006; key.shadow.normalBias = 0.04;
  const hemi = new THREE.HemisphereLight(0x27306a, 0x0a0c1c, 1.0);
  const lamp = new THREE.PointLight(0xffc070, 0, 6, 1);
  scene.add(key, key.target, hemi, lamp);
  const tearCenter = new THREE.Vector3(TEAR.xc, H, 0);
  const v = new THREE.Vector3(), v2 = new THREE.Vector3();

  const api = {
    scene, U, dome, skyMat, key, hemi, lamp, houses, hero, lanternPts, tearCenter, winMat,
    ridgePoint(lx = 0, out = new THREE.Vector3()) { return out.set(lx, HOUSE.ridgeY + 0.36, 0).applyMatrix4(hero.m); },
    /** opts: tearT (time used for the seam state), starGain, tearGain, seam (0..1 constellation), fallGain, glow */
    update(t, camera, o = {}) {
      const st = seamState(o.tearT ?? t);
      U.uT.value = t; U.uFront.value = st.front; U.uLoose.value.set(st.looseX0, st.looseX1, st.looseAmt); U.uCinch.value = st.cinch; U.uFlap.value = st.flap;
      const u = skyMat.uniforms; u.uCam.value.copy(camera.position); u.uPix.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / engine.height;
      u.uStarGain.value = o.starGain ?? 1; u.uTearGain.value = o.tearGain ?? 1; u.uSeam.value = o.seam ?? 0; u.uGlow.value = o.glow ?? 1; u.uWide.value = o.wide ?? 1;
      dome.position.copy(camera.position); dome.scale.setScalar(camera.far * 0.9);
      // key light from the tear toward the village
      const tg = o.focus || api.ridgePoint(0, v2);
      v.copy(tearCenter).sub(tg).normalize(); terrainMat.uniforms.uKeyDir.value.copy(v); terrainMat.uniforms.uKeyGain.value = (o.landGold ?? 0.3) * Math.min(1, key.intensity); key.target.position.copy(tg); key.position.copy(tg).addScaledVector(v, 60);
      // falling stars
      falls.begin(); glints.begin(); const fg = o.fallGain ?? 0;
      if (fg > 0) for (let i = 0; i < fallSeeds.length; i++) {
        const f = fallSeeds[i]; if (i / fallSeeds.length > fg) break;
        const c = t / f.period + f.ph, age = (c - Math.floor(c)) * f.period, cyc = Math.floor(c);
        const x0 = f.x + ((cyc * 131.7) % 80) - 40; const dir = v.set(f.dx + Math.sin(cyc * 3.1) * 0.2, -1, f.dz + Math.cos(cyc * 1.7) * 0.25).normalize();
        const travel = age * f.sp; const yEnd = 1260; if (travel > yEnd) continue;
        const A = sat(age * 4) * sat((yEnd - travel) / 200);
        const hx = x0 + dir.x * travel, hy = H - 4 + dir.y * travel, hz = seamZ(x0) + dir.z * travel; const tl = f.len * f.sp;
        falls.push(hx - dir.x * tl, hy - dir.y * tl, hz - dir.z * tl, 0, 0, 0, 0); falls.push(hx - dir.x * tl, hy - dir.y * tl, hz - dir.z * tl, 1.2, 0.7, 0.3, 0);
        falls.push(hx, hy, hz, 4.0 * A, 3.0 * A, 1.7 * A, 1); falls.push(hx, hy, hz, 0, 0, 0, 0);
        glints.push(hx, hy, hz, 3.0 * f.s, 5 * A, 3.8 * A, 2.2 * A, 1);
      }
      falls.end(); glints.end();
    },
  };
  return api;
}
