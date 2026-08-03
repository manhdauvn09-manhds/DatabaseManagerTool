---
name: change-pipeline
description: Pipeline đối ứng an toàn — Scope → Review → Fix (max 3 vòng) → Test theo vùng ảnh hưởng → Gate. Chỉ chạy test của vùng bị impact, không test all mỗi lần. Activates khi operator gọi /change-pipeline, hoặc nói "review + test thay đổi này", "kiểm tra đối ứng", "chạy pipeline đổi code", "verify change an toàn".
---

# change-pipeline — Review / Fix / Test theo vùng ảnh hưởng

DAG cố định. Không bỏ bước, không đảo thứ tự.

```
A1 Scope ──► A2 Review ──REJECTED──► A3 Fix ──┐ (max 3 vòng)
                 │APPROVED                    └──► quay lại A2
                 ▼
             A4 Test ──► A5 Gate ──► (approval) ──► deploy ──fail──► rollback
```

Config: `pipeline-config.yaml` cùng thư mục (C2 — đọc từ đó, không hardcode).
Rubric: `.harness/eval/judge/judge-rubric.md`.

---

## A1 — Scope (tự làm, không spawn agent)

1. `git diff --name-only` (so với `main` nếu đang ở branch, ngược lại `HEAD`).
2. Phân loại file đổi:
   - Trùng `core_files` → **FULL_SUITE = true**
   - Nằm trong key của `route_test_map` → thêm test file tương ứng
   - Còn lại → để Jest/Vitest tự lần dependency graph
3. Output **impacted-map**: `{changed_files, related_tests, full_suite: bool, risk_notes}`.
4. Nếu diff rỗng → dừng, báo "không có thay đổi".

## A2 — Review

Spawn agent `code-reviewer` (hoặc `reviewer`), model opus, effort high.

- Chỉ đọc file trong impacted-map + reverse-deps cấp 1. **Không quét cả repo.**
- Chấm theo 6 dimension của `judge-rubric.md`.
- Verdict: `APPROVED` / `CHANGES_REQUIRED` / `REJECTED` + `overall_score`.
- `overall_score < judge_min_score` (70) → coi như CHANGES_REQUIRED.
- Mỗi finding phải có: file:line, mô tả defect, kịch bản fail cụ thể.
- **Adversarial verify**: mỗi finding severity cao spawn 1 skeptic thử refute; refute được → bỏ finding.

## A3 — Fix (chỉ khi A2 không APPROVED)

Spawn agent `developer`, model sonnet.

- Sửa **đúng** các finding CONFIRMED. Không refactor thêm, không mở rộng scope.
- Xong → quay lại A2, chỉ re-review phần vừa sửa.
- Đếm vòng. Chạm `max_fix_rounds` (3) → **DỪNG**, báo người, không tự deploy. (H7)

## A4 — Test (3 tầng, dừng sớm khi fail)

**Tầng 1 — luôn chạy:**
```bash
cd SecureConnect && npx vitest related --run <changed .ts files>
```
(Vitest lần dependency graph, chỉ chạy test import file đã đổi — trực tiếp hoặc gián tiếp.)

**Tầng 2 — khi đổi API route:** chạy thêm test file từ `route_test_map`.

**Tầng 3 — FULL suite, CHỈ khi:**
- `full_suite == true` (chạm core_files), hoặc
- đang ở bước trước deploy (A5 gọi xuống)

```bash
npm test --silent --prefix SecureConnect
```

Fail ở bất kỳ tầng nào → quay lại A3 (tính vào `max_fix_rounds`).

## A5 — Gate

1. Chạy 4 suite bắt buộc của `evaluation.regression_suites_required`:
   `policy-ci`, `red-team`, `golden`, `secureconnect-unit` — lệnh lấy từ `suite_commands`.
2. Bất kỳ suite FAIL → **dừng**, không deploy.
3. Tất cả PASS → **hỏi người dùng xác nhận trước khi deploy** (H5 approval; dùng AskUserQuestion).
4. Deploy → smoke check `https://DBManager.allin1site.com/api/health`.
5. Smoke fail → gọi `rollback_deploy` ngay (H7 transaction boundary).
6. Ghi kết quả (verdict, score, suite results, ai duyệt, lúc nào) vào `.harness/ledger/`.

---

## Quy tắc

- **Không bao giờ** chạy full suite ở tầng 1/2 — mục đích của pipeline này là tiết kiệm thời gian.
- **Không tự deploy** khi chưa qua A5 approval.
- Báo cáo cuối bằng tiếng Việt, ngắn: verdict, số finding, suite nào chạy, thời gian tiết kiệm.
- Nếu nightly full-suite fail mà impact-test đều pass → ghi incident `test_regression_after_pass` và **thêm file đó vào `core_files`**.
