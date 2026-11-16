import { expectTypeOf } from "vitest";

import type { CallDetail, CallListItem } from "@lobbystack/domain";
import type { Jsonified } from "@lobbystack/shared";

/**
 * Checked by `pnpm typecheck`, not by a test run: these say what a dashboard screen may
 * expect of a response, so a renamed or removed field in the domain fails here (AUDIT-018).
 */

// A date leaves the server as a Date and reaches the browser as its ISO string.
expectTypeOf<CallListItem["startedAt"]>().toEqualTypeOf<Date>();
expectTypeOf<Jsonified<CallListItem>["startedAt"]>().toEqualTypeOf<string>();
expectTypeOf<Jsonified<CallDetail>["transcript"][number]["createdAt"]>().toEqualTypeOf<string>();

// Nothing else changes shape on the way.
expectTypeOf<Jsonified<CallListItem>["contactPhone"]>().toEqualTypeOf<string | null>();
expectTypeOf<Jsonified<CallListItem>["receptionist"]>().toEqualTypeOf<{ id: string; name: string | null } | null>();
expectTypeOf<Jsonified<CallDetail>["call"]["archivedAt"]>().toEqualTypeOf<string | null>();

// The fields the Calls page reads are the ones the query selects.
expectTypeOf<Jsonified<CallListItem>>().toExtend<{ id: string; transcriptPreview: string | null; recordingState: string }>();
