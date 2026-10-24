# ADR 0003: use a separate voice gateway

LobbyStack isolates latency-sensitive voice transport from the dashboard and durable backend.

## Status

Superseded by [ADR 0008](0008-gpt-live-voice.md). Every phone number now sits on the Twilio SIP trunk, and the gateway, `apps/voice-gateway`, was removed from the repository on 2026-09-26.

## Decision

Use a separate Node.js voice gateway for Twilio Voice, Media Streams, and OpenAI Realtime.

## Rationale

Live audio streaming is a distinct runtime concern with different latency requirements than the main app backend.
