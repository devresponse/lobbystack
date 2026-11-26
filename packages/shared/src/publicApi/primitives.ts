import { z } from "zod";

// The building blocks every v1 schema shares, in a module of their own so the
// schema modules split by resource can use them without importing each other.

export const id = z.uuid().describe("Stable identifier (UUID).");
export const timestamp = z.iso.datetime().describe("ISO 8601 timestamp in UTC.");
export const nullableTimestamp = timestamp.nullable();
