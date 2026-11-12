// Stand-in for the heroine with the same API as character.js (used only for blocking shots).
import * as THREE from 'three';
import { toonMat } from './materials.js';

export function createIo() {
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const coat = toonMat({ color: 0x27305e, roughness: 0.9 }), skin = toonMat({ color: 0xf6d2b8, sss: 0xff5a3a }), hairM = toonMat({ color: 0x1b2140 }), red = toonMat({ color: 0xc8232c, sheen: 1, sheenColor: 0xff8a70 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.5, 8, 16), coat); torso.position.y = 0.85;
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.45, 8, 12), toonMat({ color: 0x33343c })); legs.position.y = 0.35;
  const head = new THREE.Group(); head.position.y = 1.32;
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.125, 24, 16), skin); const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 24, 16, 0, 6.283, 0, 1.9), hairM); hair.rotation.x = -0.5;
  head.add(skull, hair);
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.055, 10, 20).rotateX(Math.PI / 2), red); scarf.position.y = 1.19;
  const tails = [0, 1].map((i) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 1.3).translate(0, 0, -0.65), red); m.position.set(i ? 0.06 : -0.06, 1.17, -0.08); body.add(m); return m; });
  const mk = () => new THREE.Object3D();
  const anchors = { head, neck: mk(), chest: mk(), hips: mk(), handL: mk(), handR: mk(), palmL: mk(), palmR: mk(), footL: mk(), footR: mk(), eyeL: mk(), eyeR: mk(), cup: mk(), scarfTipL: mk(), scarfTipR: mk() };
  anchors.eyeL.position.set(0.045, 0.01, 0.11); anchors.eyeR.position.set(-0.045, 0.01, 0.11); head.add(anchors.eyeL, anchors.eyeR);
  anchors.neck.position.y = 1.2; anchors.chest.position.y = 1.0; anchors.hips.position.y = 0.7;
  const hand = (sx) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), toonMat({ color: 0xf1e6d0 })); m.position.set(sx * 0.12, 0.95, 0.25); body.add(m); return m; };
  const hL = hand(1), hR = hand(-1); hL.add(anchors.handL, anchors.palmL); hR.add(anchors.handR, anchors.palmR);
  anchors.cup.position.set(0, 0.95, 0.27);
  body.add(torso, legs, head, scarf, anchors.neck, anchors.chest, anchors.hips, anchors.cup, anchors.footL, anchors.footR, anchors.scarfTipL, anchors.scarfTipR);
  root.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.layers.enable(1); } });
  const P = (name, o = {}) => ({ name, y: 0, lean: 0, armR: [-0.12, 0.95, 0.25], armL: [0.12, 0.95, 0.25], headPitch: 0, ...o });
  const POSES = {
    stand: P('stand'), sitCup: P('sitCup', { y: -0.55, headPitch: 0.4 }), lookUp: P('lookUp', { headPitch: -0.7 }), crouch: P('crouch', { y: -0.45, lean: 0.3 }),
    surf: P('surf', { y: -0.18, lean: 0.25, armR: [-0.15, 0.9, 0.45], armL: [0.2, 0.9, -0.3] }), reach: P('reach', { y: -0.05, armR: [-0.1, 1.85, 0.05], headPitch: -0.6 }),
    catch: P('catch', { lean: 0.6, armR: [-0.1, 1.5, 0.7] }), tie: P('tie', { armR: [-0.12, 1.0, 0.25], armL: [0.12, 1.0, 0.25], headPitch: 0.3 }),
    pull: P('pull', { lean: -0.6, armR: [-0.1, 1.2, 0.2], armL: [0.0, 1.15, 0.25] }), rest: P('rest', { y: -0.6 }),
  };
  const mixA = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  return {
    root, anchors, POSES, stub: true,
    blendPose: (a, b, k) => ({ name: k < 0.5 ? a.name : b.name, y: a.y + (b.y - a.y) * k, lean: a.lean + (b.lean - a.lean) * k, armR: mixA(a.armR, b.armR, k), armL: mixA(a.armL, b.armL, k), headPitch: a.headPitch + (b.headPitch - a.headPitch) * k }),
    setPose(p) { body.position.y = p.y; body.rotation.x = p.lean; hR.position.fromArray(p.armR); hL.position.fromArray(p.armL); head.rotation.x = p.headPitch; },
    setFace() {},
    update(t, { wind = new THREE.Vector3(), scarfLen = 1, scarfWrap = 1 } = {}) {
      const w = wind.clone().applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion()).invert()); const sp = Math.min(1, w.length() / 30);
      tails.forEach((m, i) => { m.visible = scarfLen > 0.02; m.scale.z = Math.max(0.01, scarfLen); m.rotation.x = (1 - sp) * 1.3 + Math.sin(t * 9 + i) * 0.15 * sp; m.rotation.y = Math.atan2(-w.x, -w.z) * sp + Math.sin(t * 7 + i * 2) * 0.2; });
      scarf.visible = scarfWrap > 0.05; scarf.scale.setScalar(Math.max(0.01, scarfWrap));
      root.updateMatrixWorld(true);
      tails.forEach((m, i) => { const a = i ? anchors.scarfTipL : anchors.scarfTipR; a.position.copy(new THREE.Vector3(0, 0, -1.3 * scarfLen).applyMatrix4(m.matrix)); });
    },
  };
}
