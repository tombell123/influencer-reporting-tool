// api/lookup.js
//
// Powers the form's dropdowns with live data instead of the hardcoded
// mock lists -- called by the front end whenever a dropdown needs
// populating. One endpoint, different behavior based on `type`:
//
//   GET /api/lookup?type=campaigns
//     -> { campaigns: ["Kids SS26", "Cath Kidston SS26", ...] }
//     (the master Sheet's actual tab names)
//
//   GET /api/lookup?type=projects&campaign=Kids+SS26
//     -> { projects: ["Back To School", ...] }
//     (distinct values in that tab's Project column)
//
//   GET /api/lookup?type=influencers&campaign=Kids+SS26&project=Back+To+School
//     -> { influencers: ["@la_sidhu", ...] }
//
//   GET /api/lookup?type=decks
//     -> { decks: [{ id, name }, ...] }
//     (every Google Slides file in the shared Drive folder)

const { google } = require('googleapis');
const { extractDistinctProjects, extractInfluencersForProject } = require('./lib/lookupLogic');
const { classifyPresentation, findSlides } = require('./lib/slidesLogic');

// Same master sheet used by submit.js. If this ever needs to become
// discoverable too (multiple master sheets), this is the one place
// that would need to change.
const SPREADSHEET_ID = '1XuUaK968_Ac0T8GGzaGSQf3tYGT8Ko9FJeOf_92XJGg';

// TODO: set this to the shared folder's ID once created (the string
// in its URL after "folders/"). Decks won't be discoverable until
// this is filled in.
const DECK_FOLDER_ID = '1gCCypWjpIpBBj5JxkGWesZeyZXjRha0t';

async function getAuthClient() {
  const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/presentations.readonly',
    ],
  });
  return auth.getClient();
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { type, campaign, project } = req.query;

  try {
    const client = await getAuthClient();

    if (type === 'campaigns') {
      const sheets = google.sheets({ version: 'v4', auth: client });
      const { data } = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const campaigns = (data.sheets || []).map(s => s.properties.title);
      return res.status(200).json({ campaigns });
    }

    if (type === 'projects') {
      if (!campaign) return res.status(400).json({ error: 'Missing campaign parameter' });
      const sheets = google.sheets({ version: 'v4', auth: client });
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${campaign}'!A2:X1000`,
      });
      const projects = extractDistinctProjects(data.values || []);
      return res.status(200).json({ projects });
    }

    if (type === 'influencers') {
      if (!campaign || !project) return res.status(400).json({ error: 'Missing campaign or project parameter' });
      const sheets = google.sheets({ version: 'v4', auth: client });
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${campaign}'!A2:X1000`,
      });
      const influencers = extractInfluencersForProject(data.values || [], project);
      return res.status(200).json({ influencers });
    }

    if (type === 'decks') {
      if (DECK_FOLDER_ID === 'REPLACE_ME_WITH_REAL_FOLDER_ID') {
        return res.status(200).json({ decks: [], warning: 'DECK_FOLDER_ID not configured yet' });
      }
      const drive = google.drive({ version: 'v3', auth: client });
      const { data } = await drive.files.list({
        q: `'${DECK_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.presentation' and trashed = false`,
        fields: 'files(id, name)',
      });
      const decks = (data.files || []).map(f => ({ id: f.id, name: f.name }));
      return res.status(200).json({ decks });
    }

    if (type === 'check-slide') {
      const { presentationId, influencer, platform, piece } = req.query;
      if (!presentationId || !influencer || !platform || !piece) {
        return res.status(400).json({ error: 'Missing presentationId, influencer, platform, or piece' });
      }
      const slides = google.slides({ version: 'v1', auth: client });
      const { data: presentation } = await slides.presentations.get({ presentationId });
      const classified = classifyPresentation(presentation);
      const matches = findSlides(classified, influencer, platform, piece);
      return res.status(200).json({ exists: matches.length === 1, matchCount: matches.length });
    }

    return res.status(400).json({ error: `Unknown lookup type "${type}"` });

  } catch (err) {
    return res.status(502).json({
      error: `Lookup failed: ${err.message}`,
      debug: { name: err.name, status: err.status ?? err.code ?? null },
    });
  }
};
