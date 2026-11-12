// Small reusable render primitives: fat glowing lines (thread), CPU-driven additive sprites, star beads.
import * as THREE from 'three';
import { toonMat, softDotTex } from './materials.js';

// ---- FatLine: a polyline with a minimum on-screen width, additive glow. Points with alpha 0 break the strip.
export class FatLine {
  constructor(maxPts, { width = 0.05, minPx = 1.4, gain = 1.0, depthTest = true } = {}) {
    this.max = maxPts; this.n = 0;
    const g = this.geometry = new THREE.BufferGeometry();
    const mk = (n) => { const a = new THREE.BufferAttribute(new Float32Array(maxPts * 2 * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    this.pos = mk(3); this.prev = mk(3); this.next = mk(3); this.col = mk(4);
    const side = new Float32Array(maxPts * 2); for (let i = 0; i < maxPts; i++) { side[i * 2] = -1; side[i * 2 + 1] = 1; }
    g.setAttribute('position', this.pos); g.setAttribute('aPrev', this.prev); g.setAttribute('aNext', this.next); g.setAttribute('aCol', this.col);
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    const idx = new Uint32Array((maxPts - 1) * 6);
    for (let i = 0; i < maxPts - 1; i++) { const a = i * 2; idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6); }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uRes: { value: new THREE.Vector2(1920, 804) }, uWidth: { value: width }, uMinPx: { value: minPx }, uGain: { value: gain } },
      vertexShader: /* glsl */ `
        attribute vec3 aPrev; attribute vec3 aNext; attribute float aSide; attribute vec4 aCol;
        uniform vec2 uRes; uniform float uWidth; uniform float uMinPx; varying vec4 vCol; varying float vS;
        void main(){
          mat4 m=projectionMatrix*modelViewMatrix;
          vec4 c=m*vec4(position,1.0), p=m*vec4(aPrev,1.0), n=m*vec4(aNext,1.0);
          vec2 cs=c.xy/c.w*uRes*0.5, ps=p.xy/p.w*uRes*0.5, ns=n.xy/n.w*uRes*0.5;
          vec2 dv=(n.w>0.0&&p.w>0.0)?ns-ps:(n.w>0.0?ns-cs:cs-ps);
          vec2 dir=normalize(dv+vec2(1e-4,0.0)); vec2 nrm=vec2(-dir.y,dir.x);
          float px=uWidth*uRes.y*0.5*projectionMatrix[1][1]/max(c.w,1e-3);
          float w=max(px,uMinPx);
          c.xy+=nrm*aSide*w*2.0/uRes*c.w;
          vCol=aCol; vCol.a*=clamp(px/uMinPx,0.3,1.0); vS=aSide;
          gl_Position=c;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uGain; varying vec4 vCol; varying float vS;
        void main(){ float pr=exp(-vS*vS*2.6); gl_FragColor=vec4(vCol.rgb*vCol.a*pr*uGain,1.0); }`,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest, transparent: true, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material); this.mesh.frustumCulled = false; this.mesh.renderOrder = 20;
  }
  begin() { this.n = 0; }
  /** push a point; a = alpha (0 breaks the strip) */
  push(x, y, z, r, g, b, a = 1) {
    if (this.n >= this.max) return;
    const i = this.n * 2;
    this.pos.setXYZ(i, x, y, z); this.pos.setXYZ(i + 1, x, y, z);
    this.col.setXYZW(i, r, g, b, a); this.col.setXYZW(i + 1, r, g, b, a);
    this.n++;
  }
  end() {
    const n = this.n, P = this.pos.array;
    for (let k = 0; k < n; k++) {
      const a = Math.max(k - 1, 0) * 6, b = Math.min(k + 1, n - 1) * 6, i = k * 6;
      for (let j = 0; j < 6; j++) { this.prev.array[i + j] = P[a + (j % 3)]; this.next.array[i + j] = P[b + (j % 3)]; }
    }
    for (const a of [this.pos, this.prev, this.next, this.col]) a.needsUpdate = true;
    this.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
  }
  setRes(w, h) { this.material.uniforms.uRes.value.set(w, h); }
}

