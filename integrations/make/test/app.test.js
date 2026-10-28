'use strict';

// Checks app/ without Make: every file makecomapp.json names exists and is
// valid JSON, component IDs follow Make's rules, labels and descriptions follow
// Make's naming conventions, and each module, webhook and drop-down list is
// wired to the others. packages/shared/src/publicApi/make.test.ts checks the
// API calls, samples and output fields against the API itself.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { codeFiles } = require('../scripts/build');

const APP = path.resolve(__dirname, '..', 'app');
const read = (file) => JSON.parse(fs.readFileSync(path.join(APP, file), 'utf8'));
const makecomapp = read('makecomapp.json');
const { connection: connections, webhook: webhooks, module: modules, rpc: rpcs } = makecomapp.components;
const code = (component, type) => read(component.codeFiles[type]);
const byType = (type) => Object.entries(modules).filter(([, module]) => module.moduleType === type);
const filesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

// The requests in a communication, which is one request or a list of them.
const requests = (communication) => (Array.isArray(communication) ? communication : [communication]).filter((request) => request.url);
// Parameters, with the ones nested under a select's options.
const allParams = (params) => params.flatMap((param) => [param, ...allParams(Array.isArray(param.options) ? param.options.flatMap((option) => option.nested || []) : [])]);

describe('makecomapp.json', () => {
  it('names every file in app/, and each one exists and parses', () => {
    const named = codeFiles(makecomapp);
    assert.equal(new Set(named).size, named.length, 'a file is named twice');
    const onDisk = filesIn(APP).map((file) => path.relative(APP, file).split(path.sep).join('/')).filter((file) => file !== 'makecomapp.json');
    assert.deepEqual([...named].sort(), onDisk.sort());
    for (const file of named.filter((name) => name.endsWith('.json'))) assert.doesNotThrow(() => read(file), file);
  });

  it('names no Make app: the build adds the brand\'s own', () => {
    assert.equal(makecomapp.fileVersion, 1);
    assert.deepEqual(makecomapp.origins, []);
  });

  it('uses component IDs Make accepts', () => {
    for (const id of [...Object.keys(modules), ...Object.keys(rpcs)]) assert.match(id, /^[a-zA-Z][0-9a-zA-Z]{2,47}$/);
    for (const id of [...Object.keys(connections), ...Object.keys(webhooks)]) assert.match(id, /^[a-zA-Z][0-9a-zA-Z-]{1,33}[0-9a-zA-Z]$/);
    assert.deepEqual(makecomapp.components.function, {});
    assert.deepEqual(makecomapp.components.endpoint, {});
  });

  it('uses only the three placeholders the build fills', () => {
    for (const file of filesIn(APP)) {
      for (const [placeholder] of fs.readFileSync(file, 'utf8').matchAll(/__[A-Z][A-Z_]*__/g)) {
        assert.ok(['__APP_NAME__', '__DASHBOARD_URL__', '__HELP_URL__'].includes(placeholder), `${placeholder} in ${file}`);
      }
    }
  });
});

