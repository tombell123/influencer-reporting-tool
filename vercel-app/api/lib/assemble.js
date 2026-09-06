// Port of assemble_submission.py -- turns a batch of per-screenshot
// readings into one submission dict per channel.

function assembleIG(pieces) {
  const frames = pieces.filter(p => p.type === 'story_frame');
  const reels = pieces.filter(p => p.type === 'reel');
  if (reels.length > 1) {
    throw new Error(
      `Got ${reels.length} Reel screenshots in one batch -- expected at most 1. `
      + `If this influencer posted two Reels, submit them as separate batches `
      + `via the content-piece dropdown, not together.`);
  }

  const sub = { channel: 'IG' };
  if (reels.length) {
    const r = reels[0];
    sub.views = r.views; sub.likes = r.likes; sub.comments = r.comments;
    sub.shares = r.shares ?? 0; sub.saves = r.saves;
  }
  if (frames.length) {
    sub.num_frames = frames.length;
    sub.first_story_views = Math.max(...frames.map(f => f.views));
    sub.story_likes_breakdown = frames.map(f => f.likes);
    sub.sticker_taps_breakdown = frames.map(f => f.sticker_taps ?? 0);
    sub.link_clicks_breakdown = frames.map(f => f.link_clicks ?? 0);
  }
  return sub;
}

function assembleTikTok(pieces) {
  const tt = pieces.filter(p => p.type === 'tiktok');
  if (tt.length > 1) {
    throw new Error(`Got ${tt.length} TikTok screenshots in one batch -- expected 1.`);
  }
  const t = tt[0];
  return {
    channel: 'TT', views: t.views, likes: t.likes, comments: t.comments,
    shares: t.shares ?? 0, saves: t.saves ?? 0,
  };
}

function assembleSubmissions(pieces) {
  const hasIG = pieces.some(p => p.type === 'story_frame' || p.type === 'reel');
  const hasTT = pieces.some(p => p.type === 'tiktok');
  const out = [];
  if (hasIG) out.push(assembleIG(pieces));
  if (hasTT) out.push(assembleTikTok(pieces));
  return out;
}

/**
 * Filters extracted pieces down to only what the person actually
 * selected on the form (platform + content piece), so a mixed batch
 * of screenshots never silently writes to a channel/row the person
 * didn't ask for. Anything filtered out is reported in `dropped` so
 * the caller can warn the person about it, rather than either
 * silently processing it or silently discarding it.
 *
 * platform: 'IG' | 'TT'
 * contentPiece: 'post1' | 'post2' | 'stories'  (only meaningful for IG)
 */
function filterPiecesBySelection(pieces, platform, contentPiece) {
  let kept, droppedReason;

  if (platform === 'TT') {
    kept = pieces.filter(p => p.type === 'tiktok');
    droppedReason = (p) => p.type === 'story_frame' ? 'Story screenshot' : p.type === 'reel' ? 'Reel screenshot' : `${p.type} screenshot`;
  } else {
    // IG: further split by content piece -- "stories" wants only
    // story frames, "post1"/"post2" wants only the Reel
    if (contentPiece === 'stories') {
      kept = pieces.filter(p => p.type === 'story_frame');
    } else {
      kept = pieces.filter(p => p.type === 'reel');
    }
    droppedReason = (p) => p.type === 'tiktok' ? 'TikTok screenshot'
      : p.type === 'story_frame' ? 'Story screenshot'
      : p.type === 'reel' ? 'Reel screenshot' : `${p.type} screenshot`;
  }

  const dropped = pieces.filter(p => !kept.includes(p));
  const warnings = [];
  if (dropped.length) {
    const counts = {};
    dropped.forEach(p => { counts[droppedReason(p)] = (counts[droppedReason(p)] || 0) + 1; });
    const summary = Object.entries(counts).map(([label, n]) => `${n} ${label}${n > 1 ? 's' : ''}`).join(', ');
    warnings.push(
      `Found ${summary} in this batch, but ${platform === 'TT' ? 'TikTok' : (contentPiece === 'stories' ? 'Instagram Stories' : 'Instagram ' + contentPiece)} was selected -- `
      + `these were NOT processed. If they belong on the sheet too, submit them separately with the matching platform/content piece selected.`
    );
  }

  return { kept, warnings };
}

module.exports = { assembleSubmissions, filterPiecesBySelection };
