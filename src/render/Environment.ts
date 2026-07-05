import * as THREE from 'three';

const GRID_SIZE      = 24;
const GRID_DIVISIONS = 48;
const GRID_Y         = -1.6;
const STAR_COUNT     = 700;
const STAR_RADIUS    = [15, 45] as const;   // shell trong/ngoài
const STAR_DRIFT     = 0.008;               // rad/s — trôi rất chậm

/**
 * Environment
 * Không gian nền cho canvas vẽ: sàn lưới chìm trong sương mù + trường sao
 * trôi chậm phía xa. Mục đích thuần thị giác — tạo cảm giác chiều sâu
 * thay vì khoảng đen trống.
 */
export class Environment {
  private grid: THREE.GridHelper;
  private stars: THREE.Points;

  constructor(scene: THREE.Scene) {
    // Sàn lưới — mờ dần vào fog của scene
    this.grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x2a4365, 0x16233a);
    this.grid.position.y = GRID_Y;
    const gridMat = this.grid.material as THREE.LineBasicMaterial;
    gridMat.transparent = true;
    gridMat.opacity = 0.35;
    gridMat.depthWrite = false;
    scene.add(this.grid);

    // Trường sao — điểm sáng nhỏ phân bố trong lớp vỏ cầu quanh scene
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const r     = THREE.MathUtils.randFloat(STAR_RADIUS[0], STAR_RADIUS[1]);
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(THREE.MathUtils.randFloat(-1, 1));
      positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const mat = new THREE.PointsMaterial({
      color: 0x8fb7e8,
      size: 0.07,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      sizeAttenuation: true,
    });
    // Sao nằm ngoài vùng fog nhìn rõ — tắt fog cho material này
    mat.fog = false;

    this.stars = new THREE.Points(geo, mat);
    scene.add(this.stars);
  }

  update(delta: number): void {
    this.stars.rotation.y += delta * STAR_DRIFT;
  }
}
