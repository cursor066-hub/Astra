// Shared look: physically based materials with a soft anime terminator, warm subsurface bleed and a
// directional rim light. Every character / prop material should come from toonMat() so the film
// keeps one coherent shading language.
import * as THREE from 'three';

// Global uniforms driven per shot (rim light is specified in world space)
export const G = {
  rimDir: { value: new THREE.Vector3(0, 1, 0) },
  rimColor: { value: new THREE.Color(1.0, 0.82, 0.55) },
  rimStrength: { value: 1.0 },
  time: { value: 0 },
};

const DIRECT_FIND_A = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
const DIRECT_FIND_B = 'vec3 irradiance = dotNL * directLight.color;';

/**
 * toonMat({ color, map, roughness, metalness, sheen, sheenColor, sheenRoughness, emissive, emissiveIntensity,
 *           rim (0..n multiplier), rimPower, sss (THREE.Color|hex: terminator bleed tint), rampLo, rampHi,
 *           side, transparent, opacity, envMapIntensity, clearcoat, flatShading, vertexColors, ... })
 */
export function toonMat(p = {}) {
  const { rim = 1.0, rimPower = 3.0, sss = 0x000000, rampLo = -0.1, rampHi = 0.42, shade = 0.3, ...rest } = p;
  const m = new THREE.MeshPhysicalMaterial({ roughness: 0.75, metalness: 0.0, ...rest });
  const u = {
    uRim: { value: rim }, uRimPower: { value: rimPower }, uSSS: { value: new THREE.Color(sss) },
    uRampLo: { value: rampLo }, uRampHi: { value: rampHi }, uShade: { value: shade },
  };
  m.userData.toon = u;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u, { uRimDirW: G.rimDir, uRimColor: G.rimColor, uRimStrength: G.rimStrength });
    let chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
    if (!chunk.includes(DIRECT_FIND_A) || !chunk.includes(DIRECT_FIND_B)) console.error('toonMat: shader chunk changed, ramp patch not applied');
    chunk = chunk
      .replace(DIRECT_FIND_A, `float toonNL = dot( geometryNormal, directLight.direction );
	float dotNL = smoothstep( uRampLo, uRampHi, toonNL ) * ( 1.0 - uShade + uShade * saturate( toonNL ) );`)
      .replace(DIRECT_FIND_B, `vec3 irradiance = dotNL * directLight.color;
	irradiance += uSSS * directLight.color * smoothstep( -0.45, 0.05, toonNL ) * ( 1.0 - smoothstep( 0.05, 0.55, toonNL ) ) * 0.6;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uRim; uniform float uRimPower; uniform vec3 uSSS; uniform float uRampLo; uniform float uRampHi; uniform float uShade;
uniform vec3 uRimDirW; uniform vec3 uRimColor; uniform float uRimStrength;`)
      .replace('#include <lights_physical_pars_fragment>', chunk)
      .replace('#include <opaque_fragment>', `{
	vec3 rimN = normalize( normal );
	vec3 rimV = normalize( vViewPosition );
	vec3 rimL = normalize( ( viewMatrix * vec4( uRimDirW, 0.0 ) ).xyz );
	float fres = pow( 1.0 - saturate( dot( rimN, rimV ) ), uRimPower );
	float side = smoothstep( -0.15, 0.6, dot( rimN, rimL ) );
	outgoingLight += uRimColor * ( fres * side * uRim * uRimStrength );
}
#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'toon';
  return m;
}

// Procedural gradient environment for reflections (PMREM filtered). Returns a texture for scene.environment.
export function makeEnv(renderer, { top = 0xffe2a8, horizon = 0x3a3f78, bottom = 0x0a0c22, topPow = 1.5, sunDir = new THREE.Vector3(0, 1, 0), sunColor = 0xfff0cc, sunSize = 0.25, sunGain = 4.0, intensity = 1.0 } = {}) {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(top) }, hor: { value: new THREE.Color(horizon) }, bot: { value: new THREE.Color(bottom) },
      sunDir: { value: sunDir.clone().normalize() }, sunCol: { value: new THREE.Color(sunColor) },
      sunSize: { value: sunSize }, sunGain: { value: sunGain }, topPow: { value: topPow }, gain: { value: intensity },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vDir; uniform vec3 top, hor, bot, sunDir, sunCol; uniform float sunSize, sunGain, topPow, gain;
      void main(){ vec3 d = normalize(vDir);
        vec3 c = d.y > 0.0 ? mix(hor, top, pow(d.y, topPow)) : mix(hor, bot, pow(-d.y, 0.6));
        float s = smoothstep(1.0 - sunSize, 1.0, dot(d, sunDir));
        c += sunCol * s * s * sunGain;
        gl_FragColor = vec4(c * gain, 1.0); }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), mat));
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(scene, 0.02).texture;
  pm.dispose();
  return tex;
}

// Canvas helper for painted textures
export function canvasTex(w, h, draw, { srgb = true, repeat = false } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// Soft round sprite used by particle systems
export function softDotTex(size = 64, power = 2.0) {
  return canvasTex(size, size, (ctx, w) => {
    const img = ctx.createImageData(w, w);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w * 2 - 1, dy = (y + 0.5) / w * 2 - 1;
      const r = Math.sqrt(dx * dx + dy * dy);
      const a = Math.pow(Math.max(0, 1 - r), power);
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
    }
    ctx.putImageData(img, 0, 0);
  }, { srgb: false });
}
