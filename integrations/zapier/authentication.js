'use strict';

const { APP_NAME, DEFAULT_BASE_URL, DOCS_URL } = require('./lib/brand');
const { apiUrl } = require('./lib/client');

// GET /me works for any valid key, whatever its scopes, so a key made only
// for one action can still connect.
const test = async (z, bundle) => {
  const response = await z.request({ url: apiUrl(bundle, '/me'), method: 'GET' });
  const me = response.data.data;
  // A platform key (lsp_) acts on many businesses and has none of its own here.
  if (!me.business) {
    throw new z.errors.Error(`This is a ${APP_NAME} platform key. Zapier needs an API key from Settings > API keys, which starts with lsk_.`, 'platform_key', 400);
  }
  return {
    business_id: me.business.id,
    business_name: me.business.name,
    api_key_id: me.api_key.id,
    api_key_name: me.api_key.name,
    api_key_prefix: me.api_key.prefix,
    scopes: me.api_key.scopes,
  };
};

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      helpText:
        `In ${APP_NAME}, go to **Settings > API keys** and create a key for Zapier. It starts with \`lsk_\`. Any key connects; give it the scopes for the steps you plan to use. Triggers need \`webhooks:manage\` plus the read scope for their data, such as \`calls:read\` for new calls. [Learn more](${DOCS_URL}/api/authentication).`,
    },
    {
      // Required, so every connection stores its address and never depends on
      // the running integration's ZAPIER_DEFAULT_URL to know where its key goes.
      key: 'baseUrl',
      label: `${APP_NAME} URL`,
      type: 'string',
      required: true,
      default: DEFAULT_BASE_URL,
      helpText:
        `Leave as is unless you sign in to ${APP_NAME} at another address. If you host it yourself, enter the address you use to sign in, for example \`https://app.yourcompany.com\`.`,
    },
  ],
  test,
  connectionLabel: '{{business_name}}',
};