describe('connection', () => {
  const [[id, connection]] = Object.entries(connections);

  it('is one API key that every module, webhook and drop-down list uses', () => {
    assert.deepEqual(Object.keys(connections), ['api-key']);
    assert.equal(connection.connectionType, 'basic');
    for (const [moduleId, module] of Object.entries(modules)) {
      // An instant trigger's connection is its webhook's.
      assert.equal(module.connection, module.moduleType === 'instant_trigger' ? null : id, moduleId);
      assert.equal(module.altConnection, null, moduleId);
    }
    for (const component of [...Object.values(webhooks), ...Object.values(rpcs)]) assert.equal(component.connection, id);
  });

  it('asks for the key and the dashboard, and checks both with GET /me', () => {
    assert.deepEqual(code(connection, 'params').map(({ name, type, required, default: value }) => ({ name, type, required, value })), [
      { name: 'apiKey', type: 'password', required: true, value: undefined },
      { name: 'url', type: 'url', required: true, value: '__DASHBOARD_URL__' },
    ]);
    const communication = code(connection, 'communication');
    assert.equal(communication.url, '{{temp.dashboardUrl}}/api/v1/me');
    assert.equal(communication.headers.authorization, 'Bearer {{parameters.apiKey}}');
    assert.deepEqual(communication.response.data, { dashboardUrl: '{{temp.dashboardUrl}}' });
    assert.deepEqual(communication.log.sanitize, ['request.headers.authorization']);
  });

  it('sends the key only over https, to the host typed, whatever else came with it', () => {
    // The same steps as the IML: replace() takes '/pattern/' and uses what's between the outer slashes.
    const iml = code(connection, 'communication').temp.dashboardUrl;
    const [, scheme, rest] = /^https:\/\/\{\{replace\(replace\(trim\(parameters\.url\), '\/(.*)\/', ''\), '\/(.*)\/', ''\)\}\}$/.exec(iml);
    const origin = (typed) => `https://${typed.trim().replace(new RegExp(scheme), '').replace(new RegExp(rest), '')}`;
    assert.equal(origin(' https://demo.alloplace.com/settings/api-keys?x=1 '), 'https://demo.alloplace.com');
    assert.equal(origin('http://demo.alloplace.com'), 'https://demo.alloplace.com');
    assert.equal(origin('demo.alloplace.com#top'), 'https://demo.alloplace.com');
    assert.equal(origin('https://localhost:3000/'), 'https://localhost:3000');
  });

  it('sends the key on every other request, and keeps it out of logs', () => {
    const base = read(makecomapp.generalCodeFiles.base);
    assert.equal(base.baseUrl, '{{connection.dashboardUrl}}/api/v1');
    assert.equal(base.headers.authorization, 'Bearer {{connection.apiKey}}');
    assert.deepEqual(base.log.sanitize, ['request.headers.authorization']);
  });
});

describe('instant triggers', () => {
  const triggers = byType('instant_trigger');

  it('watch six events, each on a webhook of its own', () => {
    assert.equal(triggers.length, 6);
    assert.deepEqual(triggers.map(([, module]) => module.webhook).sort(), Object.keys(webhooks).sort());
  });

  for (const [moduleId, module] of triggers) {
    it(`${moduleId} subscribes its webhook to one event and unsubscribes it`, () => {
      const webhook = webhooks[module.webhook];
      assert.equal(webhook.webhookType, 'web');
      const attach = code(webhook, 'attach');
      const [event] = attach.body.events;
      assert.deepEqual(attach.body, { url: '{{webhook.url}}', events: [event], description: `Make: ${module.label}` });
      assert.equal(attach.method, 'POST');
      assert.equal(attach.url, '/webhooks');
      assert.deepEqual(attach.response.data, { externalHookId: '{{body.data.id}}' });
      // The new endpoint's signing secret is in the response.
      assert.ok(attach.log.sanitize.includes('response.body.data.secret'));
      assert.deepEqual(code(webhook, 'communication'), { condition: `{{body.type == '${event}'}}`, output: '{{body.data}}' });
      const [list, remove] = code(webhook, 'detach');
      assert.deepEqual([list.method, list.url, remove.method, remove.url], ['GET', '/webhooks', 'DELETE', '/webhooks/{{webhook.externalHookId}}']);
      assert.equal(remove.condition, '{{temp.exists}}');
      assert.deepEqual(code(module, 'communication'), {});
      assert.deepEqual(code(module, 'staticParams'), []);
    });
  }

  it('are the only modules with a webhook', () => {
    for (const [moduleId, module] of Object.entries(modules)) assert.equal('webhook' in module, module.moduleType === 'instant_trigger', moduleId);
  });
});

