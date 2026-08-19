'use strict';

/*
 * End-to-end simulation of the generated workflow.
 *
 * This executes the ACTUAL jsCode from workflows/companywall-mk-scraper.json in a
 * minimal stand-in for the n8n Code-node runtime ($input, $(), static data), with
 * fixture HTML standing in for ScrapingBee responses. It exercises what the parser
 * unit tests cannot: the revenue band sweep, pagination state and stop conditions,
 * de-duplication against the existing sheet, the /lica branch, profile-failure
 * skipping, and the final sheet row.
 *
 * It does NOT verify n8n's own node semantics — only that the code we ship does
 * the right thing when fed the data n8n will feed it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/companywall-mk-scraper.json'), 'utf8'));
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const MAKITEL_EDB = '4027015512345';

// --- minimal Code-node runtime ---------------------------------------------

function nodeByName(name) {
  const node = WORKFLOW.nodes.find((n) => n.name === name);
  if (!node) throw new Error('node not found in generated workflow: ' + name);
  return node;
}

function runCode(nodeName, { input = [], nodes = {}, staticData = {} }) {
  const code = nodeByName(nodeName).parameters.jsCode;
  const $input = {
    first: () => input[0],
    last: () => input[input.length - 1],
    all: () => input
  };
  const $ = (name) => {
    if (!nodes[name]) throw new Error('simulated $(\'' + name + '\') has no recorded output');
    return { first: () => nodes[name][0], all: () => nodes[name], last: () => nodes[name][nodes[name].length - 1] };
  };
  const fn = new Function('$input', '$', '$getWorkflowStaticData', code);
  return fn($input, $, () => staticData);
}

/** Read the Config Set node's literal values straight out of the built workflow. */
function configFromWorkflow() {
  const assignments = nodeByName('Config').parameters.assignments.assignments;
  const json = {};
  for (const a of assignments) json[a.name] = a.value;
  return [{ json }];
}

/**
 * Fixture-backed stand-in for the ScrapingBee HTTP Request nodes.
 * Only the lowest revenue band's first page has companies; everything else is
 * an empty result page, so band advancement and termination get exercised.
 */
function makeFakeFetch(requestLog) {
  return function fakeFetch(targetUrl) {
    requestLog.push(targetUrl);

    if (targetUrl.includes('/prebaruvanje')) {
      const from = Number((targetUrl.match(/dsm\[0\]\.From=(\d+)/) || [])[1]);
      const page = Number((targetUrl.match(/[?&]p=(\d+)/) || [])[1] || 1);
      const hasResults = from === 5000000 && page === 1;
      return { json: { statusCode: 200, data: fixture(hasResults ? 'search-page.html' : 'search-empty.html') } };
    }
    if (targetUrl.endsWith('/lica')) {
      return { json: { statusCode: 200, data: fixture('lica.html') } };
    }
    if (targetUrl.includes('MM7EwwsC')) {
      return { json: { statusCode: 200, data: fixture('profile-makitel.html') } };
    }
    if (targetUrl.includes('AB12cdEf')) {
      return { json: { statusCode: 200, data: fixture('profile-no-people.html') } };
    }
    if (targetUrl.includes('ZZ99xyQq')) {
      // Simulates a request that exhausted its retries: onError=continueRegularOutput.
      return { json: { error: 'connect ETIMEDOUT' } };
    }
    throw new Error('unexpected URL in simulation: ' + targetUrl);
  };
}

/**
 * Run the whole workflow against the fixtures.
 * `existingRows` stands in for what the Read Existing Sheet node returns; an
 * empty sheet yields one empty item, matching alwaysOutputData.
 */
