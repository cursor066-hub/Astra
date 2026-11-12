// Minimal bench proving the engine: toon-shaded primitives, key light with shadows, clouds, DOF, bloom.
import * as THREE from 'three';
import { boot } from './boot.js';
import { defaultPost, defaultClouds } from './engine.js';
import { toonMat, makeEnv, G } from './materials.js';

boot(async (engine, q) => {
  const scene = new THREE.Scene();
  scene.environment = makeEnv(engine.renderer, {}); scene.environmentIntensity = 0.35;
  const cam = new THREE.PerspectiveCamera(32, engine.width / engine.height, 0.1, 40000);
  const key = new THREE.DirectionalLight(0xffd9a0, 3.2); key.position.set(3, 8, 4); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 30 }); key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
  scene.add(key, new THREE.HemisphereLight(0x5a6cc8, 0x141228, 1.2));
  G.rimDir.value.set(-0.5, 0.6, -0.6).normalize();
  const skin = toonMat({ color: 0xf2c9a8, sss: 0xff5a3a, roughness: 0.6 });
  const cloth = toonMat({ color: 0xb3202a, sheen: 1, sheenColor: 0xff8a70, sheenRoughness: 0.5, roughness: 0.9 });
  const metal = toonMat({ color: 0xdfe6f2, metalness: 1, roughness: 0.18, rim: 0.3 });
  const a = new THREE.Mesh(new THREE.SphereGeometry(0.8, 64, 48), skin); a.position.set(-2, 0.8, 0);
  const b = new THREE.Mesh(new THREE.TorusKnotGeometry(0.55, 0.2, 200, 32), cloth); b.position.set(0, 1.0, 0);
  const c = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.01, 3, 24), metal); c.position.set(2, 1.2, 0); c.rotation.z = 0.5;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), toonMat({ color: 0x39406a, rim: 0 })); ground.rotation.x = -Math.PI / 2;
  for (const m of [a, b, c]) { m.castShadow = m.receiveShadow = true; m.layers.enable(1); }
  ground.receiveShadow = true;
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 6, 3) })); glow.position.set(-0.8, 0.5, 1.4);
  for (let i = 0; i < 40; i++) { const g = glow.clone(); g.scale.setScalar(0.5); g.position.set(Math.sin(i * 7.1) * 14, 0.3 + (i % 5) * 0.6, -12 - (i % 7) * 3); scene.add(g); }
  scene.add(a, b, c, ground, glow);
  const post = defaultPost();
  post.focus = 9; post.aperture = 14;
  post.fog.density = 0.004; post.fog.color = [0.03, 0.04, 0.1];
  post.clouds = Object.assign(defaultClouds(), { y0: 300, y1: 700 });
  post.rays.strength = 0.5; post.rays.pos.set(-0.8, 0.5, 1.4);
  const prev = new THREE.Matrix4();
  const place = (t) => { const an = 0.4 + t * 0.5; cam.position.set(Math.sin(an) * 9, 2.2 + Math.sin(t) * 0.5, Math.cos(an) * 9); cam.lookAt(0, 1.0, 0); };
  return {
    duration: 10,
    frame(t) {
      place(t - 0.5 / 24); engine.viewProj(cam, prev);
      place(t); b.rotation.y = t;
      return { scene, camera: cam, post, prevVP: prev, frame: Math.round(t * 24) };
    },
  };
});
