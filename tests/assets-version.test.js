// Pages link landing.js, landing.css and guide.css with a version tag taken from the
// file's content (see tools/stamp-assets.js), so a browser never pairs a new page with a
// cached old script. This fails when one of those files changed and `npm run stamp` was
// not run afterwards.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { STAMPED, pages, stamp, version, root } = require('../tools/stamp-assets.js');

test('every page links the shared script and styles at their current version', () => {
  for (const page of pages()) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.equal(html, stamp(html), `${page} points at an old version: run "npm run stamp"`);
  }
});

test('the landing pages actually carry the version tags', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const file of ['assets/landing.js', 'assets/landing.css']) {
    assert.ok(html.includes(`"/${file}?v=${version(file)}"`), `index.html does not link /${file} with its version`);
  }
  assert.ok(STAMPED.includes('assets/guide.css'));
});
