# Lấy giá trị cho file `.env`

Hướng dẫn tạo OAuth 2.0 credentials để chạy extension từ source.

## Các biến cần điền

Trong 5 biến của [`.env.template`](../.env.template), chỉ **2 biến bắt buộc**:

| Biến                                   | Bắt buộc                  | Lấy ở đâu                              |
| -------------------------------------- | ------------------------- | -------------------------------------- |
| `COLAB_EXTENSION_ENVIRONMENT`          | Giữ mặc định `production` | Không cần đổi                          |
| `COLAB_EXTENSION_CLIENT_ID`            | **Có**                    | Google Cloud Console (bước 4 bên dưới) |
| `COLAB_EXTENSION_CLIENT_NOT_SO_SECRET` | **Có**                    | Google Cloud Console (bước 4 bên dưới) |
| `TEST_ACCOUNT_EMAIL`                   | Không                     | Chỉ dùng cho e2e test, để trống        |
| `TEST_ACCOUNT_PASSWORD`                | Không                     | Chỉ dùng cho e2e test, để trống        |

Hai biến `TEST_ACCOUNT_*` chỉ được đọc bởi [`scripts/test_e2e.sh`](../scripts/test_e2e.sh) khi chạy
`npm run test:e2e`. Bỏ trống không ảnh hưởng gì đến việc chạy extension.

## Bước 1 — Tạo project

Vào <https://console.cloud.google.com> và tạo một project mới, ví dụ
`colab-vscode-dev`.

## Bước 2 — Bật Colab API

_APIs & Services → Library_ → tìm `Colab` (hoặc `colaboratory.googleapis.com`) →
bấm **Enable**.

## Bước 3 — Cấu hình OAuth consent screen

_APIs & Services → OAuth consent screen_:

- **User type**: External
- **Publishing status**: để nguyên `Testing`
- **Scopes**: thêm đủ 4 scope mà extension yêu cầu (nguồn:
  [`src/auth/scopes.ts`](../src/auth/scopes.ts)):

  ```txt
  profile
  email
  https://www.googleapis.com/auth/colaboratory
  https://www.googleapis.com/auth/drive.file
  ```

- **Test users**: thêm **tất cả** các tài khoản Gmail bạn định dùng.

Bước Test users hay bị bỏ sót nhất. Khi app ở trạng thái `Testing`, Google chỉ
cho phép các tài khoản nằm trong danh sách này đăng nhập. Nếu dùng tính năng
nhiều tài khoản (`Colab: Add Account`), phải thêm đủ mọi tài khoản định dùng,
nếu không việc tự chuyển tài khoản khi hết quota sẽ thất bại.

## Bước 4 — Tạo OAuth Client ID

_APIs & Services → Credentials → Create Credentials → OAuth client ID_:

- **Application type**: `Desktop app`
- Đặt tên tuỳ ý → **Create**

Google hiện ra `Client ID` (dạng `123456789-abc.apps.googleusercontent.com`) và
`Client secret` (dạng `GOCSPX-...`).

## Bước 5 — Điền vào `.env`

```txt
COLAB_EXTENSION_ENVIRONMENT=production
COLAB_EXTENSION_CLIENT_ID=123456789-abc.apps.googleusercontent.com
COLAB_EXTENSION_CLIENT_NOT_SO_SECRET=GOCSPX-xxxxxxxxxxxxx
TEST_ACCOUNT_EMAIL=
TEST_ACCOUNT_PASSWORD=
```

## Bước 6 — Sinh lại config

```bash
npm run generate:config
```

Lệnh này ghi đè [`src/colab-config.ts`](../src/colab-config.ts). **Phải chạy lại
mỗi lần sửa `.env`**, nếu không giá trị cũ vẫn được biên dịch vào bundle.

Cả `.env` và `src/colab-config.ts` đều đã nằm trong `.gitignore`, nên client
secret sẽ không bị đẩy lên git.

## Bước 7 — Kiểm tra

```bash
npm ci                    # nếu chưa cài dependencies
npm run generate:config
npm run watch
```

Bấm `F5` trong VS Code để mở Extension Development Host, rồi chạy lệnh
`Colab: Add Account` từ command palette.

Đăng nhập thành công khi trình duyệt mở ra màn hình consent của Google liệt kê
đủ 4 scope ở bước 3.

## Vì sao chọn "Desktop app"

Extension có 2 luồng đăng nhập trong [`src/auth/flows/`](../src/auth/flows/):

- **Loopback** ([`loopback.ts`](../src/auth/flows/loopback.ts)) — dựng một HTTP
  server cục bộ và redirect về `http://127.0.0.1:<port ngẫu nhiên>`. Client loại
  `Desktop app` tự động chấp nhận mọi cổng loopback, nên **không cần khai báo
  redirect URI thủ công**. Đây là luồng mặc định trên VS Code bản desktop.
- **Proxied** ([`proxied.ts`](../src/auth/flows/proxied.ts)) — redirect về
  `https://colab.research.google.com/vscode/redirect`, tức domain của Google.
  Bạn **không thể** đăng ký URI này cho client của mình, nên luồng dự phòng này
  sẽ không chạy được. Điều này không ảnh hưởng khi dùng VS Code desktop; chỉ
  ảnh hưởng nếu chạy VS Code trên web hoặc qua remote.

## Các vấn đề thường gặp

### Refresh token hết hạn sau 7 ngày

Khi app ở trạng thái `Testing`, Google giới hạn tuổi thọ refresh token là 7
ngày. Sau đó lời gọi làm mới token trả về `invalid_grant`, và extension sẽ tự
xoá tài khoản đó khỏi danh sách (xem `classifyRefreshError` trong
[`src/auth/account-manager.ts`](../src/auth/account-manager.ts)).

Hệ quả: mỗi tuần phải đăng nhập lại toàn bộ các tài khoản. Muốn tránh thì phải
chuyển app sang `In production`, nhưng khi đó Google yêu cầu quy trình
verification.

### Lỗi `invalid_scope` hoặc `access_denied` khi đăng nhập

Nhiều khả năng scope `https://www.googleapis.com/auth/colaboratory` không được
cấp cho OAuth client do bên thứ ba tự tạo — nó có thể thuộc nhóm restricted mà
chỉ client chính thức của Google mới dùng được.

Nếu gặp lỗi này thì không có cách vòng qua; chỉ có thể dùng bản extension chính
thức trên Marketplace. Hãy kiểm tra sớm ở bước 7 trước khi đầu tư thêm thời
gian.

### Lỗi "app chưa được xác minh" hoặc chặn đăng nhập

Tài khoản đang đăng nhập chưa có trong danh sách **Test users** ở bước 3. Thêm
vào rồi thử lại.

### Sửa `.env` xong mà không thấy thay đổi

Chưa chạy lại `npm run generate:config`. Giá trị được nhúng tĩnh vào
`src/colab-config.ts` lúc build, không đọc `.env` khi chạy.
