const { COLS, colLetter, findExistingRow, buildAdditiveUpdate } = require('../api/lib/sheetLogic');

console.log('--- colLetter sanity checks ---');
const letterChecks = [[2, 'C'], [9, 'J'], [23, 'X'], [0, 'A'], [25, 'Z'], [26, 'AA']];
letterChecks.forEach(([idx, expected]) => {
  const got = colLetter(idx);
  console.log(`  ${idx} -> ${got} (expected ${expected}) -> ${got === expected ? 'OK' : 'FAIL'}`);
});

console.log('\n--- findExistingRow ---');
// row shaped like real sheet data: index 2=project,3=influencer,4=channel...
const rows = [
  ['', '', 'Kids SS26', '@la_sidhu', 'IG', '', 251000, 4762, 0.06,
    0, 0, 0, 0, 0, 0, 0, // views..er_pct all 0 for this fixture
    2, 1581, '=17+22', 0, '=0+9'],
];
const foundIdx = findExistingRow(rows, 'Kids SS26', '@la_sidhu', 'IG');
console.log(`  Found at index ${foundIdx} -> ${foundIdx === 0 ? 'OK' : 'FAIL'}`);
const notFoundIdx = findExistingRow(rows, 'Kids SS26', '@newperson', 'IG');
console.log(`  Not-found returns -1 -> ${notFoundIdx === -1 ? 'OK' : 'FAIL'}`);

console.log('\n--- buildAdditiveUpdate: real data, submission 2 arriving for an existing row ---');
// this row already has frames 1-2 of the real la_sidhu batch on it
// (views=0 because no Reel yet, frames=2, first_story_views=1831 from
// frame 1, story_likes formula chains 17+22)
const existingRow = [];
existingRow[COLS.project] = 'Kids SS26';
existingRow[COLS.influencer] = '@la_sidhu';
existingRow[COLS.channel] = 'IG';
existingRow[COLS.followers] = 251000;
existingRow[COLS.views] = 0;
existingRow[COLS.likes] = 0;
existingRow[COLS.frames] = 2;
existingRow[COLS.first_story_views] = 1831;
existingRow[COLS.story_likes] = '=17+22';
existingRow[COLS.link_clicks] = '=0+9';

// submission 2: frames 3-4 + the real Reel numbers, arriving later
const submission = {
  views: 8367, likes: 256, comments: 108, saves: 6,
  followers: 253000,
  num_frames: 2,
  first_story_views: Math.max(1555, 1510),
  story_likes_breakdown: [12, 16],
  link_clicks_breakdown: [4, 6],
};

const updates = buildAdditiveUpdate(existingRow, submission, 'Kids SS26', 5);
console.log('Cell updates that would be sent to the Sheets API:');
updates.forEach(u => console.log(`  ${u.range} = ${u.value}`));

console.log('\n--- Checks ---');
const byRange = Object.fromEntries(updates.map(u => [u.range, u.value]));
const checks = [
  ["Views cell = J5, value 8367 (0+8367)", byRange["'Kids SS26'!J5"] === 8367],
  ["Followers cell = G5, value 253000 (OVERWRITE not 251000+253000)", byRange["'Kids SS26'!G5"] === 253000],
  ["Frames cell = Q5, value 4 (2+2)", byRange["'Kids SS26'!Q5"] === 4],
  ["Story likes formula chains to =17+22+12+16", byRange["'Kids SS26'!S5"] === '=17+22+12+16'],
  ["Link clicks formula chains to =0+9+4+6", byRange["'Kids SS26'!U5"] === '=0+9+4+6'],
  ["1st story views = 1555 (max of THIS batch: 1555 vs 1510)", byRange["'Kids SS26'!R5"] === 1555],
];
checks.forEach(([label, ok]) => console.log(`  ${label} -> ${ok ? 'OK' : 'FAIL'}`));