function runWorkflow(existingRows) {
  const staticData = {};
  const nodes = {};
  const sheetRows = [];
  const requestLog = [];
  const fakeFetch = makeFakeFetch(requestLog);

  nodes['Config'] = configFromWorkflow();
  const sheetItems = (existingRows && existingRows.length)
    ? existingRows.map((json) => ({ json }))
    : [{ json: {} }];
  nodes['Read Existing Sheet'] = sheetItems;
  nodes['Init State'] = runCode('Init State', { input: sheetItems, nodes, staticData });

  // --- band + page sweep ---
  let state = nodes['Init State'];
  let guard = 0;
  for (;;) {
    if (++guard > 60) throw new Error('search sweep did not terminate');
    nodes['Build Search URL'] = runCode('Build Search URL', { input: state, nodes, staticData });
    const response = fakeFetch(nodes['Build Search URL'][0].json.searchUrl);
    nodes['Parse Search Results'] = runCode('Parse Search Results', { input: [response], nodes, staticData });
    state = nodes['Parse Search Results'];
    if (state[0].json.stop) break;
  }
  const pagination = state[0].json;

  // --- per-company loop ---
  const companies = runCode('Dedupe Companies', { input: state, nodes, staticData });
  for (const company of companies) {
    nodes['Loop Over Companies'] = [company];
    const profileResponse = fakeFetch(company.json.profileUrl);
    nodes['Parse Profile'] = runCode('Parse Profile', { input: [profileResponse], nodes, staticData });

    let record = nodes['Parse Profile'];
    if (record[0].json._needsLica) {
      const licaResponse = fakeFetch(record[0].json._licaUrl);
      nodes['Parse Lica'] = runCode('Parse Lica', { input: [licaResponse], nodes, staticData });
      record = nodes['Parse Lica'];
    }
    if (!record[0].json._write) continue;

    const rows = runCode('Prepare Sheet Row', { input: record, nodes, staticData });
    rows.forEach((r) => sheetRows.push(r.json));
  }

  const summary = runCode('Build Summary', { input: [], nodes, staticData })[0].json;
  return { pagination, companies: companies.map((c) => c.json), sheetRows, summary, requestLog, staticData };
}

// Scenario A: empty sheet — a first run.
const FIRST = runWorkflow([]);
// Scenario B: the sheet already holds МАКИТЕЛ — a follow-up run.
const REPEAT = runWorkflow([
  { 'Клиент': 'МАКИТЕЛ ДООЕЛ', 'Даночен БРОЈ': MAKITEL_EDB },
  { 'Клиент': 'НЕПОЗНАТА ДОО', 'Даночен БРОЈ': '4099999999999' }
]);

// ---------------------------------------------------------------------------
// Revenue band sweep
// ---------------------------------------------------------------------------

test('sweep: every configured revenue band is searched', () => {
  assert.strictEqual(FIRST.summary.revenueBandsPlanned, 8);
  assert.strictEqual(FIRST.summary.revenueBandsCompleted, 8);
  assert.match(FIRST.pagination.stopReason, /all 8 revenue band\(s\) swept/);
});

test('sweep: the bands are contiguous and cover the whole configured range', () => {
  const bands = FIRST.summary.revenueBands;
  assert.strictEqual(bands[0].from, 5000000);
  assert.strictEqual(bands[bands.length - 1].to, 400000000);
  for (let i = 1; i < bands.length; i++) {
    assert.strictEqual(bands[i].from, bands[i - 1].to + 1, 'gap or overlap between bands ' + i + ' and ' + (i + 1));
  }
});

test('sweep: each band is searched with its own revenue bounds', () => {
  const searchUrls = FIRST.requestLog.filter((u) => u.includes('/prebaruvanje'));
  const ranges = new Set(searchUrls.map((u) => (u.match(/dsm\[0\]\.From=(\d+)&dsm\[0\]\.To=(\d+)/) || []).slice(1).join('-')));
  assert.strictEqual(ranges.size, 8, 'expected 8 distinct revenue ranges to be searched');
});

test('sweep: pagination advances within a band, then resets for the next band', () => {
  const pages = FIRST.requestLog
    .filter((u) => u.includes('/prebaruvanje'))
    .map((u) => Number((u.match(/[?&]p=(\d+)/) || [])[1]));
  // Band 1 has results on page 1, so it goes on to page 2; every later band ends on page 1.
  assert.deepStrictEqual(pages, [1, 2, 1, 1, 1, 1, 1, 1, 1]);
});

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

test('first run: every company found is queued exactly once', () => {
  assert.strictEqual(FIRST.companies.length, 3);
  assert.strictEqual(FIRST.summary.companiesQueued, 3);
  assert.strictEqual(new Set(FIRST.companies.map((c) => c.edb)).size, 3);
});

