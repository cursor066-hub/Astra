// Free-camera bench for the ground set. cam/look are in hero-house local metres (x along ridge, y up from ground, z forward)
//   --q "cam=0,9,-9&look=0,20,30&fov=55&clouds=1&seam=0&fall=1"
import * as THREE from 'three';
import { boot } from './boot.js';
import { defaultPost, defaultClouds } from './engine.js';
import { makeEnv } from './materials.js';
import { createGroundSet, HOUSE } from './groundset.js';

boot(async (engine, q) => {
  const gs = createGroundSet(engine);
  const nums = (k, d) => (q.get(k) || d).split(',').map(parseFloat);
  const cam = new THREE.PerspectiveCamera(parseFloat(q.get('fov') || '55'), engine.width / engine.height, 0.3, 60000);
  const cp = nums('cam', '0,9.5,-9'), lk = nums('look', '0,22,30');
  gs.scene.environment = makeEnv(engine.renderer, { top: 0x1a2250, horizon: 0x0c1030, bottom: 0x05060f, sunColor: 0xffc070, sunDir: new THREE.Vector3(0.3, 0.8, 0.5), sunGain: 2 }); gs.scene.environmentIntensity = 0.5;
  const post = defaultPost(); post.exposure = parseFloat(q.get('exp') || '1');
  if (q.get('clouds')) post.clouds = Object.assign(defaultClouds(), { y0: 1150, y1: 1480, cover: parseFloat(q.get('cover') || '0.4'), bandGain: 2.5, bandBase: 0.15, band: [0, 260, -620, 330], lightCol: [1.5, 1.0, 0.5] });
  post.fog.density = 0.00012; post.fog.color = [0.02, 0.03, 0.075]; post.fog.falloff = 0.0012; post.fog.base = 800;
  post.rays.strength = parseFloat(q.get('rays') || '0'); post.rays.pos.copy(gs.tearCenter);
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  return {
    duration: 60,
    frame(t) {
      a.set(cp[0], cp[1], cp[2]).applyMatrix4(gs.hero.m); b.set(lk[0], lk[1], lk[2]).applyMatrix4(gs.hero.m);
      cam.position.copy(a); cam.lookAt(b);
      gs.update(t, cam, { tearT: parseFloat(q.get('tearT') || '10'), seam: parseFloat(q.get('seam') || '0'), fallGain: parseFloat(q.get('fall') || '1') });
      return { scene: gs.scene, camera: cam, post, frame: Math.round(t * 24) };
    },
  };
});
