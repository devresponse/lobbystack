import { registerPoolMetrics, serviceConnections } from "@lobbystack/db";
import { startFleetHeartbeat, type FleetHeartbeat } from "@lobbystack/jobs";
import { logEvent, serviceInstance } from "@lobbystack/telemetry/node";

// What this copy of the admin says about itself (docs/features/observability.md,
// "Watch every copy"): a beat in Redis every 10 seconds, which the fleet status
// address reads, and its database pools' connections with every metrics export.

type Env = Record<string, string | undefined>;
type Signals = Pick<NodeJS.Process, "once" | "listenerCount" | "kill" | "pid">;

const STARTED = Symbol.for("lobbystack.admin.fleet");

/**
 * Starts this copy's heartbeat and pool gauges, once a process, after
 * telemetry has started. Not during a build, which serves no one.
 *
 * When the host stops the copy, Next.js closes the server and exits by itself.
 * A listener of ours says first that the copy is shutting down, so a deploy or
 * a copy taken away never looks like a copy that died. Its beat is sent in
 * the same turn the signal arrives in, before Next.js can exit.
 */
export function startAdminFleet(env: Env = process.env, signals: Signals = process): FleetHeartbeat | undefined {
  if (env.NEXT_PHASE === "phase-production-build") return undefined;
  const holder = globalThis as { [STARTED]?: FleetHeartbeat };
  if (holder[STARTED]) return holder[STARTED];
  registerPoolMetrics();
  const instance = serviceInstance(env);
  const heartbeat = startFleetHeartbeat(
    { service: "admin", replica: instance.id, release: instance.release, ...(instance.deployment ? { deployment: instance.deployment } : {}), ...(instance.region ? { region: instance.region } : {}) },
    () => ({ db: serviceConnections("admin", env) }),
    { onError: (error) => logEvent("warn", "fleet.heartbeat_failed", { error }) },
  );
  holder[STARTED] = heartbeat;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    signals.once(signal, () => {
      void heartbeat.drain().finally(() => {
        // A signal with a listener no longer ends the process by itself. Next.js's own listener
        // does; should there be none, end it as the signal would have.
        if (signals.listenerCount(signal) === 0) signals.kill(signals.pid, signal);
      });
    });
  }
  return heartbeat;
}
