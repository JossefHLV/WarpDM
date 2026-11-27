import test from "node:test";
import assert from "node:assert";
import { SpeedLimiter } from "../src/core/limiter.mjs";

test("SpeedLimiter throttles throughput smoothly", async () => {
  // Limit to 100 KB/s
  const limiter = new SpeedLimiter(100 * 1024);

  const start = performance.now();
  // Acquire 50 KB (should be immediate or within burst)
  await limiter.acquire(50 * 1024);

  // Acquire another 100 KB (should delay to respect rate)
  await limiter.acquire(100 * 1024);
  const elapsed = (performance.now() - start) / 1000;

  // Expect at least ~0.5s elapsed for 150 KB at 100 KB/s
  assert.ok(elapsed >= 0.4, `Expected at least 0.4s elapsed, got ${elapsed}s`);
});
