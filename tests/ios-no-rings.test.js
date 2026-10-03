// App Review rejected the iOS app (guideline 5.2.5) because concentric progress rings
// resembled Apple's Activity rings. The iOS app must draw progress without rings; Android
// and the web keep them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.env.VL_INDEX_HTML || path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

function fnSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} not found`);
  const end = html.indexOf('\nfunction ', start + 1);
  return html.slice(start, end);
}

function load(platform) {
  const ctx = { window: platform ? { Capacitor: { getPlatform: () => platform } } : {}, Math };
  vm.runInNewContext(['ringFreeUI', 'barPct', 'goalBarsHTML', 'dayBarsHTML', 'dialSVG'].map(fnSource).join('\n'), ctx);
  return ctx;
}

test('only the iOS app switches to the ring-free design', () => {
  assert.equal(load('ios').ringFreeUI(), true);
  assert.equal(load('android').ringFreeUI(), false);
  assert.equal(load(null).ringFreeUI(), false);
});

test('the ring-free progress drawings contain no circles or arcs', () => {
  const c = load('ios');
  const out = c.goalBarsHTML([{ label: 'Comida', value: '1 / 2', pct: 0.5, color: 'red' }], true)
    + c.dayBarsHTML(0.2, 0.5, 1.4, true);
  assert.doesNotMatch(out, /<circle|<path|stroke-dash/);
  assert.match(out, /data-target-width="50%"/);
  assert.match(out, /data-target-height="100%"/, 'a day over its goal is capped at a full bar');
});

test('every ring in the Hoy screen sits in the non-iOS branch', () => {
  const iosBranches = [...html.matchAll(/\$\{ringFree \? `([\s\S]*?)` : `/g)].map((m) => m[1]);
  assert.equal(iosBranches.length, 2, 'expected the vitality score and the food/water/exercise card');
  for (const b of iosBranches) {
    assert.doesNotMatch(b, /<circle|dialSVG\(/);
  }
  const weekly = fnSource('weeklyGoalsCard');
  assert.match(weekly, /ringFreeUI\(\) \? dayBarsHTML\([^)]*\) : dialSVG\(/);
  const callers = html.split('dialSVG(').length - 1;
  assert.equal(callers, 3, 'dialSVG is defined once and called from the two non-iOS branches');
});
