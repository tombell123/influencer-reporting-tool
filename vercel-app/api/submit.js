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
const { assembleSubmissions } = require('./lib/assemble');

async function getSheetsClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { campaign, influencer, platform, followers, spreadsheetId, images, project, tabName } = req.body || {};
  if (!campaign || !project || !influencer || !platform || !spreadsheetId || !images?.length) {
    return res.status(400).json({ error: 'Missing required fields (campaign and project are both required)' });
  }
  const resolvedProject = project;
  const resolvedTab = tabName || campaign;

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  let extraction;
  try {
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
    extraction = parseExtractionResponse(message.content[0].text);
  } catch (err) {
    return res.status(502).json({ error: `Extraction failed: ${err.message}` });
  }

  const { pieces, warnings } = extraction;
  if (pieces.length === 0) {
    return res.status(422).json({ error: 'No readable data found in screenshots', warnings });
  }

  const submissions = assembleSubmissions(pieces);
  const sheets = await getSheetsClient();
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
};
