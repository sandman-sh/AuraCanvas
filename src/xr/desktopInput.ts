import * as THREE from 'three';
import type { NodeManager, OrbNode } from './nodeManager';
import type { DockAction } from './spatialDock';
import type { SpatialDock } from './spatialDock';

export interface DesktopCallbacks {
  onExpand(node: OrbNode): void;
  onDock(action: DockAction): void;
  onMergeRequest(a: OrbNode, b: OrbNode): void;
  onDragEnd?(node: OrbNode): void;
}

/**
 * Desktop 3D mode: orbit camera, drag orbs, drag-to-merge, double-click expand,
 * click dock buttons. Seated-accessible one-handed play.
 */
export class DesktopInput {
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private dragging: OrbNode | null = null;
  private dragPlane = new THREE.Plane();
  private hovered: OrbNode | null = null;
  private orbiting = false;
  private lastX = 0;
  private lastY = 0;
  private yaw = 0;
  private pitch = 0.08;
  private radius = 1.6;
  private target = new THREE.Vector3(0, 1.25, -0.85);
  private downPos = new THREE.Vector2();
  private downTime = 0;
  private lastClickNode: OrbNode | null = null;
  private lastClickTime = 0;
  private mergeCandidate: OrbNode | null = null;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement,
    private nodes: NodeManager,
    private dock: SpatialDock,
    private cb: DesktopCallbacks,
    private sound: { hover(): void; grab(): void; release(): void; click(): void }
  ) {
    this.applyCamera();
    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.radius = THREE.MathUtils.clamp(this.radius + (e as WheelEvent).deltaY * 0.0016, 1.0, 4.5);
      this.applyCamera();
    }, { passive: false });
  }

  private setPointer(e: PointerEvent): void {
    const r = this.dom.getBoundingClientRect();
    this.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }

  private applyCamera(): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch, -0.5, 0.75);
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.radius,
      this.target.y + Math.sin(this.pitch) * this.radius,
      this.target.z + Math.cos(this.yaw) * cp * this.radius
    );
    this.camera.lookAt(this.target);
  }

  private onDown(e: PointerEvent): void {
    this.setPointer(e);
    this.downPos.set(e.clientX, e.clientY);
    this.downTime = performance.now();
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const dockHit = this.dock.tryHit(this.raycaster);
    if (dockHit) {
      this.sound.click();
      this.cb.onDock(dockHit);
      return;
    }
    const hit = this.nodes.pick(this.raycaster);
    if (hit) {
      this.dragging = hit;
      hit.grabbed = true;
      hit.detail = true;
      this.nodes.refreshCard(hit.data.id);
      this.sound.grab();
      // drag plane faces camera through hit point
      const n = new THREE.Vector3();
      this.camera.getWorldDirection(n);
      this.dragPlane.setFromNormalAndCoplanarPoint(n, hit.group.position);
      this.dom.setPointerCapture?.(e.pointerId);
    } else {
      this.orbiting = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    }
  }

  private onMove(e: PointerEvent): void {
    this.setPointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.dragging) {
      const pt = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.dragPlane, pt)) {
        pt.x = THREE.MathUtils.clamp(pt.x, -2, 2);
        pt.y = THREE.MathUtils.clamp(pt.y, 0.4, 2.4);
        pt.z = THREE.MathUtils.clamp(pt.z, -2.2, 0.4);
        this.dragging.group.position.copy(pt);
      }
      // magnetic hover highlight on merge candidate
      const other = this.nodes.closestTo(this.dragging.group.position, 0.32, this.dragging);
      if (other && other !== this.mergeCandidate) this.sound.hover();
      this.mergeCandidate = other;
      if (other) other.hoverT = Math.min(other.hoverT + 0.08, 1);
    } else if (this.orbiting) {
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      // only orbit after a small deadzone so clicks don't rotate
      if (Math.hypot(e.clientX - this.downPos.x, e.clientY - this.downPos.y) > 6) {
        this.yaw -= dx * 0.005;
        this.pitch += dy * 0.004;
        this.applyCamera();
      }
    } else {
      const hit = this.nodes.pick(this.raycaster);
      if (hit !== this.hovered) {
        this.hovered = hit;
        if (hit) {
          hit.hoverT = 1;
          this.sound.hover();
          this.dom.style.cursor = 'pointer';
        } else {
          this.dom.style.cursor = 'grab';
        }
      }
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.dragging) {
      const d = this.dragging;
      d.grabbed = false;
      this.sound.release();
      // drag-to-merge: dropped within 18cm of another orb
      const other = this.nodes.closestTo(d.group.position, 0.18, d);
      if (other) {
        this.cb.onMergeRequest(d, other);
      } else {
        d.target.copy(d.group.position);
        this.cb.onDragEnd?.(d);
      }
      // double-click (two quick taps) expands
      const now = performance.now();
      if (this.lastClickNode === d && now - this.lastClickTime < 350) {
        this.cb.onExpand(d);
        this.lastClickNode = null;
      } else {
        this.lastClickNode = d;
        this.lastClickTime = now;
      }
      this.dragging = null;
      this.mergeCandidate = null;
      return;
    }
    if (this.orbiting) {
      this.orbiting = false;
      // treat as click on empty space: ignore
      void e;
    }
  }

  getMergeCandidate(): OrbNode | null { return this.mergeCandidate; }
  getDragged(): OrbNode | null { return this.dragging; }
}