test('first run: a failed profile fetch is logged and skipped, not fatal', () => {
  assert.strictEqual(FIRST.summary.profileFetchFailures, 1);
  assert.strictEqual(FIRST.summary.rowsSkipped, 1);
  const failure = FIRST.summary.failedUrls.find((f) => f.stage === 'profile');
  assert.ok(failure, 'the failed profile URL was not recorded');
  assert.match(failure.url, /ZZ99xyQq/);
  assert.strictEqual(FIRST.sheetRows.length, 2);
});

test('first run: sheet rows carry exactly the eight expected columns, in order', () => {
  const EXPECTED = [
    'Клиент', 'Град', 'ЕМБС', 'Даночен БРОЈ',
    'Шифра на дејност', 'Контакт лице', 'Контакт телефон', 'Меил адреса'
  ];
  for (const row of FIRST.sheetRows) {
    assert.deepStrictEqual(Object.keys(row), EXPECTED);
  }
});

test('first run: the fully-populated company produces a complete row', () => {
  const row = FIRST.sheetRows.find((r) => r['Клиент'] === 'МАКИТЕЛ ДООЕЛ');
  assert.ok(row, 'МАКИТЕЛ row missing');
  assert.deepStrictEqual(row, {
    'Клиент': 'МАКИТЕЛ ДООЕЛ',
    'Град': 'Струмица',
    'ЕМБС': '7145263',
    'Даночен БРОЈ': MAKITEL_EDB,
    'Шифра на дејност': '27.110 - Производство на електромотори, генератори и трансформатори',
    'Контакт лице': 'ГОРАН СТОЈАНОВ',
    'Контакт телефон': '046/250-383; +389 70 123 456',
    'Меил адреса': 'kontakt@makitel.com.mk; prodazba@makitel.com.mk'
  });
});

test('first run: the /lica fallback fires only for the company with no people listed', () => {
  assert.strictEqual(FIRST.summary.licaFallbacksNeeded, 1);
  const row = FIRST.sheetRows.find((r) => r['Клиент'] === 'ТЕСТ КОМПАНИЈА ДОО');
  assert.strictEqual(row['Контакт лице'], 'ДЕЈАН НИКОЛОВ');
});

test('first run: missing phone/e-mail leaves blank cells rather than failing the row', () => {
  const row = FIRST.sheetRows.find((r) => r['Клиент'] === 'ТЕСТ КОМПАНИЈА ДОО');
  assert.strictEqual(row['Контакт телефон'], '');
  assert.strictEqual(row['Меил адреса'], '');
  assert.strictEqual(FIRST.summary.companiesWithNoPhone, 1);
  assert.strictEqual(FIRST.summary.companiesWithNoEmail, 1);
});

test('first run: an empty sheet seeds nothing and is not mistaken for a row', () => {
  assert.strictEqual(FIRST.summary.existingRowsReadFromSheet, 0);
  assert.strictEqual(FIRST.summary.existingCompaniesSeeded, 0);
  assert.strictEqual(FIRST.summary.companiesSkippedAsAlreadyInSheet, 0);
});

test('first run: the summary reconciles with what was actually written', () => {
  const s = FIRST.summary;
  assert.strictEqual(s.newRowsWrittenToSheet, FIRST.sheetRows.length);
  assert.strictEqual(s.profilesFetchedOk + s.profileFetchFailures, s.companiesQueued);
  assert.strictEqual(s.newRowsWrittenToSheet + s.rowsSkipped, s.companiesQueued);
  assert.ok(s.startedAt && s.finishedAt);
});

// ---------------------------------------------------------------------------
// Follow-up run — de-duplication against the sheet
// ---------------------------------------------------------------------------

test('repeat run: existing sheet rows are read and seeded by ЕДБ', () => {
  assert.strictEqual(REPEAT.summary.existingRowsReadFromSheet, 2);
  assert.strictEqual(REPEAT.summary.existingCompaniesSeeded, 2);
  assert.strictEqual(REPEAT.summary.existingRowsWithUnreadableEdb, 0);
});

