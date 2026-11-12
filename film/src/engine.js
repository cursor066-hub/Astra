// Render engine: HDR MSAA scene pass + a film post chain (volumetric clouds, height fog, bokeh depth of
// field, camera motion blur with a hero mask, bloom, anamorphic streak, light shafts, filmic grade).
import * as THREE from 'three';

const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DEPTH_LIB = /* glsl */ `
uniform sampler2D tDepth; uniform float uNear; uniform float uFar; uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform vec3 uCamPos;
float linZ(float d){ return uNear*uFar/(uFar - d*(uFar-uNear)); }
vec3 worldPos(vec2 uv, float d){ vec4 v = uInvProj*vec4(uv*2.0-1.0, d*2.0-1.0, 1.0); v /= v.w; return (uCamWorld*v).xyz; }
vec3 rayDir(vec2 uv){ vec4 v = uInvProj*vec4(uv*2.0-1.0, 1.0, 1.0); return normalize((uCamWorld*vec4(v.xyz/v.w, 0.0)).xyz); }
float ihash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
`;

const CLOUD_FRAG = /* glsl */ `
varying vec2 vUv;
${DEPTH_LIB}
uniform sampler2D tNoise; uniform vec2 uRes; uniform float uFrame;
uniform float uY0, uY1, uCover, uDens, uScale, uSigma, uSteps, uMinStep, uStepGrow, uMaxDist, uShadowK, uLightStep, uHazeK, uBandBase, uBandGain, uPhase;
uniform vec3 uWind, uLightDir, uLightCol, uAmbTop, uAmbBot, uHaze; uniform vec4 uBand;
float n3(vec3 x){ vec3 p=floor(x), f=fract(x); f=f*f*(3.0-2.0*f); vec2 uv=(p.xy+vec2(37.0,17.0)*p.z)+f.xy;
  vec2 rg=textureLod(tNoise,(uv+0.5)/256.0,0.0).yx; return mix(rg.x,rg.y,f.z); }
float dens(vec3 p, float detail){
  float h=(p.y-uY0)/(uY1-uY0); if(h<0.0||h>1.0) return 0.0;
  vec3 q=p*uScale+uWind;
  float base=(n3(q)*0.5+n3(q*2.03+11.0)*0.25+n3(q*0.31+5.0)*0.35)/1.1;
  float prof=smoothstep(0.0,0.14,h)*smoothstep(1.0,0.3,h);
  float s=base-(1.0-uCover)-(1.0-prof)*0.4;
  if(s<=0.0) return 0.0;
  if(detail>0.5) s-=(1.0-n3(q*4.7+3.0))*0.11+(1.0-n3(q*10.3+7.0))*0.05;
  return clamp(s*uDens,0.0,1.0);
}
void main(){
  vec3 ro=uCamPos, rd=rayDir(vUv);
  float d=texture2D(tDepth,vUv).x;
  float maxT=d>=0.99999?uMaxDist:min(length(worldPos(vUv,d)-ro),uMaxDist);
  float ry=abs(rd.y)<1e-4?1e-4:rd.y;
  float tA=(uY0-ro.y)/ry, tB=(uY1-ro.y)/ry;
  float t0=max(min(tA,tB),0.0), t1=min(max(tA,tB),maxT);
  if(t1<=t0){ gl_FragColor=vec4(0.0,0.0,0.0,1.0); return; }
  float dt=max(uMinStep,t0*uStepGrow);
  float t=t0+dt*ihash(gl_FragCoord.xy+uFrame*7.31);
  vec3 acc=vec3(0.0); float T=1.0;
  float ph=1.0+uPhase*pow(max(dot(rd,uLightDir),0.0),5.0);
  for(int i=0;i<160;i++){
    if(float(i)>=uSteps||t>t1||T<0.02) break;
    vec3 p=ro+rd*t;
    float de=dens(p,1.0);
    if(de>0.002){
      float h=(p.y-uY0)/(uY1-uY0);
      float dl=dens(p+uLightDir*uLightStep,0.0)+0.5*dens(p+uLightDir*uLightStep*2.6,0.0);
      float sh=exp(-dl*uShadowK);
      float band=uBandBase+uBandGain*exp(-pow((p.z-uBand.x)/uBand.y,2.0))*smoothstep(uBand.z-250.0,uBand.z,p.x)*(1.0-smoothstep(uBand.w,uBand.w+250.0,p.x));
      vec3 lit=mix(uAmbBot,uAmbTop,h)+uLightCol*sh*band*ph;
      lit=mix(uHaze,lit,exp(-t*uHazeK));
      float a=1.0-exp(-de*dt*uSigma);
      acc+=T*a*lit; T*=1.0-a;
    }
    t+=dt; dt=max(uMinStep,t*uStepGrow);
  }
  gl_FragColor=vec4(acc,T);
}`;

