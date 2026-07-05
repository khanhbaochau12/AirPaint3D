# Air Paint 3D — Gesture AR Drawing

> Vẽ tranh 3D trong không khí bằng cử chỉ tay, chạy hoàn toàn trên trình duyệt.

**Tài liệu:** [Hướng dẫn cài đặt (INSTALL.md)](INSTALL.md) · [Báo cáo kỹ thuật](docs/BAO_CAO_KY_THUAT.md)

## Chạy dự án

```bash
npm install
npm run dev
```

- **Ứng dụng vẽ**: `http://localhost:5173/app.html`
- **Trang portfolio**: `http://localhost:5173/`

Camera hoạt động trên `localhost` không cần HTTPS (secure context). Khi test trên
**điện thoại qua LAN** (camera + WebXR yêu cầu HTTPS), chạy `npm run dev:https` —
dev server dùng certificate self-signed, trình duyệt cảnh báo lần đầu thì chọn
"Advanced → Proceed".

Build production: `npm run build` (typecheck + bundle vào `dist/`).

**Multiplayer** (tùy chọn): thêm URL param trỏ tới WebSocket server —
`https://localhost:5173/app.html?ws=wss://your-server.com`

---

## Cấu trúc thư mục

```
air-paint-3d/
├── index.html              # Portfolio page + demo mô phỏng (inline, tự chứa)
├── app.html                # Ứng dụng vẽ thật — load src/main.ts
├── vite.config.ts          # HTTPS + multi-page build
├── src/
│   ├── main.ts             # Entry point — khởi tạo và wiring
│   ├── cv/
│   │   └── GestureDetector.ts   # MediaPipe Hands wrapper + gesture classifier
│   ├── render/
│   │   └── StrokeEngine.ts      # Three.js TubeGeometry stroke management
│   ├── ar/
│   │   ├── PositionMapper.ts    # 2D→3D projection + Kalman filter
│   │   └── XRSession.ts         # WebXR AR session setup
│   └── net/
│       └── MultiplayerSync.ts   # WebSocket real-time sync
├── package.json
└── README.md
```

---

## Cử chỉ điều khiển

| Cử chỉ | Hành động |
|---------|-----------|
| 🤏 **PINCH** — ngón cái chạm ngón trỏ | Bắt đầu / tiếp tục vẽ |
| ☝ **POINT** — chỉ ngón trỏ | Di chuyển cursor (không vẽ) |
| ✊ **FIST** — nắm tay | Kết thúc stroke hiện tại |
| 🖐 **SPREAD** — xòe bàn tay | Xóa stroke cuối (edge-triggered — mỗi lần xòe chỉ xóa 1 nét) |
| ☝ chỉ vào nút + 🤏 chụm | Bấm nút công cụ / chọn màu / chọn loại bút |

Ứng dụng điều khiển **100% bằng cử chỉ tay** — camera là bắt buộc. Con trỏ tay
(vòng tròn) theo ngón trỏ trên màn hình; trỏ vào nút bất kỳ rồi chụm để bấm —
toàn bộ toolbar, bảng màu và loại bút đều thao tác được bằng tay. Bảng chỉ dẫn
cử chỉ luôn hiển thị ở góc dưới-trái khung vẽ. Chuột chỉ dùng để xoay/zoom góc
nhìn (OrbitControls).

**Loại bút:** Bút thường · Bút neon (phát sáng mạnh) · Bút trong mờ (bán trong suốt).
Nét neon phát sáng thật nhờ **bloom postprocessing** (UnrealBloomPass); đầu bút
bắn hạt lấp lánh khi vẽ.

**Thư viện hình khối:** nút "Thư viện" mở panel 6 hình khối (hộp, cầu, trụ, nón,
vòng xuyến, nút xoắn) — chụm vào tên hình là thả vào trước camera.

**Chế độ Chỉnh sửa:** chuyển bằng nút "Chỉnh sửa" trên toolbar. Chỉ tay vào vật
thể (nét vẽ hoặc hình khối) để chọn — viền sáng hiện quanh vật thể; chụm vào rồi
kéo để thao tác theo công cụ đang chọn: **Di chuyển** (theo tay đủ 3 trục, xa gần
theo khoảng cách tay) · **Xoay** (kéo ngang/dọc) · **Thu phóng** (kéo lên = to,
kéo xuống = nhỏ). Nút "Xóa vật thể" xóa vật đang chọn. Mọi thay đổi đều autosave.

Khung cảnh có sàn lưới + trường sao tạo chiều sâu; camera PiP hiển thị **skeleton
21 khớp tay** đang được track; rảnh tay 15 giây thì scene tự xoay khoe tranh.

