/* globals describe, it, expect, afterEach, jest */
'use strict';

const { App, TEST_API_KEY, api, apiError, appTester, bundleWith, nock } = require('./helpers');
const { samples } = require('../lib/resources');
const { resolveBaseUrl } = require('../lib/client');

afterEach(() => nock.cleanAll());

// GET /me for a key that only has knowledge:write.
const me = {
  api_key: { id: '8c7b6a59-4837-4261-9150-0f1e2d3c4b5a', name: 'Zapier', prefix: 'lsk_1a2b3c4d', scopes: ['knowledge:write'], created_at: '2026-09-20T12:00:00Z' },
  business: { id: samples.business.id, name: samples.business.name },
};

describe('authentication', () => {
  it('tests the key with GET /me, whatever its scopes, and labels the connection with the business name', async () => {
    const scope = api().get('/me').reply(200, { data: me });
    const result = await appTester(App.authentication.test, bundleWith());
    expect(result).toEqual({
      business_id: samples.business.id,
      business_name: 'Maple Street Dental',
      api_key_id: me.api_key.id,
      api_key_name: 'Zapier',
      api_key_prefix: 'lsk_1a2b3c4d',
      scopes: ['knowledge:write'],
    });
    expect(App.authentication.connectionLabel).toBe('{{business_name}}');
    scope.done();
  });

  it('uses a self-hosted base URL and ignores a trailing /api/v1', async () => {
    const scope = nock('https://lobbystack.acme.test/api/v1', { reqheaders: { authorization: `Bearer ${TEST_API_KEY}` } })
      .get('/me')
      .reply(200, { data: me });
    await appTester(App.authentication.test, bundleWith({ authData: { baseUrl: 'https://lobbystack.acme.test/api/v1/' } }));
    scope.done();
  });

  it('refuses a platform key, which has no business of its own', async () => {
    const platform = { api_key: { ...me.api_key, prefix: 'lsp_1a2b3c4d' }, business: null, platform: { partner: 'alloplace', access: 'all' } };
    api().get('/me').reply(200, { data: platform });
    await expect(appTester(App.authentication.test, bundleWith())).rejects.toThrow(/platform key/);
  });

  it('asks the user to reconnect when the key is invalid or revoked', async () => {
    api().get('/me').reply(401, apiError('unauthorized', 'The API key is invalid or has been revoked.'));
    await expect(appTester(App.authentication.test, bundleWith())).rejects.toMatchObject({
      name: 'ExpiredAuthError',
      message: expect.stringContaining('invalid or was revoked'),
    });
  });

});

describe('deployment name', () => {
  it('shows the name, address and docs a deployment sets', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { ZAPIER_APP_NAME: 'AlloPlace', ZAPIER_DEFAULT_URL: 'https://demo.alloplace.com/', ZAPIER_DOCS_URL: 'https://docs.alloplace.com/' });
    try {
      jest.isolateModules(() => {
        const authentication = require('../authentication');
        const { resolveBaseUrl: resolve } = require('../lib/client');
        const text = JSON.stringify(authentication.fields);
        expect(text).not.toContain('LobbyStack');
        expect(authentication.fields[1]).toMatchObject({ label: 'AlloPlace URL', default: 'https://demo.alloplace.com' });
        expect(authentication.fields[0].helpText).toContain('https://docs.alloplace.com/api/authentication');
        expect(resolve({})).toBe('https://demo.alloplace.com');
        expect(() => resolve({ baseUrl: 'http://example.org' })).toThrow('The AlloPlace URL must start with https://.');
      });
    } finally {
      process.env = saved;
    }
  });

  it('links the API key help to the page a deployment names', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { ZAPIER_APP_NAME: 'AlloPlace', ZAPIER_HELP_URL: 'https://demo.alloplace.com/integrations?setup=zapier', ZAPIER_DOCS_URL: 'https://docs.alloplace.com' });
    try {
      jest.isolateModules(() => {
        const authentication = require('../authentication');
        expect(authentication.fields[0].helpText).toContain('[Learn more](https://demo.alloplace.com/integrations?setup=zapier)');
        expect(authentication.fields[0].helpText).not.toContain('docs.alloplace.com');
      });
    } finally {
      process.env = saved;
    }
  });
});

describe('base URL', () => {
  it('is a required field that starts with the default address', () => {
    const field = App.authentication.fields.find((entry) => entry.key === 'baseUrl');
    expect(field).toMatchObject({ required: true, default: 'https://app.lobbystack.com' });
  });

  it('defaults to LobbyStack Cloud', () => {
    expect(resolveBaseUrl({})).toBe('https://app.lobbystack.com');
    expect(resolveBaseUrl({ baseUrl: '  ' })).toBe('https://app.lobbystack.com');
  });

  it('adds https to a bare host and keeps a path prefix', () => {
    expect(resolveBaseUrl({ baseUrl: 'lobbystack.example.org' })).toBe('https://lobbystack.example.org');
    expect(resolveBaseUrl({ baseUrl: 'https://example.org/lobby/' })).toBe('https://example.org/lobby');
  });

  it('rejects plain HTTP except for a local development server', () => {
    expect(() => resolveBaseUrl({ baseUrl: 'http://lobbystack.example.org' })).toThrow(/https/);
    expect(resolveBaseUrl({ baseUrl: 'http://localhost:3000' })).toBe('http://localhost:3000');
    expect(resolveBaseUrl({ baseUrl: 'http://127.0.0.1:3000' })).toBe('http://127.0.0.1:3000');
  });

  it('rejects credentials in the URL and other schemes', () => {
    expect(() => resolveBaseUrl({ baseUrl: 'https://user:pass@example.org' })).toThrow(/username or password/);
    expect(() => resolveBaseUrl({ baseUrl: 'javascript:alert(1)' })).toThrow();
  });
});
