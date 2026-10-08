// Browsers keep /assets/landing.js, landing.css, guide.css and fonts.css for 10 minutes (GitHub Pages
// sets that), so a visitor can run an old script against a new page. Each page therefore
// links them as file?v=<hash of the file>: when a file changes, its address changes and
// the old copy is never used. Run `npm run stamp` after editing one of them;
// tests/assets-version.test.js fails if a page is left pointing at an old version.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const STAMPED = ['assets/landing.js', 'assets/landing.css', 'assets/guide.css', 'assets/fonts.css'];
const PAGE_DIRS = ['guia', path.join('en', 'guide')];

// Line endings are normalised so the hash is the same on Windows and Linux checkouts.
function version(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}
function pages() {
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.html') ? [path.join(dir, e.name)] : []);
  return ['index.html', path.join('en', 'index.html'), ...PAGE_DIRS.flatMap(walk)];
}
/** The page's HTML with every stamped file linked at its current version. */
function stamp(html) {
  for (const file of STAMPED) {
    const ref = '/' + file;
    html = html.replace(new RegExp(`((?:src|href)=")${ref.replace(/[.]/g, '\\.')}(?:\\?v=[0-9a-f]+)?(")`, 'g'), `$1${ref}?v=${version(file)}$2`);
  }
  return html;
}
module.exports = { STAMPED, pages, stamp, version, root };

if (require.main === module) {
  let changed = 0;
  for (const page of pages()) {
    const file = path.join(root, page);
    const before = fs.readFileSync(file, 'utf8');
    const after = stamp(before);
    if (after !== before) { fs.writeFileSync(file, after); changed++; }
  }
  console.log(`${changed} page(s) updated`);
}
