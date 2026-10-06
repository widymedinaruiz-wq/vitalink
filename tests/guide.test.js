// The user guide at /guia/ (Spanish) and /en/guide/ (English): every page exists in both
// languages with the same structure, and nothing it points at is missing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const PAGES = [
  ['/guia/', '/en/guide/'],
  ['/guia/primeros-pasos/', '/en/guide/getting-started/'],
  ['/guia/registrar-comidas/', '/en/guide/logging-meals/'],
  ['/guia/ejercicio/', '/en/guide/exercise/'],
  ['/guia/registros-y-progreso/', '/en/guide/records-and-progress/'],
  ['/guia/salud-conectada/', '/en/guide/connected-health/'],
  ['/guia/personalizar/', '/en/guide/personalize/'],
  ['/guia/vitalinks-plus/', '/en/guide/vitalinks-plus/'],
  ['/guia/cuenta-y-datos/', '/en/guide/account-and-data/'],
];
const html = (url) => read(...url.split('/').filter(Boolean), 'index.html');

for (const [esUrl, enUrl] of PAGES) {
  test(`${esUrl} and ${enUrl} have the same structure`, () => {
    const shape = (h) => (h.slice(h.indexOf('<body>')).match(/<[a-z0-9]+(?: class="[^"]*")?/g) || []).join(' ');
    assert.equal(shape(html(enUrl)), shape(html(esUrl)), 'the Spanish and English pages have drifted apart');
  });

  test(`${esUrl} and ${enUrl} point at each other`, () => {
    for (const [url, lang] of [[esUrl, 'es'], [enUrl, 'en']]) {
      const h = html(url);
      assert.match(h, new RegExp(`<html lang="${lang}"`));
      assert.ok(h.includes(`<link rel="canonical" href="https://vitalinks.eu${url}">`), `${url}: wrong canonical`);
      assert.ok(h.includes(`hreflang="es" href="https://vitalinks.eu${esUrl}"`), `${url}: missing Spanish alternate`);
      assert.ok(h.includes(`hreflang="en" href="https://vitalinks.eu${enUrl}"`), `${url}: missing English alternate`);
    }
  });
}

test('every file and page the guide links to exists', () => {
  for (const url of PAGES.flat()) {
    const h = html(url);
    for (const [, ref] of h.matchAll(/(?:src|href)="(\/[^"#?]*)[^"]*"/g)) {
      const file = ref.endsWith('/') ? path.join(root, ref, 'index.html') : path.join(root, ref);
      assert.ok(fs.existsSync(file), `${url} links to ${ref}, which does not exist`);
    }
    // In-page links (the table of contents) must land on a real section.
    for (const [, id] of h.matchAll(/href="#([^"]+)"/g)) {
      assert.ok(h.includes(`id="${id}"`), `${url} links to #${id}, which is not on the page`);
    }
  }
});

test('screenshots match the language of the page', () => {
  for (const [esUrl, enUrl] of PAGES) {
    assert.doesNotMatch(html(esUrl), /\/assets\/guide-en-/);
    assert.doesNotMatch(html(enUrl), /\/assets\/guide-es-/);
  }
});

test('guide pages are never counted as landing-page views', () => {
  for (const url of PAGES.flat()) {
    const h = html(url);
    assert.doesNotMatch(h, /data-track=/, `${url} has a counted button`);
    if (h.includes('/assets/landing.js')) assert.match(h, /<html lang="[a-z]+" data-uncounted>/, `${url} loads the counter without opting out`);
  }
});

test('the landing pages, the sitemap and the app all lead to the guide', () => {
  assert.ok(read('index.html').includes('href="/guia/"'));
  assert.ok(read('en', 'index.html').includes('href="/en/guide/"'));
  const sitemap = read('sitemap.xml');
  for (const url of PAGES.flat()) assert.ok(sitemap.includes(`<loc>https://vitalinks.eu${url}</loc>`), `${url} is not in the sitemap`);
  const app = read('app', 'index.html');
  assert.ok(app.includes("set_guide_url:'https://vitalinks.eu/guia/'"));
  assert.ok(app.includes("set_guide_url:'https://vitalinks.eu/en/guide/'"));
});
