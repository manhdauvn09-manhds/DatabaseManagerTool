import { describe, it, expect, beforeEach } from "vitest";
import { recordRequest, recordCache, getMetricsSnapshot, _resetMetricsMemory } from "../metrics";

// No REDIS_URL in the test env → exercises the in-memory backend.
describe("observability/metrics (in-memory)", () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
    _resetMetricsMemory();
  });

  it("aggregates request counts, errors, avg and max latency", async () => {
    recordRequest("db.tables", true, 10);
    recordRequest("db.tables", true, 30);
    recordRequest("db.tables", false, 100);

    const snap = await getMetricsSnapshot();
    expect(snap.backend).toBe("memory");
    const a = snap.actions.find((x) => x.action === "db.tables")!;
    expect(a.count).toBe(3);
    expect(a.errors).toBe(1);
    expect(a.avgMs).toBe(Math.round((10 + 30 + 100) / 3));
    expect(a.maxMs).toBe(100);
    expect(a.errorRate).toBeCloseTo(1 / 3, 3);
  });

  it("computes totals across actions", async () => {
    recordRequest("db.tables", true, 20);
    recordRequest("db.query", false, 40);
    const snap = await getMetricsSnapshot();
    expect(snap.totals.count).toBe(2);
    expect(snap.totals.errors).toBe(1);
    expect(snap.totals.avgMs).toBe(30);
  });

  it("tracks cache hit rate", async () => {
    recordCache(true);
    recordCache(true);
    recordCache(false);
    const snap = await getMetricsSnapshot();
    expect(snap.cache.hits).toBe(2);
    expect(snap.cache.misses).toBe(1);
    expect(snap.cache.hitRate).toBeCloseTo(2 / 3, 3);
  });

  it("sorts actions by count desc", async () => {
    recordRequest("a", true, 1);
    recordRequest("b", true, 1);
    recordRequest("b", true, 1);
    const snap = await getMetricsSnapshot();
    expect(snap.actions[0].action).toBe("b");
  });
});
