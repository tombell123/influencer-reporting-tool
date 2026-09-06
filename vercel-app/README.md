# Influencer Reporting Tool (Vercel version)

Same logic as the Netlify version -- only the hosting adapter differs
(api/submit.js instead of netlify/functions/submit.js). See the code
comments in api/submit.js for what changed vs. the Netlify version
(basically nothing except request/response handling).

## Setup
1. Push this to GitHub, import it at vercel.com ("Add New Project" -> import repo)
2. Vercel auto-detects the /api folder -- no config needed for routing
3. Project Settings > Environment Variables, add:
   - ANTHROPIC_API_KEY
   - GOOGLE_SERVICE_ACCOUNT_KEY (paste the whole service account JSON)
4. Deploy

## Testing locally (no live keys needed)
node test/test_sheetLogic.js
node test/test_extraction.js
node test/test_project_tab_bug.js



