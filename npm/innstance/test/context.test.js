'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { openBrowser } = require('../lib/context');

test('openBrowser hands the URL to the system as one argument, with no shell', () => {
  const url = 'https://innstance.impossibuild.ai/auth/device?code=ABCD-EFGH';
  const cases = [
    { platform: 'darwin', env: {}, want: ['open', [url]] },
    { platform: 'win32', env: {}, want: ['explorer.exe', [url]] },
    { platform: 'linux', env: { DISPLAY: ':0' }, want: ['xdg-open', [url]] },
    { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, want: ['xdg-open', [url]] },
    { platform: 'linux', env: {}, want: null }, // headless: print the link only
    { platform: 'darwin', env: {}, url: 'file:///etc/passwd', want: null },
    { platform: 'win32', env: {}, url: 'not a url', want: null },
  ];
  for (const c of cases) {
    const calls = [];
    const fakeSpawn = (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.shell, undefined, 'never through a shell');
      return { on() {}, unref() {} };
    };
    const opened = openBrowser(c.url || url, c.platform, c.env, fakeSpawn);
    assert.equal(opened, c.want !== null, `${c.platform} ${c.url || ''}`);
    assert.deepEqual(calls, c.want ? [c.want] : [], `${c.platform} ${c.url || ''}`);
  }
});
