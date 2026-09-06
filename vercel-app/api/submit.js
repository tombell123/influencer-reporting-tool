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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { campaign, influencer, platform, followers, spreadsheetId, images, project, tabName, contentPiece } = req.body || {};
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
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
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

    return res.status(200).json({ results, warnings });

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
