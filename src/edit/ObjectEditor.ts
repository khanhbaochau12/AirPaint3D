import * as THREE from 'three';

export type EditTool = 'move' | 'rotate' | 'scale';

const HOVER_COLOR    = 0xffffff;
const SELECT_COLOR   = 0x63b3ed;
const ROTATE_FACTOR  = 5;      // rad trên một lần quét hết màn hình
const SCALE_FACTOR   = 2.5;    // hệ số scale trên một lần quét dọc màn hình
const SCALE_LIMITS   = [0.05, 8] as const;

/**
 * ObjectEditor
 * Chế độ chỉnh sửa vật thể bằng cử chỉ tay:
 *   - POINT  → hover: raycast từ con trỏ, viền BoxHelper trắng
 *   - PINCH  → grab vật thể đang hover (viền xanh), kéo theo công cụ:
 *       move   — vật thể bám theo vị trí tay (đủ 3 trục, Z từ hand size)
 *       rotate — dx/dy màn hình → rotation.y / rotation.x
 *       scale  — kéo dọc → scale đều (kéo lên = to, kéo xuống = nhỏ)
 *   - thả tay → release, vật thể vẫn được "chọn" để bấm Xóa
 *
 * Editor không sở hữu vật thể — nhận danh sách qua getTargets(),
 * báo thay đổi qua onChanged (để autosave + sync data).
 */
export class ObjectEditor {
  tool: EditTool = 'move';

  /**
   * Dung sai chọn vật thể (bán kính NDC). Nét vẽ rất mảnh (~0.015 world),
   * tay run khó trỏ trúng — khi ray chính giữa trượt, quét thêm vòng
   * offset quanh con trỏ. Chỉnh được từ panel Tinh chỉnh.
   */
  pickTolerance = 0.02;

  private scene: THREE.Scene;
  private getTargets: () => THREE.Object3D[];
  private onChanged?: (obj: THREE.Object3D) => void;

  private raycaster = new THREE.Raycaster();
  private box: THREE.BoxHelper | null = null;

  private hovered: THREE.Object3D | null = null;
  private grabbed: THREE.Object3D | null = null;
  private _selected: THREE.Object3D | null = null;

  private grabOffset = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    getTargets: () => THREE.Object3D[],
    onChanged?: (obj: THREE.Object3D) => void
  ) {
    this.scene = scene;
    this.getTargets = getTargets;
    this.onChanged = onChanged;
  }

  get selected(): THREE.Object3D | null {
    return this._selected;
  }

  get isGrabbing(): boolean {
    return this.grabbed !== null;
  }

  /** Raycast từ con trỏ tay, cập nhật highlight hover. */
  updateHover(ndc: THREE.Vector2, camera: THREE.Camera): void {
    if (this.grabbed) return;   // đang kéo thì không đổi hover

    let target = this.raycastAt(ndc.x, ndc.y, camera);

    // Fat-ray: trượt thì quét 2 vòng offset quanh con trỏ
    if (!target && this.pickTolerance > 0) {
      outer:
      for (const ring of [0.5, 1]) {
        const r = this.pickTolerance * ring;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          target = this.raycastAt(ndc.x + Math.cos(a) * r, ndc.y + Math.sin(a) * r, camera);
          if (target) break outer;
        }
      }
    }

    if (target !== this.hovered) {
      this.hovered = target;
      this.refreshBox();
    }
  }

  private raycastAt(x: number, y: number, camera: THREE.Camera): THREE.Object3D | null {
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
    return this.raycaster.intersectObjects(this.getTargets(), false)[0]?.object ?? null;
  }

  /** PINCH edge: grab vật thể đang hover (nếu có). */
  tryGrab(ndc: THREE.Vector2, camera: THREE.Camera, handWorldPos: THREE.Vector3): boolean {
    this.updateHover(ndc, camera);
    if (!this.hovered) return false;

    this.grabbed  = this.hovered;
    this._selected = this.hovered;
    this.grabOffset.subVectors(this.grabbed.position, handWorldPos);
    this.refreshBox();
    return true;
  }

  /** Gọi mỗi frame khi đang giữ PINCH. dx/dy là delta chuẩn hóa [0..1]/frame. */
  drag(handWorldPos: THREE.Vector3, dx: number, dy: number): void {
    const obj = this.grabbed;
    if (!obj) return;

    switch (this.tool) {
      case 'move':
        obj.position.copy(handWorldPos).add(this.grabOffset);
        break;

      case 'rotate':
        obj.rotation.y += dx * ROTATE_FACTOR;
        obj.rotation.x += dy * ROTATE_FACTOR;
        break;

      case 'scale': {
        // Kéo lên (dy âm) = phóng to
        const f = 1 - dy * SCALE_FACTOR;
        const next = obj.scale.x * f;
        if (next >= SCALE_LIMITS[0] && next <= SCALE_LIMITS[1]) {
          obj.scale.multiplyScalar(f);
        }
        break;
      }
    }

    this.box?.update();
    this.onChanged?.(obj);
  }

  release(): void {
    this.grabbed = null;
  }

  /** Chọn trực tiếp một vật thể (khi vừa thả từ thư viện). */
  select(obj: THREE.Object3D): void {
    this._selected = obj;
    this.hovered = null;
    this.refreshBox();
  }

  /** Trả về vật thể đang chọn và bỏ mọi highlight — caller lo việc xóa thật. */
  takeSelected(): THREE.Object3D | null {
    const obj = this._selected;
    this.grabbed = null;
    this._selected = null;
    if (this.hovered === obj) this.hovered = null;
    this.refreshBox();
    return obj;
  }

  /** Bỏ chọn + hover (khi rời chế độ chỉnh sửa / xóa tất cả). */
  reset(): void {
    this.grabbed = null;
    this._selected = null;
    this.hovered = null;
    this.refreshBox();
  }

  private refreshBox(): void {
    const target = this.hovered ?? this._selected;

    if (this.box) {
      this.scene.remove(this.box);
      this.box.geometry.dispose();
      (this.box.material as THREE.Material).dispose();
      this.box = null;
    }
    if (!target) return;

    const color = target === this._selected ? SELECT_COLOR : HOVER_COLOR;
    this.box = new THREE.BoxHelper(target, color);
    (this.box.material as THREE.LineBasicMaterial).transparent = true;
    (this.box.material as THREE.LineBasicMaterial).opacity = 0.85;
    this.scene.add(this.box);
  }
}
