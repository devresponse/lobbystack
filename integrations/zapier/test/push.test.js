/* globals describe, it, expect */
'use strict';

const { dashboardOrigin, parseArgs, pushPlan } = require('../scripts/push');

describe('push for a brand', () => {
  it('reads the name from the brand file and points new connections and the help link at the dashboard', () => {
    const plan = pushPlan(parseArgs(['--brand', 'alloplace', '--url=https://demo.alloplace.com/']));
    expect(plan.appName).toBe('AlloPlace');
    expect(plan.values).toEqual({
      ZAPIER_APP_NAME: 'AlloPlace',
      ZAPIER_DEFAULT_URL: 'https://demo.alloplace.com',
      ZAPIER_HELP_URL: 'https://demo.alloplace.com/integrations?setup=zapier',
    });
    expect(plan.commands).toEqual([
      ['push'],
      ['env:set', plan.version, 'ZAPIER_APP_NAME=AlloPlace', 'ZAPIER_DEFAULT_URL=https://demo.alloplace.com', 'ZAPIER_HELP_URL=https://demo.alloplace.com/integrations?setup=zapier'],
    ]);
  });

  it('needs a brand that exists and a dashboard address', () => {
    expect(() => parseArgs(['--brand', 'alloplace'])).toThrow(/Name the brand and the dashboard/);
    expect(() => parseArgs(['--brand'])).toThrow('--brand needs a value.');
    expect(() => parseArgs(['--brand', 'alloplace', '--url', 'https://demo.alloplace.com', '--name', 'Other'])).toThrow('Unknown option --name.');
    expect(() => pushPlan({ brand: 'nobody', url: 'https://demo.alloplace.com' })).toThrow('There is no brands/nobody/brand.json.');
    expect(() => pushPlan({ brand: '../brands', url: 'https://demo.alloplace.com' })).toThrow(/a folder name under brands/);
  });

  it('takes only an https dashboard address with nothing after the host', () => {
    expect(dashboardOrigin('https://demo.alloplace.com')).toBe('https://demo.alloplace.com');
    expect(dashboardOrigin('https://localhost:3000')).toBe('https://localhost:3000');
    for (const address of ['http://demo.alloplace.com', 'https://demo.alloplace.com/settings', 'https://demo.alloplace.com/?a=1', 'https://user:pass@demo.alloplace.com', 'demo.alloplace.com']) {
      expect(() => dashboardOrigin(address)).toThrow(/https:\/\/ address with nothing after the host/);
    }
  });
});