const FOG_FRAG = /* glsl */ `
varying vec2 vUv;
${DEPTH_LIB}
uniform sampler2D tScene; uniform sampler2D tClouds; uniform float uCloudsOn;
uniform vec3 uFogCol, uFogSunCol, uSunDir; uniform float uFogDensity, uFogFalloff, uFogBase, uFogSunPow, uFogMax;
void main(){
  vec3 col=texture2D(tScene,vUv).rgb; float d=texture2D(tDepth,vUv).x;
  vec3 rd=rayDir(vUv);
  if(uFogDensity>0.0 && d<0.999995){
    float dist=length(worldPos(vUv,d)-uCamPos);
    float amt;
    if(uFogFalloff>0.0){ float ry=abs(rd.y)<1e-4?1e-4:rd.y; float k=uFogFalloff*ry;
      amt=uFogDensity*exp(-uFogFalloff*(uCamPos.y-uFogBase))*(1.0-exp(-k*dist))/k; }
    else amt=uFogDensity*dist;
    float f=min(1.0-exp(-amt),uFogMax);
    vec3 fc=mix(uFogCol,uFogSunCol,pow(max(dot(rd,uSunDir),0.0),uFogSunPow));
    col=mix(col,fc,f);
  }
  if(uCloudsOn>0.5){ vec4 c=texture2D(tClouds,vUv); col=col*c.a+c.rgb; }
  gl_FragColor=vec4(col,1.0);
}`;

const DOF_FRAG = /* glsl */ `
varying vec2 vUv;
${DEPTH_LIB}
uniform sampler2D tColor; uniform vec2 uPixel; uniform float uFocus, uAperture, uMaxCoc;
float coc(float z){ return clamp(uAperture*abs(z-uFocus)/z,0.0,uMaxCoc); }
void main(){
  float cz=linZ(texture2D(tDepth,vUv).x); float cs=coc(cz);
  vec3 color=texture2D(tColor,vUv).rgb; float tot=1.0; float radius=0.75;
  float ang=ihash(gl_FragCoord.xy)*6.2831;
  for(int i=0;i<72;i++){
    if(radius>=uMaxCoc) break;
    vec2 tc=vUv+vec2(cos(ang),sin(ang))*uPixel*radius;
    vec3 sc=texture2D(tColor,tc).rgb; float sz=linZ(texture2D(tDepth,tc).x); float ss=coc(sz);
    if(sz>cz) ss=clamp(ss,0.0,cs*2.0);
    float m=smoothstep(radius-0.5,radius+0.5,ss);
    color+=mix(color/tot,sc,m); tot+=1.0;
    radius+=1.3/radius; ang+=2.39996323;
  }
  gl_FragColor=vec4(color/tot,cs);
}`;

const DOFMIX_FRAG = /* glsl */ `
varying vec2 vUv;
${DEPTH_LIB}
uniform sampler2D tColor; uniform sampler2D tBlur; uniform float uFocus, uAperture, uMaxCoc;
void main(){
  float z=linZ(texture2D(tDepth,vUv).x);
  float c=clamp(uAperture*abs(z-uFocus)/z,0.0,uMaxCoc);
  vec4 b=texture2D(tBlur,vUv);
  float k=smoothstep(0.35,1.6,max(c,b.a*0.6));
  gl_FragColor=vec4(mix(texture2D(tColor,vUv).rgb,b.rgb,k),1.0);
}`;

