# Contribute to LobbyStack

LobbyStack accepts focused fixes and features that preserve tenant isolation, provider boundaries, and the live call path. This guide explains the repository expectations and required checks. [Develop and test](docs/development/README.md) has the longer version: what trips the checks up, integration tests, and Windows.

## Follow the architecture boundaries

- Keep PostgreSQL as the durable source of truth
- Put persistence, migrations, roles, and row-level security in `packages/db`
- Put reusable business operations in `packages/domain`
- Add call and chat capabilities as agent-core tools backed by `packages/domain`
- Use shared provider adapters instead of importing provider SDKs into domain code

## Prepare a change

1. Open an issue or draft a proposal for an architecture change.
2. Add tests for affected critical paths.
3. Update the docs in the same pull request when behavior changes: `docs/` is the project's source of truth, and [keep this folder true](docs/README.md#keep-this-folder-true) lists what to update. Add an architecture decision record for an architecture change.
4. Keep the change focused enough for a reviewer to verify.

## Run the project

Use `pnpm` from the repository root. Start PostgreSQL and Redis before running the application:

```bash
pnpm install
pnpm env:generate
docker compose up -d postgres redis
pnpm db:migrate
pnpm --filter @lobbystack/telemetry build
pnpm dev
```

`pnpm env:generate` writes `.env` with new random secrets. The admin loads `@lobbystack/telemetry` from its build output, so build it again after you change `packages/telemetry`. Open the dashboard at `http://localhost:13000`.

Mock providers support routine development without live Twilio, AI, calendar, or email credentials.

## Verify your change

Run these checks before opening a pull request:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Run `pnpm db:check` and `pnpm db:verify-rls` after changing migrations, roles, or row-level security.

## Follow the code style

- Use TypeScript with strict types at system boundaries
- Add TSDoc or JSDoc to important exports and non-obvious invariants
- Keep tests beside their source as `*.test.ts` or `*.test.tsx`
- Use translation keys for dashboard copy
- Format dates, times, and numbers with the active locale
