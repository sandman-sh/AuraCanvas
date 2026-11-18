import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Minimal shape of a gamepad haptic actuator (XR + Gamepad specs differ). */
interface HapticActuatorLike {
  pulse?(strength: number, ms: number): Promise<void>;
  playEffect?(type: string, params?: { duration?: number; strongMagnitude?: number; weakMagnitude?: number }): Promise<void>;
}

/** Soft radial glow the workspace sits over — cheap fake grounding shadow. */
function makeGroundGlow(): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
  g.addColorStop(0, 'rgba(10,132,255,0.30)');
  g.addColorStop(0.55, 'rgba(94,92,230,0.12)');
  g.addColorStop(1, 'rgba(94,92,230,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(1.15, 40),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

export class SceneManager {
  renderer!: THREE.WebGLRenderer;
  scene!: THREE.Scene;
  camera!: THREE.PerspectiveCamera;
  rig!: THREE.Group;
  private dust: THREE.Points | null = null;
  private grid: THREE.GridHelper | null = null;
  private groundGlow: THREE.Mesh | null = null;
  private controllers: THREE.Group[] = [];
  /** Fired on controller trigger pull; main.ts maps it to the poke path. */
  onControllerSelect: ((side: number, origin: THREE.Vector3, dir: THREE.Vector3) => void) | null = null;
  passthrough = false;

  init(container: HTMLElement, passthrough: boolean): void {
    this.passthrough = passthrough;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    try { this.renderer.xr.setReferenceSpaceType('local-floor'); } catch { /* older three */ }
    // Richer materials on Quest with zero per-frame cost: image-based lighting
    // + filmic tone mapping instead of flat ambient-only standard materials.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    if (passthrough) {
      this.renderer.setClearColor(0x000000, 0);
    } else {
      this.renderer.setClearColor(new THREE.Color('#f5f5f7'), 1);
    }
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    if (!passthrough) this.scene.fog = new THREE.FogExp2(0xf0f0f4, 0.055);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 60);
    this.camera.position.set(0, 1.6, 0.6);

    this.rig = new THREE.Group();
    this.rig.add(this.camera);
    this.scene.add(this.rig);

    const ambient = new THREE.AmbientLight(0xffffff, 1.05);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(2, 4, 2);
    this.scene.add(key);
    const rim = new THREE.PointLight(0x5e5ce6, 6, 12);
    rim.position.set(-1.5, 2.2, -1.5);
    this.scene.add(rim);
    const fill = new THREE.PointLight(0x0a84ff, 4, 10);
    fill.position.set(1.5, 1.2, -0.5);
    this.scene.add(fill);

    // Image-based lighting: one PMREM bake, no per-frame cost. Makes the
    // standard-material orbs read as glass instead of flat plastic on Quest.
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    } catch { /* desktop without WebGL2 — lights alone still carry the scene */ }

    if (!passthrough) this.buildStudio();
    this.buildDust();

    // Controller rays + trigger: hands-first, but a paired Touch controller
    // must never strand the user. Trigger reuses the exact poke path.
    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      c.addEventListener('selectstart', () => this.fireControllerSelect(i));
      this.scene.add(c);
      this.controllers.push(c);
    }

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  private buildStudio(): void {
    // Light studio floor
    this.grid = new THREE.GridHelper(24, 48, 0xd2d2d7, 0xe8e8ed);
    this.grid.position.y = 0;
    const mat = this.grid.material as THREE.Material;
    mat.transparent = true;
    mat.opacity = 0.6;
    this.scene.add(this.grid);

    const discGeo = new THREE.CircleGeometry(7, 48);
    const discMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.01;
    this.scene.add(disc);

    // Soft grounding glow under the workspace: sells height in VR, hidden in MR.
    this.groundGlow = makeGroundGlow();
    this.groundGlow.position.set(0, 0.015, -0.85);
    this.scene.add(this.groundGlow);
  }

  /** Keep the grounding glow under the recentered workspace. No-op in MR. */
  placeGround(x: number, z: number): void {
    if (this.groundGlow) this.groundGlow.position.set(x, 0.015, z);
  }

  /** Controller trigger → same poke path as a fingertip. Reads the live pose. */
  private fireControllerSelect(side: number): void {
    try {
      const c = this.controllers[side];
      if (!c || !this.onControllerSelect) return;
      const origin = new THREE.Vector3();
      c.getWorldPosition(origin);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(c.getWorldQuaternion(new THREE.Quaternion()));
      this.onControllerSelect(side, origin, dir);
    } catch { /* never break XR on a controller edge */ }
  }

  /** Haptic tick on Touch controllers (and any haptics-capable gamepad). */
  pulseHaptics(strength = 0.6, ms = 18): void {
    try {
      const xr = this.renderer.xr as unknown as { getSession(): unknown };
      const session = xr.getSession() as unknown as {
        inputSources: ArrayLike<unknown>;
      } | null;
      if (!session) return;
      const sources = Array.from(session.inputSources) as Array<{
        gamepad?: { hapticActuators?: HapticActuatorLike[] };
      }>;
      for (const src of sources) {
        const acts = src.gamepad?.hapticActuators;
        if (!acts?.length) continue;
        for (const a of acts) {
          try {
            if (typeof a.pulse === 'function') { void a.pulse(strength, ms); }
            else if (typeof a.playEffect === 'function') {
              void a.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.5 });
            }
          } catch { /* one bad actuator must not kill the loop */ }
        }
      }
    } catch { /* hands have no haptics — silently fine */ }
  }

  private buildDust(): void {
    const count = 220;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 8;
      pos[i * 3 + 1] = Math.random() * 3;
      pos[i * 3 + 2] = -0.5 - Math.random() * 5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x0a84ff, size: 0.012, transparent: true, opacity: 0.35,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.dust = new THREE.Points(geo, mat);
    this.scene.add(this.dust);
  }

  setPassthrough(on: boolean): void {
    this.passthrough = on;
    if (!this.renderer) return;
    if (on) {
      this.renderer.setClearColor(0x000000, 0);
      this.scene.fog = null;
      if (this.grid) this.grid.visible = false;
      if (this.groundGlow) this.groundGlow.visible = false;
    } else {
      this.renderer.setClearColor(new THREE.Color('#f5f5f7'), 1);
      this.scene.fog = new THREE.FogExp2(0xf0f0f4, 0.055);
      if (this.grid) this.grid.visible = true;
      if (this.groundGlow) this.groundGlow.visible = true;
    }
  }

  startLoop(tick: (dt: number, t: number, frame: unknown) => void): void {
    const clock = new THREE.Clock();
    this.renderer.setAnimationLoop((_t: number, frame?: unknown) => {
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      if (this.dust) {
        this.dust.rotation.y = t * 0.01;
        const m = this.dust.material as THREE.PointsMaterial;
        m.opacity = 0.35 + Math.sin(t * 0.7) * 0.12;
      }
      tick(dt, t, frame ?? null);
      this.renderer.render(this.scene, this.camera);
    });
  }

  async startXR(mode: 'immersive-ar' | 'immersive-vr'): Promise<boolean> {
    if (!('xr' in navigator) || !this.renderer.xr) return false;
    try {
      const required: Record<string, unknown> = {
        optionalFeatures: ['hand-tracking', 'local-floor', 'bounded-floor']
      };
      if (mode === 'immersive-ar') {
        (required as Record<string, unknown>)['optionalFeatures'] = ['hand-tracking', 'local-floor', 'bounded-floor'];
      }
      const session = await (navigator as Navigator & { xr?: { requestSession(m: string, o?: unknown): Promise<unknown> } }).xr!.requestSession(mode, required);
      await this.renderer.xr.setSession(session as never);
      this.setPassthrough(mode === 'immersive-ar');
      (session as { addEventListener(e: string, f: () => void): void }).addEventListener('end', () => this.setPassthrough(false));
      return true;
    } catch {
      return false;
    }
  }

  static async isSupported(mode: 'immersive-ar' | 'immersive-vr'): Promise<boolean> {
    try {
      const nav = navigator as Navigator & { xr?: { isSessionSupported(m: string): Promise<boolean> } };
      if (!nav.xr?.isSessionSupported) return false;
      return await nav.xr.isSessionSupported(mode);
    } catch { return false; }
  }
}
