// Today's vitality score. A real tester logged only water and saw 100: the score must
// reflect how much of a healthy day has actually been logged, not just how well the
// few logged areas went.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(process.env.VL_INDEX_HTML || path.join(__dirname, '..', 'app', 'index.html'), 'utf8');

function load() {
  const begin = html.indexOf('/* ================= vitality score (begin) ================= */');
  const end = html.indexOf('/* ================= vitality score (end) ================= */');
  assert.ok(begin !== -1 && end > begin, 'vitality score block markers not found');
  const ctx = {
    Math,
    clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
    bpCategory: (s, d) => ({ label: s < 120 && d < 80 ? 'Normal' : s >= 180 ? 'Crisis hipertensiva' : 'Hipertensión etapa 1' }),
    state: {},
  };
  vm.runInNewContext(html.slice(begin, end), ctx);
  return ctx.vitalityScore;
}
const GOALS = { calorieGoal: 2000, waterGoal: 2.5, exerciseGoal: 30 };
const day = (o = {}) => ({ meals: [], exercises: [], sleepHours: null, water: 0, bp: [], medsTaken: [], ...o });
const score = (d, meds = []) => load()(day(d), GOALS, meds);

test('nothing logged yet: no score at all', () => {
  assert.equal(score({}), null);
});

test('only water, even at its goal, is far from a full day', () => {
  assert.equal(score({ water: 2.5 }), 25);
});

test('only sleep at 8 hours is far from a full day', () => {
  assert.equal(score({ sleepHours: 8 }), 25);
});

test('a complete, on-target day scores 100', () => {
  assert.equal(score({
    meals: [{ calories: 2000 }], water: 2.5, exercises: [{ minutes: 30 }], sleepHours: 8,
  }), 100);
});

test('the score rises as more of the day is logged', () => {
  const steps = [
    { water: 2.5 },
    { water: 2.5, sleepHours: 8 },
    { water: 2.5, sleepHours: 8, exercises: [{ minutes: 30 }] },
    { water: 2.5, sleepHours: 8, exercises: [{ minutes: 30 }], meals: [{ calories: 2000 }] },
  ].map((d) => score(d));
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1], `step ${i} did not raise the score: ${steps}`);
});

test('blood pressure only counts on a day it was measured', () => {
  const full = { meals: [{ calories: 2000 }], water: 2.5, exercises: [{ minutes: 30 }], sleepHours: 8 };
  assert.equal(score(full), 100);
  assert.equal(score({ ...full, bp: [{ systolic: 115, diastolic: 75 }] }), 100);
  assert.ok(score({ ...full, bp: [{ systolic: 185, diastolic: 110 }] }) < 100);
});

test('scheduled medications count, and missed doses lower the score', () => {
  const full = { meals: [{ calories: 2000 }], water: 2.5, exercises: [{ minutes: 30 }], sleepHours: 8 };
  const meds = [{ times: ['08:00', '20:00'] }];
  assert.equal(score({ ...full, medsTaken: [{}, {}] }, meds), 100);
  assert.equal(score({ ...full, medsTaken: [] }, meds), 80);
});
