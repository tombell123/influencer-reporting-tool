// api/lib/slidesLogic.js
//
// Ports slides_model.py's find/update/template-clone logic to work
// against the REAL Google Slides API response shape, instead of the
// simplified dict model used to prove the logic in Python.
//
// Key design decision (different from the Python prototype): rather
// than trying to guess which bare number on a slide means what,
// shapes are identified by their fixed CAPTION text ("Total Reach",
// "Total engagements", etc -- confirmed from the real test deck).
// Once a shape is identified, its entire text is replaced by its
// element ID directly (deleteText + insertText), never by searching
// for old values -- this sidesteps any risk of accidentally matching
// the wrong number elsewhere on the slide.

// Known caption -> how to rebuild that shape's full text from a
// submission's values. Each shape is presumed to hold exactly this
// multi-line pattern (confirmed from the real test deck's structure).
const SHAPE_TEMPLATES = {
  'Total Reach': (v) =>
    `${fmt(v.reach)}\nTotal Reach\n${v.organic_reach_pct != null ? v.organic_reach_pct + '%' : 'x%'} organic reach`,

  'Total engagements (IG)': (v) =>
    `${fmt(v.total_eng)}\nTotal engagements\nViews: ${fmt(v.views)}\nLikes: ${fmt(v.likes)}\n`
    + `Comments: ${fmt(v.comments)}\nSaves: ${fmt(v.saves)}\nEng rate: ${v.eng_rate != null ? v.eng_rate + '%' : 'x%'}`,

  'Total engagements (TT)': (v) =>
    `${fmt(v.total_eng)}\nTotal engagements\nViews: ${fmt(v.views)}\nLikes: ${fmt(v.likes)}\n`
    + `Comments: ${fmt(v.comments)}\nShares: ${fmt(v.shares)}\nSaves: ${fmt(v.saves)}\n`
    + `Eng rate: ${v.eng_rate != null ? v.eng_rate + '%' : 'x%'}`,

  'Story views': (v) => `${fmt(v.first_story_views)}\nStory views`,
  'Total link clicks': (v) => `${fmt(v.link_clicks)}\nTotal link clicks`,
  'Total likes': (v) => `${fmt(v.total_likes)}\nTotal likes`,
  // Sticker taps intentionally excluded -- it includes the @handle
  // sub-line which this tool has no data for and shouldn't touch.
};

function fmt(n) {
  if (n == null) return 'x';
  return n.toLocaleString('en-US');
}

/** Flattens a Slides API shape's text into one plain string, joining
 * paragraphs with newlines the way they visually appear. */
function shapeText(pageElement) {
  const textElements = pageElement.shape?.text?.textElements || [];
  return textElements
    .map(te => te.textRun?.content ?? (te.paragraphMarker ? '\n' : ''))
    .join('')
    .replace(/\n+$/, ''); // trailing newline Slides always adds
}

/** Extracts a lightweight model of one slide: its full text (for
 * classification) and each shape's id+text (for targeted updates). */
function extractSlide(page) {
  const shapes = (page.pageElements || [])
    .filter(el => el.shape?.text)
    .map(el => ({ objectId: el.objectId, text: shapeText(el) }));
  const fullText = shapes.map(s => s.text).join('\n');
  return { objectId: page.objectId, shapes, fullText };
}

/** Classifies a slide by scanning its text for the influencer handle,
 * platform, content piece, and whether it's a named template slide. */
function classifySlide(slide) {
  const handleMatch = slide.fullText.match(/@[\w.]+/);
  const influencer = handleMatch ? handleMatch[0] : null;

  const isTemplate = /template/i.test(slide.fullText) && !handleMatch;

  let platform = null, piece = null;
  if (/tiktok/i.test(slide.fullText)) {
    platform = 'TT'; piece = 'tiktok';
  } else if (/instagram stories?/i.test(slide.fullText)) {
    platform = 'IG'; piece = 'stories';
  } else if (/instagram reel|1x reel/i.test(slide.fullText)) {
    platform = 'IG'; piece = 'reel';
  }

  return { ...slide, influencer, platform, piece, isTemplate };
}

function classifyPresentation(presentation) {
  return (presentation.slides || []).map(page => classifySlide(extractSlide(page)));
}

/** Same contract as the Python version: 0 matches = needs a clone,
 * 1 = safe to update, 2+ = genuine collision, don't guess. */
function findSlides(classifiedSlides, influencer, platform, piece) {
  return classifiedSlides.filter(s =>
    s.influencer === influencer && s.platform === platform && s.piece === piece && !s.isTemplate);
}

function findTemplate(classifiedSlides, piece) {
  const templateTextMatch = {
    reel: /instagram template/i,
    stories: /stories? template/i,
    tiktok: /tiktok template/i,
  }[piece];
  if (!templateTextMatch) {
    throw new Error(`Unknown content piece "${piece}" -- expected 'reel', 'stories', or 'tiktok'.`);
  }
  const matches = classifiedSlides.filter(s => s.isTemplate && templateTextMatch.test(s.fullText));
  if (matches.length === 0) {
    throw new Error(`No template slide found for "${piece}" -- add one (e.g. "Instagram template") before a new influencer can be added.`);
  }
  if (matches.length > 1) {
    throw new Error(`Found ${matches.length} template slides for "${piece}" -- there should be exactly one.`);
  }
  return matches[0];
}

/** Given a found slide and a submission, returns the list of
 * {objectId, deleteText: true, insertText: newText} operations needed
 * -- one per recognized stat-box shape whose caption matched a known
 * template. Shapes with no recognized caption (title, images, captions
 * we deliberately don't touch) are left completely alone. */
function buildSlideUpdates(slide, submission, platform) {
  const engagementsKey = platform === 'TT' ? 'Total engagements (TT)' : 'Total engagements (IG)';
  const updates = [];

  for (const shape of slide.shapes) {
    const firstLine = shape.text.split('\n')[0];
    const caption = shape.text.split('\n')[1]; // the line naming what this box is

    let templateKey = null;
    if (caption === 'Total Reach') templateKey = 'Total Reach';
    else if (caption === 'Total engagements') templateKey = engagementsKey;
    else if (caption === 'Story views') templateKey = 'Story views';
    else if (caption === 'Total link clicks') templateKey = 'Total link clicks';
    else if (caption === 'Total likes') templateKey = 'Total likes';

    if (!templateKey) continue; // not a shape we know how to update -- leave it alone

    const newText = SHAPE_TEMPLATES[templateKey](submission);
    if (newText !== shape.text) {
      updates.push({ objectId: shape.objectId, oldText: shape.text, newText });
    }
  }

  return updates;
}

/** Builds the title/subtitle text for a slide, used only when filling
 * in a freshly cloned template (an existing slide's title is already
 * correct and is never touched). */
function buildTitleText(piece, influencer, submission) {
  const followersStr = submission.followers != null ? fmt(submission.followers) : 'x';
  const title = `${influencer}: ${followersStr} followers`;
  const dateStr = submission.live_date || 'x';
  const subtitle = piece === 'stories'
    ? `${submission.num_frames ?? 'x'} Instagram Stories`
    : piece === 'tiktok'
      ? `1x TikTok, live date: ${dateStr}`
      : `1x Instagram Reel, live date: ${dateStr}`;
  return { title, subtitle };
}

module.exports = {
  classifyPresentation, findSlides, findTemplate, buildSlideUpdates, buildTitleText,
  shapeText, extractSlide, classifySlide, // exported for testing
};
