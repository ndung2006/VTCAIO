# B6 — Auth: bcrypt + JWT HttpOnly + gate API (PRD §4.8)

> `tsc` sạch, `npm test` **21/21 xanh** (8 cũ + 9 API-gồm-auth + 4 auth đơn vị).

## Thiết kế (khớp PRD từng điểm)

| PRD yêu cầu | Làm ở đâu |
|---|---|
| bcrypt salt 10, không plaintext | `auth.ts: hashPassword/checkPassword`, `SALT_ROUNDS=10` |
| JWT 7 ngày trong HttpOnly Cookie (không localStorage) | `signToken/verifyToken`, `jwtSetCookie` (`HttpOnly; Path=/; SameSite=Lax`, `Secure` khi `VTC_COOKIE_SECURE=1`) |
| Đổi MK: 3 trường, min 8, confirm khớp, compare cũ | `POST /api/auth/change-password` |
| Quên MK: message chung (chống enumerate), reset token 15' | `POST /api/auth/forgot-password` → `FORGOT_MSG` cố định; token `randomBytes(32)` + `RESET_TTL_MS` |
| Đặt lại qua link | `POST /api/auth/reset-password {token, newPassword}` |
| Frontend middleware redirect /login | Phase 4 (`middleware.ts` đọc cookie `vtc_token`) |
| Backend `verifyAuth` chặn trước mọi API nghiệp vụ | `makeRequireAuth()` gate mọi `/api/*` trừ `/api/auth/*` và `/health` → 401 trước khi spawn/chạm đĩa |

## Env

- `VTC_JWT_SECRET` — bắt buộc ở Prod (dev warn + dùng default).
- `VTC_ADMIN_USER / VTC_ADMIN_EMAIL / VTC_ADMIN_PASS` — seed admin lúc boot (mặc định `admin / admin@vtc.local / admin12345`, warn khi dùng default).
- `VTC_COOKIE_SECURE=1` — bật flag Secure khi chạy HTTPS Prod.
- SMTP/Nodemailer gửi mail thật: Phase sau (hiện log reset link ra console để dev/test).

## Thử nhanh

```sh
cd apps/backend && npm install && npm run dev
curl -c jar.txt -X POST localhost:8080/api/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin12345"}'
curl -b jar.txt localhost:8080/api/sources
curl -b jar.txt -X POST localhost:8080/api/auth/change-password -H 'content-type: application/json' \
  -d '{"currentPassword":"admin12345","newPassword":"doi-moi-123","confirmPassword":"doi-moi-123"}'
curl localhost:8080/api/sources   # → 401 unauthorized (không cookie)
```

## Lưu ý bảo mật đã áp dụng

- Login sai/user lạ cùng message `sai tên đăng nhập hoặc mật khẩu` (không lộ user nào tồn tại).
- `bcrypt.compare` chạy cả khi user không tồn tại? Hiện return sớm — chấp nhận được cho nội bộ; nếu cần chống timing-attack thì compare với hash giả (ghi chú cho bản cứng hơn).
- Reset token vô hiệu ngay sau khi dùng (`setPasswordHash` xóa token).

## Phân quyền 2 vai (nhân sự xem + admin cấu hình)

| Vai | Được | Cấm (403 `cần quyền quản trị`) |
|---|---|---|
| `admin` | Mọi thứ (mọi kênh) | — |
| `user` (nhân sự) | Xem/trích xuất/timeshift/EPG **đúng kênh được gán**, đổi MK chính mình | Tạo/sửa/xóa/start/stop/preview nguồn, link pull, giám sát SSE, GC/HLS-health/notify/backup-restore/EPG-sync, tra cứu ID EPG đối tác, quản trị users |
| partner key (Bearer) | Full quyền service (máy-gọi-máy) | — |

## Gán kênh cho nhân sự (`allowedChannels`)

- Mỗi nhân sự có danh sách kênh được gán (mặc định rỗng = **không thấy kênh nào**).
  Admin gán lúc tạo user hoặc sau này: `PUT /api/admin/users/:u/channels {channels:
  [...]}` (ghi đè, hiệu lực ngay không cần đăng nhập lại).
- Mọi API theo kênh đều chặn theo scope (`channelScope`/`scopeDeny` trong
  `server.ts`): `GET /api/sources` (lọc kênh, ẩn source hết kênh thấy), `GET
  /api/sources/:id`, `POST /api/hls-tokens`, submit/list/get/download/delete
  exports, playlist timeshift, `GET /api/epg/schedule`, `GET /api/epg/status`
  (chỉ mapping/unmapped trong scope). Kênh ngoài scope → 403.
- Link xem cấp ra (token/pull) đã bind tên kênh nên chunk timeshift kế thừa scope
  từ lúc mint — không cần check thêm. **Lưu ý:** token HLS đã cấp (tối đa 4 giờ)
  vẫn xem được kênh cũ sau khi bị thu hồi gán; cần đá ngay thì đổi
  `VTC_HLS_SECRET` (+ restart backend FE không cache token).
- Phân biệt với `published`: `published` = kênh có lên danh mục VTVgo kéo luồng
  không; `allowedChannels` = nhân sự nào được xem kênh nào. Hai lớp độc lập.

- Role nằm trong JWT + tra store mỗi request (đổi role/xóa user hiệu lực ngay,
  không chờ token 7 ngày hết hạn).
- Quản trị users (admin): `GET/POST /api/admin/users`, `DELETE
  /api/admin/users/:u` (cấm tự xóa mình), `POST .../password` (đặt lại MK nhân
  sự). UI ở trang Quản trị. Biết ai gọi ai qua log (`tạo user X`, `xóa user X`).
- UI theo vai: Sidebar ẩn Giám sát/Nguồn/EPG/Quản trị với nhân sự; 4 trang đó bọc
  `RequireAdmin`; trang Kênh ẩn nút Live-toggle/Link-kéo; login chuyển
  admin→`/`, nhân sự→`/channels`. Bảo mật thật ở API — UI chỉ để gọn.
- Xóa user không thu hồi JWT đã cấp (tối đa 7 ngày còn hiệu lực đọc; mọi API
  cấu hình đã chặn từ lúc xóa vì tra store). Cần đá ngay: đổi `VTC_JWT_SECRET`
  + restart (mọi phiên chết hết).
