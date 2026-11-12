// Page bootstrap shared by the film and by test benches. A page calls boot(build) where
// build(engine, query) returns { duration, frame(t) -> { scene, camera, post, prevVP } }.
import * as THREE from 'three';
import { Engine } from './engine.js';

export const FPS = 24;
export const BASE_W = 1920, BASE_H = 804; // 2.39:1 scope frame

export async function boot(build) {
  try {
    const q = new URLSearchParams(location.search);
    const scale = parseFloat(q.get('scale') || '1');
    const W = Math.round(BASE_W * scale / 4) * 4, H = Math.round(BASE_H * scale / 4) * 4;
    const canvas = document.getElementById('c');
    const engine = new Engine({ canvas, width: W, height: H });
    const app = await build(engine, q);
    window.film = {
      fps: FPS, duration: app.duration ?? 60, width: W, height: H,
      frame: async (t) => { const fd = app.frame(t); engine.render(fd); return engine.capture(); },
      info: () => ({ tris: engine.renderer.info.render.triangles, calls: engine.renderer.info.render.calls }),
    };
    window.ready = true;
  } catch (e) {
    console.error('BOOT ERROR', e && e.stack || e);
    window.bootError = String(e && e.stack || e);
  }
}
export { THREE };
