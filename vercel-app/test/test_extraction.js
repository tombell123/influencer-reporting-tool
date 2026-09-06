const { parseExtractionResponse } = require('../api/lib/extraction');
const { assembleSubmissions } = require('../api/lib/assemble');

console.log('--- Real la_sidhu batch, bare array response ---');
const cleanResponse = JSON.stringify([
  { type: 'story_frame', views: 1831, likes: 17, link_clicks: 0, sticker_taps: 0 },
  { type: 'story_frame', views: 1581, likes: 22, link_clicks: 9, sticker_taps: 0 },
  { type: 'story_frame', views: 1555, likes: 12, link_clicks: 4, sticker_taps: 0 },
  { type: 'story_frame', views: 1510, likes: 16, link_clicks: 6, sticker_taps: 2 },
  { type: 'reel', views: 8367, likes: 256, comments: 108, shares: 0, saves: 6 },
  { type: 'tiktok', views: 375, likes: 4, comments: 0, shares: 0, saves: 0 },
]);
const { pieces, warnings } = parseExtractionResponse(cleanResponse);
console.log(`Parsed ${pieces.length} pieces, ${warnings.length} warnings`);
const submissions = assembleSubmissions(pieces);
submissions.forEach(s => console.log(' ', s));

console.log('\n--- Checks ---');
const ig = submissions.find(s => s.channel === 'IG');
const tt = submissions.find(s => s.channel === 'TT');
const checks = [
  ['IG views = 8367', ig.views === 8367],
  ['IG likes = 256', ig.likes === 256],
  ['IG frames = 4', ig.num_frames === 4],
  ['IG first_story_views = 1831 (max)', ig.first_story_views === 1831],
  ['IG story_likes_breakdown = [17,22,12,16]', JSON.stringify(ig.story_likes_breakdown) === '[17,22,12,16]'],
  ['TT views = 375', tt.views === 375],
];
checks.forEach(([label, ok]) => console.log(`  ${label} -> ${ok ? 'OK' : 'FAIL'}`));

console.log('\n--- Markdown-fenced response still parses ---');
const fenced = '```json\n' + JSON.stringify([{ type: 'tiktok', views: 375, likes: 4, comments: 0 }]) + '\n```';
const fencedResult = parseExtractionResponse(fenced);
console.log(`  Parsed ${fencedResult.pieces.length} piece(s) -> ${fencedResult.pieces.length === 1 ? 'OK' : 'FAIL'}`);

console.log('\n--- Malformed response throws clearly ---');
try {
  parseExtractionResponse("Sorry, I couldn't read this.");
  console.log('  FAIL -- should have thrown');
} catch (e) {
  console.log(`  OK -- threw: ${e.message}`);
}
