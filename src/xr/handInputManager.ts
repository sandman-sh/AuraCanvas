import * as THREE from 'three';

export interface TrackedHand {
  handedness: string;
  pinching: boolean;
  pinchDist: number;
  pinchPos: THREE.Vector3;
  indexTip: THREE.Vector3;
  wrist: THREE.Vector3;
  present: boolean;
  /** Seconds the current pinch has been held (for hold-to-confirm gestures). */
  pinchHoldT: number;
}

/** Hysteresis band: grab below GRAB_D, release above RELEASE_D. Prevents flutter. */
const GRAB_D = 0.028;
const RELEASE_D = 0.038;

function jointPos(frame: unknown, space: unknown, refSpace: unknown): THREE.Vector3 | null {
  try {
    const f = frame as { getJointPose?(s: unknown, r: unknown): { transform: { position: { x: number; y: number; z: number } } } | null };
    if (!f.getJointPose) return null;
    const pose = f.getJointPose(space, refSpace);
    if (!pose) return null;
    const p = pose.transform.position;
    return new THREE.Vector3(p.x, p.y, p.z);
  } catch { return null; }
}

/**
 * WebXR hand tracking: pinch/grab/poke state + visual pinch cursor.
 * Fully null-guarded for desktop / IWE without hands.
 */
export class HandInputManager {
  hands: TrackedHand[] = [];
  cursors: THREE.Mesh[] = [];
  controllerRays: THREE.Line[] = [];

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    for (let i = 0; i < 2; i++) {
      const cursor = new THREE.Mesh(
        new THREE.TorusGeometry(0.018, 0.004, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.9, depthWrite: false })
      );
      cursor.visible = false;
      scene.add(cursor);
      this.cursors.push(cursor);
      this.hands.push({
        handedness: i === 0 ? 'left' : 'right', pinching: false, pinchDist: 1,
        pinchPos: new THREE.Vector3(), indexTip: new THREE.Vector3(), wrist: new THREE.Vector3(), present: false,
        pinchHoldT: 0
      });
    }
    // Controller ray fallback visuals
    for (let i = 0; i < 2; i++) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x0a84ff, transparent: true, opacity: 0.6 }));
      line.visible = false;
      scene.add(line);
      this.controllerRays.push(line);
    }
  }

  update(frame: unknown, refSpace: unknown, dt = 0.016): void {
    if (!frame || !this.renderer.xr.isPresenting) {
      this.hands.forEach((h) => { h.present = false; });
      this.cursors.forEach((c) => { c.visible = false; });
      this.controllerRays.forEach((l) => { l.visible = false; });
      return;
    }
    try {
      const session = (this.renderer.xr.getSession() as unknown as { inputSources: ArrayLike<unknown> } | null);
      const sources = session ? [...(session.inputSources as unknown as Iterable<unknown>)] as Array<Record<string, unknown>> : [];
      let hi = 0;
      let ci = 0;
      for (const src of sources) {
        const hand = src['hand'] as { get(k: string): unknown } | undefined;
        const handedness = (src['handedness'] as string) || 'unknown';
        if (hand && typeof hand.get === 'function' && hi < 2) {
          const h = this.hands[hi];
          const thumb = jointPos(frame, hand.get('thumb-tip'), refSpace);
          const index = jointPos(frame, hand.get('index-finger-tip'), refSpace);
          const wrist = jointPos(frame, hand.get('wrist'), refSpace);
          if (thumb && index) {
            h.present = true;
            h.handedness = handedness;
            h.indexTip.copy(index);
            if (wrist) h.wrist.copy(wrist);
            h.pinchPos.copy(thumb).add(index).multiplyScalar(0.5);
            h.pinchDist = thumb.distanceTo(index);
            // Hysteresis: state flips only when crossing its own edge.
            if (h.pinching) {
              if (h.pinchDist > RELEASE_D) { h.pinching = false; h.pinchHoldT = 0; }
              else h.pinchHoldT += dt;
            } else {
              if (h.pinchDist < GRAB_D) { h.pinching = true; h.pinchHoldT = 0; }
            }
            const cursor = this.cursors[hi];
            cursor.visible = true;
            cursor.position.copy(h.pinchPos);
            const mat = cursor.material as THREE.MeshBasicMaterial;
            if (h.pinching) { mat.color.setHex(0x1d8127); cursor.scale.setScalar(0.55); }
            else {
              const s = THREE.MathUtils.clamp(h.pinchDist * 12, 0.8, 2.2);
              mat.color.setHex(0x0a84ff);
              cursor.scale.setScalar(s);
            }
            hi++;
            continue;
          }
        }
        // Controller fallback ray
        const raySpace = src['targetRaySpace'] as unknown;
        const mode = src['targetRayMode'] as string;
        if (raySpace && mode && mode !== 'screen' && ci < 2) {
          try {
            const f = frame as { getPose?(s: unknown, r: unknown): { transform: { position: { x: number; y: number; z: number }; orientation: { x: number; y: number; z: number; w: number } } } | null };
            const pose = f.getPose ? f.getPose(raySpace, refSpace) : null;
            if (pose) {
              const line = this.controllerRays[ci];
              line.visible = true;
              const p = pose.transform.position;
              const q = pose.transform.orientation;
              const quat = new THREE.Quaternion(q.x, q.y, q.z, q.w);
              const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
              line.geometry.setFromPoints([new THREE.Vector3(p.x, p.y, p.z), new THREE.Vector3(p.x, p.y, p.z).addScaledVector(dir, 2)]);
              ci++;
            }
          } catch { /* ignore */ }
        }
      }
      for (let i = hi; i < 2; i++) {
        this.hands[i].present = false;
        this.cursors[i].visible = false;
      }
      for (let i = ci; i < 2; i++) this.controllerRays[i].visible = false;
    } catch {
      /* never crash the frame loop on hand errors */
    }
  }
}
