# ✅ Việc & Vé

Web app to-do (cài được lên màn hình chính như app) tự lấy việc từ **Apple Calendar (iCloud)**.
Mỗi việc hoàn thành = **1 vé 🎟️**. Dùng vé để quay vòng quay may mắn:

| Ô | Số ô | Tỉ lệ |
|---|---|---|
| 📱 5p TikTok | 1 | 25% |
| 📖 5p đọc truyện | 1 | 25% |
| 🍀 Chúc bạn may mắn lần sau | 2 | 50% |

Trúng thưởng có nút **hẹn giờ 5 phút** (hết giờ có chuông báo). Các ô sửa được trong *Cài đặt*.

**Link app:** https://phuociii.github.io/to-do/

---

## 🚀 Bắt đầu dùng (khoảng 3 phút)

### 1. Bật GitHub Pages (chỉ làm 1 lần)
1. Mở https://github.com/phuociii/to-do/settings/pages
2. Ở **Build and deployment → Source** chọn **GitHub Actions**.
3. Vào tab **Actions** → workflow **Deploy web app** → **Run workflow** (hoặc chờ tối đa ~30 phút, workflow tự chạy).
4. Khi chạy xong (dấu ✅ xanh), app nằm ở https://phuociii.github.io/to-do/

### 2. Cài lên iPhone
1. Mở link trên bằng **Safari**.
2. Bấm nút **Chia sẻ** → **Thêm vào MH chính**.
3. Mở app từ màn hình chính (từ giờ luôn mở từ biểu tượng này: dữ liệu của app trên màn hình chính tách riêng với Safari).

### 3. Kết nối Apple Calendar
1. Trên iPhone: app **Lịch** → chạm **Lịch** ở dưới → nút **ⓘ** cạnh lịch muốn dùng → bật **Lịch công khai** → **Chia sẻ liên kết…** → **Sao chép**.
2. Trong app Việc & Vé: **Cài đặt** → dán link vào ô *Lịch Apple* → **Thêm lịch & đồng bộ**.
3. Có nhiều lịch thì lặp lại cho từng lịch.

Xong! App tự đồng bộ mỗi khi mở và mỗi 15 phút.

---

## Cách hoạt động

- **Việc**: sự kiện hôm nay và ngày mai (chỉnh được số ngày) → thành việc cần làm. Việc chưa xong của 2 ngày trước hiện ở mục *Chưa xong từ trước* (sự kiện lặp lại như “chạy bộ mỗi ngày” thì không bị dồn lại).
- Sự kiện không phải việc (vd. sinh nhật) → bấm **✕** để ẩn, hoặc thêm từ khoá vào *Bỏ qua sự kiện có chữ*.
- Có thể **thêm việc thủ công**.
- Mỗi việc chỉ cho vé **1 lần** (bỏ tích rồi tích lại không được thêm vé).
- Vé bị trừ ngay khi bấm QUAY. Kết quả ngẫu nhiên bằng `crypto.getRandomValues`, tất cả ô có xác suất bằng nhau.
- Dữ liệu (việc đã xong, vé, lịch sử) lưu trên máy (localStorage). Có nút *Xuất/Nhập sao lưu* trong Cài đặt.
- Chạy offline được (service worker).

## Nếu đồng bộ lịch bị lỗi

Lịch iCloud không cho trình duyệt tải trực tiếp (CORS), nên app thử lần lượt vài proxy công cộng
(allorigins, codetabs, corsproxy.io, cors.lol). Proxy công cộng đôi khi chậm/hỏng. Có 2 cách ổn định hơn:

### Cách A — Đồng bộ qua GitHub, mã hoá (khuyên dùng)
GitHub Actions tải lịch mỗi 30 phút, **mã hoá AES-256-GCM** rồi đưa lên web. Chỉ ai có mật khẩu mới đọc được.

1. Vào https://github.com/phuociii/to-do/settings/secrets/actions → **New repository secret**:
   - `ICS_URLS`: link lịch, mỗi dòng một lịch. Có thể đặt tên: `Công việc | webcal://p…-caldav.icloud.com/published/2/…`
   - `CAL_PASSPHRASE`: một mật khẩu dài tuỳ bạn.
2. Actions → **Deploy web app** → **Run workflow**.
3. Trong app: **Cài đặt → Đồng bộ qua GitHub** → nhập đúng mật khẩu đó.
   (Có thể xoá link lịch ở mục “Lịch Apple” để không dùng proxy nữa.)

> Lưu ý: GitHub tự tắt lịch chạy định kỳ nếu repo không có hoạt động trong 60 ngày — khi đó vào Actions bấm *Enable workflow*.

### Cách B — Proxy riêng trên Cloudflare (miễn phí)
1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → *Hello World* → **Edit code**.
2. Dán nội dung file [`worker/cors-proxy.js`](worker/cors-proxy.js) → **Deploy**.
3. Trong app: **Cài đặt → Kết nối → Proxy riêng**: `https://<ten-worker>.<tai-khoan>.workers.dev/?url={url}`

### Cách C — Nhập file .ics
Cài đặt → *Nhập file .ics* (không tự cập nhật).

---

## Cấu trúc

```
index.html              giao diện
css/style.css           giao diện sáng/tối
js/app.js               logic: việc, vé, vòng quay, hẹn giờ, đồng bộ
js/calendar.js          tải + đọc .ics (lặp lại, ngoại lệ, múi giờ)
js/ical.min.js          thư viện ical.js 1.5.0 (MPL-2.0)
sw.js                   service worker (offline)
manifest.webmanifest    cài như app
scripts/build-calendar.mjs   (Actions) tải + mã hoá lịch
worker/cors-proxy.js    proxy Cloudflare tuỳ chọn
.github/workflows/pages.yml  deploy GitHub Pages + đồng bộ mã hoá
```

Chạy thử trên máy: `python3 -m http.server 8000` rồi mở http://localhost:8000
