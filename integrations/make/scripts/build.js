'use strict';

// Builds this Make app for one brand and dashboard, ready for Make's Apps
// Editor for VS Code to deploy:
//
//   npm run build -- --brand alloplace --url https://demo.alloplace.com --app-id <app ID> --zone eu1
//
// app/ holds the app in the editor's local format, with three placeholders:
// __APP_NAME__ (the name in the repository's brands/<id>/brand.json),
// __DASHBOARD_URL__ (--url, the address a new connection starts with) and
// __HELP_URL__ (that dashboard's Make dialog on its Integrations page, which
// the API key field's help links to). The build writes the app with those
// filled in to brands/<brand>/ in this folder. A connection keeps the address
// it was made with, so building and deploying with another --url changes only
// new connections.
//
// --app-id and --zone name the brand's app in Make, which "Deploy to Make"
// uploads to. A deploy records the ID Make gave each component in
// brands/<brand>/makecomapp.json, the only file there that git keeps, and the
// next deploy needs them to update those components instead of adding new
// ones. So a later build keeps the Make apps that file already names, with
// their IDs, and the .secrets folder that holds the Make API token.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
const BRANDS = path.resolve(ROOT, '..', '..', 'brands');
const BRAND_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// Make's rule for an app's ID, and a zone such as eu1 in eu1.make.com.
const APP_ID = /^[a-z][0-9a-z-]{1,28}[0-9a-z]$/;
const ZONE = /^[a-z]{2}[0-9]{1,2}$/;
const PLACEHOLDER = /__(APP_NAME|DASHBOARD_URL|HELP_URL)__/g;
// What a build writes in brands/<brand>/. Anything else there, such as .secrets, stays.
const BUILT = ['makecomapp.json', 'README.md', 'general', 'connections', 'webhooks', 'modules', 'rpcs'];
const OPTIONS = { '--brand': 'brand', '--url': 'url', '--app-id': 'appId', '--zone': 'zone' };

const parseArgs = (argv) => {
  const options = { brand: '', url: '', appId: '', zone: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!Object.hasOwn(OPTIONS, flag)) throw new Error(`Unknown option ${arg}. Use --brand <id> --url <dashboard address> [--app-id <app ID> --zone <zone>].`);
    const value = inline !== undefined ? inline : argv[(index += 1)];
    if (!value) throw new Error(`${flag} needs a value.`);
    options[OPTIONS[flag]] = value;
  }
  if (!options.brand || !options.url) throw new Error('Name the brand and the dashboard, for example: npm run build -- --brand alloplace --url https://demo.alloplace.com');
  if (Boolean(options.appId) !== Boolean(options.zone)) throw new Error('Give --app-id and --zone together: the ID Make shows for the app, and the zone at the start of Make\'s address, such as eu1 for eu1.make.com.');
  if (options.appId && !APP_ID.test(options.appId)) throw new Error(`--app-id must be the app's ID in Make: 3 to 30 lowercase letters, digits and dashes, starting with a letter, not "${options.appId}".`);
  if (options.zone && !ZONE.test(options.zone)) throw new Error(`--zone must be the zone at the start of Make's address, such as eu1 or us2, not "${options.zone}".`);
  return options;
};

/** The brand's name from brands/<id>/brand.json. */
const brandName = (id, brands = BRANDS) => {
  if (!BRAND_ID.test(id)) throw new Error(`--brand must be a folder name under brands/, such as alloplace, not "${id}".`);
  const file = path.join(brands, id, 'brand.json');
  if (!fs.existsSync(file)) throw new Error(`There is no brands/${id}/brand.json.`);
  const { appName } = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof appName !== 'string' || !appName.trim()) throw new Error(`brands/${id}/brand.json has no appName.`);
  return appName.trim();
};

/** The dashboard's origin: an https:// address with nothing after the host. */
const dashboardOrigin = (value) => {
  let url = null;
  try {
    url = new URL(value);
  } catch (error) {
    url = null;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`--url must be the dashboard's https:// address with nothing after the host, such as https://demo.alloplace.com, not "${value}".`);
  }
  return url.origin;
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The value with each placeholder in its strings replaced. */
const fill = (value, values) => {
  if (typeof value === 'string') return value.replace(PLACEHOLDER, (match, key) => values[key]);
  if (Array.isArray(value)) return value.map((item) => fill(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, values)]));
  return value;
};

/** Every file makecomapp.json names, relative to its folder. */
const codeFiles = (makecomapp) => [
  ...Object.values(makecomapp.generalCodeFiles),
  ...Object.values(makecomapp.components).flatMap((components) => Object.values(components).flatMap((component) => Object.values(component.codeFiles))),
].filter(Boolean);

/** makecomapp.json's entry for the brand's app in Make, before the editor has deployed anything to it. */
const makeOrigin = ({ appName, appId, zone }) => ({
  label: `${appName} (${appId} in ${zone})`,
  baseUrl: `https://${zone}.make.com/api`,
  appId,
  appVersion: 1,
  idMapping: { connection: [], webhook: [], module: [], rpc: [], function: [], endpoint: [] },
  apikeyFile: '.secrets/apikey',
});

const build = ({ brand, url, appId, zone }, { app = APP, brands = BRANDS, outDir = path.join(ROOT, 'brands', brand) } = {}) => {
  const appName = brandName(brand, brands);
  const origin = dashboardOrigin(url);
  const values = {
    APP_NAME: appName,
    DASHBOARD_URL: origin,
    HELP_URL: `${origin}/integrations?setup=make`,
  };
  const template = readJson(path.join(app, 'makecomapp.json'));
  const makecomappFile = path.join(outDir, 'makecomapp.json');
  const origins = fs.existsSync(makecomappFile) ? readJson(makecomappFile).origins || [] : [];
  if (appId && !origins.some((item) => item.appId === appId && item.baseUrl === `https://${zone}.make.com/api`)) origins.push(makeOrigin({ appName, appId, zone }));

  for (const name of BUILT) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  for (const file of codeFiles(template)) {
    const target = path.join(outDir, file);
    const source = path.join(app, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.endsWith('.json') ? `${JSON.stringify(fill(readJson(source), values), null, 2)}\n` : fill(fs.readFileSync(source, 'utf8'), values));
  }
  // The editor writes makecomapp.json with four spaces, so a deploy changes only what it adds.
  fs.writeFileSync(makecomappFile, `${JSON.stringify({ ...fill(template, values), origins }, null, 4)}\n`);
  return { appName, values, outDir, origins, components: Object.fromEntries(Object.entries(template.components).map(([type, components]) => [type, Object.keys(components).length])) };
};

const main = (argv) => {
  const result = build(parseArgs(argv));
  const { module: modules, webhook: webhooks, rpc: rpcs } = result.components;
  console.log(`${result.appName} for Make, with new connections to ${result.values.DASHBOARD_URL}: ${modules} modules, ${webhooks} webhooks and ${rpcs} drop-down lists in ${path.relative(process.cwd(), result.outDir) || '.'}`);
  if (!result.origins.length) console.log('It names no app in Make yet. Create the app there, then build again with --app-id and --zone.');
  for (const origin of result.origins) console.log(`  deploys to ${origin.appId} at ${origin.baseUrl}`);
  console.log('In VS Code with Make Apps Editor, right-click its makecomapp.json and choose Deploy to Make. Then commit that file: it holds the IDs Make gave each component.');
  return 0;
};

module.exports = { build, codeFiles, dashboardOrigin, parseArgs };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
