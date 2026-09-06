// api/submit.js
// Vercel's serverless function convention: files in /api become
// endpoints automatically at /api/<filename> -- no routing config
// needed, unlike Netlify's netlify.toml + netlify/functions folder.
// Everything else here is IDENTICAL logic to netlify-app's submit.js
// -- only the request/response handling at the top and bottom differs.

const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const { findExistingRow, buildAdditiveUpdate } = require('./lib/sheetLogic');
const { EXTRACTION_SYSTEM_PROMPT, parseExtractionResponse } = require('./lib/extraction');
const { assembleSubmissions, filterPiecesBySelection } = require('./lib/assemble');
const { classifyPresentation, findSlides, findTemplate, buildSlideUpdates, buildTitleText } = require('./lib/slidesLogic');

/** Updates an EXISTING slide's stat-box shapes in place, or clones a
 * named template for a brand-new influencer. Returns a short status
 * string for the response, and never throws for "expected" cases
 * (ambiguous match, missing template) -- those come back as a status
 * message, same pattern as the Sheet's needs_new_row handling. */
async function updateDeck(slidesClient, presentationId, influencer, platform, piece, submission) {
  const { data: presentation } = await slidesClient.presentations.get({ presentationId });
  const classified = classifyPresentation(presentation);

  const matches = findSlides(classified, influencer, platform, piece);

  if (matches.length > 1) {
    return { status: 'ambiguous', message: `Found ${matches.length} matching slides for ${influencer} -- this is the Post 1/Post 2 collision case; pick the specific one via the content-piece dropdown rather than submitting blind.` };
  }

  if (matches.length === 1) {
    const updates = buildSlideUpdates(matches[0], submission, platform);
    if (updates.length === 0) {
      return {
        status: 'no_change',
        message: 'Found the slide but nothing recognized needed updating.',
        debug: { shapes: matches[0].shapes.map(s => ({ objectId: s.objectId, text: s.text })) },
      };
    }
    const requests = updates.flatMap(u => [
      { deleteText: { objectId: u.objectId, textRange: { type: 'ALL' } } },
      { insertText: { objectId: u.objectId, text: u.newText, insertionIndex: 0 } },
    ]);
    await slidesClient.presentations.batchUpdate({ presentationId, requestBody: { requests } });
    return { status: 'updated', shapesChanged: updates.length };
  }

  // No match -- clone the template. This is the riskier path (it
  // changes deck structure, not just text) so it only does the clone
  // itself; filling in the new slide's numbers is a fast follow-up
  // update using the exact same buildSlideUpdates logic once the
  // clone's new objectId is known.
  let template;
  try {
    template = findTemplate(classified, piece);
  } catch (err) {
    return { status: 'error', message: err.message };
  }

  const newSlideId = `slide_${Date.now()}`;
  await slidesClient.presentations.batchUpdate({
    presentationId,
    requestBody: { requests: [{ duplicateObject: { objectId: template.objectId, objectIds: { [template.objectId]: newSlideId } } }] },
  });

  // Re-fetch to get the clone's actual shape objectIds (duplicateObject
  // maps the page id but not each child shape id predictably), then
  // apply the same update logic to the freshly cloned slide.
  const { data: refreshed } = await slidesClient.presentations.get({ presentationId });
  const reclassified = classifyPresentation(refreshed);
  const clonedSlide = reclassified.find(s => s.objectId === newSlideId);
  if (!clonedSlide) {
    return { status: 'error', message: 'Cloned the template but could not locate the new slide afterward -- check the deck manually.' };
  }

  const requests = [];
  // Title (shape[0]) and subtitle (shape[1]) are consistently the
  // first two shapes on every real slide in this deck -- they're
  // blank/placeholder on the template and need setting for the first
  // time here, unlike an existing slide's title which is already
  // correct and untouched by buildSlideUpdates.
  if (clonedSlide.shapes[0] && clonedSlide.shapes[1]) {
    const { title, subtitle } = buildTitleText(piece, influencer, submission);
    requests.push(
      { deleteText: { objectId: clonedSlide.shapes[0].objectId, textRange: { type: 'ALL' } } },
      { insertText: { objectId: clonedSlide.shapes[0].objectId, text: title, insertionIndex: 0 } },
      { deleteText: { objectId: clonedSlide.shapes[1].objectId, textRange: { type: 'ALL' } } },
      { insertText: { objectId: clonedSlide.shapes[1].objectId, text: subtitle, insertionIndex: 0 } },
    );
  }

  const updates = buildSlideUpdates(clonedSlide, submission, platform);
  updates.forEach(u => requests.push(
    { deleteText: { objectId: u.objectId, textRange: { type: 'ALL' } } },
    { insertText: { objectId: u.objectId, text: u.newText, insertionIndex: 0 } },
  ));

  if (requests.length) {
    await slidesClient.presentations.batchUpdate({ presentationId, requestBody: { requests } });
  }
  return { status: 'cloned_and_updated', shapesChanged: updates.length, titleSet: !!(clonedSlide.shapes[0] && clonedSlide.shapes[1]) };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { campaign, influencer, platform, followers, spreadsheetId, images, project, tabName, contentPiece, presentationId } = req.body || {};
  if (!campaign || !project || !influencer || !platform || !spreadsheetId || !images?.length) {
    return res.status(400).json({ error: 'Missing required fields (campaign and project are both required)' });
  }
  const resolvedProject = project;
  const resolvedTab = tabName || campaign;

  // Everything below is wrapped in one top-level try/catch -- nothing
  // should ever be able to crash the function silently. Whatever
  // fails, we want a JSON error back with enough detail to diagnose
  // it, not Vercel's generic FUNCTION_INVOCATION_FAILED page.
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let extraction;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          ...images.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: img },
          })),
          { type: 'text', text: 'Extract the pieces from these screenshots.' },
        ],
      }],
    });

    const textBlock = message.content?.find(b => b.type === 'text');
    if (!textBlock || typeof textBlock.text !== 'string') {
      return res.status(502).json({
        error: 'Extraction failed: response had no readable text content',
        debug: {
          stopReason: message.stop_reason,
          contentTypes: message.content?.map(b => b.type),
          fullContent: message.content,
        },
      });
    }
    extraction = parseExtractionResponse(textBlock.text);

    const { pieces: rawPieces, warnings: extractionWarnings } = extraction;
    if (rawPieces.length === 0) {
      return res.status(422).json({ error: 'No readable data found in screenshots', warnings: extractionWarnings });
    }

    const { kept: pieces, warnings: filterWarnings } = filterPiecesBySelection(rawPieces, platform, contentPiece);
    const warnings = [...extractionWarnings, ...filterWarnings];

    if (pieces.length === 0) {
      return res.status(422).json({
        error: `None of the uploaded screenshots matched the selected platform/content piece.`,
        warnings,
      });
    }

    const submissions = assembleSubmissions(pieces);

    // Parse the service account key separately with its own clear
    // error, since a malformed value here is a very plausible failure
    // point given how much has been copy-pasted into env vars today.
    let serviceAccountKey;
    try {
      serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch (parseErr) {
      return res.status(502).json({
        error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON -- it may have gotten corrupted when pasted into Vercel (extra characters, missing braces, or a stray newline). Re-copy the ENTIRE contents of the downloaded key file and re-paste it.',
        debug: {
          parseErrorMessage: parseErr.message,
          keyLength: process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.length ?? 0,
          keyStartsWithBrace: process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim().startsWith('{'),
          keyEndsWithBrace: process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim().endsWith('}'),
        },
      });
    }

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccountKey,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/presentations',
      ],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const results = [];
    for (const submission of submissions) {
      if (followers != null) submission.followers = followers;

      const range = `'${resolvedTab}'!A2:X1000`;
      const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      const rows = data.values || [];

      const foundIdx = findExistingRow(rows, resolvedProject, influencer, submission.channel);

      if (foundIdx === -1) {
        results.push({
          channel: submission.channel,
          status: 'needs_new_row',
          message: `No existing row for ${influencer} (${submission.channel}) in project "${resolvedProject}" on tab "${resolvedTab}" -- new-row insertion isn't wired into this function yet.`,
        });
        continue;
      }

      const sheetRow = foundIdx + 2;
      const row = rows[foundIdx];
      const updates = buildAdditiveUpdate(row, submission, resolvedTab, sheetRow);

      if (updates.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: updates.map(u => ({ range: u.range, values: [[u.value]] })),
          },
        });
      }
      results.push({ channel: submission.channel, status: 'updated', cellsWritten: updates.length });
    }

    let deckResult = null;
    if (presentationId) {
      const slidesClient = google.slides({ version: 'v1', auth: client });
      // Use the FIRST submission for the deck (matches the front
      // end's single content-piece selection -- if both IG and TT
      // came out of one batch, the deck side only ever expects one
      // platform/piece per submission anyway per the dropdown design).
      const primary = submissions[0];
      // The form's dropdown speaks 'post1'/'post2'/'stories'; the deck
      // logic speaks 'reel'/'stories'/'tiktok'. Post 1 and Post 2 both
      // mean "the reel slide" -- the dropdown value only disambiguates
      // which one when there's a collision, it's not a separate deck
      // piece type. TikTok is determined by platform, not the dropdown.
      const deckPiece = platform === 'TT' ? 'tiktok' : (contentPiece === 'stories' ? 'stories' : 'reel');
      try {
        deckResult = await updateDeck(slidesClient, presentationId, influencer, platform, deckPiece, primary);
      } catch (err) {
        deckResult = { status: 'error', message: `Deck update failed: ${err.message}` };
      }
    }

    return res.status(200).json({ results, warnings, deckResult });

  } catch (err) {
    return res.status(502).json({
      error: `Something failed: ${err.message}`,
      debug: {
        name: err.name,
        message: err.message,
        cause: err.cause ? String(err.cause) : null,
        status: err.status ?? err.code ?? null,
        stack: err.stack ? err.stack.split('\n').slice(0, 8) : null,
        hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        hasGoogleKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      },
    });
  }
};
