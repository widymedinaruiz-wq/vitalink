// Optional distance on exercise entries: typed by hand, or taken from a workout
// imported from Apple Health (meters). Bad input must be rejected, not stored.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.env.VL_INDEX_HTML || path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

function load() {
  const begin = html.indexOf('/* ================= exercise distance (begin) ================= */');
  const end = html.indexOf('/* ================= exercise distance (end) ================= */');
  assert.ok(begin !== -1 && end > begin, 'exercise distance block markers not found');
  return vm.runInNewContext(`${html.slice(begin, end)}\n({distanceKmFromMeters, parseDistanceKm, formatDistanceKm})`, { Number, String, Math, isFinite });
}

test('imported workout distance: meters to km, nothing for missing or zero', () => {
  const d = load();
  assert.equal(d.distanceKmFromMeters(5234.6), 5.23);
  assert.equal(d.distanceKmFromMeters('1000'), 1);
  for (const v of [undefined, null, 0, -5, 'abc', NaN]) assert.equal(d.distanceKmFromMeters(v), null);
});

test('typed distance: empty is fine, comma or dot decimals, rounded to 2 decimals', () => {
  const d = load();
  assert.equal(d.parseDistanceKm(''), null);
  assert.equal(d.parseDistanceKm('  '), null);
  assert.equal(d.parseDistanceKm('0'), null);
  assert.equal(d.parseDistanceKm('5.2'), 5.2);
  assert.equal(d.parseDistanceKm('5,2'), 5.2);
  assert.equal(d.parseDistanceKm('10.456'), 10.46);
});

test('typed distance: impossible values are rejected, not stored', () => {
  const d = load();
  for (const v of ['-1', '1000.5', 'abc', '5km']) assert.ok(Number.isNaN(d.parseDistanceKm(v)), v);
});

test('distance is shown with the language\'s decimal separator', () => {
  const d = load();
  assert.equal(d.formatDistanceKm(5.25, 'es'), '5,25 km');
  assert.equal(d.formatDistanceKm(5.25, 'en'), '5.25 km');
  assert.equal(d.formatDistanceKm(42.195, 'en'), '42.2 km');
  assert.equal(d.formatDistanceKm(null, 'es'), '');
  assert.equal(d.formatDistanceKm(0, 'es'), '');
});
