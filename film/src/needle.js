// The needle: a 3.4 m silver sewing needle Io rides like a flying sword.
// Local frame: needle lies along Z, tip toward +Z, top surface at y = 0, rider stands around z in [-0.4, 0.4].
import * as THREE from 'three';
import { toonMat } from './materials.js';
import { smoothstep } from './lib.js';

export const NEEDLE = { tipZ: 1.9, tailZ: -1.15, eyeZ: -1.33, halfW: 0.06, halfH: 0.034, spoolZ: -0.82, spoolY: 0.17 };

export function createNeedle() {
  const root = new THREE.Group(); root.name = 'needle';
  const steel = toonMat({ color: 0xe9eef7, metalness: 1.0, roughness: 0.2, envMapIntensity: 1.6, rim: 0.6, rimPower: 2.5 });
  const brass = toonMat({ color: 0xd8a24a, metalness: 1.0, roughness: 0.32, envMapIntensity: 1.3, rim: 0.4 });
  const wood = toonMat({ color: 0x6a4630, roughness: 0.8, rim: 0.3 });

  // body: elliptical cross-section swept along z
  const NS = 64, NR = 20, pos = [], idx = [];
  for (let i = 0; i <= NS; i++) {
    const s = i / NS; const z = NEEDLE.tailZ + (NEEDLE.tipZ - NEEDLE.tailZ) * s;
    let k = 1.0;
    if (s > 0.45) k = Math.pow(1 - (s - 0.45) / 0.55, 0.85);       // long taper to the point
    if (s < 0.06) k = 0.55 + 0.45 * smoothstep(0, 0.06, s);          // neck toward the eye
    const hw = NEEDLE.halfW * k, hh = NEEDLE.halfH * (0.35 + 0.65 * k);
    for (let j = 0; j < NR; j++) { const a = j / NR * Math.PI * 2; pos.push(Math.cos(a) * hw, -NEEDLE.halfH + Math.sin(a) * hh, z); }
  }
  for (let i = 0; i < NS; i++) for (let j = 0; j < NR; j++) {
    const a = i * NR + j, b = i * NR + (j + 1) % NR, c = a + NR, d = b + NR; idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const body = new THREE.Mesh(g, steel); root.add(body);

  // eye: elongated ring at the tail, hole axis along X so it reads from the side
  const eyeG = new THREE.TorusGeometry(0.075, 0.021, 14, 40); eyeG.rotateY(Math.PI / 2); eyeG.scale(1.0, 0.78, 2.3);
  const eyeM = new THREE.Mesh(eyeG, steel); eyeM.position.set(0, -NEEDLE.halfH, NEEDLE.eyeZ); root.add(eyeM);
  const eye = new THREE.Object3D(); eye.position.set(0, -NEEDLE.halfH, NEEDLE.eyeZ - 0.03); root.add(eye);

  // spool on a brass fork behind the rider
  const spool = new THREE.Group(); spool.position.set(0, NEEDLE.spoolY, NEEDLE.spoolZ); root.add(spool);
  const spin = new THREE.Group(); spool.add(spin);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.2, 20).rotateZ(Math.PI / 2), wood); spin.add(core);
  for (const sx of [-1, 1]) {
    const fl = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.125, 0.016, 32).rotateZ(Math.PI / 2), brass); fl.position.x = sx * 0.095; spin.add(fl);
    for (let h = 0; h < 5; h++) { // spokes cut-out impression: small studs so rotation is readable
      const st = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), wood); const a = h / 5 * Math.PI * 2;
      st.position.set(sx * 0.105, Math.cos(a) * 0.085, Math.sin(a) * 0.085); spin.add(st);
    }
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, NEEDLE.spoolY + 0.03, 10), brass);
    arm.position.set(sx * 0.118, -(NEEDLE.spoolY + 0.03) / 2 + 0.01, 0); arm.rotation.z = sx * 0.33; spool.add(arm);
  }
  const threadMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1.0, 0.72, 0.3), emissiveIntensity: 3.0, roughness: 0.6 });
  const wound = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.168, 28, 1).rotateZ(Math.PI / 2), threadMat); spin.add(wound);
  // short visible run of thread from spool to eye
  const lead = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 6), threadMat); root.add(lead);

  for (const m of [body, eyeM, core, wound, lead]) { m.castShadow = true; m.receiveShadow = true; }
  root.traverse((o) => { if (o.isMesh) { o.layers.enable(1); o.castShadow = true; } });

  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  const api = {
    root, eye, spool, threadMat, amount: 1,
    /** k: 1 = full spool, 0 = bare. */
    setThread(k) {
      api.amount = k; const r = 0.041 + 0.07 * Math.max(0, k); wound.scale.set(1, r, r); wound.visible = k > 0.002;
      lead.visible = k > 0.002 || api.leadForced;
      tmpA.set(0, NEEDLE.spoolY + r * 0.2, NEEDLE.spoolZ - r); tmpB.copy(eye.position);
      lead.position.copy(tmpA).add(tmpB).multiplyScalar(0.5); lead.scale.set(1, tmpA.distanceTo(tmpB), 1);
      lead.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmpB.clone().sub(tmpA).normalize());
    },
    setThreadColor(emissive, intensity = 3.0) { threadMat.emissive.copy(emissive); threadMat.emissiveIntensity = intensity; },
    setSpin(a) { spin.rotation.x = a; },
  };
  api.setThread(1);
  return api;
}
