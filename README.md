# Bi-a 3D Online

Game bi-a 8 bi (bi trơn / bi sọc) 3D chạy trên trình duyệt, chơi online 1 đấu 1, có chỗ cho người xem.

## Chạy thử

```bash
npm install
npm run dev        # server :3000 + client :5173  → mở http://localhost:5173
```

Mở hai tab (hoặc hai máy cùng mạng, dùng `http://<IP-máy>:5173`): một người **Tạo phòng**, người kia nhập **mã phòng** (hoặc dùng liên kết mời) rồi **Vào chơi**. Hoặc cả hai bấm **Ghép trận nhanh**.

> Hai tab cùng một trình duyệt dùng chung `localStorage` nên sẽ bị coi là một người. Hãy dùng cửa sổ ẩn danh / trình duyệt khác cho người thứ hai.

### Production

```bash
npm run build      # build client vào client/dist
npm start          # server phục vụ cả giao diện tại http://localhost:3000 (PORT để đổi cổng)
```

Hoặc `docker build -t bi-a . && docker run -p 3000:3000 bi-a`. Cần HTTPS (Nginx/Caddy/Render/Fly.io…) khi đưa lên mạng; WebSocket chạy trên cùng cổng.

### Chơi mượt nhất

- Dùng bản production thay vì `npm run dev`: `npm run build && npm start` rồi mở `http://<IP-máy>:3000` (tải nhanh hơn, không có lớp phát triển của Vite).
- Mỗi máy chỉ mở **một** tab game: hai tab cùng lúc dùng chung card đồ họa.
- Để cửa sổ game ở phía trước: trình duyệt hãm trang bị ẩn/che (game tự tua tới kết quả khi quay lại).
- Card yếu: game tự chọn đồ họa *Nhẹ*, tự hạ rồi tự nâng lại độ phân giải theo FPS.

## Điều khiển

| Thao tác | Cách làm |
|---|---|
| Ngắm | Di chuột trên bàn · `←/→` chỉnh hướng (giữ `Shift` để chỉnh tinh) |
| **Lấy lực + đánh** | **Nhấn giữ chuột trái ở bất kỳ đâu trên bàn → kéo chuột ra xa (càng xa càng mạnh) → thả ra để đánh.** Chuột phải hoặc `Esc` để huỷ. Hoặc giữ `Space` rồi thả |
| Điểm đánh (xoáy) | **Giữ chuột phải + rê** để dời điểm đánh rồi thả (bấm nhanh chuột phải để mở bi lớn rồi bấm chọn) · hoặc bấm vào bi trắng ở mép trái (trên = đuổi, dưới = giật, trái/phải = xoáy ngang) · phím `W A S D`, `X` về giữa |
| Camera | Giữ con lăn (chuột giữa) + kéo = xoay · lăn chuột = zoom · phím `1` 3D, `2` trên cao, `3` sau gậy (góc nhìn thứ nhất: rê chuột trái/phải để xoay cơ, lăn chuột hoặc đưa chuột sát mép trái/phải để xoay trọn 360°; khi đánh camera tự chuyển toàn cảnh rồi quay lại) · nút chọn góc nhìn nằm cạnh đồng hồ |
| Cầm bi | Khi được đặt bi cái: di chuột rồi bấm để đặt |
| Bi số 8 | Khi chỉ còn bi 8, bấm vào lỗ muốn đánh vào (vòng vàng) |
| Điện thoại | Kéo một ngón trên bàn để ngắm, kéo thanh lực bên phải xuống rồi thả |

Nút **❔** (cạnh mã phòng, trên cùng) mở lại bảng hướng dẫn cách đánh.

### Đồ họa

Nút **⚙️** (cạnh mã phòng) chuyển giữa *Cao* và *Nhẹ* (trang tự tải lại, ván đang chơi được giữ nguyên). Lần đầu game tự chọn theo card đồ họa: card cũ/yếu (ví dụ GeForce 210, Intel HD đời cũ) hoặc trình duyệt đang vẽ bằng CPU sẽ dùng chế độ *Nhẹ*. Ngoài ra game chỉ vẽ lại khi có thay đổi và tự giảm độ phân giải nếu FPS thấp.

## Luật (8 bi, theo thông lệ quốc tế/WPA)

