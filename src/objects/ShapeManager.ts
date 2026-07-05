import * as THREE from 'three';

export type ShapeType = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'knot';

export interface ShapeData {
  id: string;
  type: ShapeType;
  color: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale:    [number, number, number];
}

const BASE_SIZE = 0.28;   // kích thước mặc định khi thả vào scene

function createGeometry(type: ShapeType): THREE.BufferGeometry {
  switch (type) {
    case 'box':      return new THREE.BoxGeometry(BASE_SIZE, BASE_SIZE, BASE_SIZE);
    case 'sphere':   return new THREE.SphereGeometry(BASE_SIZE * 0.6, 32, 32);
    case 'cylinder': return new THREE.CylinderGeometry(BASE_SIZE * 0.45, BASE_SIZE * 0.45, BASE_SIZE, 32);
    case 'cone':     return new THREE.ConeGeometry(BASE_SIZE * 0.5, BASE_SIZE, 32);
    case 'torus':    return new THREE.TorusGeometry(BASE_SIZE * 0.5, BASE_SIZE * 0.18, 16, 64);
    case 'knot':     return new THREE.TorusKnotGeometry(BASE_SIZE * 0.42, BASE_SIZE * 0.13, 96, 16);
  }
}

/**
 * ShapeManager
 * Quản lý các hình khối thả từ thư viện vào scene: tạo, xóa,
 * serialize để autosave, khôi phục từ localStorage.
 *
 * Mesh của shape có userData.shapeId — dùng phân biệt với stroke
 * khi chỉnh sửa / xóa.
 */
export class ShapeManager {
  private scene: THREE.Scene;
  private entries: { mesh: THREE.Mesh; data: ShapeData }[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Danh sách mesh cho raycast chọn vật thể. */
  get meshes(): THREE.Mesh[] {
    return this.entries.map(e => e.mesh);
  }

  add(type: ShapeType, color: string, position: THREE.Vector3): THREE.Mesh {
    const data: ShapeData = {
      id: crypto.randomUUID(),
      type,
      color,
      position: [position.x, position.y, position.z],
      rotation: [0, 0, 0],
      scale:    [1, 1, 1],
    };
    const mesh = this.buildMesh(data);
    this.entries.push({ mesh, data });
    return mesh;
  }

  /** Xóa shape theo mesh. Trả về true nếu mesh thuộc quản lý của manager. */
  remove(mesh: THREE.Object3D): boolean {
    const idx = this.entries.findIndex(e => e.mesh === mesh);
    if (idx === -1) return false;

    const [entry] = this.entries.splice(idx, 1);
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    (entry.mesh.material as THREE.Material).dispose();
    return true;
  }

  /** Cập nhật data từ transform hiện tại của mesh (gọi sau khi kéo/xoay/scale). */
  syncTransform(mesh: THREE.Object3D): boolean {
    const entry = this.entries.find(e => e.mesh === mesh);
    if (!entry) return false;

    entry.data.position = [mesh.position.x, mesh.position.y, mesh.position.z];
    entry.data.rotation = [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z];
    entry.data.scale    = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
    return true;
  }

  serialize(): ShapeData[] {
    return this.entries.map(e => e.data);
  }

  load(shapes: ShapeData[]): void {
    this.clear();
    shapes.forEach(data => {
      const mesh = this.buildMesh(data);
      this.entries.push({ mesh, data });
    });
  }

  clear(): void {
    this.entries.forEach(({ mesh }) => {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    });
    this.entries = [];
  }

  get count(): number {
    return this.entries.length;
  }

  private buildMesh(data: ShapeData): THREE.Mesh {
    const color = new THREE.Color(data.color);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.3,
      roughness: 0.35,
      metalness: 0.15,
    });

    const mesh = new THREE.Mesh(createGeometry(data.type), mat);
    mesh.position.fromArray(data.position);
    mesh.rotation.set(data.rotation[0], data.rotation[1], data.rotation[2]);
    mesh.scale.fromArray(data.scale);
    mesh.userData.shapeId = data.id;
    this.scene.add(mesh);
    return mesh;
  }
}
