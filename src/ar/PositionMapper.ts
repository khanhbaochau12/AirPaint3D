import * as THREE from 'three';

/**
 * Kalman Filter 1D đơn giản cho làm mượt tọa độ.
 *
 * Mô hình:
 *   x̂ₙ = x̂ₙ₋₁ + K * (zₙ - x̂ₙ₋₁)
 *   K = P / (P + R)
 *   P = P + Q
 *
 * R = measurement noise (cao = tin đo ít, smooth nhiều)
 * Q = process noise   (cao = tin model ít, phản ứng nhanh hơn)
 */
class KalmanFilter1D {
  private x: number;    // state estimate
  private P: number;    // error covariance
  private R: number;    // measurement noise
  private Q: number;    // process noise

  constructor({ R = 0.01, Q = 0.1 } = {}) {
    this.x = 0;
    this.P = 1;
    this.R = R;
    this.Q = Q;
  }

  filter(z: number): number {
    // Predict
    this.P += this.Q;

    // Update
    const K = this.P / (this.P + this.R);
    this.x += K * (z - this.x);
    this.P *= (1 - K);

    return this.x;
  }

  /** Đổi tham số nhiễu lúc chạy (panel Tinh chỉnh). */
  setNoise(R: number, Q: number): void {
    this.R = R;
    this.Q = Q;
  }

  reset(value: number = 0): void {
    this.x = value;
    this.P = 1;
  }
}

// ──────────────────────────────────────────────────────────
// PositionMapper
// ──────────────────────────────────────────────────────────

export interface MapperOptions {
  /**
   * Khoảng cách vẽ tối thiểu (near) và tối đa (far) theo trục Z.
   * Đơn vị: Three.js world units.
   */
  depthRange: [number, number];

  /**
   * Khoảng cách bàn tay tương ứng với near / far.
   * Đơn vị: normalized (0–1) từ estimateHandSize().
   */
  handSizeRange: [number, number];

  /**
   * Hệ số Kalman. Cao hơn = smooth hơn nhưng laggy hơn.
   */
  kalmanR?: number;
  kalmanQ?: number;
}

/**
 * PositionMapper
 * Chuyển đổi tọa độ 2D normalized từ MediaPipe sang 3D world space.
 *
 * Thuật toán:
 *   1. Flip X (camera là gương)
 *   2. Kalman filter riêng cho X, Y, Z
 *   3. Chuyển [0,1] → NDC [-1,1]
 *   4. Ray cast từ camera
 *   5. Lấy điểm trên ray tại depth ước tính từ hand size
 */
export class PositionMapper {
  private camera: THREE.PerspectiveCamera;
  private raycaster = new THREE.Raycaster();
  private opts: MapperOptions;

  // 3 Kalman filter độc lập cho X, Y, Z
  private kX: KalmanFilter1D;
  private kY: KalmanFilter1D;
  private kZ: KalmanFilter1D;

  // Lưu vị trí trước để tính velocity (dùng cho predictive smoothing)
  private prevPos: THREE.Vector3 | null = null;
  private velocity = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, opts: Partial<MapperOptions> = {}) {
    this.camera = camera;
    this.opts = {
      depthRange:     [0.2, 1.5],
      handSizeRange:  [0.08, 0.4],
      kalmanR:        0.01,
      kalmanQ:        0.1,
      ...opts,
    };

    const r = this.opts.kalmanR!;
    const q = this.opts.kalmanQ!;
    this.kX = new KalmanFilter1D({ R: r,        Q: q });
    this.kY = new KalmanFilter1D({ R: r,        Q: q });
    this.kZ = new KalmanFilter1D({ R: r * 5,    Q: q * 0.5 }); // Z noisier → smooth hơn
  }

  /**
   * Map tọa độ MediaPipe → Three.js world position.
   *
   * @param nx         Normalized X từ MediaPipe (0 = trái, 1 = phải trong ảnh gốc)
   * @param ny         Normalized Y từ MediaPipe (0 = trên, 1 = dưới)
   * @param handSize   Kết quả từ GestureDetector.estimateHandSize()
   * @returns          World position THREE.Vector3
   */
  map(nx: number, ny: number, handSize: number): THREE.Vector3 {
    // 1. Flip X — camera là gương, tay bên phải thực tế = bên phải màn hình
    const flippedX = 1 - nx;

    // 2. Kalman filter X, Y
    const sx = this.kX.filter(flippedX);
    const sy = this.kY.filter(ny);

    // 3. Depth từ hand size (heuristic — không cần depth camera)
    const [minHS, maxHS]   = this.opts.handSizeRange;
    const [nearD, farD]    = this.opts.depthRange;
    const rawDepth = THREE.MathUtils.mapLinear(
      THREE.MathUtils.clamp(handSize, minHS, maxHS),
      minHS, maxHS,
      farD, nearD  // lật: hand lớn = gần = depth nhỏ
    );
    const depth = this.kZ.filter(rawDepth);

    // 4. Screen space [0,1] → NDC [-1,1]
    const ndcX = sx * 2 - 1;
    const ndcY = -(sy * 2 - 1);   // Y flip (screen Y xuống, NDC Y lên)

    // 5. Ray từ camera
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);

    // 6. Điểm trên ray
    const pos = new THREE.Vector3();
    this.raycaster.ray.at(depth, pos);

    // 7. Tính velocity để predictive smoothing (dùng ở tầng cao hơn nếu cần)
    if (this.prevPos) {
      this.velocity.subVectors(pos, this.prevPos);
    }
    this.prevPos = pos.clone();

    return pos;
  }

  /**
   * Chỉnh độ mượt lúc chạy — s trong [0, 1].
   * s = 0: phản ứng nhanh nhất (ít lọc, theo tay sát nhưng rung);
   * s = 1: mượt nhất (lọc mạnh, trễ hơn). s = 0.5 = mặc định gốc.
   */
  setSmoothing(s: number): void {
    const t = THREE.MathUtils.clamp(s, 0, 1);
    // Mapping mũ quanh giá trị mặc định R=0.01, Q=0.1
    const r = 0.01 * Math.pow(4, 2 * t - 1);   // 0.0025 → 0.04
    const q = 0.1  * Math.pow(4, 1 - 2 * t);   // 0.4    → 0.025
    this.kX.setNoise(r, q);
    this.kY.setNoise(r, q);
    this.kZ.setNoise(r * 5, q * 0.5);          // Z luôn smooth hơn
  }

  /** Reset filter khi mất tracking để tránh lurch khi phát hiện lại. */
  reset(): void {
    this.kX.reset();
    this.kY.reset();
    this.kZ.reset();
    this.prevPos = null;
    this.velocity.set(0, 0, 0);
  }

  getVelocity(): THREE.Vector3 {
    return this.velocity.clone();
  }
}
