// Rule tests for the calculation engine embedded in index.html.
// Run: node tests.cjs
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/\/\*ENGINE-START\*\/([\s\S]*?)\/\*ENGINE-END\*\//);
if (!m) throw new Error('engine block not found');
const mod = { exports: {} };
new Function('module', m[1])(mod);
const EX = mod.exports;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + e.message); }
}
const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const BASE = { sex: 'male', age: 38, height: 172, weight: 78, lossKg: 4, weeks: 8, days: 4, share: 0.4, activity: 1.2, conds: {} };
const P = (over = {}, conds = {}) => EX.plan({ ...BASE, ...over, conds: { ...conds } });
const ids = r => r.plans.map(p => p.id);

console.log('Basic formulas');
t('Mifflin-St Jeor male', () => near(EX.bmr('male', 38, 172, 78), 10 * 78 + 6.25 * 172 - 5 * 38 + 5, 1e-9));
t('Mifflin-St Jeor female = male − 166', () => near(EX.bmr('male', 50, 160, 60) - EX.bmr('female', 50, 160, 60), 166, 1e-9));
t('gross = MET × kg × h', () => near(EX.burn(6, 60, 60).gross, 360, 1e-9));
t('net (no BMR) = (MET−1) × kg × h', () => near(EX.burn(6, 60, 60).net, 300, 1e-9));
t('net with individual resting rate', () => near(EX.burn(6, 60, 60, 1440 / 1440).net, 360 - 60, 1e-9));
t('intensity cut-offs 3 / 6 MET', () => {
  assert.equal(EX.intensity(2.9).key, 'light');
  assert.equal(EX.intensity(3).key, 'moderate');
  assert.equal(EX.intensity(5.9).key, 'moderate');
  assert.equal(EX.intensity(6).key, 'vigorous');
});
t('Taiwan BMI cut-offs 18.5/24/27/30/35', () => {
  assert.equal(EX.bmiCat(18.4).key, 'under');
  assert.equal(EX.bmiCat(18.5).key, 'normal');
  assert.equal(EX.bmiCat(24).key, 'over');
  assert.equal(EX.bmiCat(27).key, 'ob1');
  assert.equal(EX.bmiCat(30).key, 'ob2');
  assert.equal(EX.bmiCat(35).key, 'ob3');
});

console.log('Data integrity');
t('every POOL id exists in DB', () => EX.POOL.forEach(p => assert.ok(EX.BY_ID[p.id], p.id)));
t('every PREF id exists in POOL', () => Object.values(EX.PREF).flat().forEach(id => assert.ok(EX.POOL.find(p => p.id === id), id)));
t('DB ids unique', () => { const all = Object.values(EX.DB).flat().map(x => x.id); assert.equal(new Set(all).size, all.length); });
t('every DB item has MET and Compendium code', () => Object.values(EX.DB).flat().forEach(x => {
  assert.ok(x.met > 1 && x.met < 20, x.id);
  assert.ok(/^\d{5}$/.test(x.code), x.id + ' code ' + x.code);
}));
t('plan MET comes from DB', () => P().plans.forEach(p => assert.equal(p.met, EX.BY_ID[p.id].met)));

console.log('Deficit, rate and diet');
t('daily deficit = kg × 7700 / weeks / 7', () => near(P().dailyDeficit, 4 * 7700 / 8 / 7, 1e-9));
t('exercise/diet split follows share', () => { const r = P(); near(r.dailyEx, r.dailyDeficit * 0.4, 1e-9); near(r.dailyDiet, r.dailyDeficit * 0.6, 1e-9); });
t('intake = TDEE − diet deficit', () => { const r = P(); near(r.intake, r.bmr * 1.2 - r.dailyDiet, 1e-9); });
t('100% exercise → intake = TDEE', () => { const r = P({ share: 1 }); near(r.intake, r.tdee, 1e-9); });
t('0.5 kg/wk → ok', () => assert.equal(P().rateLevel, 'ok'));
t('0.1 kg/wk → slow (not "0.5–0.8" green)', () => assert.equal(P({ lossKg: 1, weeks: 10 }).rateLevel, 'slow'));
t('1.2 kg/wk (1.2% BW) → warning', () => assert.equal(P({ weight: 100, lossKg: 6, weeks: 5 }).rateLevel, 'warning'));
t('>1% body weight/week → warning even if <1 kg', () => assert.equal(P({ weight: 60, height: 160, lossKg: 3.2, weeks: 4 }).rateLevel, 'warning'));
t('2 kg/wk → danger', () => assert.equal(P({ lossKg: 8, weeks: 4 }).rateLevel, 'danger'));
t('suggested weeks keeps ≤0.75 kg/wk', () => assert.ok(8 / P({ lossKg: 8, weeks: 4 }).suggestWeeks <= 0.75));
t('intake below floor flagged (female 1200)', () => {
  const r = P({ sex: 'female', age: 45, height: 155, weight: 62, lossKg: 5, weeks: 8, share: 0.3 });
  assert.ok(r.intake < 1200 && r.intakeLow);
});
t('male floor is 1500', () => assert.equal(P().intakeFloor, 1500));

