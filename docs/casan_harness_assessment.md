# CASAN Harness Assessment — SDD Pipeline Evaluation Framework

> Tài liệu này mô tả cách đánh giá mức độ trưởng thành Harness của một SDD pipeline theo khung CASAN.  
> Áp dụng được cho bất kỳ project nào dùng Speckit / okr.* agent pattern.  
> Cập nhật lần cuối: 2026-06-26

---

## 1. Bảy thành phần Harness cần đánh giá

| ID | Harness | Mô tả cốt lõi |
|----|---------|---------------|
| H1 | Context Harness | Đưa đúng thông tin, đúng lúc vào agent — RAG, agent memory, context window optimization |
| H2 | Tool Harness | Gọi đúng tool, đúng quyền — tool registry, idempotency, audit log, rate limit |
| H3 | Evaluation Harness | Kiểm định đầu ra — golden dataset, LLM-as-judge, regression tests, feedback loop |
| H4 | Security Harness | Phòng chống prompt injection, data leakage, credential abuse |
| H5 | Governance Harness | Luồng phê duyệt, audit log bất biến, risk registry, policy engine |
| H6 | AgentOps Harness | Giám sát hiệu năng — cost/task, hallucination rate, drift detection |
| H7 | Orchestration Harness | DAG/state machine, agent-to-agent protocol, retry, parallel execution |

---

## 2. Scorecard đánh giá từng Harness

Chấm điểm theo thang 0–100. Gợi ý mức:

| Score | Mô tả |
|-------|-------|
| 0–30  | **GAP** — Harness này gần như không có, rủi ro cao |
| 31–60 | **Partial** — Có một số cơ chế nhưng thiếu bài bản |
| 61–80 | **Good** — Hoạt động tốt, còn một vài điểm cần cứng hóa |
| 81–100 | **Strong** — Đủ tiêu chuẩn vận hành thật |

### Bảng chấm điểm

| ID | Harness | Score | Nhận xét | GAP cần bổ sung |
|----|---------|-------|----------|-----------------|
| H1 | Context Harness | __ /100 | | |
| H2 | Tool Harness | __ /100 | | |
| H3 | Evaluation Harness | __ /100 | | |
| H4 | Security Harness | __ /100 | | |
| H5 | Governance Harness | __ /100 | | |
| H6 | AgentOps Harness | __ /100 | | |
| H7 | Orchestration Harness | __ /100 | | |

---

## 3. Checklist đánh giá chi tiết từng Harness

### H1 — Context Harness

- [ ] Có file context tập trung (pipeline-context.yaml hoặc tương đương)?
- [ ] Context được cập nhật sau mỗi step, không cần agent tự scan lại?
- [ ] Agent nhận đường dẫn artifact từ context thay vì hardcode/đoán?
- [ ] Tech stack và domain knowledge chỉ đọc một lần, cache lại?
- [ ] Có cơ chế làm sạch context khi outdated/stale?

**Câu hỏi chốt:** *Sub-agent có thể biết đường dẫn SRS, BD, spec từ context mà không cần Boss truyền lại không?*

---

### H2 — Tool Harness

- [ ] Các tool call có schema mô tả rõ (input/output/error types)?
- [ ] Có tool registry — agent gọi qua registry, không hardcode URL/credential?
- [ ] Có idempotency key cho các tool thay đổi hệ thống (write, deploy)?
- [ ] Có rate limit và retry policy?
- [ ] Có audit log ghi lại mỗi tool call?

**Câu hỏi chốt:** *Nếu một tool call chạy 2 lần, hệ thống có safe không?*

---

### H3 — Evaluation Harness

- [ ] Có golden dataset (bộ test case chuẩn) trước khi implement?
- [ ] Review dùng LLM-as-judge với tiêu chí rõ ràng (không chỉ "nhìn qua")?
- [ ] Có gate cứng — pipeline dừng nếu verdict REJECTED?
- [ ] Gate có auto-retry với fix agent, không dừng toàn bộ pipeline?
- [ ] Có regression test chạy trước khi deploy lên môi trường thật?
- [ ] Feedback từ môi trường thật (test fail, bug) quay lại update spec/plan?

**Câu hỏi chốt:** *Một thay đổi nhỏ trong spec có trigger lại test tự động không?*

---

### H4 — Security Harness

- [ ] Có scan prompt injection trong user input trước khi đưa vào agent?
- [ ] Credential (API key, DB password) không được hardcode trong prompt/spec?
- [ ] Có kiểm tra data leakage — PII/nhạy cảm không đi vào log?
- [ ] Có sandbox/timeout cho tool execution để tránh agent chạy lệnh nguy hiểm?
- [ ] Có cơ chế jailbreak detection?

**Câu hỏi chốt:** *Nếu user inject `ignore previous instructions` vào input, pipeline có bị ảnh hưởng không?*

---

### H5 — Governance Harness

- [ ] Có luồng phê duyệt con người trước khi agent thực thi action có rủi ro cao?
- [ ] Audit log bất biến — không ai (kể cả admin) xóa được?
- [ ] Có risk registry — danh sách các action bị cấm hoặc cần review?
- [ ] Có policy engine — agent tự check quyền trước khi gọi tool?
- [ ] Có báo cáo compliance định kỳ?

