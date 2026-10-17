// Rotating illustration protagonists: one series per app launch, every series shown
// evenly, and series 1 keeps the original file names.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.env.VL_INDEX_HTML || path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

function load() {
  const begin = html.indexOf('/* ilus series (begin) */');
  const end = html.indexOf('/* ilus series (end) */');
  assert.ok(begin !== -1 && end > begin, 'ilus series block markers not found');
  const ctx = {};
  vm.runInNewContext(html.slice(begin, end) + ';this.nextIlusSerie=nextIlusSerie;this.ilusSrc=ilusSrc;this.ILUS_SERIES_COUNT=ILUS_SERIES_COUNT;', ctx);
  return ctx;
}

test('rotates through every series and wraps around', () => {
  const { nextIlusSerie } = load();
  const seen = [];
  let last = null;
  for (let i = 0; i < 7; i++) { last = nextIlusSerie(last, 3); seen.push(last); }
  assert.deepEqual(seen, [1, 2, 3, 1, 2, 3, 1]);
});

test('first launch, junk or out-of-range stored values start at series 1', () => {
  const { nextIlusSerie } = load();
  for (const v of [null, '', 'abc', '0', '-2', '1.5', '9']) assert.equal(nextIlusSerie(v, 3), 1, String(v));
});

test('with a single series it always stays on 1', () => {
  const { nextIlusSerie } = load();
  assert.equal(nextIlusSerie('1', 1), 1);
  assert.equal(nextIlusSerie(null, 1), 1);
});

test('series 1 keeps the original names; later series add a suffix', () => {
  const { ilusSrc } = load();
  assert.equal(ilusSrc('hoy-vacio', 1), 'img/ilus-hoy-vacio.webp');
  assert.equal(ilusSrc('bienvenida', 3), 'img/ilus-bienvenida-3.webp');
});

test('every series the app can pick has all four images on disk', () => {
  const { ilusSrc, ILUS_SERIES_COUNT } = load();
  for (let n = 1; n <= ILUS_SERIES_COUNT; n++) {
    for (const scene of ['bienvenida', 'hoy-vacio', 'comidas-vacio', 'ejercicio-vacio']) {
      assert.ok(fs.existsSync(path.join(__dirname, '..', 'app', ilusSrc(scene, n))), ilusSrc(scene, n));
    }
  }
});
