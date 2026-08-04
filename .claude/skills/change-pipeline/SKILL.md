---
name: change-pipeline
description: Release gate cho DatabaseManager — chạy /impact-review (review→fix→test theo vùng ảnh hưởng) rồi mới tới 4 suite bắt buộc, xin phê duyệt, deploy, smoke check, rollback nếu hỏng. Activates khi operator gọi /change-pipeline, hoặc nói "đối ứng xong rồi deploy", "chạy pipeline đổi code", "review + test + deploy thay đổi này".
---

# change-pipeline — Release gate

> **Hợp nhất 2026-08-04.** Phần review/fix/test trước đây do `impact-scoper` +
> `impact-tester` tự viết đảm nhiệm. Bundle nay ship sẵn `impact-analyzer`,
> `code-reviewer`, `fix-agent`, `targeted-tester` + skill `/impact-review` làm
> đúng việc đó và tốt hơn (3 lens song song, adversarial verify). Skill này
> **không làm lại** phần đó nữa — chỉ gọi `/impact-review` rồi làm tiếp phần
> release mà bundle không có: phê duyệt, deploy, smoke, rollback, ledger.

```
/impact-review  ──►  A5 Release Gate  ──►  approval  ──►  deploy
   (bundle)              (skill này)                          │
                                                       smoke fail
                                                              ▼
                                                       rollback_deploy
```

## Config (C2 — DATA, không hardcode)

| File | Nội dung |
|---|---|
| `.harness/control/agent-config.yaml` | `unit_related_cmd`, `full_suite_cmd`, hub file buộc full suite |
| `contracts/impact-map.yaml` | 11 group: source glob → test file + integration case + risk |
| `.harness/control/casan-policies.yaml` | suite bắt buộc, danh sách cần phê duyệt, smoke URL |

---

## Bước 1 — Review / Fix / Test

Gọi skill **`/impact-review`**. Không tự dựng lại impact map, không tự chọn test.

Dừng và báo người nếu `/impact-review` kết thúc mà vẫn còn finding CONFIRMED
hoặc test đỏ. **Không đi tiếp sang A5.**

---

## Bước 2 — A5 Release Gate

### 2.1 Chạy đủ 4 suite bắt buộc

Lấy lệnh từ `casan-policies.yaml` → `evaluation.suite_commands`. Không tin kết
quả test ở bước 1 — gate phải tự chạy lại:

```
policy-ci · red-team · golden · secureconnect-unit
```

Bất kỳ suite nào FAIL → **dừng**, không deploy.

### 2.2 Xin phê duyệt (H5)

`deploy` nằm trong `governance.approval_required`, nên hook
`approval-checkpoint.ps1` sẽ tự hỏi. Đừng tìm cách đi vòng. Trước khi gọi
deploy, tóm tắt cho người dùng: đổi những gì, suite nào xanh, rủi ro gì.

### 2.3 Deploy

```
MCP deploy { server_id: "mcp-80", app_id: "dbmanager" }
```

**Trước khi deploy, tự hỏi: có file nào trong `SecureConnect/` thay đổi không?**
Nếu không — nói thẳng là không cần deploy và dừng. Build lại image y hệt rồi
restart container prod là rủi ro không đổi lấy gì.

### 2.4 Smoke + rollback (H7)

Hook `deploy-verify.ps1` tự smoke `https://DBManager.allin1site.com/api/health`
(3 lần, cách 5s) và trả `block` nếu hỏng. Khi thấy block:

1. Gọi `rollback_deploy` ngay
2. Xác nhận lại health sau rollback
3. Báo người nguyên nhân trước khi deploy lại

Hook **không tự rollback được** — nó chỉ phát hiện và chặn. Việc gọi
`rollback_deploy` là của bạn.

---

## Quy tắc

- Không deploy khi chưa qua 2.1 và 2.2.
- Không sửa test cho pass. Test đỏ là tín hiệu, không phải chướng ngại.
- Nếu nightly full-suite đỏ mà impact-test trong ngày đều xanh → có file nằm
  ngoài dependency graph: thêm nó vào `impact.force_full_test_on` trong
  `agent-config.yaml`, hoặc thêm group mới vào `contracts/impact-map.yaml`.
- Báo cáo cuối bằng tiếng Việt, ngắn: đổi gì, suite nào chạy, deploy hay không
  và vì sao.
