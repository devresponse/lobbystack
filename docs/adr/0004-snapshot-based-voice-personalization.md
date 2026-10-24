# ADR 0004: use snapshot-based voice personalization

Each voice call loads one durable business snapshot before starting the live model session.

## Status

Accepted. Since [ADR 0008](0008-gpt-live-voice.md) removed the voice gateway, the admin reads the snapshot to accept a call with the business's instructions, and the worker that runs the call loads it too, through a Redis cache.

## Decision

The admin and worker compile business configuration and knowledge into a call-start snapshot stored in PostgreSQL. The voice gateway fetches the snapshot from the private admin backend once per call.

## Rationale

This avoids per-turn backend round trips during calls while preserving PostgreSQL as the durable source of truth.
