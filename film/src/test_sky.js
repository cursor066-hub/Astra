// Free-camera bench for the sky set:  --q "cam=x,y,z&look=x,y,z&fov=40&clouds=1&exp=1"
import * as THREE from 'three';
import { boot } from './boot.js';
import { defaultPost, defaultClouds } from './engine.js';
import { makeEnv, G } from './materials.js';
import { createSkySet } from './skyset.js';
import { H, seamZ, stitchPathPos, seamState } from './tear.js';

boot(async (engine, q) => {
  const sky = createSkySet(engine);
  const nums = (k, d) => (q.get(k) || d).split(',').map(parseFloat);
  const cam = new THREE.PerspectiveCamera(parseFloat(q.get('fov') || '40'), engine.width / engine.height, 0.5, 60000);
  const cp = nums('cam', '-700,1900,-260'), lk = nums('look', '-300,2000,0');
  sky.scene.environment = makeEnv(engine.renderer, {}); sky.scene.environmentIntensity = 0.4;
  for (let i = 0; i < 40; i++) sky.addHeroBead(-800 + (i % 8) * 1.3, -80 + Math.floor(i / 8) * 1.1, 0.3 + (i % 5) * 0.2, 0.024, i * 1.7);
  const post = defaultPost();
  post.exposure = parseFloat(q.get('exp') || '1');
  if (q.get('clouds')) { post.clouds = Object.assign(defaultClouds(), { y0: 1150, y1: 1480, bandGain: 2.0, bandBase: 0.25 }); }
  post.fog.density = parseFloat(q.get('fog') || '0.00002'); post.fog.color = [0.012, 0.018, 0.05];
  const hero = new THREE.Vector3();
  return {
    duration: 60,
    frame(t) {
      cam.position.set(cp[0], cp[1], cp[2]);
      if (q.get('follow')) { const st = seamState(t); stitchPathPos(Math.min(Math.max(t, 24.3), 47.6), st, hero); cam.position.set(hero.x + cp[0], H + cp[1], seamZ(hero.x) + cp[2]); cam.lookAt(hero.x + lk[0], H + lk[1], seamZ(hero.x) + lk[2]); }
      else cam.lookAt(lk[0], lk[1], lk[2]);
      if (post.clouds) { post.clouds.band = [0, 220, -620, 330]; post.clouds.wind.set(t * 0.004, 0, 0); }
      const st = seamState(t); stitchPathPos(Math.min(Math.max(t, 24.3), 47.6), st, hero);
      sky.update(t, cam, { eye: hero, hero });
      return { scene: sky.scene, camera: cam, post, frame: Math.round(t * 24) };
    },
  };
});