const MBLUR_FRAG = /* glsl */ `
varying vec2 vUv;
${DEPTH_LIB}
uniform sampler2D tColor; uniform sampler2D tHero; uniform mat4 uPrevVP; uniform vec2 uRes; uniform float uStrength, uMaxBlur, uHeroOn;
float heroAt(vec2 uv, float z){ if(uHeroOn<0.5) return 0.0; float hz=texture2D(tHero,uv).r; return (hz>0.0 && abs(hz-z)<0.04*z+0.04)?1.0:0.0; }
void main(){
  vec3 c0=texture2D(tColor,vUv).rgb;
  float d=texture2D(tDepth,vUv).x; float z=linZ(d);
  vec3 wp=worldPos(vUv,d);
  vec4 pc=uPrevVP*vec4(wp,1.0);
  if(pc.w<=0.0){ gl_FragColor=vec4(c0,1.0); return; }
  vec2 vel=(vUv-(pc.xy/pc.w*0.5+0.5))*uStrength;
  float len=length(vel*uRes);
  if(len>uMaxBlur){ vel*=uMaxBlur/len; len=uMaxBlur; }
  if(len<0.6||heroAt(vUv,z)>0.5){ gl_FragColor=vec4(c0,1.0); return; }
  vec3 acc=c0; float w=1.0; float j=ihash(gl_FragCoord.xy)-0.5;
  for(int i=0;i<14;i++){
    float f=(float(i)+0.5+j)/14.0-0.5;
    vec2 uv=vUv+vel*f;
    float sz=linZ(texture2D(tDepth,uv).x);
    float m=1.0-heroAt(uv,sz);
    acc+=texture2D(tColor,uv).rgb*m; w+=m;
  }
  gl_FragColor=vec4(acc/w,1.0);
}`;

const BRIGHT_FRAG = /* glsl */ `
varying vec2 vUv; uniform sampler2D tColor; uniform float uThreshold, uKnee;
void main(){ vec3 c=min(texture2D(tColor,vUv).rgb,vec3(40.0)); float br=max(c.r,max(c.g,c.b));
  float soft=clamp(br-uThreshold+uKnee,0.0,2.0*uKnee); soft=soft*soft/(4.0*uKnee+1e-4);
  float k=max(soft,br-uThreshold)/max(br,1e-4); gl_FragColor=vec4(c*k,1.0); }`;

const DOWN_FRAG = /* glsl */ `
varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uPixel;
void main(){ vec2 p=uPixel;
  vec3 a=texture2D(tColor,vUv+p*vec2(-2,-2)).rgb, b=texture2D(tColor,vUv+p*vec2(0,-2)).rgb, c=texture2D(tColor,vUv+p*vec2(2,-2)).rgb;
  vec3 d=texture2D(tColor,vUv+p*vec2(-2,0)).rgb, e=texture2D(tColor,vUv).rgb, f=texture2D(tColor,vUv+p*vec2(2,0)).rgb;
  vec3 g=texture2D(tColor,vUv+p*vec2(-2,2)).rgb, h=texture2D(tColor,vUv+p*vec2(0,2)).rgb, i=texture2D(tColor,vUv+p*vec2(2,2)).rgb;
  vec3 j=texture2D(tColor,vUv+p*vec2(-1,-1)).rgb, k=texture2D(tColor,vUv+p*vec2(1,-1)).rgb, l=texture2D(tColor,vUv+p*vec2(-1,1)).rgb, m=texture2D(tColor,vUv+p*vec2(1,1)).rgb;
  vec3 o=e*0.125+(a+c+g+i)*0.03125+(b+d+f+h)*0.0625+(j+k+l+m)*0.125;
  gl_FragColor=vec4(o,1.0); }`;

const UP_FRAG = /* glsl */ `
varying vec2 vUv; uniform sampler2D tColor; uniform sampler2D tAdd; uniform vec2 uPixel; uniform float uRadius;
void main(){ vec2 p=uPixel*uRadius;
  vec3 s=texture2D(tColor,vUv).rgb*4.0;
  s+=(texture2D(tColor,vUv+p*vec2(-1,0)).rgb+texture2D(tColor,vUv+p*vec2(1,0)).rgb+texture2D(tColor,vUv+p*vec2(0,-1)).rgb+texture2D(tColor,vUv+p*vec2(0,1)).rgb)*2.0;
  s+=texture2D(tColor,vUv+p*vec2(-1,-1)).rgb+texture2D(tColor,vUv+p*vec2(1,-1)).rgb+texture2D(tColor,vUv+p*vec2(-1,1)).rgb+texture2D(tColor,vUv+p*vec2(1,1)).rgb;
  gl_FragColor=vec4(s/16.0+texture2D(tAdd,vUv).rgb,1.0); }`;

