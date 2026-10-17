'use strict';

// The name, default address and docs this integration shows. Each deployment
// that publishes its own Zapier integration sets them where it runs
// `zapier push` and, for the running integration, with `zapier env:set`:
// ZAPIER_APP_NAME (for example AlloPlace), ZAPIER_DEFAULT_URL (the dashboard's
// address) and ZAPIER_DOCS_URL. Unset, they are LobbyStack's.
const clean = (value) => String(value || '').trim();

const APP_NAME = clean(process.env.ZAPIER_APP_NAME) || 'LobbyStack';
const DEFAULT_BASE_URL = clean(process.env.ZAPIER_DEFAULT_URL).replace(/\/+$/, '') || 'https://app.lobbystack.com';
const DOCS_URL = clean(process.env.ZAPIER_DOCS_URL).replace(/\/+$/, '') || 'https://docs.lobbystack.com';

module.exports = { APP_NAME, DEFAULT_BASE_URL, DOCS_URL };
