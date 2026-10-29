'use strict';

const nock = require('nock');
const zapier = require('zapier-platform-core');

const App = require('../index');

// Every test must mock its HTTP calls.
nock.disableNetConnect();

// Jest gives each test file its own copy of nock, but they all patch the same
// Node http module. Remove this file's patch when it finishes so the next
// file's nock sees the requests.
/* globals afterAll */
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  nock.restore();
});

// A made-up key in the lsk_ format. It is never valid against a real server.
const TEST_API_KEY = 'lsk_0000test_zapierunittestkeyzapierunittest00';
const BASE = 'https://app.lobbystack.com';

const appTester = zapier.createAppTester(App);

const bundleWith = (extra = {}) => ({
  authData: { apiKey: TEST_API_KEY, ...(extra.authData || {}) },
  inputData: extra.inputData || {},
  meta: extra.meta || {},
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => !['authData', 'inputData', 'meta'].includes(key))),
});

// Nock scope for the v1 API that also checks the bearer header.
const api = (base = BASE) =>
  nock(`${base}/api/v1`, { reqheaders: { authorization: `Bearer ${TEST_API_KEY}` } });

const page = (data, extra = {}) => ({ data, next_cursor: null, has_more: false, ...extra });

const apiError = (code, message, details) => ({ error: { code, message, ...(details ? { details } : {}) } });

// A sample's keys as Zapier names its fields: a nested value is parent__child.
const flatKeys = (object, prefix = '') =>
  Object.entries(object).flatMap(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value) ? flatKeys(value, `${prefix}${key}__`) : [`${prefix}${key}`],
  );

module.exports = { App, BASE, TEST_API_KEY, api, apiError, appTester, bundleWith, flatKeys, nock, page };
