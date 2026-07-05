// MediaPipe Hands được load qua CDN script tag trong index.html
// Types được khai báo trong src/types/mediapipe-hands.d.ts
import type { Hands, Results, NormalizedLandmarkList } from '@mediapipe/hands';

export type GestureType = 'PINCH' | 'FIST' | 'SPREAD' | 'POINT' | 'NONE';

export interface GestureEvent {
  gesture:    GestureType;
  indexTip:   { x: number; y: number; z: number };
  thumbTip:   { x: number; y: number; z: number };
  handSize:   number;   // normalized 0–1, dùng cho depth estimation
  confidence: number;
  /** 21 landmarks đầy đủ — vẽ skeleton overlay lên camera PiP. */
  landmarks?: NormalizedLandmarkList;
}

/** Các cặp khớp nối của bàn tay theo chuẩn MediaPipe — vẽ skeleton. */
export const HAND_CONNECTIONS: ReadonlyArray<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // ngón cái
  [0, 5], [5, 6], [6, 7], [7, 8],           // ngón trỏ
  [5, 9], [9, 10], [10, 11], [11, 12],      // ngón giữa
  [9, 13], [13, 14], [14, 15], [15, 16],    // ngón áp út
  [13, 17], [17, 18], [18, 19], [19, 20],   // ngón út
  [0, 17],                                   // cạnh lòng bàn tay
];

/**
 * GestureDetector
 * Bọc MediaPipe Hands (load qua CDN) + phân loại cử chỉ tùy chỉnh.
 *
 * Kiến trúc:
 *   Camera feed → MediaPipe (WASM) → 21 landmarks → classifyGesture() → GestureEvent
 *
 * Lưu ý: window.Hands được inject bởi CDN script trước khi bundle chạy.
 *   <script src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js"></script>
 */
export class GestureDetector {
  private hands: InstanceType<typeof Hands>;
  private callback: (event: GestureEvent) => void;
  private lastGesture: GestureType = 'NONE';
  private gestureHistory: GestureType[] = [];
  private readonly DEBOUNCE_FRAMES = 3;

  // Chặn gọi send() chồng lấn — MediaPipe inference (5–15ms) có thể
  // chậm hơn render loop; frame mới sẽ bị skip thay vì xếp hàng.
  private busy = false;

  constructor(callback: (event: GestureEvent) => void) {
    this.callback = callback;

    // Lấy Hands từ global scope (inject bởi CDN script tag)
    const HandsClass = (window as any).Hands as typeof Hands;
    if (!HandsClass) {
      throw new Error(
        '[GestureDetector] window.Hands không tìm thấy. ' +
        'Đảm bảo đã thêm CDN script trước bundle:\n' +
        '<script src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js"></script>'
      );
    }

    this.hands = new HandsClass({
      locateFile: (file: string) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    this.hands.setOptions({
      maxNumHands:              2,
      modelComplexity:          1,     // 0 = lite (nhanh hơn), 1 = full (chính xác hơn)
      minDetectionConfidence:   0.75,
      minTrackingConfidence:    0.70,
    });

    this.hands.onResults((results: Results) => this.processResults(results));
  }

  // ──────────────────────────────────────────────────────────
  // PUBLIC
  // ──────────────────────────────────────────────────────────

  async detect(video: HTMLVideoElement): Promise<void> {
    if (video.readyState < 2 || this.busy) return;
    this.busy = true;
    try {
      await this.hands.send({ image: video });
    } finally {
      this.busy = false;
    }
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE: RESULTS
  // ──────────────────────────────────────────────────────────

  private processResults(results: Results): void {
    if (!results.multiHandLandmarks?.length) {
      // Mất tracking — thông báo MỘT LẦN để tầng trên commit stroke dở dang
      if (this.lastGesture !== 'NONE') {
        this.lastGesture = 'NONE';
        this.gestureHistory = [];
        this.callback({
          gesture:    'NONE',
          indexTip:   { x: 0.5, y: 0.5, z: 0 },
          thumbTip:   { x: 0.5, y: 0.5, z: 0 },
          handSize:   0,
          confidence: 0,
        });
      }
      return;
    }

    const lm        = results.multiHandLandmarks[0];
    const gesture   = this.classifyGesture(lm);
    const debounced = this.debounceGesture(gesture);

    const event: GestureEvent = {
      gesture:    debounced,
      indexTip:   { x: lm[8].x, y: lm[8].y, z: lm[8].z  ?? 0 },
      thumbTip:   { x: lm[4].x, y: lm[4].y, z: lm[4].z  ?? 0 },
      handSize:   this.estimateHandSize(lm),
      confidence: results.multiHandedness?.[0]?.score ?? 1,
      landmarks:  lm,
    };

    this.lastGesture = debounced;
    this.callback(event);
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE: GESTURE CLASSIFICATION
  // ──────────────────────────────────────────────────────────

  /**
   * MediaPipe landmark indices:
   *   0        = WRIST
   *   1–4      = THUMB  (CMC → TIP)
   *   5–8      = INDEX  (MCP → TIP)
   *   9–12     = MIDDLE (MCP → TIP)
   *  13–16     = RING   (MCP → TIP)
   *  17–20     = PINKY  (MCP → TIP)
   */
  private classifyGesture(lm: NormalizedLandmarkList): GestureType {
    const pinchDist = this.dist(lm[4], lm[8]);
    const indexExt  = this.isFingerExtended(lm, 'index');
    const middleExt = this.isFingerExtended(lm, 'middle');
    const ringExt   = this.isFingerExtended(lm, 'ring');
    const pinkyExt  = this.isFingerExtended(lm, 'pinky');

    const extCount = [indexExt, middleExt, ringExt, pinkyExt].filter(Boolean).length;

    if (pinchDist < 0.05)                         return 'PINCH';   // ✌ vẽ
    if (extCount === 0)                            return 'FIST';    // ✊ dừng / menu
    if (extCount >= 4)                             return 'SPREAD';  // 🖐 xóa
    if (indexExt && !middleExt && !ringExt)        return 'POINT';   // ☝ cursor
    return 'POINT';
  }

  private isFingerExtended(lm: NormalizedLandmarkList, finger: string): boolean {
    const map: Record<string, [number, number]> = {
      index:  [8,  6],
      middle: [12, 10],
      ring:   [16, 14],
      pinky:  [20, 18],
    };
    const [tip, pip] = map[finger];
    return lm[tip].y < lm[pip].y;
  }

  // ──────────────────────────────────────────────────────────
  // PRIVATE: HELPERS
  // ──────────────────────────────────────────────────────────

  private dist(
    a: { x: number; y: number; z?: number },
    b: { x: number; y: number; z?: number }
  ): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z ?? 0) - (b.z ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private estimateHandSize(lm: NormalizedLandmarkList): number {
    return this.dist(lm[0], lm[9]); // wrist → middle MCP
  }

  private debounceGesture(gesture: GestureType): GestureType {
    this.gestureHistory.push(gesture);
    if (this.gestureHistory.length > this.DEBOUNCE_FRAMES) {
      this.gestureHistory.shift();
    }
    const allSame = this.gestureHistory.every(g => g === gesture);
    return allSame ? gesture : this.lastGesture;
  }
}
