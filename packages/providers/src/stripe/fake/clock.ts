/** The fake's time in Stripe's unix seconds, which a test moves on. Starts on 2026-11-01 at 00:00 UTC. */
export class FakeClock {
  constructor(private seconds = Date.UTC(2026, 10, 1) / 1000) {}

  now(): number {
    return this.seconds;
  }

  advance(seconds: number): void {
    this.seconds += seconds;
  }
}