**Câu hỏi chốt:** *Nếu audit, có thể trả lời "ai đã làm gì, lúc mấy giờ, được ai duyệt" không?*

---

### H6 — AgentOps Harness

- [ ] Đo cost per agent run (token, thời gian, tiền)?
- [ ] Track tỷ lệ hallucination / error per step?
- [ ] Có alerting khi một step fail quá N lần?
- [ ] Có drift detection — phát hiện khi model output thay đổi hành vi theo thời gian?
- [ ] Dashboard theo dõi throughput và latency của toàn pipeline?

**Câu hỏi chốt:** *Nếu một step đột nhiên tốn gấp 3 lần token bình thường, có ai biết không?*

---

### H7 — Orchestration Harness

- [ ] Pipeline có DAG rõ ràng — biết step nào phụ thuộc step nào?
- [ ] Có parallel execution cho các step độc lập (không chờ tuần tự không cần thiết)?
- [ ] Có BACK-TO-PLAN / retry cycle khi gate fail?
- [ ] Có giới hạn số lần retry để tránh infinite loop?
- [ ] Có fallback — nếu model A fail, thử model B?
- [ ] Có transaction boundary — rollback được nếu step giữa pipeline fail?

**Câu hỏi chốt:** *Nếu step 10 fail sau khi step 8-9 đã chạy xong, pipeline có recover được không?*

---

## 4. Xác định CASAN Level từ kết quả Harness

### Công thức quy đổi

```
Average Score = (H1 + H2 + H3 + H4 + H5 + H6 + H7) / 7
Critical GAP  = bất kỳ Harness nào có score < 30
```

| Điều kiện | CASAN Level |
|-----------|-------------|
| Average < 40 hoặc ≥ 3 GAP | Level 2 — Augmented (dùng Harness của nhà cung cấp) |
| Average 40–65, ≤ 2 GAP | Level 3 — Standard (Harness chuẩn hóa) |
| Average 65–80, ≤ 1 GAP | Level 3 → 4 (đang chuyển đổi) |
| Average > 80, không có GAP | Level 4 — Automated (đủ 7 Harness vận hành thật) |
| Average > 80 + tất cả > 70 + Multi-Agent phức tạp | Level 5 — Native |

### Nguyên tắc quan trọng

> **Harness thấp nhất quyết định ceiling.** Dù H1/H3/H7 rất mạnh, nếu H4 (Security) = 0%, pipeline không thể đạt Level 4 trong môi trường production thật.

---

## 5. Kết quả đánh giá — MDE_AINative_OKR (2026-06-26)

| ID | Harness | Score | Nhận xét |
|----|---------|-------|----------|
| H1 | Context Harness | **90** | `pipeline-context.yaml` — pointer store cho artifact paths + tech stack. Boss cập nhật sau mỗi step, sub-agent đọc để discover input. Không cần re-scan. |
| H2 | Tool Harness | **75** | Build/lint/docker/npm chains có cấu trúc. Thiếu: idempotency key, tool registry chính thức, audit log per-call. |
| H3 | Evaluation Harness | **85** | LLM-as-judge multi-gate (Steps 5, 7, 11), golden dataset từ `okr.testkit` (Step 8b), auto-retry tối đa 5 lần, BACK-TO-PLAN 3 cycles. |
| H4 | Security Harness | **20** | ⚠️ GAP: Không có prompt injection scan, không kiểm tra credential hardcode trong spec, không có sandbox. |
| H5 | Governance Harness | **25** | ⚠️ GAP: Không có approval workflow, audit log chỉ là text file (không bất biến), không có risk registry. |
| H6 | AgentOps Harness | **30** | ⚠️ GAP: Chỉ có port check và startup log ở Step 13. Không track cost/agent, không có hallucination rate, không drift detection. |
| H7 | Orchestration Harness | **80** | Boss DAG rõ ràng, parallel dispatch Steps 8+9, BACK-TO-PLAN loop, gate retry protocol. Thiếu: fallback model, transaction rollback. |

**Average Score: 58/100 → CASAN Level 3 → 4**

### Roadmap đóng gap để đạt Level 4

| Priority | Action | Harness |
|----------|--------|---------|
| 🔴 High | Thêm prompt injection scan vào Boss trước khi delegate | H4 |
| 🔴 High | Không để credential trong spec/prompt — dùng env var | H4 |
| 🟠 Medium | Thêm per-agent cost tracking vào Boss log | H6 |
| 🟠 Medium | Thêm approval checkpoint trước Step 13 (deploy) | H5 |
| 🟡 Low | Thêm idempotency key cho tool calls có side effect | H2 |
| 🟡 Low | Thêm fallback model nếu primary model fail | H7 |

---

## 6. Cách dùng tài liệu này cho project mới

1. Copy bảng scorecard ở mục 2 vào file assessment của project
2. Chạy qua checklist mục 3 cho từng Harness, check ✅ những gì đã có
3. Score = (số ✅ / tổng số câu hỏi) × 100, điều chỉnh theo nhận xét thực tế
4. Dùng bảng mục 4 để xác định CASAN Level hiện tại
5. Lập roadmap từ các GAP theo priority

> **Gợi ý:** Chạy assessment này ở đầu mỗi project mới và sau mỗi milestone lớn để track tiến độ trưởng thành.
