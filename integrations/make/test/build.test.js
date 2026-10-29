'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { build, dashboardOrigin, parseArgs } = require('../scripts/build');

const URL = 'https://demo.alloplace.com';
const EMPTY_MAPPING = { connection: [], webhook: [], module: [], rpc: [], function: [], endpoint: [] };

describe('parseArgs', () => {
  it('reads the brand, the dashboard and the app in Make', () => {
    assert.deepEqual(parseArgs(['--brand', 'alloplace', `--url=${URL}`, '--app-id', 'alloplace-test', '--zone', 'eu1']), { brand: 'alloplace', url: URL, appId: 'alloplace-test', zone: 'eu1' });
    assert.deepEqual(parseArgs(['--brand=alloplace', '--url', URL]), { brand: 'alloplace', url: URL, appId: '', zone: '' });
  });

  it('needs a brand and a dashboard, and an app ID only with its zone', () => {
    assert.throws(() => parseArgs(['--brand', 'alloplace']), /Name the brand and the dashboard/);
    assert.throws(() => parseArgs(['--brand']), /--brand needs a value\./);
    assert.throws(() => parseArgs(['--brand', 'alloplace', '--url', URL, '--deploy']), /Unknown option --deploy\./);
    assert.throws(() => parseArgs(['--__proto__', 'x']), /Unknown option --__proto__\./);
    assert.throws(() => parseArgs(['--brand', 'alloplace', '--url', URL, '--app-id', 'alloplace-test']), /--app-id and --zone together/);
    assert.throws(() => parseArgs(['--brand', 'alloplace', '--url', URL, '--app-id', 'AlloPlace', '--zone', 'eu1']), /--app-id must be the app's ID in Make/);
    assert.throws(() => parseArgs(['--brand', 'alloplace', '--url', URL, '--app-id', 'alloplace-test', '--zone', 'eu1.make.com']), /--zone must be the zone/);
  });

  it('takes only an https dashboard address with nothing after the host', () => {
    assert.equal(dashboardOrigin(`${URL}/`), URL);
    for (const address of ['http://demo.alloplace.com', `${URL}/settings`, `${URL}/?a=1`, 'https://user:pass@demo.alloplace.com', 'demo.alloplace.com']) {
      assert.throws(() => dashboardOrigin(address), /https:\/\/ address with nothing after the host/);
    }
  });
});

describe('build', () => {
  let dir = '';
  let outDir = '';
  const read = (file) => fs.readFileSync(path.join(outDir, file), 'utf8');
  const json = (file) => JSON.parse(read(file));
  const filesIn = (folder) => fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(folder, entry.name)) : [path.join(folder, entry.name)]));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'make-build-'));
    outDir = path.join(dir, 'alloplace');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('fills in the brand\'s name and the dashboard everywhere', () => {
    const result = build({ brand: 'alloplace', url: URL }, { outDir });
    assert.equal(result.appName, 'AlloPlace');
    assert.deepEqual(result.components, { connection: 1, webhook: 6, module: 19, rpc: 5, function: 0, endpoint: 0 });
    for (const file of filesIn(outDir)) {
      const content = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(content, /__[A-Z][A-Z_]*__/, file);
      if (file.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(content), file);
    }
    const makecomapp = json('makecomapp.json');
    assert.equal(makecomapp.components.connection['api-key'].label, 'AlloPlace');
    assert.deepEqual(makecomapp.origins, []);
    const [apiKey, address] = json('connections/api-key/api-key.params.iml.json');
    assert.match(apiKey.help, /\[Connect Make\]\(https:\/\/demo\.alloplace\.com\/integrations\?setup=make\)/);
    assert.deepEqual([address.label, address.default], ['AlloPlace URL', URL]);
    assert.match(makecomapp.components.module.makeApiCall.description, /^Sends a custom API call to AlloPlace\. /);
    assert.match(read('README.md'), /^# AlloPlace for Make\n/);
  });

  it('keeps a name with quotes valid JSON', () => {
    const brands = path.join(dir, 'brands');
    fs.mkdirSync(path.join(brands, 'quoted'), { recursive: true });
    fs.writeFileSync(path.join(brands, 'quoted', 'brand.json'), JSON.stringify({ appName: 'Say "Allo" \\ Place' }));
    build({ brand: 'quoted', url: URL }, { brands, outDir });
    assert.equal(json('makecomapp.json').components.connection['api-key'].label, 'Say "Allo" \\ Place');
  });

  it('adds the app in Make once, and keeps what the editor saved and the token', () => {
    build({ brand: 'alloplace', url: URL, appId: 'alloplace-test', zone: 'eu1' }, { outDir });
    const origin = { label: 'AlloPlace (alloplace-test in eu1)', baseUrl: 'https://eu1.make.com/api', appId: 'alloplace-test', appVersion: 1, idMapping: EMPTY_MAPPING, apikeyFile: '.secrets/apikey' };
    assert.deepEqual(json('makecomapp.json').origins, [origin]);

    // What a deploy leaves behind: the IDs Make gave each component, and the token.
    const deployed = json('makecomapp.json');
    deployed.origins[0].idMapping.connection.push({ local: 'api-key', remote: 'alloplace-test' });
    fs.writeFileSync(path.join(outDir, 'makecomapp.json'), JSON.stringify(deployed));
    fs.mkdirSync(path.join(outDir, '.secrets'));
    fs.writeFileSync(path.join(outDir, '.secrets', 'apikey'), 'token');
    fs.mkdirSync(path.join(outDir, 'modules', 'gone'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'modules', 'gone', 'gone.communication.iml.json'), '{}');

    build({ brand: 'alloplace', url: URL, appId: 'alloplace-test', zone: 'eu1' }, { outDir });
    assert.deepEqual(json('makecomapp.json').origins, deployed.origins);
    assert.equal(read('.secrets/apikey'), 'token');
    assert.equal(fs.existsSync(path.join(outDir, 'modules', 'gone')), false);

    build({ brand: 'alloplace', url: URL, appId: 'alloplace', zone: 'us2' }, { outDir });
    assert.deepEqual(json('makecomapp.json').origins.map(({ appId, baseUrl }) => [appId, baseUrl]), [['alloplace-test', 'https://eu1.make.com/api'], ['alloplace', 'https://us2.make.com/api']]);
  });

  it('needs a brand that exists', () => {
    assert.throws(() => build({ brand: 'nobody', url: URL }, { outDir }), /There is no brands\/nobody\/brand\.json\./);
    assert.throws(() => build({ brand: '../brands', url: URL }, { outDir }), /a folder name under brands/);
    assert.equal(fs.existsSync(outDir), false);
  });
});
