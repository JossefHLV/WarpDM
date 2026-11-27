/**
 * High-Precision Token-Bucket Speed Limiter
 * Microsecond-accurate bandwidth throttling with zero CPU spin-locks.
 */

export class SpeedLimiter {
  constructor(bytesPerSecond = 0) {
    this.bytesPerSecond = bytesPerSecond;
    this.maxTokens = bytesPerSecond > 0 ? bytesPerSecond : Infinity;
    this.tokens = this.maxTokens;
    this.lastUpdate = performance.now();
  }

  setLimit(bytesPerSecond) {
    this.bytesPerSecond = Math.max(0, Number(bytesPerSecond) || 0);
    this.maxTokens = this.bytesPerSecond > 0 ? this.bytesPerSecond : Infinity;
    this.tokens =
      this.bytesPerSecond > 0
        ? Math.min(Math.max(0, this.tokens), this.maxTokens)
        : Infinity;
    this.lastUpdate = performance.now();
  }

  async acquire(bytesToRead) {
    if (this.bytesPerSecond === 0 || bytesToRead <= 0) {
      return;
    }

    const now = performance.now();
    const elapsedSeconds = (now - this.lastUpdate) / 1000;
    this.lastUpdate = now;

    this.tokens = Math.min(
      this.maxTokens,
      this.tokens + elapsedSeconds * this.bytesPerSecond
    );

    this.tokens -= bytesToRead;

    if (this.tokens < 0) {
      const waitMs = (-this.tokens / this.bytesPerSecond) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
