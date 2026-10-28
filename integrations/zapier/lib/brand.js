'use strict';

// The name, default address and help link this integration shows. Each
// deployment that publishes its own Zapier integration sets them where it runs
// `zapier push` and, for the running integration, with `zapier env:set`:
// ZAPIER_APP_NAME (for example AlloPlace), ZAPIER_DEFAULT_URL (the dashboard's
// address), and ZAPIER_HELP_URL (the page the API key's help links to) or
// ZAPIER_DOCS_URL (docs whose /api/authentication page it links to instead).
// `npm run push -- --brand <id> --url <address>` sets all of them. Unset, they
// are LobbyStack's.
const clean = (value) => String(value || '').trim();

const APP_NAME = clean(process.env.ZAPIER_APP_NAME) || 'LobbyStack';
const DEFAULT_BASE_URL = clean(process.env.ZAPIER_DEFAULT_URL).replace(/\/+$/, '') || 'https://app.lobbystack.com';
const DOCS_URL = clean(process.env.ZAPIER_DOCS_URL).replace(/\/+$/, '') || 'https://docs.lobbystack.com';
const HELP_URL = clean(process.env.ZAPIER_HELP_URL) || `${DOCS_URL}/api/authentication`;

module.exports = { APP_NAME, DEFAULT_BASE_URL, DOCS_URL, HELP_URL };
