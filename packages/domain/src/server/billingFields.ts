// Readers for the provider events reconcile applies. The webhook stores each
// event as the provider's object with LobbyStack's normalized names beside it
// (packages/providers/src/*/events.ts), and older events in Polar's own
// names, so each reader takes the names to try in order and skips a value of
// the wrong type rather than failing the event.

/** The value as an object, or an empty one. */
export function recordObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

/** The first of the keys that holds a non-empty string. */
export function stringField(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** The first of the keys that holds a finite number, or a string of one. */
export function numberField(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** The first of the keys that holds a string naming a valid time. */
export function dateField(source: Record<string, unknown>, ...keys: string[]): Date | undefined {
  const value = stringField(source, ...keys);
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}
