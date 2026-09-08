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

// Known caption text -> which substitutions to apply within that
// shape, using the targeted find-and-replace primitives above rather
// than rebuilding the shape's text from scratch. This is robust to
// whatever mix of blank lines / soft line breaks the real slide
// actually uses, since only the specific value tokens are touched.

function fmt(n) {
  if (n == null) return 'x';
  return n.toLocaleString('en-US');
}

/** Splits a shape's text into meaningful (non-blank) lines, tolerant
 * of the real API's quirks: extra blank paragraph lines, and vertical
 * tab characters (\v) used for soft line breaks within one paragraph,
 * both of which showed up in the real deck but not in any reasonable
 * hand-written assumption of the structure. */
function cleanLines(text) {
  return text.split(/[\n\v]+/).map(s => s.trim()).filter(Boolean);
}

// Matches an existing number ("4,762"), a decimal ("6.5"), or any of
// the blank-placeholder conventions actually seen on the real deck
// ("-", "x", "X") -- the real slides weren't consistent about which
// placeholder they used, so all of them need to be recognized.
const NUMBER_TOKEN = /[\d,]+\.?\d*|[xX\-]/;

/** Replaces the number/placeholder token that appears before a known
 * caption string, AND tightens the gap between them to a single line
 * break -- the blank template has extra blank-line padding there
 * (presumably meant to look OK when empty), which causes an oversized
 * visual gap once a real number replaces the placeholder. */
function replaceLeadingNumber(text, captionText, newValue) {
  const idx = text.indexOf(captionText);
  if (idx === -1) return text;
  const after = text.slice(idx);
  return `${fmt(newValue)}\n${after}`;
}

const KNOWN_LABELS = ['Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Eng rate'];

/** Replaces the value that follows "Label:" up to the next known
 * label (or end of string), while preserving whatever separator
 * (space, blank lines, vertical tabs) originally sat between this
 * field and the next one -- the real deck isn't consistent about
 * which separator it uses, and naively consuming it with \s* in the
 * match causes the new value to land in the wrong place, merged
 * against the next label with no space. */
function replaceLabeledValue(text, label, newValue, suffix = '') {
  const stopWords = KNOWN_LABELS.filter(l => l !== label).map(l => l + ':').join('|');
  const re = new RegExp(`(${label}:)([\\s\\S]*?)(?=${stopWords}|$)`, 'i');
  const m = text.match(re);
  if (!m) return text;
  const [fullMatch, labelPart, restZone] = m;
  const trailingSeparator = (restZone.match(/\s*$/) || [''])[0];
  const replacement = `${labelPart} ${fmt(newValue)}${suffix}${trailingSeparator}`;
  return text.slice(0, m.index) + replacement + text.slice(m.index + fullMatch.length);
}

/** Replaces the percentage figure that appears right before a known
 * trailing phrase, e.g. "x% organic reach" -> "6% organic reach", or
 * even a bare "% organic reach" with nothing before the % at all
 * (seen on the real deck for a never-filled-in box). */
function replacePercentBefore(text, phrase, newValue) {
  const idx = text.indexOf(phrase);
  if (idx === -1) return text;
  const before = text.slice(0, idx);
  const after = text.slice(idx);
  const pct = newValue != null ? `${newValue}%` : 'x%';
  const updatedBefore = before.replace(/([\d.]+|[xX\-])?%/, pct);
  return updatedBefore + after;
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
  // Kept for matching (case/whitespace-insensitive, same fix applied
  // to the Sheet's row-matching after "Back to School" vs "Back To
  // School" caused a silent miss there) alongside the original for
  // anything that wants the real display casing.
  const influencerNormalized = influencer ? influencer.trim().toLowerCase() : null;

  const isTemplate = /template/i.test(slide.fullText) && !handleMatch;

  let platform = null, piece = null;
  if (/tiktok/i.test(slide.fullText)) {
    platform = 'TT'; piece = 'tiktok';
  } else if (/instagram stories?/i.test(slide.fullText)) {
    platform = 'IG'; piece = 'stories';
  } else if (/instagram reel|1x reel/i.test(slide.fullText)) {
    platform = 'IG'; piece = 'reel';
  }

  return { ...slide, influencer, influencerNormalized, platform, piece, isTemplate };
}

