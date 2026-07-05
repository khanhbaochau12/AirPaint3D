# Hướng dẫn cài đặt — AirPaint 3D

## 1. Yêu cầu hệ thống

| Thành phần | Yêu cầu tối thiểu |
|------------|-------------------|
| Node.js | 18.x trở lên (khuyến nghị 20.x LTS) |
| npm | 9.x trở lên (đi kèm Node.js) |
| Trình duyệt | Chrome / Edge 90+ hoặc Firefox 100+ (desktop) |
| Webcam | Bất kỳ webcam nào (720p trở lên cho kết quả tốt nhất) |
| Kết nối mạng | Cần internet khi chạy — model MediaPipe Hands tải từ CDN (~10 MB, chỉ lần đầu) |
| (Tùy chọn) Điện thoại Android | Chrome 92+ và hỗ trợ ARCore, dùng cho chế độ AR |

Kiểm tra phiên bản:

```bash
node -v    # >= v18
npm -v     # >= 9
```

## 2. Cài đặt từ mã nguồn

```bash
# Giải nén / clone dự án rồi vào thư mục
cd air-paint-3d

# Cài dependencies
npm install

# Chạy dev server
npm run dev
```

Mở trình duyệt và truy cập:

- **Ứng dụng vẽ**: http://localhost:5173/app.html
- **Trang giới thiệu**: http://localhost:5173/

Nhấn **"Bắt đầu vẽ"** và cấp quyền camera khi trình duyệt hỏi.

## 3. Chạy trên điện thoại (chế độ AR)

Camera và WebXR yêu cầu HTTPS khi truy cập qua mạng LAN:

```bash
npm run dev:https
```

1. Đảm bảo điện thoại và máy tính cùng mạng Wi-Fi.
2. Xem địa chỉ LAN mà Vite in ra terminal (dạng `https://192.168.x.x:5173`).
3. Mở `https://192.168.x.x:5173/app.html` trên Chrome điện thoại.
4. Certificate là self-signed — chọn **Advanced → Proceed** ở cảnh báo đầu tiên.
5. Trên thiết bị hỗ trợ ARCore, nút **"Chế độ AR"** sẽ xuất hiện ở góc trên-phải.

## 4. Đóng gói production

```bash
npm run build
```

Lệnh này chạy typecheck (`tsc`) rồi bundle vào thư mục `dist/`. Kết quả là
**trang web tĩnh hoàn toàn** — không cần backend.

Chạy thử bản build:

```bash
npm run preview
```

## 5. Triển khai (deploy)

Thư mục `dist/` có thể deploy lên bất kỳ static hosting nào:

**Netlify / Vercel / GitHub Pages** — kéo thả thư mục `dist/` hoặc trỏ CI vào
lệnh build `npm run build`, output directory `dist`.

**Server riêng (nginx):**

```nginx
server {
    listen 443 ssl;
    root /var/www/air-paint-3d/dist;
    index index.html;
}
```

Lưu ý bắt buộc khi deploy:

- **Phải có HTTPS** — trình duyệt chặn `getUserMedia` (camera) trên HTTP,
  trừ `localhost`. Các dịch vụ Netlify/Vercel/GitHub Pages có sẵn HTTPS.
- Máy client cần internet để tải model MediaPipe từ CDN jsDelivr.

## 6. Multiplayer (tùy chọn)

Ứng dụng có sẵn client đồng bộ qua WebSocket. Bật bằng URL param:

```
https://your-domain.com/app.html?ws=wss://your-websocket-server.com
```

Server cần relay các message JSON (`stroke_add`, `stroke_undo`, `stroke_clear`,
`cursor_move`, `sync_full` — xem `src/net/MultiplayerSync.ts`). Repo chưa kèm
server mẫu.

## 7. Xử lý sự cố

| Hiện tượng | Nguyên nhân & cách xử lý |
|------------|--------------------------|
| Báo "Không truy cập được camera" | Quyền camera bị chặn — bấm biểu tượng ổ khóa trên thanh địa chỉ → Site settings → Camera → Allow, rồi bấm "Bắt đầu vẽ" lại |
| Màn hình đen, không có gì xảy ra sau khi bấm bắt đầu | Model MediaPipe đang tải lần đầu (~10 MB) — chờ 5–15 giây tùy mạng |
| Nét vẽ rung lắc mạnh | Thiếu sáng khiến tracking kém — tăng ánh sáng phòng, đưa tay cách camera 30–60 cm |
| Không thấy nút "Chế độ AR" | Thiết bị/trình duyệt không hỗ trợ WebXR immersive-ar (desktop thường không có) — đây là hành vi đúng |
| Cảnh báo certificate khi dùng `dev:https` | Certificate self-signed của dev server — chọn Advanced → Proceed (chỉ dùng cho môi trường dev) |
| `npm install` lỗi | Xóa `node_modules/` và `package-lock.json` rồi chạy lại `npm install`; kiểm tra Node >= 18 |
| Tranh biến mất sau khi xóa cache trình duyệt | Tranh autosave vào localStorage — xóa dữ liệu trang sẽ mất; dùng nút "Xuất GLTF" để lưu file lâu dài |

## 8. Cấu trúc lệnh tóm tắt

| Lệnh | Chức năng |
|------|-----------|
| `npm run dev` | Dev server HTTP (localhost) |
| `npm run dev:https` | Dev server HTTPS (test mobile/AR qua LAN) |
| `npm run typecheck` | Kiểm tra kiểu TypeScript, không build |
| `npm run build` | Typecheck + đóng gói production vào `dist/` |
| `npm run preview` | Chạy thử bản build production |
