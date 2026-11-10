# Compliance Report - 2026-10

> Sinh tu dong boi `.harness/scripts/powershell/compliance-report.ps1` luc 2026-10-01 08:00.
> Nguon: hash-chain ledger (H5) + telemetry (H6). Khong sua tay.

## 1. Tinh toan ven cua ledger

| | |
|---|---|
| Trang thai chain | **INTACT** (OK) |
| Tong entry (toan bo) | 7 |
| Entry trong thang | 6 |

## 2. Ai da lam gi

| Nguoi dung | So action |
|---|---|
| unknown | 6 |

## 3. Phan loai action

| Loai | So luong |
|---|---|
| tool_call | 5 |
| pipeline_event | 1 |

| Ket qua | So luong |
|---|---|
| deny | 6 |

## 4. Phe duyet (approval)

_Khong co action nao can phe duyet trong thang._

## 5. Action bi tu choi / rui ro cao

- Bi tu choi (deny): **6**
- Rui ro high/critical: **6**

| Lan dau | Lan cuoi | So lan | Tool | Muc | Mo ta |
|---|---|---|---|---|---|
| 2026-10-01T02:00:25 | 2026-10-01T02:00:25 | 1 | Bash | high | blocked by runtime guard |
| 2026-10-01T02:00:26 | 2026-10-01T02:00:26 | 1 | Bash | high | blocked by runtime guard |
| 2026-10-01T02:02:10 | 2026-10-01T02:02:10 | 1 | nightly-regression | high | nightly full-suite FAILED: policy-ci |
| 2026-10-01T02:00:23 | 2026-10-01T02:00:23 | 1 | Bash | high | blocked by runtime guard |
| 2026-10-01T02:00:24 | 2026-10-01T02:00:24 | 1 | Bash | high | blocked by runtime guard |
| 2026-10-01T02:00:24 | 2026-10-01T02:00:24 | 1 | Bash | high | blocked by runtime guard |

> **Doc bang nay the nao:** cung mot `input_hash` lap lai nhieu lan thuong la
> hook self-test cua toolkit (`test-hooks.ps1` co chu dich gui `rm -rf`,
> `git push --force`... de kiem tra guard con song). Do KHONG phai cong viec
> that bi chan. Su co that la nhung dong co **So lan = 1** va mo ta gan voi
> viec dang lam. Con **6** nhom khac nhau tren tong 6 entry.

## 6. Tool duoc goi nhieu nhat

| Tool | So lan |
|---|---|
| Bash | 5 |
| nightly-regression | 1 |

## 7. Chi phi agent (H6)

| | |
|---|---|
| Session | 0 |
| Token in | 0 |
| Token out | 0 |
| Chi phi uoc tinh | $0.00 |

---

_Bao cao nay dap ung `governance.compliance_report: monthly` trong casan-policies.yaml._

