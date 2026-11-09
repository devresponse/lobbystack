'use strict';

const { apiUrl, listPage } = require('../lib/client');
const { APP_NAME } = require('../lib/brand');
const { verifyDelivery } = require('../lib/signature');
const { outputFields, samples } = require('../lib/resources');

const SAMPLE_PAGE_SIZE = 25;

// Builds a REST hook trigger. Subscribing creates a v1 webhook endpoint for one
// event; the payload's `data` is the same object the list endpoint returns, so
// performList gives Zapier real sample data in the same shape.
// receptionist names what the trigger lists (calls, messages) when its events say which
// receptionist answered: the trigger then takes a Receptionist to keep only that one's.
const createHookTrigger = ({ key, noun, label, description, event, resource, listPath, listParams = {}, filter, receptionist }) => {
  const chosenReceptionist = (bundle) => {
    const value = receptionist && bundle.inputData ? bundle.inputData.receptionist_id : undefined;
    return value ? String(value).trim().toLowerCase() : '';
  };
  const performSubscribe = async (z, bundle) => {
    const response = await z.request({
      url: apiUrl(bundle, '/webhooks'),
      method: 'POST',
      body: {
        url: bundle.targetUrl,
        events: [event],
        description: `Zapier: ${label}`,
      },
    });
    // Zapier stores subscribeData with the Zap, so perform can check each
    // delivery's signature against this endpoint's secret.
    return { id: response.data.data.id, secret: response.data.data.secret };
  };

  const performUnsubscribe = async (z, bundle) => {
    const id = bundle.subscribeData && bundle.subscribeData.id;
    if (!id) return {};
    const response = await z.request({
      url: apiUrl(bundle, `/webhooks/${encodeURIComponent(id)}`),
      method: 'DELETE',
      skipThrowForStatus: true,
    });
    // The endpoint may already be gone if someone deleted it in the dashboard.
    if (response.status === 404) return { id, deleted: true };
    if (response.status >= 400) response.throwForStatus();
    return response.data.data;
  };

  const perform = async (z, bundle) => {
    const secret = bundle.subscribeData && bundle.subscribeData.secret;
    let payload = bundle.cleanedRequest || {};
    // Subscriptions made before signatures were checked have no secret.
    // LOBBYSTACK_SKIP_WEBHOOK_SIGNATURE=1 (zapier-platform env:set) turns the
    // check off without a new version if Zapier ever changes rawRequest.
    if (secret && process.env.LOBBYSTACK_SKIP_WEBHOOK_SIGNATURE !== '1') {
      const result = verifyDelivery(secret, bundle.rawRequest);
      if (!result.ok) {
        throw new z.errors.Error(`Ignored a webhook delivery that ${APP_NAME} did not sign (${result.reason}).`, 'invalid_signature', 401);
      }
      // Read the event from the exact bytes that were verified.
      payload = JSON.parse(bundle.rawRequest.content);
    }
    // Ignore test pings and anything that is not the subscribed event.
    if (!payload || payload.type !== event || !payload.data || typeof payload.data !== 'object') return [];
    const only = chosenReceptionist(bundle);
    if (only && String(payload.data.receptionist_id || '').toLowerCase() !== only) return [];
    return [payload.data];
  };

  const performList = async (z, bundle) => {
    const only = chosenReceptionist(bundle);
    const body = await listPage(z, bundle, listPath, { limit: SAMPLE_PAGE_SIZE, ...listParams, ...(only ? { receptionist_id: only } : {}) });
    const items = Array.isArray(body.data) ? body.data : [];
    return filter ? items.filter(filter) : items;
  };

  return {
    key,
    noun,
    display: { label, description },
    operation: {
      type: 'hook',
      ...(receptionist
        ? {
            inputFields: [
              {
                key: 'receptionist_id',
                label: 'Receptionist',
                dynamic: 'receptionist_list.id.name',
                required: false,
                helpText: `Only the ${receptionist} this receptionist answered. Leave it empty for every receptionist's.`,
              },
            ],
          }
        : {}),
      performSubscribe,
      performUnsubscribe,
      perform,
      performList,
      sample: samples[resource],
      outputFields: outputFields[resource],
    },
  };
};

module.exports = { createHookTrigger };