// ---- Sprites: CPU-updated additive (or alpha) point sprites with world-space size
export class Sprites {
  constructor(max, { additive = true, minPx = 0, soft = 2.0, depthTest = true } = {}) {
    this.max = max; this.n = 0;
    const g = this.geometry = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(max * 3), 3); this.col = new THREE.BufferAttribute(new Float32Array(max * 4), 4); this.size = new THREE.BufferAttribute(new Float32Array(max), 1);
    for (const a of [this.pos, this.col, this.size]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.pos); g.setAttribute('aCol', this.col); g.setAttribute('aSize', this.size);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uH: { value: 804 }, uMinPx: { value: minPx }, uMap: { value: softDotTex(64, soft) } },
      vertexShader: /* glsl */ `attribute vec4 aCol; attribute float aSize; uniform float uH; uniform float uMinPx; varying vec4 vCol;
        void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mv;
          float px=aSize*uH*0.5*projectionMatrix[1][1]/max(gl_Position.w,1e-3);
          float s=max(px,uMinPx); vCol=aCol; if(px<uMinPx) vCol.a*=max(px/uMinPx,0.2);
          gl_PointSize=min(s,256.0); if(s>256.0) vCol.a*=1.0; }`,
      fragmentShader: /* glsl */ `uniform sampler2D uMap; varying vec4 vCol;
        void main(){ float a=texture2D(uMap,gl_PointCoord).a; ${additive ? 'gl_FragColor=vec4(vCol.rgb*vCol.a*a,1.0);' : 'gl_FragColor=vec4(vCol.rgb,vCol.a*a);'} }`,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false, depthTest, transparent: true,
    });
    this.points = new THREE.Points(g, this.material); this.points.frustumCulled = false; this.points.renderOrder = 22;
  }
  begin() { this.n = 0; }
  push(x, y, z, size, r, g, b, a = 1) {
    if (this.n >= this.max) return; const i = this.n++;
    this.pos.setXYZ(i, x, y, z); this.col.setXYZW(i, r, g, b, a); this.size.setX(i, size);
  }
  end() { this.pos.needsUpdate = this.col.needsUpdate = this.size.needsUpdate = true; this.geometry.setDrawRange(0, this.n); }
  setRes(w, h) { this.material.uniforms.uH.value = h; }
}

// ---- Star bead: a faceted glass bead with a glowing heart, a brass cap and a (possibly snapped) thread.
// Origin at the bead centre. Radius in metres (the real ones are marble sized).
let beadMats = null;
export function createBead({ radius = 0.022, thread = 0.4, frayed = false, glow = 1.0 } = {}) {
  if (!beadMats) {
    beadMats = {
      shell: new THREE.MeshPhysicalMaterial({ color: 0xfff6e0, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.38, envMapIntensity: 2.2, flatShading: true, depthWrite: false, side: THREE.DoubleSide, specularIntensity: 1.0 }),
      brass: toonMat({ color: 0xd8a24a, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.2 }),
      thread: new THREE.MeshStandardMaterial({ color: 0xe9dcc0, roughness: 0.9, emissive: new THREE.Color(0.35, 0.28, 0.16) }),
    };
  }
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(radius * 0.62, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(9.0, 6.6, 3.4).multiplyScalar(glow) }));
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 1), beadMats.shell); shell.renderOrder = 5;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.32, radius * 0.42, radius * 0.5, 10), beadMats.brass); cap.position.y = radius * 1.02;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.22, radius * 0.07, 6, 14), beadMats.brass); ring.position.y = radius * 1.42;
  g.add(core, shell, cap, ring);
  let th = null;
  if (thread > 0) {
    const N = 10, pts = [];
    for (let i = 0; i <= N; i++) { const k = i / N; pts.push(new THREE.Vector3(frayed ? Math.sin(k * 5.0) * radius * 1.4 * k : 0, radius * 1.5 + k * thread, frayed ? Math.cos(k * 3.7) * radius * 1.0 * k : 0)); }
    th = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, radius * 0.07, 5), beadMats.thread); g.add(th);
  }
  g.userData = { core, shell, radius, thread };
  return g;
}