console.log('Blocks');
t('age < 18 blocks', () => assert.ok(P({ age: 16 }).blocks.length));
t('BMI < 18.5 blocks', () => assert.ok(P({ weight: 52 }).blocks.length));
t('target BMI < 18.5 blocks', () => { const r = P({ weight: 60, lossKg: 6 }); assert.ok(r.targetBmi < 18.5 && r.blocks.length); });
t('symptoms block and screening says clearance', () => { const r = P({}, { symptoms: true }); assert.ok(r.blocks.length); assert.equal(r.screen.level, 'danger'); });
t('blocked plan has no prescription', () => assert.equal(P({ age: 16 }).plans, undefined));

console.log('Prescription selection (conditions stack)');
t('general → 4 plans incl. running', () => { const r = P(); assert.equal(r.plans.length, 4); assert.ok(ids(r).includes('r_8')); });
t('DM alone differs from general', () => assert.notDeepEqual(ids(P({}, { dm: true })), ids(P())));
t('DM alone → walking first', () => assert.equal(ids(P({}, { dm: true }))[0], 'w_3_5'));
t('knee → no high-impact', () => P({}, { knee: true }).plans.forEach(p => assert.notEqual(p.impact, 'high')));
t('BMI ≥30 auto → no high-impact', () => { const r = P({ weight: 95 }); assert.ok(r.conds.obese); r.plans.forEach(p => assert.notEqual(p.impact, 'high')); });
t('CVD → all < 6 MET', () => P({}, { cvd: true }).plans.forEach(p => assert.ok(p.met < 6)));
t('knee + CVD → both constraints, both note groups', () => {
  const r = P({}, { knee: true, cvd: true });
  r.plans.forEach(p => { assert.notEqual(p.impact, 'high'); assert.ok(p.met < 6); });
  const g = new Set(r.notes.map(n => n.group));
  assert.ok(g.has('膝關節／下肢疼痛') && g.has('心血管／腎臟疾病'));
});
t('age ≥65 → no high-impact, < 6 MET, balance training', () => {
  const r = P({ age: 72 });
  assert.ok(r.conds.older);
  r.plans.forEach(p => { assert.notEqual(p.impact, 'high'); assert.ok(p.met < 6); });
  assert.ok(r.strength.lines.some(l => l.includes('平衡')));
});
t('distinct activity kinds', () => { const k = P().plans.map(p => p.kind); assert.equal(new Set(k).size, k.length); });
t('DM + <3 days → warning', () => assert.ok(P({ days: 2 }, { dm: true }).alerts.length));
t('insulin note only when insulin checked', () => {
  assert.ok(!P({}, { dm: true }).notes.some(n => n.text.includes('90 mg/dL')));
  assert.ok(P({}, { dm: true, insulin: true }).notes.some(n => n.text.includes('90 mg/dL')));
});
t('DM resistance 2–3 days', () => assert.ok(P({}, { dm: true }).strength.days.includes('2–3')));

console.log('Session minutes & feasibility');
t('minutes rounded up to 5 and ≥15', () => P().plans.forEach(p => { assert.equal(p.minutes % 5, 0); assert.ok(p.minutes >= 15); }));
t('floored session reports real kcal', () => {
  const r = P({ lossKg: 1, weeks: 20, days: 6, share: 0.3 });
  r.plans.forEach(p => { assert.equal(p.minutes, 15); near(p.kcal, p.netPerMin * 15, 1e-9); });
});
t('knee preset at 100% exercise → infeasible with remedy', () => {
  const r = EX.plan({ sex: 'female', age: 52, height: 160, weight: 72, lossKg: 5, weeks: 12, days: 4, share: 1, activity: 1.2, conds: { knee: true } });
  const p = r.plans[0];
  assert.equal(p.feas, 'infeasible');
  assert.ok(p.weeksFor60 > 12);
  const npm = p.netPerMin;
  assert.ok(5 * 7700 * 1 / p.weeksFor60 / 4 / npm <= 60.0001);
});
t('weekly moderate-equivalent doubles vigorous', () => {
  const r = P();
  const run = r.plans.find(p => p.id === 'r_8');
  assert.equal(run.modEq, run.minutes * 4 * 2);
});
t('corrected MET = MET × (kg/60) ÷ (BMR/1440)', () => { const r = P(); const p = r.plans[0]; near(p.correctedMet, p.met * (78 / 60) / (r.bmr / 1440), 1e-9); });
t('screening: disease + inactive → clearance', () => assert.equal(P({}, { dm: true, beginner: true }).screen.level, 'warning'));
t('screening: hypertension alone is not "known disease"', () => assert.equal(P({}, { htn: true }).screen.level, 'success'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
