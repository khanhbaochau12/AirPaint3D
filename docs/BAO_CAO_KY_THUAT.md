# BÁO CÁO KỸ THUẬT

## AirPaint 3D — Ứng dụng vẽ tranh 3D trong không khí bằng cử chỉ tay

**Loại dự án:** Dự án cá nhân
**Nền tảng:** Web (trình duyệt), không cần backend
**Công nghệ chính:** MediaPipe Hands, Three.js, WebXR, TypeScript

---

## 1. Giới thiệu

### 1.1. Bối cảnh

Các ứng dụng vẽ 3D truyền thống đòi hỏi thiết bị chuyên dụng (bút VR, kính AR,
bảng vẽ cảm ứng). Dự án này chứng minh rằng chỉ với **một webcam thông thường
và trình duyệt web**, người dùng có thể vẽ tranh 3D trong không gian bằng cử
chỉ tay tự nhiên — không chạm màn hình, không cài đặt phần mềm.

### 1.2. Mục tiêu

1. Nhận diện bàn tay và phân loại 4 cử chỉ điều khiển theo thời gian thực (≥ 20 FPS).
2. Chuyển đổi chuyển động tay 2D từ camera thành nét vẽ 3D mượt mà trong không gian.
3. Ước lượng chiều sâu (trục Z) mà **không cần depth camera**.
4. Hỗ trợ AR (WebXR) trên thiết bị tương thích và đồng bộ đa người dùng qua WebSocket.
5. Giao diện điều khiển **100% bằng cử chỉ tay**, trực quan cho người dùng mới.

### 1.3. Phạm vi

Ứng dụng chạy hoàn toàn phía client. Thành phần multiplayer chỉ gồm client-side
protocol; server relay nằm ngoài phạm vi dự án.

---

## 2. Kiến trúc tổng thể

### 2.1. Pipeline xử lý

```
Webcam (getUserMedia, 1280×720 @ 30fps)
    │
    ▼
MediaPipe Hands (WASM)                 ← tải qua CDN, chạy trong trình duyệt
    │  21 landmarks chuẩn hóa / frame
    ▼
GestureDetector.classifyGesture()      ← rule-based + debounce 3 frame
    │  GestureEvent { gesture, indexTip, handSize, confidence }
    ▼
PositionMapper.map()                   ← Kalman filter + raycasting + depth heuristic
    │  THREE.Vector3 (world space)
    ▼
StrokeEngine.addPoint()                ← Catmull-Rom spline → TubeGeometry
    │
    ▼
Three.js WebGL render (60 fps)
    │
    ├── (tùy chọn) WebXR AR overlay
    └── (tùy chọn) MultiplayerSync broadcast qua WebSocket
```

### 2.2. Sơ đồ module

| Module | File | Trách nhiệm |
|--------|------|-------------|
| App orchestration | `src/main.ts` | Khởi tạo, wiring, UI, vòng lặp render |
| Computer Vision | `src/cv/GestureDetector.ts` | Bọc MediaPipe, phân loại cử chỉ |
| Chiếu tọa độ | `src/ar/PositionMapper.ts` | 2D → 3D, Kalman filter, depth heuristic |
| Render nét vẽ | `src/render/StrokeEngine.ts` | Lifecycle stroke, undo/redo, export |
| Thực tế tăng cường | `src/ar/XRSession.ts` | WebXR session, hit-test, light estimation |
| Mạng | `src/net/MultiplayerSync.ts` | Đồng bộ stroke/cursor qua WebSocket |

Nguyên tắc thiết kế: mỗi module một trách nhiệm, giao tiếp qua interface typed
(`GestureEvent`, `StrokeData`, `SyncMessage`), không phụ thuộc vòng.

---

## 3. Các thuật toán chính

### 3.1. Phân loại cử chỉ (rule-based)

MediaPipe trả về 21 landmarks chuẩn hóa. Bộ phân loại dùng luật hình học thay
vì mô hình học máy — đơn giản, không cần dữ liệu huấn luyện, độ trễ ~0 ms:

```
pinchDist = ‖thumb_tip − index_tip‖          (khoảng cách Euclid 3D)
extCount  = số ngón duỗi (tip.y < pip.y)

PINCH  nếu pinchDist < 0.05
FIST   nếu extCount = 0
SPREAD nếu extCount ≥ 4
POINT  còn lại
```

**Chống nhiễu hai tầng:**

1. **Debounce 3 frame** — gesture chỉ được công nhận khi 3 frame liên tiếp cho
   cùng kết quả, loại bỏ flickering tại ranh giới PINCH ↔ POINT.
2. **Edge-trigger cho hành động một lần** — SPREAD (xóa nét) chỉ kích hoạt tại
   frame gesture *chuyển trạng thái*; nếu xử lý mỗi frame, giữ tay xòe 1 giây
   sẽ xóa nhầm ~30 nét.

### 3.2. Ước lượng chiều sâu không cần depth camera

