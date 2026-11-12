// SKY SET: the underside (and topside) of the velvet night sky around the tear.
// Cloth lips, the light beyond, hanging shafts of light, star beads, lint, thread and stitches.
import * as THREE from 'three';
import { GLSL_NOISE, rng, sat, lerp, smoothstep, ease } from './lib.js';
import { FatLine, Sprites, createBead } from './prims.js';
import { H, TEAR, TEAR_GLSL, PIERCES, RED_PIERCES, FINAL_PIERCE, ALL_PIERCES, T, seamState, seamZ, gapW, clothAt, threadPoint, piercePoint, stitchPathPos } from './tear.js';

const GOLD = [1.0, 0.70, 0.28], RED = [1.0, 0.09, 0.07];

export function createSkySet(engine) {
  const scene = new THREE.Scene();
  const U = {
    uT: { value: 0 }, uFront: { value: -900 }, uLoose: { value: new THREE.Vector3() }, uCinch: { value: 900 }, uFlap: { value: 1 },
    uPierce: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, uSun: { value: new THREE.Vector3(0.8, 0.22, 0.55).normalize() },
  };

  // ---------------------------------------------------------------- backdrop: the light beyond (up) / night (down)
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { uT: U.uT, uSun: U.uSun, uRealm: { value: 1 }, uNight: { value: 1 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0); gl_Position = p.xyww; }',
    fragmentShader: /* glsl */ `varying vec3 vDir; uniform float uT, uRealm, uNight; uniform vec3 uSun; ${GLSL_NOISE}
      void main(){ vec3 d=normalize(vDir); vec3 col;
        if(d.y>0.0){ vec2 q=d.xz/(d.y+0.18);
          float n=fbm(q*1.3+vec2(uT*0.02,0.0)); float n2=fbm(q*3.7-vec2(0.0,uT*0.04)+5.0);
          vec3 zen=vec3(1.7,1.35,0.85), mid=vec3(1.35,0.80,0.34), hor=vec3(1.0,0.38,0.12);
          col=mix(hor,mid,smoothstep(0.0,0.22,d.y)); col=mix(col,zen,smoothstep(0.15,0.8,d.y));
          float band=smoothstep(0.42,0.72,n)*(1.0-smoothstep(0.02,0.55,d.y)); col=mix(col,col*vec3(0.5,0.38,0.36),band*0.75);
          col+=vec3(0.9,0.75,0.5)*pow(n2,3.0)*smoothstep(0.1,0.6,d.y);
          float sd=max(dot(d,uSun),0.0); col+=vec3(5.0,3.6,1.9)*pow(sd,220.0)+vec3(1.5,0.95,0.42)*pow(sd,16.0)*(1.0-band*0.5)+vec3(0.45,0.26,0.1)*pow(sd,3.0);
          col*=uRealm;
        } else { float h=-d.y;
          col=mix(vec3(0.016,0.024,0.065),vec3(0.003,0.005,0.016),smoothstep(0.0,0.55,h));
          col+=vec3(0.02,0.045,0.075)*exp(-h*16.0);
          col*=uNight; }
        gl_FragColor=vec4(col,1.0); }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), domeMat); dome.frustumCulled = false; dome.renderOrder = -10; scene.add(dome);

  // ---------------------------------------------------------------- cloth lips
  const xs = []; { let x = -770; while (x <= 480) { xs.push(x); x += 3; } let st = 4, xl = -770, xr = xs[xs.length - 1]; const L = [], R = [];
    while (xl > -32000) { st *= 1.2; xl -= st; L.push(xl); } st = 4; while (xr < 32000) { st *= 1.2; xr += st; R.push(xr); }
    xs.unshift(...L.reverse()); xs.push(...R); }
  const ds = [0]; { let d = 0, st = 0.35; while (d < 32000) { d += st; ds.push(d); st *= 1.2; } }
  const NX = xs.length, ND = ds.length;
  const cp = new Float32Array(NX * ND * 3); const ci = [];
  for (let j = 0; j < ND; j++) for (let i = 0; i < NX; i++) { const k = (j * NX + i) * 3; cp[k] = xs[i]; cp[k + 1] = ds[j]; cp[k + 2] = 0; }
  for (let j = 0; j < ND - 1; j++) for (let i = 0; i < NX - 1; i++) { const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1; ci.push(a, c, b, b, c, d); }
  const clothGeo = new THREE.BufferGeometry(); clothGeo.setAttribute('position', new THREE.BufferAttribute(cp, 3)); clothGeo.setIndex(ci);
  const clothUniforms = (side) => ({ ...U, uSide: { value: side }, uAmb: { value: 1 }, uSheenCol: { value: new THREE.Color(0.05, 0.07, 0.2) }, uSeamGlow: { value: 0.6 }, uTopGain: { value: 1 }, uEdgeGain: { value: 1 }, uLamp: { value: new THREE.Vector4(0, 0, 0, 0) }, uLampCol: { value: new THREE.Color(1.0, 0.75, 0.45) } });
  const clothVert = /* glsl */ `
    ${TEAR_GLSL}
    uniform float uSide; varying vec3 vW; varying vec3 vN; varying float vD; varying float vOk; varying float vClose;
    vec3 P(float x, float d){ float z=seamZ(x)+uSide*(gapW(x)+d); return vec3(x, clothY(x,z,d,uSide), z); }
    void main(){ float x=position.x, d=position.y; vec3 p=P(x,d); float e=max(0.6,d*0.04);
      vec3 px=P(x+e,d), pd=P(x,d+e); vN=normalize(cross(pd-p,px-p)*uSide);
      vW=p; vD=d; vOk=gapW(x)/WMAX; vClose=closeAmt(x)*smoothstep(0.0,1.0,baseW(x));
      gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0); }`;
  const clothFrag = /* glsl */ `
    uniform float uSide, uAmb, uSeamGlow, uTopGain, uEdgeGain, uT; uniform vec3 uSun; uniform vec3 uSheenCol; uniform vec4 uLamp; uniform vec3 uLampCol;
    varying vec3 vW; varying vec3 vN; varying float vD; varying float vOk; varying float vClose;
    ${GLSL_NOISE}
    void main(){
      float fr=0.2+1.2*vnoise(vec2(vW.x*1.7,uSide*3.0))+0.5*vnoise(vec2(vW.x*7.0,9.0+uSide));
      if(vD<fr*0.8*smoothstep(0.02,0.3,vOk)) discard;
      vec3 N=normalize(vN); vec3 Vv=cameraPosition-vW; float dist=length(Vv); vec3 V=Vv/dist;
      float ndv=dot(N,V); float near=1.0-smoothstep(20.0,120.0,dist);
      float wv=0.0;
      if(near>0.0){ float fine=1.0-smoothstep(2.5,9.0,dist); vec2 q=vW.xz*310.0; wv=sin(q.x+q.y)*sin(q.x-q.y)*0.55*fine+(vnoise(vW.xz*3.1)-0.5)*0.9+(vnoise(vW.xz*17.0)-0.5)*0.5*fine; wv*=near; }
      vec3 col;
      if(ndv<0.0){
        float m1=fbm(vW.xz*0.0011+3.0), m2=fbm(vW.xz*0.0045+11.0);
        vec3 base=mix(vec3(0.006,0.009,0.03),vec3(0.022,0.03,0.09),smoothstep(0.25,0.75,m1));
        base+=vec3(0.02,0.005,0.032)*smoothstep(0.5,0.85,m2);
        float sheen=pow(1.0+ndv,2.5);
        col=base*(1.0+0.4*wv)*uAmb+uSheenCol*sheen*(0.4+0.3*wv)*uAmb;
        col+=vec3(1.0,0.30,0.09)*vOk*exp(-vD/9.0)*1.5*(0.75+0.25*wv)*uEdgeGain;
        col+=vec3(1.0,0.72,0.38)*vOk*exp(-vD/2.2)*3.2*uEdgeGain;
        col+=vec3(0.5,0.2,0.12)*vOk*exp(-vD/60.0)*0.1*uEdgeGain;
        col+=vec3(1.0,0.5,0.2)*vClose*(1.0-vOk)*exp(-vD/1.3)*uSeamGlow;
        // a local warm lamp (hero bead / thread glow) so close-ups have shape
        if(uLamp.w>0.0){ vec3 L=uLamp.xyz-vW; float dl=length(L); float nl=max(dot(-N,L/dl),0.0);
          col+=uLampCol*(base*7.0+0.012)*(1.0+0.6*wv)*nl*uLamp.w/(1.0+dl*dl*0.06); }
      } else {
        vec3 satin=vec3(0.80,0.56,0.30);
        float nl=max(dot(N,uSun),0.0); float upf=clamp(N.y,0.0,1.0); vec3 Hh=normalize(V+uSun); float sp=pow(max(dot(N,Hh),0.0),60.0);
        col=satin*(0.26*upf+1.6*nl)*(1.0+0.2*wv)+vec3(1.0,0.85,0.6)*sp*2.2+vec3(1.0,0.75,0.45)*pow(1.0-ndv,4.0)*0.5;
        col*=uTopGain;
      }
      gl_FragColor=vec4(col,1.0); }`;
  const lips = [1, -1].map((side) => {
    const m = new THREE.Mesh(clothGeo, new THREE.ShaderMaterial({ uniforms: clothUniforms(side), vertexShader: clothVert, fragmentShader: clothFrag, side: THREE.DoubleSide }));
    m.frustumCulled = false; scene.add(m); return m;
  });

  // ---------------------------------------------------------------- hanging shafts of light under the tear
  const curtains = [];
  { const xsC = []; for (let x = -640; x <= 350; x += 5) xsC.push(x); const NV = 14;
    const p = new Float32Array(xsC.length * (NV + 1) * 3), ix = [];
    for (let j = 0; j <= NV; j++) for (let i = 0; i < xsC.length; i++) { const k = (j * xsC.length + i) * 3; p[k] = xsC[i]; p[k + 1] = j / NV; }
    for (let j = 0; j < NV; j++) for (let i = 0; i < xsC.length - 1; i++) { const a = j * xsC.length + i, b = a + 1, c = a + xsC.length, d = c + 1; ix.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setIndex(ix);
    const offs = [-0.75, -0.35, 0.05, 0.4, 0.8];
    offs.forEach((off, n) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...U, uOff: { value: off }, uSlant: { value: (n - 2) * 0.05 + 0.04 }, uGain: { value: 1 }, uFall: { value: 520 }, uCol: { value: new THREE.Color(1.0, 0.68, 0.32) } },
        vertexShader: /* glsl */ `${TEAR_GLSL}
          uniform float uOff, uSlant; varying vec3 vW; varying float vOk; varying float vDepth; varying float vX;
          void main(){ float x=position.x; float w=gapW(x); float depth=position.y*position.y*1500.0;
            float z=seamZ(x)+uOff*w+uSlant*depth+sin(x*0.02+uOff*9.0)*depth*0.03;
            vec3 p=vec3(x-depth*0.12, SKY_H-5.0*w/WMAX-depth, z);
            vW=p; vOk=w/WMAX; vDepth=depth; vX=x; gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0); }`,
        fragmentShader: /* glsl */ `uniform float uOff, uGain, uFall, uT; uniform vec3 uCol; varying vec3 vW; varying float vOk; varying float vDepth; varying float vX; ${GLSL_NOISE}
          void main(){ float s=0.5+0.5*sin(vX*0.13+uOff*5.0+sin(vX*0.031+uOff)*3.0); s=0.25+0.75*s*s; s*=0.55+0.45*vnoise(vec2(vX*0.35+uOff*7.0,uT*0.35));
            vec3 Vv=cameraPosition-vW; float dist=length(Vv); vec3 V=Vv/dist;
            float a=vOk*s*exp(-vDepth/uFall)*uGain*mix(0.22,1.0,abs(V.z))*smoothstep(3.0,45.0,dist)*smoothstep(0.0,25.0,vDepth+6.0);
            gl_FragColor=vec4(uCol*a,1.0); }`,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 8; scene.add(m); curtains.push(m);
    });
  }

  // ---------------------------------------------------------------- stars: glass beads sewn to the cloth (far ones are just glints)
  const NSTAR = 11000; const sp = new Float32Array(NSTAR * 3), ss = new Float32Array(NSTAR * 4); const r = rng(77);
  for (let i = 0; i < NSTAR; i++) {
    const far = i > NSTAR * 0.45; const rad = far ? 14000 : 2600;
    sp[i * 3] = TEAR.xc + (r() * 2 - 1) * rad * (far ? 1 : 0.9); sp[i * 3 + 1] = 2 + Math.pow(r(), far ? 1.0 : 1.5) * rad; sp[i * 3 + 2] = r() < 0.5 ? 1 : -1;
    ss[i * 4] = 0.35 + Math.pow(r(), 3.0) * 1.6; ss[i * 4 + 1] = r() * 6.28; ss[i * 4 + 2] = 0.25 + r() * 1.6; ss[i * 4 + 3] = r();
  }
  const starGeo = new THREE.BufferGeometry(); starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3)); starGeo.setAttribute('aSeed', new THREE.BufferAttribute(ss, 4));
  const starMat = new THREE.ShaderMaterial({
    uniforms: { ...U, uH: { value: engine.height }, uGain: { value: 1 }, uMinPx: { value: 2.4 * engine.k }, uSwing: { value: new THREE.Vector4(0, 0, 0, 0) } },
    vertexShader: /* glsl */ `${TEAR_GLSL}
      attribute vec4 aSeed; uniform float uH, uMinPx; uniform vec4 uSwing; varying vec3 vCol; varying float vA;
      void main(){ float x=position.x, d=position.y, side=position.z; float z=seamZ(x)+side*(gapW(x)+d);
        float sw=uSwing.w*exp(-max(0.0,(uT-uSwing.z))*0.5)*sin((uT-uSwing.z)*3.2-distance(vec2(x,z),uSwing.xy)*0.004+aSeed.y);
        vec3 p=vec3(x+sw*aSeed.z*0.5, clothY(x,z,d,side)-aSeed.z*(1.0-0.1*abs(sw)), z+sw*aSeed.z*0.3);
        gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0);
        float px=0.55*aSeed.x*uH*0.5*projectionMatrix[1][1]/max(gl_Position.w,1e-3);
        float s=max(px*2.0,uMinPx); float tw=0.72+0.28*sin(uT*(1.5+aSeed.w*3.0)+aSeed.y*7.0);
        vA=aSeed.x*tw*clamp(px*2.0/uMinPx,0.12,1.0)*exp(-gl_Position.w/2000.0)*(1.0-smoothstep(5000.0,8000.0,gl_Position.w));
        vCol=mix(vec3(1.0,0.86,0.62),vec3(0.72,0.84,1.0),step(0.62,aSeed.w))+vec3(0.15)*step(0.9,aSeed.w);
        gl_PointSize=min(s,64.0); }`,
    fragmentShader: /* glsl */ `uniform float uGain; varying vec3 vCol; varying float vA;
      void main(){ vec2 c=gl_PointCoord-0.5; float r2=dot(c,c)*4.0; float a=exp(-r2*5.0)*0.7+exp(-r2*40.0)*2.2; a*=smoothstep(1.0,0.6,r2);
        gl_FragColor=vec4(vCol*a*vA*uGain*1.5,1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  const stars = new THREE.Points(starGeo, starMat); stars.frustumCulled = false; stars.renderOrder = 6; scene.add(stars);

  // ---------------------------------------------------------------- lint: gold dust streaming out of the tear
  const NL = 7000; const lp = new Float32Array(NL * 3), ls = new Float32Array(NL * 4);
  for (let i = 0; i < NL; i++) { ls[i * 4] = r(); ls[i * 4 + 1] = r(); ls[i * 4 + 2] = r(); ls[i * 4 + 3] = r(); }
  const lintGeo = new THREE.BufferGeometry(); lintGeo.setAttribute('position', new THREE.BufferAttribute(lp, 3)); lintGeo.setAttribute('aSeed', new THREE.BufferAttribute(ls, 4));
  const lintMat = new THREE.ShaderMaterial({
    uniforms: { ...U, uH: { value: engine.height }, uCamX: { value: 0 }, uGain: { value: 1 }, uSpan: { value: 520 }, uMinPx: { value: 1.5 * engine.k } },
    vertexShader: /* glsl */ `${TEAR_GLSL}
      attribute vec4 aSeed; uniform float uH, uCamX, uSpan, uMinPx; varying float vA;
      void main(){ float life=2.6+aSeed.w*3.0; float c=uT/life+aSeed.x; float ph=fract(c); float cyc=floor(c);
        float x=uCamX+(fract(aSeed.y+cyc*0.371)-0.5)*uSpan; float w=gapW(x); float lat=(fract(aSeed.z+cyc*0.613)*2.0-1.0);
        float age=ph*life; float z=seamZ(x)+lat*w*0.92+lat*age*(3.0+5.0*aSeed.w)+sin(uT*1.3+aSeed.x*40.0)*0.9*age;
        float y=SKY_H+10.0-age*(14.0+22.0*aSeed.y)-age*age*1.2;
        x+=-age*(6.0+10.0*aSeed.z)+sin(uT*0.9+aSeed.y*30.0)*1.2*age;
        gl_Position=projectionMatrix*viewMatrix*vec4(x,y,z,1.0);
        float px=(0.10+0.22*aSeed.w)*uH*0.5*projectionMatrix[1][1]/max(gl_Position.w,1e-3);
        vA=sin(ph*3.14159)*(w/WMAX)*clamp(px/uMinPx,0.25,1.0)*(0.5+0.5*sin(uT*7.0+aSeed.x*90.0));
        gl_PointSize=clamp(px,uMinPx,48.0); }`,
    fragmentShader: /* glsl */ `uniform float uGain; varying float vA;
      void main(){ vec2 c=gl_PointCoord-0.5; float r2=dot(c,c)*4.0; float a=exp(-r2*4.0)*smoothstep(1.0,0.5,r2);
        gl_FragColor=vec4(vec3(1.0,0.72,0.34)*a*vA*uGain*2.2,1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  });
  const lint = new THREE.Points(lintGeo, lintMat); lint.frustumCulled = false; lint.renderOrder = 9; scene.add(lint);

  // ---------------------------------------------------------------- thread, falling stars, bursts
  const gold = new FatLine(1400, { width: 0.07, minPx: 1.5 * engine.k, gain: 1 });
  const red = new FatLine(700, { width: 0.07, minPx: 1.5 * engine.k, gain: 1 });
  const falls = new FatLine(700, { width: 0.10, minPx: 1.2 * engine.k, gain: 1 });
  const glints = new Sprites(900, { additive: true, minPx: 2.0 * engine.k, soft: 2.2 });
  for (const f of [gold, red, falls]) { f.setRes(engine.width, engine.height); scene.add(f.mesh); }
  glints.setRes(engine.width, engine.height); scene.add(glints.points);

  const fallSeeds = Array.from({ length: 110 }, () => ({ x: lerp(-600, 320, r()), side: r() < 0.5 ? 1 : -1, ph: r(), life: 2.6 + r() * 2.2, vx: (r() - 0.5) * 8, vz: (r() - 0.5) * 6, s: 0.4 + r() * 0.8 }));
  const burstSeeds = Array.from({ length: 70 }, () => { const a = r() * 6.283, e = r(); return { dx: Math.cos(a) * (0.3 + e), dz: Math.sin(a) * (0.3 + e), dy: 0.4 + r() * 1.6, s: 0.5 + r(), l: 0.5 + r() * 0.9 }; });

  // ---------------------------------------------------------------- hero beads (real geometry for close shots)
  const heroBeads = [];
  function addHeroBead(x, z, hang = 0.6, radius = 0.024, phase = 0) {
    const g = createBead({ radius, thread: hang, glow: 1.0 }); scene.add(g);
    const b = { g, x, z, hang, phase, amp: 0.12, kick: 0, kickT: -99 }; heroBeads.push(b); return b;
  }

  // ---------------------------------------------------------------- lights for the hero
  const key = new THREE.DirectionalLight(0xffd08a, 3.2); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -3.2, right: 3.2, top: 3.2, bottom: -3.2, near: 1, far: 80 }); key.shadow.bias = -0.0006; key.shadow.normalBias = 0.03;
  const hemi = new THREE.HemisphereLight(0x2a3470, 0x10142e, 1.6);
  const lamp = new THREE.PointLight(0xffc070, 0, 12, 1);
  scene.add(key, key.target, hemi, lamp);

  const v = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3();
  let state = seamState(0);

  // free end of the gold thread after it whips out of the needle (before she catches it)
  function whipEnd(t, st, out = new THREE.Vector3()) {
    const a = piercePoint(PIERCES[17], st, v3);
    const k = sat((t - T.whip) / 0.8);
    return out.set(a.x + 6 - 14 * k + Math.sin(t * 3.3) * 2.2, a.y - 5 - 13 * ease.outCubic(k) + Math.sin(t * 2.3 + 1.0) * 1.6, a.z + 7 + 3 * k + Math.sin(t * 2.9 + 2.0) * 2.6);
  }

  const api = {
    scene, U, lips, dome, curtains, stars, lint, key, hemi, lamp, heroBeads, addHeroBead, whipEnd,
    get state() { return state; },
    /**
     * opts: eye (Vector3 needle-eye world pos = live end of thread), trail (fn(tau)->Vector3 pre-stitch streamer path),
     *       goldEnd (Vector3: held end of the gold thread after the catch), redEnd (Vector3: red yarn end in her mittens during the pull),
     *       ripples [{x,z,t,s}], threadGain, lintGain, starGain, realm, night, curtainGain, hero (Vector3)
     */
    update(t, camera, o = {}) {
      const st = state = seamState(t);
      U.uT.value = t; U.uFront.value = st.front; U.uLoose.value.set(st.looseX0, st.looseX1, st.looseAmt); U.uCinch.value = st.cinch; U.uFlap.value = st.flap;
      // pierce ripples: most recent events
      const ev = [];
      for (const p of ALL_PIERCES) { const age = t - p.t; if (age >= 0 && age < 2.6) { piercePoint(p, st, v); ev.push([v.x, v.z, age, (p.final ? 2.2 : 1.0) * (Math.cos(p.phi) > 0 && !p.final ? 1 : -1)]); } }
      for (const rp of o.ripples || []) { const age = t - rp.t; if (age >= 0 && age < 3.5) ev.push([rp.x, rp.z, age, rp.s]); }
      ev.sort((a, b) => a[2] - b[2]);
      for (let i = 0; i < 6; i++) { const e = ev[i]; if (e) U.uPierce.value[i].set(e[0], e[1], e[2], e[3]); else U.uPierce.value[i].set(0, 0, 0, 0); }

      dome.position.copy(camera.position); dome.scale.setScalar(camera.far * 0.9);
      domeMat.uniforms.uRealm.value = o.realm ?? 1; domeMat.uniforms.uNight.value = o.night ?? 1;
      for (const c of curtains) c.material.uniforms.uGain.value = (o.curtainGain ?? 1) * 0.5;
      starMat.uniforms.uGain.value = o.starGain ?? 1; starMat.uniforms.uH.value = engine.height;
      if (o.swing) starMat.uniforms.uSwing.value.set(o.swing.x, o.swing.z, o.swing.t, o.swing.s); else starMat.uniforms.uSwing.value.set(0, 0, 0, 0);
      lintMat.uniforms.uGain.value = o.lintGain ?? 1; lintMat.uniforms.uCamX.value = (o.hero ? o.hero.x : camera.position.x);
      for (const l of lips) { const u = l.material.uniforms; u.uAmb.value = o.amb ?? 1; u.uSeamGlow.value = o.seamGlow ?? 0.6; u.uTopGain.value = o.topGain ?? 1; u.uEdgeGain.value = o.edgeGain ?? 1;
        if (o.lamp) u.uLamp.value.set(o.lamp.x, o.lamp.y, o.lamp.z, o.lampGain ?? 1); else u.uLamp.value.set(0, 0, 0, 0); }

      // ---- gold thread
      const tg = (o.threadGain ?? 1) * 5.0; const dT = 0.025;
      gold.begin();
      if (t < 24.3) {
        if (o.trail) { const N = 60; for (let i = 0; i <= N; i++) { const k = i / N; const p = o.trail(t - (1 - k) * 1.3); gold.push(p.x, p.y, p.z, GOLD[0] * tg, GOLD[1] * tg, GOLD[2] * tg, k * k); } }
      } else {
        const tEnd = Math.min(t, 34.5);
        for (let tau = 24.3; tau <= tEnd + 1e-6; tau += dT) { threadPoint(Math.min(tau, tEnd), t, st, v); gold.push(v.x, v.y, v.z, GOLD[0] * tg, GOLD[1] * tg, GOLD[2] * tg, 1); }
        if (t > 34.5 && t <= T.whip) { for (let tau = 34.5; tau < Math.min(t, 35.0); tau += dT) { threadPoint(tau, t, st, v); gold.push(v.x, v.y, v.z, GOLD[0] * tg, GOLD[1] * tg, GOLD[2] * tg, 1); } }
        if (t <= T.whip && o.eye) gold.push(o.eye.x, o.eye.y, o.eye.z, GOLD[0] * tg, GOLD[1] * tg, GOLD[2] * tg, 1);
        if (t > T.whip) {
          // loose tail from the last gold stitch
          const a = piercePoint(PIERCES[17], st, v2); let e;
          if (t < T.redStart) e = o.goldEnd || whipEnd(Math.min(t, T.catch), st, v3); else e = threadPoint(42.5, t, st, v3);
          const slack = t < T.catch ? 1 : (t < T.redStart ? 0.35 : 0.1 * (1 - smoothstep(42.5, 43.4, t)));
          const N = 28;
          for (let i = 1; i <= N; i++) { const k = i / N; const s = Math.sin(Math.PI * k);
            gold.push(lerp(a.x, e.x, k) + Math.sin(k * 9 - t * 7) * 1.2 * slack * s, lerp(a.y, e.y, k) - s * 3.5 * slack + Math.cos(k * 7 - t * 6) * 0.9 * slack * s, lerp(a.z, e.z, k) + Math.sin(k * 6 + t * 5) * 1.4 * slack * s, GOLD[0] * tg, GOLD[1] * tg, GOLD[2] * tg, 1); }
        }
      }
      gold.end();

      // ---- red yarn
      red.begin();
      const tr = (o.threadGain ?? 1) * 4.2;
      if (t >= T.redStart) {
        const tEnd = Math.min(t, 47.6);
        for (let tau = 42.5; tau <= tEnd + 1e-6; tau += dT) { threadPoint(Math.min(tau, tEnd), t, st, v); red.push(v.x, v.y, v.z, RED[0] * tr, RED[1] * tr, RED[2] * tr, 1); }
        if (t < 47.6 && o.eye) red.push(o.eye.x, o.eye.y, o.eye.z, RED[0] * tr, RED[1] * tr, RED[2] * tr, 1);
        if (t >= 47.6 && o.redEnd && t < T.shut + 3) { const a = piercePoint(FINAL_PIERCE, st, v2); const N = 12; const fade = 1 - smoothstep(T.shut + 0.2, T.shut + 1.6, t);
          for (let i = 1; i <= N; i++) { const k = i / N; red.push(lerp(a.x, o.redEnd.x, k), lerp(a.y, o.redEnd.y, k) - Math.sin(Math.PI * k) * (o.redSag ?? 0.2), lerp(a.z, o.redEnd.z, k), RED[0] * tr, RED[1] * tr, RED[2] * tr, lerp(1, fade, k)); } }
      }
      red.end();

      // ---- falling stars shaken loose along the open lips, stitch glints, pierce bursts
      falls.begin(); glints.begin();
      for (const f of fallSeeds) {
        const c = t / f.life + f.ph, age = (c - Math.floor(c)) * f.life, cyc = Math.floor(c);
        const x = f.x + ((cyc * 97.3) % 60) - 30; const w = gapW(x, st); if (w < 1.2) continue;
        const pos = (a, out) => { const z = seamZ(x) + f.side * (w + 0.5) + f.vz * a; return out.set(x + f.vx * a - a * a * 1.5, clothAt(x, seamZ(x) + f.side * (w + 1), st) - 2 - 9 * a - 4.9 * a * a, z); };
        const A = sat(age * 3) * sat((f.life - age) * 1.5) * (w / TEAR.wmax + 0.3);
        pos(Math.max(0, age - 0.16), v); pos(age, v2);
        falls.push(v.x, v.y, v.z, 0, 0, 0, 0); falls.push(v.x, v.y, v.z, 1.0, 0.6, 0.25, 0.0); falls.push(v2.x, v2.y, v2.z, 3.0 * A, 2.2 * A, 1.3 * A, 1); falls.push(v2.x, v2.y, v2.z, 0, 0, 0, 0);
        glints.push(v2.x, v2.y, v2.z, 0.9 * f.s, 4.0 * A, 3.0 * A, 1.8 * A, 1);
      }
      const settle = smoothstep(T.shut, T.shut + 1.5, t);
      for (const p of ALL_PIERCES) {
        const age = t - p.t; if (age < 0) continue;
        piercePoint(p, st, v); const c = p.red ? RED : GOLD; const tw = 0.75 + 0.25 * Math.sin(t * 2.3 + p.x);
        const g0 = (1.4 + 4.0 * Math.exp(-age * 3.0)) * lerp(1, 1.5 * tw, settle) * (o.threadGain ?? 1);
        glints.push(v.x, v.y - 0.6, v.z, lerp(1.0, 1.7, settle), c[0] * g0 + 0.4 * settle, c[1] * g0 + 0.3 * settle, c[2] * g0 + 0.25 * settle, 1);
        if (age < 1.3) { const up = (Math.cos(p.phi) > 0 && !p.final) ? 1 : -1; const big = p.final ? 2.0 : 1.0;
          for (const b of burstSeeds) { const k = age / b.l; if (k >= 1) continue; const dr = 1 - Math.exp(-age * 3.5);
            glints.push(v.x + b.dx * 5.5 * dr * big, v.y + up * b.dy * 5.0 * dr * big - 4.0 * age * age, v.z + b.dz * 5.5 * dr * big, 0.22 * b.s * big, c[0] * 3 * (1 - k), c[1] * 3 * (1 - k) + 0.3, c[2] * 3 * (1 - k) + 0.2, 1 - k); } }
      }
      falls.end(); glints.end();

      // ---- hero beads sway on their threads
      for (const b of heroBeads) {
        const ay = clothAt(b.x, b.z, st) - 0.02;
        const kick = b.kick * Math.exp(-Math.max(0, t - b.kickT) * 0.9) * Math.sin((t - b.kickT) * 5.2) * (t >= b.kickT ? 1 : 0);
        const th = b.amp * Math.sin(t * 1.9 + b.phase) + kick, th2 = b.amp * 0.7 * Math.sin(t * 1.4 + b.phase * 1.7) + kick * 0.5;
        const L = b.hang + 0.03;
        b.g.position.set(b.x + Math.sin(th) * L, ay - Math.cos(th) * Math.cos(th2) * L, b.z + Math.sin(th2) * L);
        b.g.rotation.set(th2, b.phase, -th);
      }
    },
    /** aim the hero key light: dir = direction light travels FROM (unit, toward the light) */
    aimKey(target, dir, intensity, color) {
      key.target.position.copy(target); key.position.copy(target).addScaledVector(dir, 30);
      key.intensity = intensity; if (color !== undefined) key.color.set(color);
    },
  };
  return api;
}
