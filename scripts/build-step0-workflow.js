'use strict';

/* Step 0: live verification probes. Run this first; it writes nothing. */

const B = require('./build.js');

module.exports = function buildStep0Workflow() {
  const CONFIG_FIELDS = B.SEARCH_CONFIG_FIELDS.concat([
    { name: 'probeFirstPages', value: 3, type: 'number' },
    { name: 'probeHighPage', value: 999, type: 'number' },
    { name: 'probeProfileCount', value: 3, type: 'number' },
    {
      name: 'knownProfileUrl',
      value: 'https://www.companywall.com.mk/kompanija/makitel-dooel-strumica/MM7EwwsC',
      type: 'string'
    }
  ]);

  const nodes = [
    B.manualTrigger('Start (manual)', [-320, 380]),
    B.setNode('Config', CONFIG_FIELDS, [-100, 380]),
    B.codeNode('Build Search Targets', 'step0-build-targets.js', [120, 380]),

    B.splitInBatchesNode('Loop Search Pages', [340, 380]),
    B.waitNode('Wait (search)', [340, 620]),
    B.scrapingBeeNode('ScrapingBee — Search Page', '={{ $json.searchUrl }}', [560, 620]),
    B.codeNode('Inspect Search Page', 'step0-inspect-search.js', [780, 620]),

    B.codeNode('Pick Profile Targets', 'step0-pick-profiles.js', [560, 260]),
    B.splitInBatchesNode('Loop Profiles', [780, 260]),
    B.waitNode('Wait (profile)', [780, 40]),
    B.scrapingBeeNode('ScrapingBee — Profile Page', '={{ $json.profileUrl }}', [1000, 40]),
    B.codeNode('Inspect Profile Page', 'step0-inspect-profile.js', [1220, 40]),

    B.codeNode('Step 0 Report', 'step0-report.js', [1000, 260]),
    B.noOpNode('Findings', [1220, 260]),

    B.stickyNote('Note — what this does',
      '## Step 0 — live verification (read-only)\n\n' +
      'Writes nothing anywhere. It fetches, through ScrapingBee:\n\n' +
      '- search pages **1, 2, 3** and a deliberately high page (**999**), to observe what ' +
      'the real end-of-results looks like;\n' +
      '- **4 profile pages** — one known-good control plus companies discovered by the probes.\n\n' +
      'Roughly **8 requests**, each preceded by a 3–5 s wait: about a minute.',
      [-320, 60], 460, 320, 4),

    B.stickyNote('Note — read the report',
      '## Reading the result\n\n' +
      'Open the **Step 0 Report** node output. It is structured as the seven Step 0 ' +
      'questions, each with a `verdict`.\n\n' +
      'Report the verdicts back **before** running the main workflow — especially ' +
      '`q5_totalVolume` (expectation was ~400 companies) and anything reading ' +
      '`NEEDS ATTENTION`, `UNVERIFIED` or `SUSPECT`.\n\n' +
      'If a search page parsed 0 rows, its `rawExcerpt` holds the first 3000 bytes of ' +
      'real HTML — that is what the row selectors need to be tuned against.',
      [1000, 480], 460, 340, 3)
  ];

  const connections = B.buildConnections({
    'Start (manual)': [[{ node: 'Config' }]],
    'Config': [[{ node: 'Build Search Targets' }]],
    'Build Search Targets': [[{ node: 'Loop Search Pages' }]],
    'Loop Search Pages': [[{ node: 'Pick Profile Targets' }], [{ node: 'Wait (search)' }]],
    'Wait (search)': [[{ node: 'ScrapingBee — Search Page' }]],
    'ScrapingBee — Search Page': [[{ node: 'Inspect Search Page' }]],
    'Inspect Search Page': [[{ node: 'Loop Search Pages' }]],

    'Pick Profile Targets': [[{ node: 'Loop Profiles' }]],
    'Loop Profiles': [[{ node: 'Step 0 Report' }], [{ node: 'Wait (profile)' }]],
    'Wait (profile)': [[{ node: 'ScrapingBee — Profile Page' }]],
    'ScrapingBee — Profile Page': [[{ node: 'Inspect Profile Page' }]],
    'Inspect Profile Page': [[{ node: 'Loop Profiles' }]],

    'Step 0 Report': [[{ node: 'Findings' }]]
  });

  return {
    name: 'CompanyWall MK — Step 0 live verification',
    nodes,
    connections,
    active: false,
    pinData: {},
    settings: { executionOrder: 'v1' },
    meta: { instanceId: 'companywall-mk-step0' },
    tags: []
  };
};