Webcam thường không đo được khoảng cách. Hệ thống dùng heuristic: **tay càng
gần camera thì chiếm tỷ lệ khung hình càng lớn**.

```
handSize = ‖wrist − middle_MCP‖   (chuẩn hóa 0–1)
depth    = mapLinear(clamp(handSize, 0.06, 0.45), 0.06, 0.45, far=2.0, near=0.2)
```

Hai landmark này ổn định vì không phụ thuộc tư thế ngón tay. Giá trị depth sau
đó đi qua Kalman filter riêng (nhiễu Z lớn hơn X, Y nên R nhân 5).

### 3.3. Kalman Filter 1D cho từng trục

Tọa độ landmark rung lắc do nhiễu cảm biến. Ba filter độc lập cho X, Y, Z:

```
Predict:  P = P + Q
Update:   K = P / (P + R)
          x̂ = x̂ + K(z − x̂)
          P = (1 − K)P
```

Tham số: `R = 0.01` (tin đo), `Q = 0.1` (tin model). Trục Z dùng `R×5, Q×0.5`
để smooth mạnh hơn. Filter được **reset khi mất tracking** để tránh hiện tượng
"lurch" (nét nhảy vọt) khi tay xuất hiện trở lại.

### 3.4. Chiếu 2D → 3D bằng raycasting

```
1. Flip X (ảnh camera là ảnh gương)
2. [0,1]² → NDC [−1,1]²
3. Raycaster.setFromCamera(ndc, camera)
4. worldPos = ray.at(depth)
```

Cách này đảm bảo điểm vẽ luôn nằm đúng dưới ngón tay **theo góc nhìn hiện tại**,
kể cả khi người dùng xoay camera bằng OrbitControls.

### 3.5. Dựng hình nét vẽ

Mỗi nét là một `TubeGeometry` dựng quanh **Catmull-Rom spline** (tension 0.5)
đi qua các điểm đã lọc:

- Điểm cách điểm trước < 3 mm (world unit) bị bỏ qua — giảm mật độ geometry.
- `tubularSegments = min(số_điểm × 4, 300)` — chặn trên độ phức tạp.
- Geometry cũ được `dispose()` ngay trước khi dựng lại → không rò rỉ GPU memory.
- Material cache theo mã màu hex — 6 màu = tối đa 6 material, giảm draw call.

### 3.6. Undo / Redo hai stack

```
undo: committedStrokes.pop() → redoStack.push()   (giữ geometry, chỉ remove khỏi scene)
redo: redoStack.pop() → committedStrokes.push()   (add lại scene, không dựng lại)
nét mới commit → clear redoStack (dispose geometry)
```

Giữ nguyên geometry khi undo giúp redo tức thời (O(1), không rebuild).

---

## 4. Các vấn đề kỹ thuật đã giải quyết

| # | Vấn đề | Giải pháp |
|---|--------|-----------|
| 1 | Jitter tọa độ từ MediaPipe | Kalman Filter 1D độc lập cho X, Y, Z (mục 3.3) |
| 2 | MediaPipe inference (5–15 ms) chậm hơn render loop, các lời gọi xếp hàng chồng lấn | Busy-flag trong `detect()` — frame mới bị **skip** thay vì xếp hàng; render loop không bao giờ chờ CV |
| 3 | Không có depth sensor | Heuristic kích thước bàn tay (mục 3.2) |
| 4 | GPU memory leak khi rebuild TubeGeometry mỗi frame | `geometry.dispose()` trước khi tạo mới + material cache theo màu |
| 5 | Gesture flickering tại ranh giới | Debounce buffer 3 frame |
| 6 | Mất tracking giữa chừng khi đang vẽ → nét treo, orbit bị khóa | GestureDetector phát sự kiện `NONE` đúng một lần khi mất tay; app commit nét dở dang, reset filter, ẩn cursor |
| 7 | SPREAD lặp mỗi frame xóa nhầm hàng loạt nét | Edge-trigger — chỉ xử lý tại frame chuyển trạng thái |
| 8 | `requestSession('immersive-ar')` bị trình duyệt chặn khi gọi lúc khởi tạo | Chỉ gọi trong click handler của nút "Chế độ AR" (yêu cầu user gesture của WebXR spec) |
| 9 | `requestAnimationFrame` không nhận XR frame trong AR session | Dùng `renderer.setAnimationLoop` cho toàn bộ vòng lặp render |

---

## 5. Giao diện & trải nghiệm người dùng

Nguyên tắc: **điều khiển 100% bằng cử chỉ tay**; biểu tượng trên giao diện chỉ
dùng đúng 4 icon cử chỉ (🤏 ☝ ✊ 🖐), mọi nút chức năng dùng nhãn chữ.

