# Compliance Report - 2026-08

> Sinh tu dong boi `.harness/scripts/powershell/compliance-report.ps1` luc 2026-08-04 17:24.
> Nguon: hash-chain ledger (H5) + telemetry (H6). Khong sua tay.

## 1. Tinh toan ven cua ledger

| | |
|---|---|
| Trang thai chain | **INTACT** (OK) |
| Tong entry (toan bo) | 22 |
| Entry trong thang | 22 |

## 2. Ai da lam gi

| Nguoi dung | So action |
|---|---|
| unknown | 21 |
| manhdauvn09@gmail.com | 1 |

## 3. Phan loai action

| Loai | So luong |
|---|---|
| tool_call | 16 |
| pipeline_event | 2 |
| decision | 2 |
| approval | 2 |

| Ket qua | So luong |
|---|---|
| deny | 15 |
| ask | 4 |
| allow | 3 |

## 4. Phe duyet (approval)

| Thoi diem | Tool | Nguoi | Ly do |
|---|---|---|---|
| 2026-08-03T22:12:20 | mcp__codeprovider-mcp__deploy | unknown | governance.approval_required contains 'deploy' |
| 2026-08-03T22:12:20 | mcp__codeprovider-mcp__mysql_query | unknown | governance.approval_required contains 'mysql_query' |

> Luu y: entry ghi lai luc HOI phe duyet. Ket qua cuoi (nguoi bam dong y hay khong)
> nam o prompt cua Claude Code, chua duoc ghi nguoc lai ledger - day la gap con lai cua H5.

## 5. Action bi tu choi / rui ro cao

- Bi tu choi (deny): **15**
- Rui ro high/critical: **17**

| Lan dau | Lan cuoi | So lan | Tool | Muc | Mo ta |
|---|---|---|---|---|---|
| 2026-08-03T21:08:48 | 2026-08-03T22:45:22 | 3 | Bash | high | blocked by runtime guard |
| 2026-08-03T21:08:49 | 2026-08-03T22:45:23 | 3 | Bash | high | blocked by runtime guard |
| 2026-08-03T21:08:46 | 2026-08-03T22:45:21 | 3 | Bash | high | blocked by runtime guard |
| 2026-08-03T21:08:42 | 2026-08-03T22:45:18 | 3 | Bash | high | blocked by runtime guard |
| 2026-08-03T21:08:44 | 2026-08-03T22:45:19 | 3 | Bash | high | blocked by runtime guard |
| 2026-08-03T22:12:20 | 2026-08-03T22:12:20 | 1 | mcp__codeprovider-mcp__mysql_query | high | approval requested for high-risk action 'mysql_query' |
| 2026-08-03T22:12:20 | 2026-08-03T22:12:20 | 1 | mcp__codeprovider-mcp__deploy | high | approval requested for high-risk action 'deploy' |

> **Doc bang nay the nao:** cung mot `input_hash` lap lai nhieu lan thuong la
> hook self-test cua toolkit (`test-hooks.ps1` co chu dich gui `rm -rf`,
> `git push --force`... de kiem tra guard con song). Do KHONG phai cong viec
> that bi chan. Su co that la nhung dong co **So lan = 1** va mo ta gan voi
> viec dang lam. Con **7** nhom khac nhau tren tong 17 entry.

## 6. Tool duoc goi nhieu nhat

| Tool | So lan |
|---|---|
| Bash | 15 |
| mcp__codeprovider-mcp__deploy | 4 |
| nightly-regression | 1 |
| mcp__codeprovider-mcp__mysql_query | 1 |
| probe | 1 |

## 7. Chi phi agent (H6)

| | |
|---|---|
| Session | 0 |
| Token in | 0 |
| Token out | 0 |
| Chi phi uoc tinh | $0.00 |

---

_Bao cao nay dap ung `governance.compliance_report: monthly` trong casan-policies.yaml._

