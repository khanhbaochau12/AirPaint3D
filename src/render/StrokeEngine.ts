import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';

/** Loại bút — quyết định material của nét vẽ. */
export type BrushType = 'normal' | 'neon' | 'glass';

export interface StrokeOptions {
  color: THREE.Color | string | number;
  brushRadius: number;   // world units, default 0.015
  brushType: BrushType;
  emissiveIntensity?: number;
}

export interface StrokeData {
  id: string;
  points: THREE.Vector3[];
  color: string;
  radius: number;
  /** Dữ liệu cũ không có field này — hydrate mặc định 'normal'. */
  brush?: BrushType;
  /** Transform sau khi chỉnh sửa (di chuyển/xoay/thu phóng). Optional — tương thích ngược. */
  transform?: {
    position: [number, number, number];
    rotation: [number, number, number];
    scale:    [number, number, number];
  };
  timestamp: number;
}

/**
 * StrokeEngine
 * Quản lý toàn bộ lifecycle của một nét vẽ 3D:
 *   addPoint() → rebuildCurrentStroke() → commitStroke()
 *
 * Mỗi stroke là một THREE.TubeGeometry với Catmull-Rom spline.
 * Giữ danh sách tất cả strokes để hỗ trợ undo / export.
 */
export class StrokeEngine {
  private scene: THREE.Scene;
  private activePoints: THREE.Vector3[] = [];
  private activeMesh: THREE.Mesh | null = null;
  private committedStrokes: { mesh: THREE.Mesh; data: StrokeData }[] = [];
  private redoStack: { mesh: THREE.Mesh; data: StrokeData }[] = [];
  private options: StrokeOptions;

  /** Gọi sau mỗi commitStroke() thành công — dùng cho multiplayer / autosave. */
  onStrokeCommitted?: (data: StrokeData) => void;

  // Geometry pool — tái sử dụng material để giảm draw calls
  private materialCache = new Map<string, THREE.MeshStandardMaterial>();

  constructor(scene: THREE.Scene, opts: Partial<StrokeOptions> = {}) {
    this.scene = scene;
    this.options = {
      color: '#63b3ed',
      brushRadius: 0.015,
      brushType: 'normal',
      emissiveIntensity: 0.35,
      ...opts,
    };
  }

  // ──────────────────────────────────────────────────────────
  // PUBLIC API
  // ──────────────────────────────────────────────────────────

  /**
   * Thêm điểm mới vào stroke đang vẽ.
   * Gọi khi gesture === PINCH.
   */
  addPoint(worldPos: THREE.Vector3): void {
    // Lọc điểm quá gần nhau để tránh geometry phức tạp không cần thiết
    if (this.activePoints.length > 0) {
      const last = this.activePoints[this.activePoints.length - 1];
      if (worldPos.distanceTo(last) < 0.003) return;
    }

    this.activePoints.push(worldPos.clone());

    // Cần ít nhất 2 điểm để TubeGeometry hoạt động
    if (this.activePoints.length >= 2) {
      this.rebuildCurrentStroke();
    }
  }

  /** Kết thúc stroke hiện tại, lưu vào lịch sử. Trả về data nếu commit thành công. */
  commitStroke(): StrokeData | null {
    if (!this.activeMesh || this.activePoints.length < 2) {
      // Clean up nếu stroke quá ngắn
      if (this.activeMesh) {
        this.scene.remove(this.activeMesh);
        this.activeMesh.geometry.dispose();
        this.activeMesh = null;
      }
      this.activePoints = [];
      return null;
    }

    const data: StrokeData = {
      id:        crypto.randomUUID(),
      points:    [...this.activePoints],
      color:     `#${new THREE.Color(this.options.color).getHexString()}`,
      radius:    this.options.brushRadius,
      brush:     this.options.brushType,
      timestamp: Date.now(),
    };

    // Recenter: dời gốc geometry về tâm bounding box để xoay/thu phóng
    // trong chế độ chỉnh sửa quay quanh tâm nét thay vì gốc tọa độ world
    this.recenterMesh(this.activeMesh);

    this.committedStrokes.push({ mesh: this.activeMesh, data });
    this.activeMesh = null;
    this.activePoints = [];

    // Stroke mới vô hiệu hóa nhánh redo cũ
    this.clearRedoStack();

    this.onStrokeCommitted?.(data);
    return data;
  }