| Thành phần | Vị trí | Vai trò |
|------------|--------|---------|
| Onboarding overlay | Giữa màn hình (lần đầu) | Giải thích 4 cử chỉ, xin quyền camera sau khi người dùng chủ động bấm "Bắt đầu vẽ" |
| Bảng chỉ dẫn cử chỉ | Góc dưới-trái, luôn hiển thị | Nhắc 4 cử chỉ trong lúc vẽ |
| Camera PiP (mirror) | Góc dưới-phải | Người dùng canh vị trí tay trong khung hình |
| HUD trạng thái | Góc trên-trái | Cử chỉ hiện tại, chế độ, số nét vẽ |
| Toolbar | Giữa-dưới | Màu, cỡ brush, hoàn tác/làm lại, xóa, lưu PNG, xuất GLTF |
| Nút "Chế độ AR" | Góc trên-phải | Chỉ hiện trên thiết bị hỗ trợ immersive-ar |

Xử lý lỗi thân thiện: camera bị từ chối → thông báo hướng dẫn cấp quyền và nút
thử lại (không có fallback ẩn nào làm sai lệch trải nghiệm cử chỉ).

**Lưu trữ:** tranh autosave vào localStorage (debounce 500 ms) sau mỗi thao tác;
mở lại tab là khôi phục nguyên trạng. Xuất file lâu dài qua GLTF (.glb) hoặc PNG.

---

## 6. Hiệu năng

| Chỉ số | Giá trị đo | Điều kiện |
|--------|-----------|-----------|
| Độ trễ nhận diện cử chỉ | ~21 ms | MediaPipe full model, desktop GPU tích hợp |
| Render framerate | 60 fps | Chrome desktop |
| Landmark / bàn tay | 21 điểm | 2 tay đồng thời (chỉ dùng tay thứ nhất) |
| Số nét đồng thời tối đa | ~500 | Trước khi FPS giảm dưới 60 (desktop) |
| Kích thước export GLTF | ~2 MB / 100 nét | Binary .glb |
| Bundle production | ~546 KB (gzip ~142 KB) | Chủ yếu là Three.js |

Kỹ thuật tối ưu: skip-frame CV (mục 4.2), lọc điểm gần nhau, chặn trên segment,
material cache, `pixelRatio` giới hạn 2, dispose geometry triệt để.

---

## 7. Kiểm thử

- **Kiểm tra tĩnh:** `npm run typecheck` (TypeScript strict mode) — 0 lỗi;
  build production pass.
- **Kiểm thử chức năng thủ công:** vẽ/commit nét, hoàn tác → làm lại, autosave
  → reload khôi phục đúng số nét, luồng từ chối camera → báo lỗi + thử lại,
  luồng cấp camera → bảng chỉ dẫn + PiP hiển thị.
- **Kiểm thử tương thích:** Chrome, Edge (desktop); Chrome Android cho AR.

Hạng mục đề xuất bổ sung: unit test cho `KalmanFilter1D` và `classifyGesture()`
(hai thành phần thuần logic, dễ test bằng Vitest).

---

## 8. Hạn chế & hướng phát triển

**Hạn chế hiện tại:**

1. Phân loại cử chỉ rule-based nhạy với góc quay bàn tay lớn (luật "ngón duỗi"
   dựa trên trục Y ảnh).
2. Depth heuristic tuyến tính — chính xác tương đối, không phải khoảng cách mét thật.
3. MediaPipe chạy trên main thread (đã giảm thiểu bằng skip-frame); phiên bản
   Tasks API mới của MediaPipe hỗ trợ Web Worker tốt hơn.
4. Multiplayer cần server relay tự triển khai.

**Hướng phát triển:**

- Nâng cấp lên MediaPipe Tasks Vision (GPU delegate + worker).
- Phân loại cử chỉ bằng mô hình nhỏ (MLP trên 21 landmarks) để bất biến với góc quay.
- Vẽ hai tay đồng thời; cử chỉ hai tay để xoay/scale cả bức tranh.
- Server multiplayer mẫu (Node.js + ws) kèm room management.
- Brush nâng cao: độ dày theo tốc độ tay, particle, texture.

---

## 9. Kết luận

Dự án hoàn thành mục tiêu đặt ra: một ứng dụng web thuần client cho phép vẽ
tranh 3D bằng cử chỉ tay với độ trễ thấp, nét vẽ mượt nhờ tổ hợp
Kalman filter + Catmull-Rom spline, chạy 60 fps trên phần cứng phổ thông, có
đường mở rộng sang AR và cộng tác thời gian thực. Toàn bộ mã nguồn TypeScript
strict, kiến trúc module hóa rõ ràng, dễ bảo trì và mở rộng.

---

## Tài liệu tham khảo

1. MediaPipe Hands — https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
2. Three.js Documentation — https://threejs.org/docs/
3. WebXR Device API — https://www.w3.org/TR/webxr/
4. Kalman, R.E. (1960). *A New Approach to Linear Filtering and Prediction Problems*
5. Catmull, E., Rom, R. (1974). *A Class of Local Interpolating Splines*
