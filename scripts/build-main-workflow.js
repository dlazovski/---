'use strict';

/* Main workflow: nationwide revenue-filtered scrape -> Google Sheet. */

const B = require('./build.js');

module.exports = function buildMainWorkflow() {
  const CONFIG_FIELDS = B.SEARCH_CONFIG_FIELDS.concat([
    // Pagination / volume controls
    { name: 'startPage', value: 1, type: 'number' },
    { name: 'maxPages', value: 60, type: 'number' },
    { name: 'maxCompanies', value: 0, type: 'number' },
    { name: 'maxConsecutiveFailures', value: 3, type: 'number' },
    { name: 'writePartialRows', value: false, type: 'boolean' },
    // Google Sheet target — must be filled in before running
    { name: 'googleSheetId', value: 'PUT-YOUR-GOOGLE-SHEET-ID-HERE', type: 'string' },
    { name: 'googleSheetName', value: 'Sheet1', type: 'string' }
  ]);

  const nodes = [
    B.manualTrigger('Start (manual)', [-320, 380]),
    B.setNode('Config', CONFIG_FIELDS, [-100, 380]),
    B.codeNode('Init State', 'init-state.js', [120, 380]),

    // --- search pagination loop ---
    B.codeNode('Build Search URL', 'build-search-url.js', [340, 380]),
    B.waitNode('Wait (search)', [560, 380]),
    B.scrapingBeeNode('ScrapingBee — Search Page', '={{ $json.searchUrl }}', [780, 380]),
    B.codeNode('Parse Search Results', 'parse-search-results.js', [1000, 380]),
    B.ifBooleanNode('More Pages?', '={{ $json.stop }}', 'false', [1220, 380]),

    // --- per-company profile loop ---
    B.codeNode('Dedupe Companies', 'dedupe-companies.js', [1440, 500]),
    B.splitInBatchesNode('Loop Over Companies', [1660, 500]),
    B.waitNode('Wait (profile)', [1660, 760]),
    B.scrapingBeeNode('ScrapingBee — Company Profile', '={{ $json.profileUrl }}', [1880, 760]),
    B.codeNode('Parse Profile', 'parse-profile.js', [2100, 760]),
    B.ifBooleanNode('Needs /lica?', '={{ $json._needsLica }}', 'true', [2320, 760]),

    // --- conditional /lica fallback ---
    B.waitNode('Wait (lica)', [2540, 620]),
    B.scrapingBeeNode('ScrapingBee — /lica', '={{ $json._licaUrl }}', [2760, 620]),
    B.codeNode('Parse Lica', 'parse-lica.js', [2980, 620]),

    // --- write ---
    B.ifBooleanNode('Write Row?', '={{ $json._write }}', 'true', [3200, 760]),
    B.codeNode('Prepare Sheet Row', 'prepare-sheet-row.js', [3420, 680]),
    B.googleSheetsAppendNode('Google Sheets — Append', [3640, 680]),

    // --- summary ---
    B.codeNode('Build Summary', 'build-summary.js', [1880, 340]),
    B.noOpNode('Run Summary', [2100, 340]),

    B.stickyNote('Note — Step 0 first',
      '## Run Step 0 first\n\n' +
      'Import and run **step0-verification.json** before this workflow.\n\n' +
      'The search-results page markup and the end-of-results behaviour have **not** been ' +
      'verified against the live site. The parsers here are written defensively, but the ' +
      'Step 0 report is what confirms they match reality.\n\n' +
      'See `docs/step-0-verification.md`.',
      [-320, 60], 460, 300, 3),

    B.stickyNote('Note — before running',
      '## Set these before running\n\n' +
      '1. **Config → googleSheetId** — the existing sheet\'s ID.\n' +
      '2. **Config → googleSheetName** — the tab name.\n' +
      '3. Each **ScrapingBee** node → pick the existing ScrapingBee credential ' +
      '(HTTP Query Auth, param name `api_key`).\n' +
      '4. **Google Sheets — Append** → pick the Google credential.\n\n' +
      '**Tip:** set `maxCompanies` to 5 for a smoke run, then back to 0 for the full run.',
      [180, 60], 460, 320, 5),

    B.stickyNote('Note — rate limiting',
      '## Rate limiting\n\n' +
      'Every outbound request is preceded by a **Wait** node with a fresh random ' +
      '**3–5 second** delay. Batch size is **1**, so at most one request is in flight ' +
      'against the site at a time.\n\n' +
      'Do not raise the batch size or remove a Wait node — CompanyWall explicitly asks ' +
      'not to be sent bursts of search requests.',
      [1440, 900], 440, 260, 6),

    B.stickyNote('Note — request budget',
      '## 2 requests per company\n\n' +
      'Контакт лице comes from the **main profile page** (prefer `Управител`, ' +
      'fall back to `Сопственик`).\n\n' +
      'The `/lica` sub-page is fetched **only** when the profile page lists nobody at ' +
      'all — keeping the default at 2 ScrapingBee requests per company, not 3.\n\n' +
      'No authenticated URLs are ever requested (`/CompanyBonitet`, `/CompanyPersons`).',
      [2540, 900], 460, 280, 7)
  ];

  const connections = B.buildConnections({
    'Start (manual)': [[{ node: 'Config' }]],
    'Config': [[{ node: 'Init State' }]],
    'Init State': [[{ node: 'Build Search URL' }]],
    'Build Search URL': [[{ node: 'Wait (search)' }]],
    'Wait (search)': [[{ node: 'ScrapingBee — Search Page' }]],
    'ScrapingBee — Search Page': [[{ node: 'Parse Search Results' }]],
    'Parse Search Results': [[{ node: 'More Pages?' }]],
    // true = keep paginating (loops back); false = pagination finished
    'More Pages?': [[{ node: 'Build Search URL' }], [{ node: 'Dedupe Companies' }]],

    'Dedupe Companies': [[{ node: 'Loop Over Companies' }]],
    // output 0 = done, output 1 = loop
    'Loop Over Companies': [[{ node: 'Build Summary' }], [{ node: 'Wait (profile)' }]],

    'Wait (profile)': [[{ node: 'ScrapingBee — Company Profile' }]],
    'ScrapingBee — Company Profile': [[{ node: 'Parse Profile' }]],
    'Parse Profile': [[{ node: 'Needs /lica?' }]],
    'Needs /lica?': [[{ node: 'Wait (lica)' }], [{ node: 'Write Row?' }]],

    'Wait (lica)': [[{ node: 'ScrapingBee — /lica' }]],
    'ScrapingBee — /lica': [[{ node: 'Parse Lica' }]],
    'Parse Lica': [[{ node: 'Write Row?' }]],

    // false = profile fetch failed and partial rows are disabled: skip, keep looping
    'Write Row?': [[{ node: 'Prepare Sheet Row' }], [{ node: 'Loop Over Companies' }]],
    'Prepare Sheet Row': [[{ node: 'Google Sheets — Append' }]],
    'Google Sheets — Append': [[{ node: 'Loop Over Companies' }]],

    'Build Summary': [[{ node: 'Run Summary' }]]
  });

  return {
    name: 'CompanyWall MK — revenue-filtered company scrape',
    nodes,
    connections,
    active: false,
    pinData: {},
    settings: { executionOrder: 'v1' },
    meta: { instanceId: 'companywall-mk-scraper' },
    tags: []
  };
};