function classifyPresentation(presentation) {
  return (presentation.slides || []).map(page => classifySlide(extractSlide(page)));
}

/** Same contract as the Python version: 0 matches = needs a clone,
 * 1 = safe to update, 2+ = genuine collision, don't guess. Matching
 * is case/whitespace-insensitive on the influencer handle. */
function findSlides(classifiedSlides, influencer, platform, piece) {
  const target = influencer ? influencer.trim().toLowerCase() : null;
  return classifiedSlides.filter(s =>
    s.influencerNormalized === target && s.platform === platform && s.piece === piece && !s.isTemplate);
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
 * {objectId, oldText, newText} updates needed -- one per recognized
 * stat-box shape. Shapes with no recognized caption (title, image,
 * captions we deliberately don't touch like sticker taps/revenue) are
 * left completely alone. Uses targeted substitution (see primitives
 * above) rather than rebuilding shape text from scratch, so it
 * survives whatever blank-line/formatting quirks the real slide has. */
/** Updates a title's handle and/or follower count. The Sheet is
 * treated as the source of truth for spelling/casing of the handle --
 * if what's on the slide differs from the Sheet's version, it gets
 * corrected, and the discrepancy is reported back rather than fixed
 * silently. followers always overwrites (never additive), same
 * convention as the Sheet's own Followers column. Either argument can
 * be omitted (pass null) to leave that part untouched. */
function updateTitle(text, canonicalHandle, newFollowers) {
  const re = /(@[\w.]+)(:\s*)([\d,.]+[kK]?|[xX\-])(\s*followers)/;
  const m = text.match(re);
  if (!m) return { newText: text, handleDiscrepancy: null };

  const [fullMatch, oldHandle, sep, oldFollowersToken, after] = m;
  const handleDiffers = canonicalHandle != null && oldHandle.toLowerCase() !== canonicalHandle.toLowerCase();
  const finalHandle = canonicalHandle != null ? canonicalHandle : oldHandle;
  const finalFollowers = newFollowers != null ? fmt(newFollowers) : oldFollowersToken;

  const replacement = `${finalHandle}${sep}${finalFollowers}${after}`;
  const newText = text.slice(0, m.index) + replacement + text.slice(m.index + fullMatch.length);

  return {
    newText,
    handleDiscrepancy: handleDiffers ? { onSlide: oldHandle, fromSheet: canonicalHandle } : null,
  };
}

function buildSlideUpdates(slide, submission, platform) {
  const updates = [];
  const has = (field) => submission[field] != null;
  const discrepancies = [];

  for (const shape of slide.shapes) {
    // The title shape (always the first one) holds the handle and
    // follower count, sometimes combined with the subtitle in the
    // same shape -- handle it separately from the caption-based
    // stat boxes below, since it has no recognized caption of its own.
    if (shape === slide.shapes[0] && (has('followers') || has('canonicalInfluencer'))) {
      const { newText: updatedTitle, handleDiscrepancy } = updateTitle(
        shape.text, submission.canonicalInfluencer ?? null, submission.followers ?? null);
      if (handleDiscrepancy) discrepancies.push(handleDiscrepancy);
      if (updatedTitle !== shape.text) {
        updates.push({ objectId: shape.objectId, oldText: shape.text, newText: updatedTitle, caption: 'Title' });
      }
      continue;
    }

    const lines = cleanLines(shape.text);
    const caption = lines[1]; // number/value is lines[0], caption is lines[1] once blanks are stripped
    let newText = shape.text;

    // Guard every substitution on actually having a new value for it
    // -- if we don't have new data for a field (e.g. Reach, which
    // nothing in this pipeline currently extracts), leave whatever is
    // already on the slide completely untouched rather than blanking
    // it with a placeholder.
    if (caption === 'Total Reach') {
      if (has('reach')) newText = replaceLeadingNumber(newText, 'Total Reach', submission.reach);
      if (has('organic_reach_pct')) newText = replacePercentBefore(newText, 'organic reach', submission.organic_reach_pct);
    } else if (caption === 'Total engagements') {
      // The labeled fields (Views/Likes/etc) are rebuilt compactly
      // rather than preserving the original separator, because the
      // blank template's spacing (extra blank lines, meant to look
      // OK when empty) causes real multi-line data to overflow the
      // box and spill into whatever sits below it on the slide.
      if (has('views') || has('likes') || has('comments') || has('saves') || has('shares')) {
        if (has('total_eng')) newText = replaceLeadingNumber(newText, 'Total engagements', submission.total_eng);
        const idx = newText.indexOf('Total engagements');
        if (idx !== -1) {
          const before = newText.slice(0, idx + 'Total engagements'.length);
          const fieldLines = [
            `Views: ${has('views') ? fmt(submission.views) : 'x'}`,
            `Likes: ${has('likes') ? fmt(submission.likes) : 'x'}`,
            `Comments: ${has('comments') ? fmt(submission.comments) : 'x'}`,
          ];
          if (platform === 'TT') fieldLines.push(`Shares: ${has('shares') ? fmt(submission.shares) : 'x'}`);
          fieldLines.push(`Saves: ${has('saves') ? fmt(submission.saves) : 'x'}`);
          fieldLines.push(`Eng rate: ${has('eng_rate') ? submission.eng_rate : 'x'}%`);
          newText = before + '\n' + fieldLines.join('\n');
        }
      }
    } else if (caption === 'Story views') {
      if (has('first_story_views')) newText = replaceLeadingNumber(newText, 'Story views', submission.first_story_views);
    } else if (caption === 'Total link clicks') {
      if (has('link_clicks')) newText = replaceLeadingNumber(newText, 'Total link clicks', submission.link_clicks);
    } else if (caption === 'Total likes') {
      if (has('total_likes')) newText = replaceLeadingNumber(newText, 'Total likes', submission.total_likes);
    } else {
      continue; // not a shape we know how to update -- leave it alone
    }

    if (newText !== shape.text) {
      updates.push({ objectId: shape.objectId, oldText: shape.text, newText, caption });
    }
  }

  updates.discrepancies = discrepancies;
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

/** Given a shape's final rebuilt text, returns the updateTextStyle
 * requests needed to apply the deck's styling convention: the leading
 * number is bold, and (for the Total engagements box specifically)
 * each individual stat line is italic. Ranges are computed from the
 * text itself, not assumed -- this is the part most likely to have an
 * off-by-one bug, so it's covered by its own tests. */
function buildStyleRequests(objectId, newText, caption) {
  if (caption === 'Title') return []; // title styling is never touched, only its follower count changes

  const requests = [];

  // The leading number is always the first line -- bold it.
  const firstLineEnd = newText.indexOf('\n');
  if (firstLineEnd > 0) {
    requests.push({
      updateTextStyle: {
        objectId,
        textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: firstLineEnd },
        style: { bold: true },
        fields: 'bold',
      },
    });
  }

  // Total engagements specifically: italicize each individual stat
  // line (everything after the "Total engagements" caption line).
  if (caption === 'Total engagements') {
    const captionIdx = newText.indexOf('Total engagements');
    if (captionIdx !== -1) {
      const statsStart = newText.indexOf('\n', captionIdx) + 1;
      if (statsStart > 0 && statsStart < newText.length) {
        requests.push({
          updateTextStyle: {
            objectId,
            textRange: { type: 'FIXED_RANGE', startIndex: statsStart, endIndex: newText.length },
            style: { italic: true },
            fields: 'italic',
          },
        });
      }
    }
  }

  return requests;
}

module.exports = {
  classifyPresentation, findSlides, findTemplate, buildSlideUpdates, buildTitleText, buildStyleRequests, updateTitle,
  shapeText, extractSlide, classifySlide, // exported for testing
};
