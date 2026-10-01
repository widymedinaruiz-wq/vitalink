// Android and iOS ship from the same commit under the same user-facing version, so a
// user (or a feedback report) saying "1.25" means the same code on both stores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('Android versionName and iOS MARKETING_VERSION are the same', () => {
  const android = read('android', 'app', 'build.gradle').match(/versionName\s+"([^"]+)"/);
  const ios = [...read('ios', 'App', 'App.xcodeproj', 'project.pbxproj').matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
  assert.ok(android, 'versionName not found in android/app/build.gradle');
  assert.ok(ios.length > 0, 'MARKETING_VERSION not found in the Xcode project');
  assert.deepEqual([...new Set(ios)], [android[1]], 'Android and iOS versions have drifted apart');
});
