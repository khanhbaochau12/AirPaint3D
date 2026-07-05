import * as THREE from 'three';

const MAX_PARTICLES = 160;
const LIFETIME      = 0.7;    // giây
const SPREAD_SPEED  = 0.35;   // vận tốc bắn ra ban đầu
const FLOAT_UP      = 0.12;   // lực nổi nhẹ lên trên

/**
 * SparkSystem
 * Hạt lấp lánh bắn ra từ đầu bút khi đang vẽ. Pool cố định MAX_PARTICLES,
 * tái sử dụng vòng tròn — không cấp phát trong render loop.
 *
 * Fade-out: dùng AdditiveBlending nên hạt màu đen = vô hình,
 * giảm màu về đen theo tuổi thọ thay vì cần per-particle opacity.
 */
export class SparkSystem {
  private points: THREE.Points;
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private velocities: Float32Array;
  private life: Float32Array;
  private baseColor: Float32Array;
  private cursor = 0;

  constructor(scene: THREE.Scene) {
    this.positions  = new Float32Array(MAX_PARTICLES * 3);
    this.colors     = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.life       = new Float32Array(MAX_PARTICLES);       // 0 = chết
    this.baseColor  = new Float32Array(MAX_PARTICLES * 3);

    // Hạt chết đặt rất xa để không lọt vào khung hình
    this.positions.fill(9999);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color',    new THREE.BufferAttribute(this.colors, 3));

    const mat = new THREE.PointsMaterial({
      size: 0.028,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.points = new THREE.Points(this.geometry, mat);
    this.points.frustumCulled = false;   // hạt rải rác, bbox không ổn định
    scene.add(this.points);
  }

  /** Bắn n hạt tại vị trí đầu bút. */
  emit(pos: THREE.Vector3, color: THREE.Color, n = 2): void {
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;

      this.positions[i * 3]     = pos.x;
      this.positions[i * 3 + 1] = pos.y;
      this.positions[i * 3 + 2] = pos.z;

      this.velocities[i * 3]     = (Math.random() - 0.5) * SPREAD_SPEED;
      this.velocities[i * 3 + 1] = (Math.random() - 0.3) * SPREAD_SPEED;
      this.velocities[i * 3 + 2] = (Math.random() - 0.5) * SPREAD_SPEED;

      // Sáng hơn màu bút một chút để bloom bắt được
      this.baseColor[i * 3]     = Math.min(1, color.r * 1.3 + 0.15);
      this.baseColor[i * 3 + 1] = Math.min(1, color.g * 1.3 + 0.15);
      this.baseColor[i * 3 + 2] = Math.min(1, color.b * 1.3 + 0.15);

      this.life[i] = LIFETIME;
    }
  }

  update(delta: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;

      this.life[i] -= delta;
      if (this.life[i] <= 0) {
        this.positions[i * 3] = 9999;   // đưa hạt chết ra xa
        this.colors[i * 3] = this.colors[i * 3 + 1] = this.colors[i * 3 + 2] = 0;
        continue;
      }

      this.positions[i * 3]     += this.velocities[i * 3] * delta;
      this.positions[i * 3 + 1] += (this.velocities[i * 3 + 1] + FLOAT_UP) * delta;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * delta;

      // Fade về đen theo tuổi (đen = vô hình với AdditiveBlending)
      const t = this.life[i] / LIFETIME;
      this.colors[i * 3]     = this.baseColor[i * 3] * t;
      this.colors[i * 3 + 1] = this.baseColor[i * 3 + 1] * t;
      this.colors[i * 3 + 2] = this.baseColor[i * 3 + 2] * t;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }
}
