// The landing page at / (Spanish) and /en/ (English), and the script that sends
// existing web users and invite links straight to the app at /app/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const es = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const en = fs.readFileSync(path.join(root, 'en', 'index.html'), 'utf8');

function forwardScript(html) {
  const m = html.match(/<script>\s*(\(function\(\)\{try\{[\s\S]*?)<\/script>/);
  assert.ok(m, 'forwarding script not found in <head>');
  return m[1];
}
function visit(html, { search = '', keys = [] } = {}) {
  let target = null;
  vm.runInNewContext(forwardScript(html), {
    location: { search, replace: (u) => { target = u; } },
    localStorage: { length: keys.length, key: (i) => keys[i] },
  });
  return target;
}

for (const [name, html] of [['/', es], ['/en/', en]]) {
  test(`${name}: a first-time visitor stays on the landing page`, () => {
    assert.equal(visit(html), null);
    assert.equal(visit(html, { keys: ['cfg:remote', 'hc:meta'] }), null);
  });
  test(`${name}: someone who already uses the web app goes straight to it`, () => {
    assert.equal(visit(html, { keys: ['vl:lang', 'vl:day:2026-09-30'] }), '/app/');
  });
  test(`${name}: an invite link keeps its code on the way to the app`, () => {
    assert.equal(visit(html, { search: '?ref=ABC123' }), '/app/?ref=ABC123');
  });
  test(`${name}: ?landing=1 shows the page even to an existing user`, () => {
    assert.equal(visit(html, { search: '?landing=1', keys: ['vl:day:2026-09-30'] }), null);
  });
}

test('both languages have the same structure', () => {
  const shape = (html) => (html.slice(html.indexOf('<body>')).match(/<[a-z0-9]+(?: class="[^"]*")?/g) || []).join(' ');
  assert.equal(shape(en), shape(es), 'the Spanish and English pages have drifted apart');
});

test('every local file the pages reference exists', () => {
  for (const html of [es, en]) {
    for (const [, ref] of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(root, ref)), `missing ${ref}`);
    }
  }
  assert.ok(fs.existsSync(path.join(root, 'app', 'index.html')), 'the app is not at /app/');
});