**Panel Tinh chỉnh** (webcam mỗi người mỗi khác): độ mượt tay (Kalman), độ nhạy
chụm, dung sai chọn vật thể, độ sáng neon, chất lượng tracking nhanh/chính xác —
chỉnh bằng slider hoặc nút +/− (bấm được bằng cử chỉ), tự lưu vào localStorage.

---

## Luồng kỹ thuật

```
Camera (getUserMedia)
    ↓
MediaPipe Hands (WASM)
    ↓  21 keypoints / frame
GestureDetector.classifyGesture()
    ↓  GestureType + confidence
PositionMapper.map()
    ↓  THREE.Vector3 (Kalman filtered)
StrokeEngine.addPoint()
    ↓  TubeGeometry rebuild
Three.js WebGL render
    ↓
(Optional) WebXR AR overlay
    ↓
(Optional) WebSocket broadcast
```

---

## Các vấn đề kỹ thuật đã giải quyết

### 1. Jitter tọa độ từ MediaPipe
**Vấn đề:** Tọa độ landmark rung lắc do nhiễu video, tạo stroke không mượt.  
**Giải pháp:** Kalman Filter 1D cho mỗi trục X, Y, Z với R=0.01, Q=0.1.

### 2. Main thread blocking
**Vấn đề:** MediaPipe inference nặng (5–15ms/frame) có thể chậm hơn render loop,
khiến các lời gọi `send()` xếp hàng chồng lấn và gây drop frame.  
**Giải pháp:** Busy-flag trong `GestureDetector.detect()` — khi inference đang chạy,
frame mới bị skip thay vì xếp hàng. Render loop không bao giờ phải chờ CV pipeline.

### 3. Depth estimation không cần depth sensor
**Vấn đề:** Webcam thường không có depth camera.  
**Giải pháp:** `handSize = dist(wrist, middle_mcp)` — tay lớn trong frame = gần camera. Map tuyến tính sang Z axis.

### 4. GPU memory leak
**Vấn đề:** `TubeGeometry` được tạo mới mỗi frame khi đang vẽ, geometry cũ không được giải phóng.  
**Giải pháp:** Gọi `geometry.dispose()` ngay trước khi tạo geometry mới. Material được cache theo hex color key.

### 5. Gesture flickering
**Vấn đề:** Gesture phân loại không ổn định tại ranh giới (ví dụ PINCH ↔ POINT).  
**Giải pháp:** Debounce buffer 3 frame — chỉ thay đổi gesture khi 3 frame liên tiếp cho cùng kết quả.

### 6. Mất tracking giữa chừng khi đang vẽ
**Vấn đề:** Tay ra khỏi khung hình khi đang PINCH → stroke treo lơ lửng, orbit
controls bị khóa vĩnh viễn.  
**Giải pháp:** `GestureDetector` phát sự kiện `NONE` một lần khi mất tracking —
tầng app commit stroke dở dang, reset Kalman filter và ẩn cursor.

### 7. SPREAD xóa nhầm hàng loạt
**Vấn đề:** Gesture SPREAD được báo mỗi frame — giữ tay xòe 1 giây xóa sạch ~30 strokes.  
**Giải pháp:** Edge-trigger — chỉ undo tại frame gesture *chuyển sang* SPREAD.

---

## Hiệu suất

| Metric | Giá trị |
|--------|---------|
| Gesture detection latency | ~21ms |
| Hand landmark accuracy | ~98% |
| Render framerate | 60fps |
| Keypoints tracked | 21/hand |
| Max concurrent strokes | ~500 (desktop) |
| GLTF export size (100 strokes) | ~2MB |

---

## Keyboard Shortcuts

| Phím | Hành động |
|------|-----------|
| `Ctrl+Z` | Undo stroke |
| `Ctrl+Y` / `Ctrl+Shift+Z` | Redo stroke |
| `Ctrl+E` | Export GLTF (.glb) |
| `Ctrl+S` | Chụp ảnh PNG |
| `Esc` | Commit stroke hiện tại |
| `Shift+Delete` | Xóa tất cả |

Tranh được **autosave vào localStorage** sau mỗi thao tác — đóng tab rồi mở lại
vẫn giữ nguyên các strokes.

---

## Tech Stack

- **MediaPipe Hands** — Hand tracking + 21 landmark detection
- **Three.js** — 3D rendering, TubeGeometry, OrbitControls
- **WebXR API** — AR session, hit-test, light estimation
- **WebGL 2.0** — GPU-accelerated rendering
- **WebSocket** — Real-time multiplayer sync (bật qua `?ws=` param)
- **localStorage** — Autosave / khôi phục tranh giữa các phiên
- **Vite + TypeScript** — Build tooling, HTTPS dev server

---

## Tác giả

Dự án cá nhân — làm cho vui · 2024