  private recenterMesh(mesh: THREE.Mesh): void {
    mesh.geometry.computeBoundingBox();
    const center = new THREE.Vector3();
    mesh.geometry.boundingBox!.getCenter(center);
    mesh.geometry.translate(-center.x, -center.y, -center.z);
    mesh.position.add(center);
  }

  /** Xóa stroke cuối cùng (Ctrl+Z). Trả về id stroke đã xóa để broadcast. */
  undo(): string | null {
    const entry = this.committedStrokes.pop();
    if (!entry) return null;

    this.scene.remove(entry.mesh);
    // Không dispose geometry — giữ lại cho redo
    this.redoStack.push(entry);
    return entry.data.id;
  }

  /** Vẽ lại stroke vừa undo (Ctrl+Y). Trả về data để broadcast. */
  redo(): StrokeData | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;

    this.scene.add(entry.mesh);
    this.committedStrokes.push(entry);
    return entry.data;
  }

  /** Xóa stroke theo id (nhận từ multiplayer). */
  removeById(id: string): void {
    const idx = this.committedStrokes.findIndex(s => s.data.id === id);
    if (idx === -1) return;

    const [entry] = this.committedStrokes.splice(idx, 1);
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    // Material có thể đang được dùng bởi stroke khác, không dispose
  }

  /** Xóa stroke theo mesh (chế độ chỉnh sửa). Trả về true nếu mesh là stroke. */
  removeByMesh(mesh: THREE.Object3D): boolean {
    const idx = this.committedStrokes.findIndex(s => s.mesh === mesh);
    if (idx === -1) return false;

    const [entry] = this.committedStrokes.splice(idx, 1);
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    return true;
  }

  /** Danh sách mesh đã commit — dùng cho raycast chọn vật thể. */
  get meshes(): THREE.Mesh[] {
    return this.committedStrokes.map(s => s.mesh);
  }

  /** Lưu transform hiện tại của mesh vào data (sau khi kéo/xoay/scale). */
  syncTransform(mesh: THREE.Object3D): boolean {
    const entry = this.committedStrokes.find(s => s.mesh === mesh);
    if (!entry) return false;

    entry.data.transform = {
      position: [mesh.position.x, mesh.position.y, mesh.position.z],
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      scale:    [mesh.scale.x, mesh.scale.y, mesh.scale.z],
    };
    return true;
  }

  /** Xóa toàn bộ canvas. */
  clear(): void {
    // Xóa stroke đang vẽ
    if (this.activeMesh) {
      this.scene.remove(this.activeMesh);
      this.activeMesh.geometry.dispose();
      this.activeMesh = null;
    }
    this.activePoints = [];

    // Xóa tất cả strokes đã commit
    this.committedStrokes.forEach(({ mesh }) => {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    });
    this.committedStrokes = [];
    this.clearRedoStack();

    // Dispose toàn bộ material cache
    this.materialCache.forEach(mat => mat.dispose());
    this.materialCache.clear();
  }

  private clearRedoStack(): void {
    this.redoStack.forEach(({ mesh }) => mesh.geometry.dispose());
    this.redoStack = [];
  }

  /** Cập nhật màu/kích thước brush cho stroke tiếp theo. */
  setOptions(opts: Partial<StrokeOptions>): void {
    this.options = { ...this.options, ...opts };
  }

  /** Trả về tất cả StrokeData để serialize/sync. */
  exportData(): StrokeData[] {
    return this.committedStrokes.map(s => s.data);
  }

  /** Tái tạo toàn bộ tranh từ dữ liệu đã serialize (localStorage / sync_full). */
  loadData(strokes: StrokeData[]): void {
    this.clear();
    strokes.forEach(s => this.hydrateStroke(s));
  }

  get strokeCount(): number {
    return this.committedStrokes.length;
  }

  /**
   * Xuất toàn bộ scene thành file GLTF binary (.glb).
   * Download về máy người dùng.
   */
  async exportGLTF(): Promise<void> {
    const exporter = new GLTFExporter();
    const group = new THREE.Group();
    group.name = 'AirPaint3D_Export';

    this.committedStrokes.forEach(({ mesh }) => {
      group.add(mesh.clone());
    });

    return new Promise((resolve, reject) => {
      exporter.parse(
        group,
        (gltf) => {
          const blob = new Blob([gltf as ArrayBuffer], { type: 'model/gltf-binary' });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href     = url;
          a.download = `airpaint_${Date.now()}.glb`;
          a.click();
          URL.revokeObjectURL(url);
          resolve();
        },
        (error) => reject(error),
        { binary: true }
      );
    });
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE: GEOMETRY
  // ──────────────────────────────────────────────────────────

  /**
   * Rebuild TubeGeometry từ activePoints mỗi khi có điểm mới.
   *
   * Chiến lược hiệu suất:
   * - Xóa geometry cũ ngay lập tức (tránh GPU memory leak)
   * - Giới hạn tubularSegments theo số điểm
   * - Tái dùng Material từ cache (khóa = colorHex)
   */
  private rebuildCurrentStroke(): void {
    // 1. Dispose geometry cũ
    if (this.activeMesh) {
      this.scene.remove(this.activeMesh);
      this.activeMesh.geometry.dispose();
      this.activeMesh = null;
    }

    const pts = this.activePoints;

    // 2. Catmull-Rom spline — làm mượt input thô
    const curve = new THREE.CatmullRomCurve3(
      pts,
      false,          // closed
      'catmullrom',   // type: centripetal | chordal | catmullrom
      0.5             // tension: 0 = round, 1 = tight
    );

    // 3. Số segment tỉ lệ với số điểm, giới hạn 300
    const tubularSegments = Math.min(pts.length * 4, 300);

    const geo = new THREE.TubeGeometry(
      curve,
      tubularSegments,
      this.options.brushRadius,
      8,      // radialSegments — 8 = mượt đủ, không quá nặng
      false   // closed
    );

    // 4. Lấy / tạo material từ cache
    const mat = this.getOrCreateMaterial(
      new THREE.Color(this.options.color).getHexString(),
      this.options.brushType
    );

    // 5. Tạo mesh và thêm vào scene
    this.activeMesh = new THREE.Mesh(geo, mat);
    this.activeMesh.name = 'active_stroke';
    this.scene.add(this.activeMesh);
  }

  private getOrCreateMaterial(hexKey: string, type: BrushType): THREE.MeshStandardMaterial {
    const cacheKey = `${type}_${hexKey}`;
    if (this.materialCache.has(cacheKey)) {
      return this.materialCache.get(cacheKey)!;
    }

    const color = new THREE.Color(`#${hexKey}`);

    // Mỗi loại bút một bộ tham số material riêng
    const params: THREE.MeshStandardMaterialParameters = {
      color,
      emissive: color,
    };
    switch (type) {
      case 'neon':
        params.emissiveIntensity = 1.4;
        params.roughness = 0.15;
        params.metalness = 0;
        break;
      case 'glass':
        params.emissiveIntensity = 0.15;
        params.roughness = 0.05;
        params.metalness = 0.3;
        params.transparent = true;
        params.opacity = 0.45;
        break;
      default:
        params.emissiveIntensity = this.options.emissiveIntensity ?? 0.35;
        params.roughness = 0.3;
        params.metalness = 0.1;
    }

    const mat = new THREE.MeshStandardMaterial(params);
    this.materialCache.set(cacheKey, mat);
    return mat;
  }

  // ──────────────────────────────────────────────────────────
  // HYDRATE — Tái tạo stroke từ serialized data (multiplayer)
  // ──────────────────────────────────────────────────────────

  hydrateStroke(data: StrokeData): void {
    if (data.points.length < 2) return;

    const pts   = data.points.map(p => new THREE.Vector3(p.x, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts);
    const geo   = new THREE.TubeGeometry(curve, Math.min(pts.length * 4, 300), data.radius, 8, false);
    const mat   = this.getOrCreateMaterial(
      new THREE.Color(data.color).getHexString(),
      data.brush ?? 'normal'
    );

    const mesh  = new THREE.Mesh(geo, mat);
    mesh.name   = `remote_stroke_${data.id}`;

    // Recenter giống commitStroke để transform lưu trữ khớp hệ quy chiếu
    this.recenterMesh(mesh);

    // Áp transform đã lưu (nếu stroke từng được chỉnh sửa)
    if (data.transform) {
      mesh.position.fromArray(data.transform.position);
      mesh.rotation.set(...data.transform.rotation);
      mesh.scale.fromArray(data.transform.scale);
    }

    this.scene.add(mesh);
    this.committedStrokes.push({ mesh, data });
  }
}
