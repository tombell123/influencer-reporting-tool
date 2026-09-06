const { findExistingRow, COLS } = require('../api/lib/sheetLogic');

console.log('--- Reproducing the real bug: tab name vs project value ---');
// row as it actually appears in the real sheet: Project column says
// "Back To School" (NOT "Kids SS26" -- that's the TAB name, a
// different thing)
const rows = [];
rows[0] = [];
rows[0][COLS.project] = 'Back To School';
rows[0][COLS.influencer] = '@la_sidhu';
rows[0][COLS.channel] = 'IG';

console.log('\nOLD (buggy) behavior would have searched for project="Kids SS26":');
const buggyResult = findExistingRow(rows, 'Kids SS26', '@la_sidhu', 'IG');
console.log(`  Result: ${buggyResult} -> ${buggyResult === -1 ? 'correctly -1 (this WAS the bug -- tab name != project)' : 'unexpected'}`);

console.log('\nFIXED behavior: search for the real project value "Back To School":');
const fixedResult = findExistingRow(rows, 'Back To School', '@la_sidhu', 'IG');
console.log(`  Result: ${fixedResult} -> ${fixedResult === 0 ? 'OK, found it' : 'FAIL'}`);

console.log('\n--- Casing/whitespace robustness (the other real gap) ---');
const castingChecks = [
  ['Back to School', 'lowercase t\'s, as Tom actually typed it in chat'],
  ['back to school', 'all lowercase'],
  ['  Back To School  ', 'extra whitespace'],
];
castingChecks.forEach(([variant, desc]) => {
  const result = findExistingRow(rows, variant, '@la_sidhu', 'IG');
  console.log(`  "${variant}" (${desc}): ${result === 0 ? 'OK, still matches' : 'FAIL'}`);
});

console.log('\n--- Influencer/channel casing also robust ---');
const r2 = findExistingRow(rows, 'Back To School', '@LA_SIDHU', 'ig');
console.log(`  Mixed-case influencer + lowercase channel: ${r2 === 0 ? 'OK' : 'FAIL'}`);