test('repeat run: a company already in the sheet is never queued or re-fetched', () => {
  assert.strictEqual(REPEAT.summary.companiesSkippedAsAlreadyInSheet, 1);
  assert.strictEqual(REPEAT.summary.companiesQueued, 2);
  assert.ok(!REPEAT.companies.some((c) => c.edb === MAKITEL_EDB), 'МАКИТЕЛ was queued despite being in the sheet');
  assert.ok(!REPEAT.requestLog.some((u) => u.includes('MM7EwwsC')), 'МАКИТЕЛ profile was fetched despite being in the sheet');
});

test('repeat run: only genuinely new companies are appended', () => {
  assert.strictEqual(REPEAT.sheetRows.length, 1);
  assert.strictEqual(REPEAT.sheetRows[0]['Клиент'], 'ТЕСТ КОМПАНИЈА ДОО');
  assert.strictEqual(REPEAT.summary.newRowsWrittenToSheet, 1);
});

test('repeat run: an ЕДБ stored as a number by Sheets still matches', () => {
  const run = runWorkflow([{ 'Клиент': 'МАКИТЕЛ ДООЕЛ', 'Даночен БРОЈ': Number(MAKITEL_EDB) }]);
  assert.strictEqual(run.summary.existingCompaniesSeeded, 1);
  assert.strictEqual(run.summary.companiesSkippedAsAlreadyInSheet, 1);
});

test('repeat run: a mismatched ЕДБ column is flagged loudly rather than duplicating silently', () => {
  const run = runWorkflow([{ 'Клиент': 'МАКИТЕЛ ДООЕЛ', 'Tax number': MAKITEL_EDB }]);
  assert.strictEqual(run.summary.existingCompaniesSeeded, 0);
  assert.strictEqual(run.summary.existingRowsWithUnreadableEdb, 1);
  assert.ok(
    run.summary.warnings.some((w) => w.includes('seeded no ЕДБ')),
    'no warning raised about the unreadable ЕДБ column'
  );
});

test('repeat run: an exhausted filter says so explicitly', () => {
  const everything = FIRST.companies.map((c) => ({ 'Даночен БРОЈ': c.edb }));
  const run = runWorkflow(everything);
  assert.strictEqual(run.summary.companiesQueued, 0);
  assert.strictEqual(run.summary.newRowsWrittenToSheet, 0);
  assert.match(run.summary.note, /search is exhausted/);
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test('the search URL sent for the first band, page 1, is the confirmed URL', () => {
  const expected = 'https://www.companywall.com.mk/prebaruvanje?cr=MKD&n=&mv=&r=&c=&cp=&at=&area=&subarea=' +
    '&sbjact=t&blckd=&dbf=&dbt=&type=&bly=2025&dsm[0].Code=201&dsm[0].From=5000000&dsm[0].To=8646816' +
    '&dsm[1].Code=48&dsm[1].From=0&dsm[1].To=0&dsm[-1].Code=0&dsm[-1].From=0&dsm[-1].To=0' +
    '&distinctcodes=&xpnd=true&p=1';
  assert.strictEqual(FIRST.requestLog[0], expected);
});

test('with revenueBandCount = 1 the sweep is the original single undivided search', () => {
  const staticData = {};
  const nodes = {};
  const cfg = configFromWorkflow();
  cfg[0].json.revenueBandCount = 1;
  nodes['Config'] = cfg;
  nodes['Init State'] = runCode('Init State', { input: [{ json: {} }], nodes, staticData });
  const built = runCode('Build Search URL', { input: nodes['Init State'], nodes, staticData });
  assert.match(built[0].json.searchUrl, /dsm\[0\]\.From=5000000&dsm\[0\]\.To=400000000/);
  assert.strictEqual(staticData.bands.length, 1);
});

test('no authenticated-only URL is ever requested', () => {
  for (const url of FIRST.requestLog) {
    assert.ok(!/CompanyBonitet|CompanyPersons|[?&]sid=/i.test(url), 'authenticated URL requested: ' + url);
  }
  // Sticky notes name the forbidden endpoints on purpose, to document that they
  // are off-limits, so only the nodes that issue requests are scanned here.
  const requestNodes = WORKFLOW.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
  const serialised = JSON.stringify(requestNodes);
  assert.ok(!/CompanyBonitet|CompanyPersons/i.test(serialised), 'workflow references an authenticated endpoint');
  assert.ok(!/[?&]sid=/i.test(serialised), 'workflow constructs a session-scoped (sid) URL');
});
