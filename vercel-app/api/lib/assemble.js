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

module.exports = { assembleSubmissions };
