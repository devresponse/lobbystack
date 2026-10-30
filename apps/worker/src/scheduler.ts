import { createQueue, type JobQueue, type JobType } from "@lobbystack/jobs";

/** A job scheduler as last set in Redis; `every` is 0 once removed. */
export type Schedule = { queue: JobQueue; name: string; type: JobType; every: number; businessId: string | null };

// A dormant business (see listSchedulerBusinesses) runs a job every
// `idleEvery` instead, or not at all when that is 0. The per-minute jobs only
// matter to a business someone uses. A canceled business (closed) keeps only
// its `housekeeping` jobs, at the dormant pace: nothing more reaches its
// owners, customers or calendar, but its data keeps its retention and its
// numbers still go back to Twilio.
const tenantSchedules: Array<{ queue: JobQueue; name: string; type: JobType; every: number; idleEvery?: number; housekeeping?: true }> = [
  { queue: "maintenance", name: "privacy-retention-sweep", type: "privacy.scrubMessage", every: 60 * 60_000, housekeeping: true },
  { queue: "maintenance", name: "pending-upload-cleanup", type: "privacy.cleanupPendingUpload", every: 15 * 60_000, housekeeping: true },
  { queue: "default", name: "calendar-reconcile", type: "calendar.reconcileBusiness", every: 15 * 60_000 },
  { queue: "maintenance", name: "phone-number-reclaim", type: "phoneNumber.reclaim", every: 60 * 60_000, housekeeping: true },
  { queue: "maintenance", name: "operator-daily-summary", type: "notification.dailySummary", every: 60_000, idleEvery: 0 },
  // A closed demo still records events (a failed claim, a call that ends late), and only this job sends them.
  { queue: "maintenance", name: "telemetry-flush", type: "telemetry.flush", every: 60_000, idleEvery: 60 * 60_000, housekeeping: true },
  { queue: "maintenance", name: "outbox-backlog-sample", type: "outbox.backlogSample", every: 60_000, idleEvery: 0 },
  { queue: "maintenance", name: "unit-economics-rollup", type: "billing.refreshUnitEconomics", every: 60 * 60_000, housekeeping: true },
  { queue: "maintenance", name: "api-retention", type: "api.retention", every: 60 * 60_000, housekeeping: true },
  // A promo plan's ending is told to Polar and its owners a week ahead, so once a day is enough.
  { queue: "default", name: "promo-plan-end", type: "billing.endPromoPlan", every: 24 * 60 * 60_000 },
];

/**
 * Brings the job schedulers in Redis in line with the business list. `applied`
 * holds what this process last set, so a refresh only calls Redis for what
 * changed: pass the same map every time. An empty map, as after a boot,
 * applies everything. Upserts and removals are idempotent, so several worker
 * processes can each keep their own map.
 */
export async function configureSchedulers(
  queues = new Map<JobQueue, ReturnType<typeof createQueue>>(),
  businesses: ReadonlyArray<{ id: string; active: boolean; closed?: boolean }> = [],
  applied = new Map<string, Schedule>(),
): Promise<void> {
  const desired: Schedule[] = [
    { queue: "maintenance", name: "prospect-demo-expiry", type: "prospectDemo.expire", every: 60 * 60_000, businessId: null },
    { queue: "maintenance", name: "affiliate-payout", type: "affiliate.generatePayoutRun", every: 24 * 60 * 60_000, businessId: null },
    // Compares the billing tables with Polar once a day; it skips until Polar is linked.
    { queue: "maintenance", name: "billing-verify", type: "billing.verifyCatalog", every: 24 * 60 * 60_000, businessId: null },
    // Queues billing work whose job ran out of tries or died: Polar events, usage and checkouts.
    { queue: "maintenance", name: "billing-sweep", type: "billing.sweep", every: 5 * 60_000, businessId: null },
    // A call whose worker died keeps talking with nobody answering, so look every minute.
    { queue: "critical", name: "live-orphan-recovery", type: "live.recoverOrphans", every: 60_000, businessId: null },
    // Keeps each phone business's opening recorded, so calls after a quiet week still open with it.
    { queue: "maintenance", name: "live-greeting-recordings", type: "live.recordGreetings", every: 24 * 60 * 60_000, businessId: null },
  ];
  for (const { id: businessId, active, closed } of businesses) {
    for (const schedule of tenantSchedules) {
      const every = active && !closed ? schedule.every : schedule.idleEvery ?? schedule.every;
      desired.push({ queue: schedule.queue, name: `${schedule.name}:${businessId}`, type: schedule.type, every: closed && !schedule.housekeeping ? 0 : every, businessId });
    }
    // Orphan recovery used to run once per business. shortcut: this removes those schedulers at every boot, drop it once every environment has deployed it.
    desired.push({ queue: "critical", name: `live-orphan-recovery:${businessId}`, type: "live.recoverOrphans", every: 0, businessId });
  }
  const wanted = new Set(desired.map((schedule) => schedule.name));
  // A business that left the list keeps no schedulers.
  for (const schedule of applied.values()) {
    if (!wanted.has(schedule.name)) desired.push({ ...schedule, every: 0 });
  }
  // After a boot this process knows nothing it set before, so a business
  // deleted while no worker ran would keep its schedulers: drop each one in
  // Redis that is per business and names no business on the list.
  if (applied.size === 0) {
    const tenantNames = new Set(["live-orphan-recovery", ...tenantSchedules.map((schedule) => schedule.name)]);
    for (const queue of new Set(queues.values())) {
      for (const scheduler of await queue.getJobSchedulers()) {
        const separator = scheduler.key.indexOf(":");
        if (separator > 0 && tenantNames.has(scheduler.key.slice(0, separator)) && !wanted.has(scheduler.key)) await queue.removeJobScheduler(scheduler.key);
      }
    }
  }
  for (const schedule of desired) {
    const queue = queues.get(schedule.queue);
    if (!queue || applied.get(schedule.name)?.every === schedule.every) continue;
    if (schedule.every) {
      await queue.upsertJobScheduler(schedule.name, { every: schedule.every }, { name: schedule.type, data: { jobId: schedule.name, type: schedule.type, queue: schedule.queue, businessId: schedule.businessId, payload: {}, trace: {}, idempotencyKey: schedule.name, scheduled: true, recurring: true } });
    } else {
      await queue.removeJobScheduler(schedule.name);
    }
    applied.set(schedule.name, schedule);
  }
  for (const name of applied.keys()) {
    if (!wanted.has(name)) applied.delete(name);
  }
}
