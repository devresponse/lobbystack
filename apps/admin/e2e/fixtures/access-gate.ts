// The token the access gate's browser journey starts its own server with
// (playwright.access-gate.config.ts). It guards a server on localhost that
// lives for one test run, so it is fixed and no secret.
export const ACCESS_GATE_E2E_TOKEN = "e2e-access-gate-token-0123456789-abcdefgh";