const STREAK_FRAG = /* glsl */ `
varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uDir;
void main(){ vec3 s=vec3(0.0); float w=0.0;
  for(int i=-12;i<=12;i++){ float f=float(i); float g=exp(-f*f/60.0); s+=texture2D(tColor,vUv+uDir*f).rgb*g; w+=g; }
  gl_FragColor=vec4(s/w,1.0); }`;

const RAYS_FRAG = /* glsl */ `
varying vec2 vUv; uniform sampler2D tColor; uniform vec2 uLight; uniform float uLen, uDecay;
void main(){ vec2 dv=(uLight-vUv)*uLen/10.0; vec3 s=vec3(0.0); float w=1.0, tw=0.0; vec2 uv=vUv;
  for(int i=0;i<10;i++){ s+=texture2D(tColor,uv).rgb*w; tw+=w; w*=uDecay; uv+=dv; }
  gl_FragColor=vec4(s/tw,1.0); }`;

const FINAL_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tColor, tBloom, tStreak, tRays;
uniform vec2 uRes; uniform float uFrame;
uniform float uBloom, uStreak, uRays, uExposure, uContrast, uSaturation, uVignette, uGrain, uCA, uFade, uFlash, uRaysOn;
uniform vec3 uLift, uGamma, uGain, uShadowTint, uHighTint, uStreakTint, uRaysTint, uFlashCol;
float h(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }
void main(){
  vec2 c=vUv-0.5; float r2=dot(c,c);
  vec2 off=c*uCA*(0.4+r2*3.0);
  vec3 col=vec3(texture2D(tColor,vUv+off).r, texture2D(tColor,vUv).g, texture2D(tColor,vUv-off).b);
  col+=texture2D(tBloom,vUv).rgb*uBloom;
  col+=texture2D(tStreak,vUv).rgb*uStreak*uStreakTint;
  if(uRaysOn>0.5) col+=texture2D(tRays,vUv).rgb*uRays*uRaysTint;
  col+=uFlashCol*uFlash;
  col*=uExposure;
  float asp=uRes.x/uRes.y; vec2 vc=c*vec2(1.0,1.0/asp*1.55);
  col*=mix(1.0,smoothstep(0.78,0.12,length(vc)),uVignette);
  // filmic tonemap, partly hue preserving so saturated golds do not skew
  float l=dot(col,vec3(0.2126,0.7152,0.0722));
  vec3 t1=aces(col); vec3 t2=col*(aces(vec3(l)).x/max(l,1e-4));
  col=mix(t1,clamp(t2,0.0,1.0),0.35);
  // lift / gamma / gain
  col=uGain*(col+uLift*(1.0-col));
  col=pow(max(col,0.0),1.0/uGamma);
  l=dot(col,vec3(0.2126,0.7152,0.0722));
  col+=uShadowTint*(1.0-l)*(1.0-l);
  col*=mix(vec3(1.0),uHighTint,smoothstep(0.35,1.0,l));
  col=pow(max(col,0.0),vec3(1.0/2.2));
  l=dot(col,vec3(0.2126,0.7152,0.0722));
  col=mix(vec3(l),col,uSaturation);
  col=(col-0.5)*uContrast+0.5;
  float g=h(gl_FragCoord.xy+vec2(uFrame*17.0,uFrame*29.0))+h(gl_FragCoord.yx+vec2(uFrame*5.0,uFrame*3.0))-1.0;
  col+=g*uGrain*(1.0-0.5*l);
  col*=uFade;
  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
}`;

const HERO_VERT = /* glsl */ `
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
varying float vZ;
void main(){
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vZ = -mvPosition.z;
}`;

export function defaultPost() {
  return {
    exposure: 1.0, contrast: 1.06, saturation: 1.08,
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1],
    shadowTint: [0.0, 0.004, 0.018], highTint: [1.03, 1.0, 0.95],
    bloom: 0.55, bloomThreshold: 1.0, bloomKnee: 0.5, bloomRadius: 1.0,
    streak: 0.12, streakTint: [1.0, 0.85, 0.6],
    vignette: 0.4, grain: 0.03, ca: 0.0012,
    focus: 10, aperture: 0, maxCoc: 22,          // aperture = blur radius (px @1920w) of objects at infinity
    mblur: 1.0, maxBlur: 48,                     // shutter fraction (1 = 180deg) and max streak in px @1920w
    fog: { density: 0, falloff: 0, base: 0, color: [0.05, 0.06, 0.14], sunColor: [1.0, 0.8, 0.5], sunDir: new THREE.Vector3(0, 1, 0), sunPow: 6, max: 1 },
    rays: { strength: 0, pos: new THREE.Vector3(0, 1e4, 0), len: 0.9, decay: 0.92, tint: [1.0, 0.86, 0.6] },
    clouds: null,
    fade: 1, flash: 0, flashColor: [1.0, 0.92, 0.75],
  };
}

export function defaultClouds() {
  return {
    y0: 700, y1: 1100, cover: 0.52, dens: 2.4, scale: 1 / 420, sigma: 0.012, steps: 56, minStep: 12, stepGrow: 0.012,
    maxDist: 30000, shadowK: 2.2, lightStep: 60, hazeK: 0.00004, phase: 1.5,
    wind: new THREE.Vector3(0, 0, 0), lightDir: new THREE.Vector3(0, 1, 0), lightCol: [1.6, 1.15, 0.6],
    ambTop: [0.10, 0.13, 0.30], ambBot: [0.02, 0.03, 0.08], haze: [0.03, 0.04, 0.10],
    band: [0, 1e9, -1e9, 1e9], bandBase: 1.0, bandGain: 0.0,
  };
}

export class Engine {
  constructor({ canvas, width, height }) {
    this.width = width; this.height = height; this.canvas = canvas;
    this.k = width / 1920; // resolution factor for pixel-sized effects
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    r.setPixelRatio(1); r.setSize(width, height, false);
    r.toneMapping = THREE.NoToneMapping; r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.autoClear = true; r.setClearColor(0x000000, 1);
    const hf = (w, h, o = {}) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...o });
    const W = width, H = height, W2 = W >> 1, H2 = H >> 1;
    const depth = new THREE.DepthTexture(W, H); depth.type = THREE.UnsignedIntType; depth.minFilter = depth.magFilter = THREE.NearestFilter;
    this.rtScene = hf(W, H, { samples: 4, depthBuffer: true, depthTexture: depth });
    this.rtA = hf(W, H); this.rtB = hf(W, H);
    this.rtClouds = hf(W2, H2); this.rtDof = hf(W2, H2);
    this.rtHero = hf(W2, H2, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.rtBright = hf(W2, H2);
    this.mips = []; this.ups = [];
    let w = W2, h = H2;
    for (let i = 0; i < 6; i++) { w = Math.max(2, w >> 1); h = Math.max(2, h >> 1); this.mips.push(hf(w, h)); this.ups.push(hf(w, h)); }
    this.rtBloom = hf(W2, H2);
    this.rtStreakA = hf(this.mips[1].width, this.mips[1].height); this.rtStreakB = hf(this.mips[1].width, this.mips[1].height);
    this.rtRaysA = hf(this.mips[0].width, this.mips[0].height); this.rtRaysB = hf(this.mips[0].width, this.mips[0].height);

    // tiling noise for the cloud march (G channel = R shifted by (37,17) so one fetch gives two z-slices)
    const N = 256, base = new Float32Array(N * N); let s = 1234567;
    for (let i = 0; i < N * N; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; base[i] = s / 4294967296; }
    const data = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      data[i] = base[y * N + x] * 255; data[i + 1] = base[((y + 17) % N) * N + ((x + 37) % N)] * 255; data[i + 2] = 0; data[i + 3] = 255;
    }
    this.noiseTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    this.noiseTex.wrapS = this.noiseTex.wrapT = THREE.RepeatWrapping; this.noiseTex.minFilter = this.noiseTex.magFilter = THREE.LinearFilter; this.noiseTex.needsUpdate = true;

    this.fsq = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)); this.fsq.frustumCulled = false;
    this.ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const cam = () => ({ tDepth: { value: depth }, uNear: { value: 0.1 }, uFar: { value: 1000 }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() } });
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    const v3 = () => ({ value: new THREE.Vector3() }), f = (x = 0) => ({ value: x }), tx = () => ({ value: null }), v2 = () => ({ value: new THREE.Vector2() });
    this.P = {
      clouds: mk(CLOUD_FRAG, { ...cam(), tNoise: { value: this.noiseTex }, uRes: v2(), uFrame: f(), uY0: f(), uY1: f(), uCover: f(), uDens: f(), uScale: f(), uSigma: f(), uSteps: f(), uMinStep: f(), uStepGrow: f(), uMaxDist: f(), uShadowK: f(), uLightStep: f(), uHazeK: f(), uBandBase: f(), uBandGain: f(), uPhase: f(), uWind: v3(), uLightDir: v3(), uLightCol: v3(), uAmbTop: v3(), uAmbBot: v3(), uHaze: v3(), uBand: { value: new THREE.Vector4() } }),
      fog: mk(FOG_FRAG, { ...cam(), tScene: tx(), tClouds: tx(), uCloudsOn: f(), uFogCol: v3(), uFogSunCol: v3(), uSunDir: v3(), uFogDensity: f(), uFogFalloff: f(), uFogBase: f(), uFogSunPow: f(), uFogMax: f(1) }),
      dof: mk(DOF_FRAG, { ...cam(), tColor: tx(), uPixel: v2(), uFocus: f(), uAperture: f(), uMaxCoc: f() }),
      dofmix: mk(DOFMIX_FRAG, { ...cam(), tColor: tx(), tBlur: tx(), uFocus: f(), uAperture: f(), uMaxCoc: f() }),
      mblur: mk(MBLUR_FRAG, { ...cam(), tColor: tx(), tHero: tx(), uPrevVP: { value: new THREE.Matrix4() }, uRes: v2(), uStrength: f(), uMaxBlur: f(), uHeroOn: f() }),
      bright: mk(BRIGHT_FRAG, { tColor: tx(), uThreshold: f(1), uKnee: f(0.5) }),
      down: mk(DOWN_FRAG, { tColor: tx(), uPixel: v2() }),
      up: mk(UP_FRAG, { tColor: tx(), tAdd: tx(), uPixel: v2(), uRadius: f(1) }),
      streak: mk(STREAK_FRAG, { tColor: tx(), uDir: v2() }),
      rays: mk(RAYS_FRAG, { tColor: tx(), uLight: v2(), uLen: f(), uDecay: f() }),
      final: mk(FINAL_FRAG, { tColor: tx(), tBloom: tx(), tStreak: tx(), tRays: tx(), uRes: v2(), uFrame: f(), uBloom: f(), uStreak: f(), uRays: f(), uExposure: f(1), uContrast: f(1), uSaturation: f(1), uVignette: f(), uGrain: f(), uCA: f(), uFade: f(1), uFlash: f(), uRaysOn: f(), uLift: v3(), uGamma: v3(), uGain: v3(), uShadowTint: v3(), uHighTint: v3(), uStreakTint: v3(), uRaysTint: v3(), uFlashCol: v3() }),
    };
    this.heroMat = new THREE.ShaderMaterial({ vertexShader: HERO_VERT, fragmentShader: 'varying float vZ; void main(){ gl_FragColor = vec4(vZ, 0.0, 0.0, 1.0); }', side: THREE.DoubleSide });
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); this.black.needsUpdate = true;
    this._vp = new THREE.Matrix4(); this._v = new THREE.Vector3(); this._v4 = new THREE.Vector4();
    this.frameIndex = 0;
  }

  run(mat, target) { this.fsq.material = mat; this.renderer.setRenderTarget(target); this.renderer.render(this.fsq, this.ocam); }

  viewProj(camera, out = new THREE.Matrix4()) {
    camera.updateMatrixWorld(true); camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    return out.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }

  _cam(mat, camera) {
    const u = mat.uniforms;
    u.uNear.value = camera.near; u.uFar.value = camera.far;
    u.uInvProj.value.copy(camera.projectionMatrixInverse); u.uCamWorld.value.copy(camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
  }

  /** fd = { scene, camera, post, prevVP?: Matrix4, frame?: number } */
  render(fd) {
    const { scene, camera } = fd; const post = fd.post || defaultPost();
    const r = this.renderer, P = this.P, k = this.k, W = this.width, H = this.height;
    this.frameIndex = fd.frame ?? this.frameIndex + 1;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);

    // 1. scene (HDR, MSAA)
    r.setRenderTarget(this.rtScene); r.clear(); r.render(scene, camera);
    let cur = this.rtScene, next = this.rtA;
    const swap = () => { cur = next; next = cur === this.rtA ? this.rtB : this.rtA; };

    // 2. volumetric clouds (half res) + fog composite
    const cl = post.clouds, fog = post.fog;
    if (cl || fog.density > 0) {
      if (cl) {
        const u = P.clouds.uniforms; this._cam(P.clouds, camera);
        u.uRes.value.set(W >> 1, H >> 1); u.uFrame.value = this.frameIndex % 64;
        u.uY0.value = cl.y0; u.uY1.value = cl.y1; u.uCover.value = cl.cover; u.uDens.value = cl.dens; u.uScale.value = cl.scale; u.uSigma.value = cl.sigma;
        u.uSteps.value = cl.steps; u.uMinStep.value = cl.minStep; u.uStepGrow.value = cl.stepGrow; u.uMaxDist.value = cl.maxDist;
        u.uShadowK.value = cl.shadowK; u.uLightStep.value = cl.lightStep; u.uHazeK.value = cl.hazeK; u.uPhase.value = cl.phase;
        u.uBandBase.value = cl.bandBase; u.uBandGain.value = cl.bandGain; u.uBand.value.fromArray(cl.band);
        u.uWind.value.copy(cl.wind); u.uLightDir.value.copy(cl.lightDir).normalize(); u.uLightCol.value.fromArray(cl.lightCol);
        u.uAmbTop.value.fromArray(cl.ambTop); u.uAmbBot.value.fromArray(cl.ambBot); u.uHaze.value.fromArray(cl.haze);
        this.run(P.clouds, this.rtClouds);
      }
      const u = P.fog.uniforms; this._cam(P.fog, camera);
      u.tScene.value = cur.texture; u.tClouds.value = this.rtClouds.texture; u.uCloudsOn.value = cl ? 1 : 0;
      u.uFogCol.value.fromArray(fog.color); u.uFogSunCol.value.fromArray(fog.sunColor); u.uSunDir.value.copy(fog.sunDir).normalize();
      u.uFogDensity.value = fog.density; u.uFogFalloff.value = fog.falloff; u.uFogBase.value = fog.base; u.uFogSunPow.value = fog.sunPow; u.uFogMax.value = fog.max;
      this.run(P.fog, next); swap();
    }

    // 3. depth of field
    if (post.aperture > 0.01) {
      const u = P.dof.uniforms; this._cam(P.dof, camera);
      u.tColor.value = cur.texture; u.uPixel.value.set(1 / (W >> 1), 1 / (H >> 1));
      u.uFocus.value = post.focus; u.uAperture.value = post.aperture * k * 0.5; u.uMaxCoc.value = post.maxCoc * k * 0.5;
      this.run(P.dof, this.rtDof);
      const m = P.dofmix.uniforms; this._cam(P.dofmix, camera);
      m.tColor.value = cur.texture; m.tBlur.value = this.rtDof.texture; m.uFocus.value = post.focus; m.uAperture.value = post.aperture * k; m.uMaxCoc.value = post.maxCoc * k;
      this.run(P.dofmix, next); swap();
    }

    // 4. camera motion blur (hero layer stays sharp)
    if (post.mblur > 0.01 && fd.prevVP) {
      let heroOn = 0;
      if (fd.hero !== false) {
        const oldMask = camera.layers.mask, oldOv = scene.overrideMaterial;
        camera.layers.set(1); scene.overrideMaterial = this.heroMat;
        r.setRenderTarget(this.rtHero); r.setClearColor(0x000000, 1); r.clear();
        const sm = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
        r.render(scene, camera);
        r.shadowMap.autoUpdate = sm; camera.layers.mask = oldMask; scene.overrideMaterial = oldOv; heroOn = 1;
      }
      const u = P.mblur.uniforms; this._cam(P.mblur, camera);
      u.tColor.value = cur.texture; u.tHero.value = this.rtHero.texture; u.uPrevVP.value.copy(fd.prevVP);
      u.uRes.value.set(W, H); u.uStrength.value = post.mblur; u.uMaxBlur.value = post.maxBlur * k; u.uHeroOn.value = heroOn;
      this.run(P.mblur, next); swap();
    }

    // 5. bloom chain
    P.bright.uniforms.tColor.value = cur.texture; P.bright.uniforms.uThreshold.value = post.bloomThreshold; P.bright.uniforms.uKnee.value = post.bloomKnee;
    this.run(P.bright, this.rtBright);
    let src = this.rtBright;
    for (let i = 0; i < this.mips.length; i++) {
      P.down.uniforms.tColor.value = src.texture; P.down.uniforms.uPixel.value.set(1 / src.width, 1 / src.height);
      this.run(P.down, this.mips[i]); src = this.mips[i];
    }
    let acc = this.mips[this.mips.length - 1];
    for (let i = this.mips.length - 2; i >= -1; i--) {
      const dst = i >= 0 ? this.ups[i] : this.rtBloom; const add = i >= 0 ? this.mips[i] : this.rtBright;
      P.up.uniforms.tColor.value = acc.texture; P.up.uniforms.tAdd.value = i >= 0 ? add.texture : this.black;
      P.up.uniforms.uPixel.value.set(1 / acc.width, 1 / acc.height); P.up.uniforms.uRadius.value = post.bloomRadius;
      this.run(P.up, dst); acc = dst;
    }
    // anamorphic streak from 1/8 res brights
    P.streak.uniforms.tColor.value = this.mips[1].texture; P.streak.uniforms.uDir.value.set(1.6 / this.mips[1].width, 0); this.run(P.streak, this.rtStreakA);
    P.streak.uniforms.tColor.value = this.rtStreakA.texture; P.streak.uniforms.uDir.value.set(4.0 / this.mips[1].width, 0); this.run(P.streak, this.rtStreakB);

    // 6. light shafts (screen space, from thresholded brights)
    let raysOn = 0;
    if (post.rays.strength > 0.001) {
      this.viewProj(camera, this._vp);
      const p = this._v4.set(post.rays.pos.x, post.rays.pos.y, post.rays.pos.z, 1).applyMatrix4(this._vp);
      if (p.w > 0) {
        const lx = p.x / p.w * 0.5 + 0.5, ly = p.y / p.w * 0.5 + 0.5;
        const u = P.rays.uniforms; u.uLight.value.set(lx, ly); u.uDecay.value = post.rays.decay;
        u.tColor.value = this.mips[0].texture; u.uLen.value = post.rays.len; this.run(P.rays, this.rtRaysA);
        u.tColor.value = this.rtRaysA.texture; u.uLen.value = post.rays.len / 10; this.run(P.rays, this.rtRaysB);
        raysOn = 1;
      }
    }

    // 7. final grade
    const u = P.final.uniforms;
    u.tColor.value = cur.texture; u.tBloom.value = this.rtBloom.texture; u.tStreak.value = this.rtStreakB.texture; u.tRays.value = this.rtRaysB.texture;
    u.uRes.value.set(W, H); u.uFrame.value = this.frameIndex % 97;
    u.uBloom.value = post.bloom; u.uStreak.value = post.streak; u.uRays.value = post.rays.strength; u.uRaysOn.value = raysOn;
    u.uExposure.value = post.exposure; u.uContrast.value = post.contrast; u.uSaturation.value = post.saturation;
    u.uVignette.value = post.vignette; u.uGrain.value = post.grain; u.uCA.value = post.ca; u.uFade.value = post.fade; u.uFlash.value = post.flash;
    u.uLift.value.fromArray(post.lift); u.uGamma.value.fromArray(post.gamma); u.uGain.value.fromArray(post.gain);
    u.uShadowTint.value.fromArray(post.shadowTint); u.uHighTint.value.fromArray(post.highTint);
    u.uStreakTint.value.fromArray(post.streakTint); u.uRaysTint.value.fromArray(post.rays.tint); u.uFlashCol.value.fromArray(post.flashColor);
    this.run(P.final, null);
  }

  capture(type = 'image/png') { return this.canvas.toDataURL(type); }
}