describe('modules', () => {
  it('follow Make\'s naming conventions', () => {
    for (const [moduleId, module] of Object.entries(modules)) {
      const [first, ...rest] = module.label.split(' ');
      assert.match(first, /^[A-Z][a-z]+$/, moduleId);
      for (const word of rest) assert.ok(!/^[A-Z][a-z]/.test(word) || word === 'API', `${moduleId}: "${word}" in "${module.label}" should be lowercase`);
      assert.match(module.description, /\.$/, moduleId);
      const start = { instant_trigger: /^Triggers when /, search: /^Returns a list of /, universal: /^Sends a custom API call to __APP_NAME__\. /, action: /^(Returns information about a specific|[A-Z][a-z]+s an?) / }[module.moduleType];
      assert.match(module.description, start, moduleId);
    }
    const [[, universal], ...others] = byType('universal');
    assert.equal(others.length, 0, 'an app has one universal module');
    assert.equal(universal.label, 'Make an API call');
  });

  it('mark each action create, read, update or delete', () => {
    for (const [moduleId, module] of byType('action')) {
      assert.ok(['create', 'read', 'update', 'delete'].includes(module.actionCrud), moduleId);
      if (/^Get /.test(module.label)) assert.equal(module.actionCrud, 'read', moduleId);
    }
  });

  it('take a mappable ID wherever they act on one item', () => {
    for (const [moduleId, module] of byType('action')) {
      if (module.actionCrud === 'create') continue;
      const [idParam] = code(module, 'mappableParams');
      assert.match(idParam.name, /_id$/, moduleId);
      assert.match(idParam.label, / ID$/, moduleId);
      assert.deepEqual([idParam.required, idParam.mode], [true, 'edit'], moduleId);
    }
  });

  it('return what the API returns, unchanged', () => {
    for (const [moduleId, module] of [...byType('action'), ...byType('search')]) {
      const { response } = code(module, 'communication');
      if (module.moduleType === 'search') assert.deepEqual([response.iterate, response.output], ['{{body.data}}', '{{item}}'], moduleId);
      else assert.equal(response.output, '{{body.data}}', moduleId);
    }
  });

  it('let searches stop at a limit, 10 by default, and ask the API for no more than they need', () => {
    for (const [moduleId, module] of byType('search')) {
      const limit = code(module, 'mappableParams').find((param) => param.name === 'limit');
      assert.deepEqual({ type: limit.type, default: limit.default, required: limit.required }, { type: 'uinteger', default: 10, required: undefined }, moduleId);
      const communication = code(module, 'communication');
      assert.equal(communication.response.limit, '{{parameters.limit}}', moduleId);
      if (communication.pagination) {
        assert.equal(communication.qs.limit, '{{if(parameters.limit > 0 && parameters.limit < 100, parameters.limit, 100)}}', moduleId);
        assert.deepEqual(communication.pagination, { qs: { cursor: '{{body.next_cursor}}' }, condition: '{{body.has_more}}' }, moduleId);
      }
    }
  });

  it('call the API relative to its base, except Make an API call', () => {
    for (const [moduleId, module] of Object.entries(modules)) {
      if (module.moduleType === 'instant_trigger') continue;
      for (const request of requests(code(module, 'communication'))) {
        if (module.moduleType === 'universal') assert.equal(request.url, '{{connection.dashboardUrl}}/api/{{parameters.url}}');
        else assert.match(request.url, /^\/[a-z]/, moduleId);
      }
    }
  });

  it('fill every drop-down from a list that exists, and use every list', () => {
    const used = new Set();
    for (const [moduleId, module] of Object.entries(modules)) {
      const params = module.codeFiles.mappableParams ? code(module, 'mappableParams') : code(module, 'staticParams');
      for (const param of allParams(params)) {
        if (typeof param.options !== 'string') continue;
        const [, rpc] = param.options.match(/^rpc:\/\/(\w+)$/) || [];
        assert.ok(rpcs[rpc], `${moduleId}.${param.name} uses ${param.options}`);
        used.add(rpc);
      }
    }
    assert.deepEqual([...used].sort(), Object.keys(rpcs).sort());
  });

  it('show sample data with a value for each output field', () => {
    for (const [moduleId, module] of Object.entries(modules)) {
      if (module.moduleType === 'universal') continue;
      const names = code(module, 'interface').map((field) => field.name).sort();
      assert.deepEqual(Object.keys(code(module, 'samples')).sort(), names, moduleId);
    }
  });
});

describe('drop-down lists', () => {
  for (const [rpcId, rpc] of Object.entries(rpcs)) {
    it(`${rpcId} labels each item and uses its ID as the value`, () => {
      const { response } = code(rpc, 'communication');
      assert.equal(response.output.value, '{{item.id}}');
      assert.match(response.output.label, /^\{\{.+\}\}$/);
      // Make wants a limit on lists that can pass 500 items.
      if (code(rpc, 'communication').pagination) assert.ok(response.limit > 0 && response.limit <= 500, rpcId);
    });
  }
});

describe('groups', () => {
  it('list every module once, triggers first and Other last', () => {
    const groups = read(makecomapp.generalCodeFiles.groups);
    const listed = groups.flatMap((group) => group.modules);
    assert.deepEqual([...listed].sort(), Object.keys(modules).sort());
    assert.equal(new Set(listed).size, listed.length);
    assert.deepEqual(groups[0].modules.sort(), byType('instant_trigger').map(([id]) => id).sort());
    assert.deepEqual(groups.at(-1), { label: 'Other', modules: ['makeApiCall'] });
  });
});
