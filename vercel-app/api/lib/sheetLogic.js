// Ports update_existing_row.py / append_to_sheet.py to work against
// what the Sheets API actually gives you: an array of arrays (one
// per row), not a spreadsheet file. Column letters are converted to
// 0-based array indices.
//
// This file has NO network calls in it -- it's pure logic, the same
// way the Python version was, so it can be fully tested without a
// live Sheets connection. netlify/functions/submit.js is the thin
// wrapper that actually calls the Sheets API and hands rows to this.

const COLS = {
  project: 2, influencer: 3, channel: 4, cost: 5, followers: 6, reach: 7,
  organic_reach_pct: 8, views: 9, likes: 10, comments: 11, shares: 12,
  saves: 13, total: 14, er_pct: 15, frames: 16, first_story_views: 17,
  story_likes: 18, sticker_taps: 19, link_clicks: 20, open_rate: 21,
  total_views: 22, total_eng: 23,
}; // C=2 ... X=23, matching the real sheet's column layout 1:1 with the
   // proven Python version (COLS dict in append_to_sheet.py)

function colLetter(index) {
  // 0-based index -> spreadsheet column letter, e.g. 2 -> "C"
  let s = '', n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** rows: the raw values.get() result (array of arrays, row 1 = headers
 * assumed already stripped by the caller). Returns the 0-based row
 * index within `rows` (NOT the real sheet row number -- caller adds
 * the offset), or -1 if not found. Matching is case/whitespace
 * insensitive -- "Back To School" and "back to school " are the same
 * project, since real-world typing/casing varies. */
function findExistingRow(rows, project, influencer, channel) {
  const p = normalize(project), inf = normalize(influencer), c = normalize(channel);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (normalize(r[COLS.project]) === p && normalize(r[COLS.influencer]) === inf
        && normalize(r[COLS.channel]) === c) {
      return i;
    }
  }
  return -1;
}

function existingBreakdown(cellValue) {
  if (!cellValue) return [];
  if (typeof cellValue === 'string' && cellValue.startsWith('=')) {
    return cellValue.slice(1).split('+').filter(Boolean);
  }
  return [String(cellValue)];
}

/** Given one existing row (array) and a submission dict, returns the
 * set of {range, value} cell updates to send to Sheets API -- i.e.
 * ONLY the cells that actually change, nothing else touched. sheetRow
 * is the real 1-based sheet row number (caller computes this). */
function buildAdditiveUpdate(row, submission, tabName, sheetRow) {
  const updates = [];
  const set = (field, value) => {
    updates.push({
      range: `'${tabName}'!${colLetter(COLS[field])}${sheetRow}`,
      value,
    });
  };

  // summed raw fields
  for (const field of ['views', 'likes', 'comments', 'shares', 'saves', 'reach']) {
    if (submission[field] != null) {
      const existing = Number(row[COLS[field]]) || 0;
      set(field, existing + submission[field]);
    }
  }
  if (submission.num_frames != null) {
    const existing = Number(row[COLS.frames]) || 0;
    set('frames', existing + submission.num_frames);
  }

  // always overwrite
  if (submission.followers != null) set('followers', submission.followers);

  // 1st story views: overwrite with this batch's max
  if (submission.first_story_views != null) {
    set('first_story_views', submission.first_story_views);
  }

  // breakdown formulas: append this batch's values to the existing list
  const breakdownFields = [
    ['story_likes', 'story_likes_breakdown'],
    ['sticker_taps', 'sticker_taps_breakdown'],
    ['link_clicks', 'link_clicks_breakdown'],
  ];
  for (const [field, key] of breakdownFields) {
    const newVals = submission[key];
    if (newVals && newVals.length) {
      const combined = existingBreakdown(row[COLS[field]]).concat(newVals.map(String));
      set(field, '=' + combined.join('+'));
    }
  }

  // cost: only write if currently empty (never auto-overwrite real budget)
  if (submission.cost != null) {
    const existingCost = row[COLS.cost];
    if (existingCost === undefined || existingCost === '' || existingCost === null) {
      set('cost', submission.cost);
    }
    // else: intentionally left alone -- caller should surface this to
    // a human rather than silently dropping it
  }

  return updates;
}

module.exports = { COLS, colLetter, findExistingRow, buildAdditiveUpdate, existingBreakdown };
