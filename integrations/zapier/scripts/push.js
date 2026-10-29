'use strict';

// Uploads this integration to Zapier under one brand's name and dashboard
// address, then sets the same values on the uploaded version:
//
//   npm run push -- --brand alloplace --url https://demo.alloplace.com
//
// The name comes from brands/<id>/brand.json. --url is the dashboard address a
// new connection starts with. The API key field's help link goes to that
// dashboard's Integrations page, whose Zapier card explains how to connect.
// `zapier-platform push` reads the three values into field labels, help text
// and the address field's default; `zapier-platform env:set` gives them to the
// running integration, for its error messages and for a connection saved
// without an address. It uploads to the integration .zapierapprc names, which
// `npm run zapier -- register "<name>"` writes.
//
// Add --dry-run to print what it would do without running anything.

const fs = require('fs');
const path = require('path');

const { runZapier } = require('./zapier');

const ROOT = path.resolve(__dirname, '..');
const BRANDS = path.resolve(ROOT, '..', '..', 'brands');
const BRAND_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const parseArgs = (argv) => {
  const options = { brand: '', url: '', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag === '--dry-run' && inline === undefined) options.dryRun = true;
    else if (flag === '--brand' || flag === '--url') {
      const value = inline !== undefined ? inline : argv[(index += 1)];
      if (!value) throw new Error(`${flag} needs a value.`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option ${arg}. Use --brand <id> --url <dashboard address> [--dry-run].`);
  }
  if (!options.brand || !options.url) throw new Error('Name the brand and the dashboard, for example: npm run push -- --brand alloplace --url https://demo.alloplace.com');
  return options;
};

/** The brand's name from brands/<id>/brand.json. */
const brandName = (id) => {
  if (!BRAND_ID.test(id)) throw new Error(`--brand must be a folder name under brands/, such as alloplace, not "${id}".`);
  const file = path.join(BRANDS, id, 'brand.json');
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

/** The integration .zapierapprc links this folder to. */
const linkedApp = () => {
  const file = path.join(ROOT, '.zapierapprc');
  if (!fs.existsSync(file)) return null;
  const { id } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return id || null;
};

const pushPlan = ({ brand, url }) => {
  const appName = brandName(brand);
  const origin = dashboardOrigin(url);
  const values = {
    ZAPIER_APP_NAME: appName,
    ZAPIER_DEFAULT_URL: origin,
    ZAPIER_HELP_URL: `${origin}/integrations?setup=zapier`,
  };
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return {
    appName,
    version,
    values,
    commands: [['push'], ['env:set', version, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)]],
  };
};

const main = (argv) => {
  const options = parseArgs(argv);
  const plan = pushPlan(options);
  const appId = linkedApp();
  console.log(`${plan.appName} ${plan.version} for Zapier, to integration ${appId || '(none yet)'}:`);
  for (const [key, value] of Object.entries(plan.values)) console.log(`  ${key}=${value}`);
  if (options.dryRun) {
    for (const command of plan.commands) console.log(`would run: zapier-platform ${command.join(' ')}`);
    return 0;
  }
  if (!appId) throw new Error(`This folder isn't linked to a Zapier integration yet. Register it first: npm run zapier -- register "${plan.appName}"`);
  const env = { ...process.env, ...plan.values };
  for (const command of plan.commands) {
    const status = runZapier(command, env);
    if (status !== 0) return status;
  }
  return 0;
};

module.exports = { dashboardOrigin, parseArgs, pushPlan };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