- Phá bi từ sau vạch phá bi. Phá hợp lệ: có bi xuống lỗ **hoặc** ít nhất 4 bi mục tiêu chạm băng. Phá lỗi (hoặc bi cái lọt lỗ khi phá) → đối thủ chọn: nhận bàn, hoặc xếp lại bi (mình phá / đối thủ phá). Bi 8 xuống lỗ khi phá → xếp lại.
- Sau phá bàn còn **mở**; bi đầu tiên vào lỗ hợp lệ quyết định nhóm (trơn 1–7 / sọc 9–15). Vào bi nhóm mình thì đánh tiếp.
- **Lỗi** → đối thủ được đặt bi cái tự do: bi cái lọt lỗ; bi cái không chạm bi nào; chạm bi của đối thủ (hoặc bi 8 khi còn bi nhóm mình / bàn mở) trước; sau va chạm không có bi nào chạm băng hay xuống lỗ; hết giờ (60 giây/lượt, 3 lần liên tiếp thì thua ván).
- Hết bi nhóm mình thì đánh bi 8 và **chỉ định lỗ**. Thắng khi bi 8 vào đúng lỗ đã chỉ định, không lỗi. Thua nếu bi 8 xuống sớm, vào sai lỗ, hoặc xuống cùng lúc phạm lỗi.
- Lưu ý: bản này chỉ yêu cầu chỉ định lỗ cho bi 8 (các bi khác không cần "gọi lỗ").

## Vật lý

Engine 2D có xoáy (trượt → lăn, xoáy trên/dưới/ngang), chạy giống hệt nhau trên server và client. Thông số theo đo đạc thực tế cho nỉ và băng thi đấu:

- **Va băng – mô hình Han (2005):** mũi băng cao 63,5% đường kính bi (quy chuẩn WPA) nên chạm bi phía trên tâm: băng "ăn" phần lớn xoáy lăn, bi bật ra rồi tự lăn lại, không bị ghì về băng. Có phân biệt dính/trượt tại điểm chạm; english thuận mở rộng góc bật, english nghịch thu hẹp.
- Hệ số phục hồi của băng giảm theo tốc độ (0,86 → 0,70); ma sát băng như băng pool thật (≈0,24 khi đập thẳng, 0,18–0,2 khi đập chéo) → tốc độ bật ra ổn định 68–90% tốc độ tới.
- Phát lại bám theo đồng hồ thật: máy có khựng thì khung sau bù ngay, tốc độ bi trên màn hình luôn đúng vật lý.
- Ma sát bi–bi phụ thuộc tốc độ trượt (Alciatore) → hiện tượng "throw" khi cắt bi; ma sát lăn 0,012 như nỉ thi đấu.
- Kiểm chứng bằng test: quy tắc 30° (bi lăn trúng nửa bi lệch ~30°), quy tắc 90° (bi stun đi vuông góc), góc bật băng, english thuận/nghịch.
- Lực theo đường cong p^1,5: kéo 50% ≈ 2,8 m/s (cú vừa), 100% = 8 m/s (phá bi). Phát lại đúng thời gian thực.
- Đường ngắm chỉ gồm một đường từ bi cái tới vị trí chạm (vòng bi ma).

## Kiến trúc

```
shared/     engine vật lý 2D có xoáy (physics.ts), luật chơi (game.ts), giao thức (protocol.ts)
server/     Express + Socket.IO: phòng, lượt, đồng hồ, kết nối lại (hub.ts)
client/     Vite + Three.js: bàn 3D, gậy, đường ngắm, HUD, âm thanh tổng hợp
tests/      Vitest cho vật lý và luật
scripts/    bot-match.ts: hai bot chơi qua server thật để kiểm thử
```

Server là bên quyết định: client chỉ gửi `{hướng, lực, xoáy}`; server mô phỏng bằng đúng engine dùng chung, áp luật rồi phát kết quả. Mỗi client chạy lại cú đánh để có hoạt ảnh mượt, sau đó gán vị trí bi theo trạng thái cuối của server nên không bao giờ lệch.

Mất kết nối: giữ chỗ 60 giây (client tự nối lại bằng token trong `localStorage`), quá hạn bị xử thua ván.

## Kiểm thử

```bash
npm test                              # 31 test vật lý + luật + năng lượng
npm run typecheck
npx tsx scripts/bot-match.ts 3        # 3 ván bot-vs-bot qua server đang chạy
npx tsx scripts/speed-diag.ts 300     # đo tốc độ/năng lượng qua 300 cú đánh ngẫu nhiên
npx tsx scripts/bench.ts              # đo tốc độ engine vật lý
BIA_LOG=1 npm start                   # in log từng cú đánh trên server
```
