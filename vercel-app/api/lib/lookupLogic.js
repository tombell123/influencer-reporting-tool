// api/lib/lookupLogic.js
//
// Pure logic for the live-discovery endpoint -- turns raw Sheets API
// row data into the distinct project/influencer lists a dropdown
// needs. Kept separate from the actual API calls (in api/lookup.js)
// so this can be tested without a live connection, same pattern as
// sheetLogic.js and slidesLogic.js.

const { COLS } = require('./sheetLogic');

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Returns the distinct, non-empty Project values (column C) found in
 * a tab's rows, in the order they first appear -- not alphabetized,
 * so campaign blocks stay in the order they're actually laid out in
 * the sheet, which is usually meaningful (newest/current work first
 * or last, depending on the team's convention). */
function extractDistinctProjects(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const project = row[COLS.project];
    if (!project) continue;
    const key = normalize(project);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(project); // keep the ORIGINAL casing/spacing for display
  }
  return out;
}

/** Returns the distinct Influencer values (column D) belonging to one
 * specific project, in first-seen order. One influencer can appear on
 * more than one row (an IG row and a TT row) -- deduped here so the
 * dropdown shows each person once regardless of how many channel rows
 * they have. */
function extractInfluencersForProject(rows, targetProject) {
  const target = normalize(targetProject);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (normalize(row[COLS.project]) !== target) continue;
    const influencer = row[COLS.influencer];
    if (!influencer) continue;
    const key = normalize(influencer);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(influencer);
  }
  return out;
}

module.exports = { extractDistinctProjects, extractInfluencersForProject, normalize };
