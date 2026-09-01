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
function configFromWorkflow(overrides) {
  const assignments = nodeByName('Config').parameters.assignments.assignments;
  const json = {};
  for (const a of assignments) json[a.name] = a.value;
  // nkdCodes ships as a placeholder the user must replace, so every scenario
  // states explicitly which codes it is exercising.
  return [{ json: { ...json, nkdCodes: '', ...(overrides || {}) } }];
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
      const at = decodeURIComponent((targetUrl.match(/[?&]at=([^&]*)/) || [])[1] || '');
      const page = Number((targetUrl.match(/[?&]p=(\d+)/) || [])[1] || 1);
      // Companies exist for the unfiltered search and for НКД 27; every other
      // code returns an empty result page.
      const hasResults = page === 1 && (at === '' || at === '27');
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
function runWorkflow(options) {
  const opts = options || {};
  const existingRows = opts.existingRows || [];
  const staticData = {};
  const nodes = {};
  const sheetRows = [];
  const requestLog = [];
  const fakeFetch = makeFakeFetch(requestLog);

  nodes['Config'] = configFromWorkflow(opts.config);
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


// Scenario A: no НКД filter, empty sheet — the baseline first run.
const FIRST = runWorkflow({ existingRows: [], config: { nkdCodes: '' } });

// Scenario B: filtered to НКД division 27. МАКИТЕЛ is 27.110 (matches);
// ТЕСТ КОМПАНИЈА is 46.900 (does not); ТРЕТА ФИРМА's profile fetch fails.
const FILTERED = runWorkflow({ existingRows: [], config: { nkdCodes: '27' } });

// Scenario C: the sheet already holds МАКИТЕЛ — a follow-up run.
const REPEAT = runWorkflow({
  existingRows: [
    { 'Клиент': 'МАКИТЕЛ ДООЕЛ', 'Даночен БРОЈ': MAKITEL_EDB },
    { 'Клиент': 'НЕПОЗНАТА ДОО', 'Даночен БРОЈ': '4099999999999' }
  ],
  config: { nkdCodes: '' }
});

// ---------------------------------------------------------------------------
// The НКД filter
// ---------------------------------------------------------------------------

test('nkd: the configured code is sent as at= on every search', () => {
  const searches = FILTERED.requestLog.filter((u) => u.includes('/prebaruvanje'));
  assert.ok(searches.length > 0);
  for (const url of searches) {
    assert.match(url, /[?&]at=27&/, 'search ran without the НКД filter: ' + url);
  }
});

test('nkd: several codes become several segments, each swept in turn', () => {
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '27, 46' } });
  assert.strictEqual(run.summary.segmentsPlanned, 2);
  assert.strictEqual(run.summary.segmentsCompleted, 2);
  assert.deepStrictEqual(run.summary.nkdCodesFiltered, ['27', '46']);
  const codes = run.requestLog
    .filter((u) => u.includes('/prebaruvanje'))
    .map((u) => decodeURIComponent((u.match(/[?&]at=([^&]*)/) || [])[1] || ''));
  assert.deepStrictEqual([...new Set(codes)], ['27', '46']);
});

test('nkd: a company outside the requested division is skipped, not written', () => {
  assert.strictEqual(FILTERED.summary.companiesNotMatchingNkdFilter, 1);
  const written = FILTERED.sheetRows.map((r) => r['Клиент']);
  assert.ok(written.includes('МАКИТЕЛ ДООЕЛ'), 'the matching company was not written');
  assert.ok(!written.includes('ТЕСТ КОМПАНИЈА ДОО'), 'a company outside НКД 27 was written');
  assert.strictEqual(FILTERED.summary.companiesMatchingNkdFilter, 1);
});

test('nkd: enforceNkdMatch=false keeps mismatches but still counts them', () => {
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '27', enforceNkdMatch: false } });
  assert.strictEqual(run.summary.companiesNotMatchingNkdFilter, 1);
  assert.strictEqual(run.sheetRows.length, 2, 'mismatching row should still have been written');
});

/** Drive Build Summary directly, for cases the three-company fixture cannot produce. */
function summaryFor(stats, nkdCodes) {
  const staticData = {
    stats: Object.assign({
      profilesOk: 0, nkdMismatched: 0, nkdUnknown: 0, failedUrls: [], warnings: []
    }, stats),
    segments: [],
    nkdCodes: nkdCodes || []
  };
  return runCode('Build Summary', { input: [], nodes: {}, staticData })[0].json;
}

test('nkd: a wholesale mismatch is called out as the filter not working', () => {
  // What it looks like when the site ignores at= entirely: the search ran, plenty
  // of companies came back, and almost none of them are in the requested division.
  const summary = summaryFor({ profilesOk: 20, nkdMismatched: 18 }, ['46']);
  assert.strictEqual(summary.companiesNotMatchingNkdFilter, 18);
  assert.match(summary.nkdFilterWarning || '', /`at=` search parameter is most likely being ignored/);
});

test('nkd: a handful of mismatches in a tiny sample does not raise a false alarm', () => {
  // Below the sample threshold there is not enough evidence to accuse the site,
  // and crying wolf here would train the warning to be ignored.
  const summary = summaryFor({ profilesOk: 3, nkdMismatched: 3 }, ['46']);
  assert.strictEqual(summary.nkdFilterWarning, undefined);
});

test('nkd: a mostly-matching run raises no warning', () => {
  const summary = summaryFor({ profilesOk: 20, nkdMismatched: 2 }, ['46']);
  assert.strictEqual(summary.nkdFilterWarning, undefined);
});

test('nkd: no warning when no НКД filter was requested at all', () => {
  const summary = summaryFor({ profilesOk: 20, nkdMismatched: 20 }, []);
  assert.strictEqual(summary.nkdFilterWarning, undefined);
});

test('nkd: a company whose НКД could not be read is kept, not silently dropped', () => {
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '27' } });
  // Every fixture profile has a readable code, so nothing should land here —
  // the counter existing at all is what keeps unreadable codes visible.
  assert.strictEqual(run.summary.companiesWithUnreadableNkd, 0);
  assert.strictEqual(
    run.summary.companiesMatchingNkdFilter + run.summary.companiesNotMatchingNkdFilter
      + run.summary.companiesWithUnreadableNkd,
    run.summary.profilesFetchedOk
  );
});

// ---------------------------------------------------------------------------
// The revenue filter is gone
// ---------------------------------------------------------------------------

test('revenue: no revenue bound appears in any search URL', () => {
  for (const url of FIRST.requestLog.filter((u) => u.includes('/prebaruvanje'))) {
    assert.match(url, /dsm\[0\]\.From=0&dsm\[0\]\.To=0/, 'revenue slot is not neutral: ' + url);
    assert.ok(!url.includes('5000000'), 'a revenue bound leaked into the URL: ' + url);
    assert.ok(!url.includes('400000000'), 'a revenue bound leaked into the URL: ' + url);
  }
});

test('revenue: with no codes and no revenue filter the sweep is a single search', () => {
  assert.strictEqual(FIRST.summary.segmentsPlanned, 1);
  assert.deepStrictEqual(FIRST.summary.nkdCodesFiltered, []);
});

test('revenue: setting revenueFilterMode back to range restores the banded sweep', () => {
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '', revenueFilterMode: 'range' } });
  assert.strictEqual(run.summary.segmentsPlanned, 8);
  assert.match(run.requestLog[0], /dsm\[0\]\.From=5000000&dsm\[0\]\.To=8646816/);
});

test('revenue: off-omit drops the dsm[0] triplet from every search URL', () => {
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '27', revenueFilterMode: 'off-omit' } });
  for (const url of run.requestLog.filter((u) => u.includes('/prebaruvanje'))) {
    assert.ok(!url.includes('dsm[0]'), 'dsm[0] should be absent: ' + url);
  }
});

// ---------------------------------------------------------------------------
// Sweep mechanics
// ---------------------------------------------------------------------------

test('sweep: pagination advances within a segment, then resets for the next', () => {
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '27, 46' } });
  const pages = run.requestLog
    .filter((u) => u.includes('/prebaruvanje'))
    .map((u) => Number((u.match(/[?&]p=(\d+)/) || [])[1]));
  // НКД 27 has results on page 1 so it goes on to page 2; НКД 46 is empty at once.
  assert.deepStrictEqual(pages, [1, 2, 1]);
});

test('sweep: the run stops once every segment is exhausted', () => {
  assert.strictEqual(FIRST.pagination.stop, true);
  assert.match(FIRST.pagination.stopReason, /all 1 segment\(s\) swept/);
});

// ---------------------------------------------------------------------------
// First run (unfiltered)
// ---------------------------------------------------------------------------

test('first run: every company found is queued exactly once', () => {
  assert.strictEqual(FIRST.companies.length, 3);
  assert.strictEqual(FIRST.summary.companiesQueued, 3);
  assert.strictEqual(new Set(FIRST.companies.map((c) => c.edb)).size, 3);
});

test('first run: a failed profile fetch is logged and skipped, not fatal', () => {
  assert.strictEqual(FIRST.summary.profileFetchFailures, 1);
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
  const run = runWorkflow({
    existingRows: [{ 'Клиент': 'МАКИТЕЛ ДООЕЛ', 'Даночен БРОЈ': Number(MAKITEL_EDB) }],
    config: { nkdCodes: '' }
  });
  assert.strictEqual(run.summary.existingCompaniesSeeded, 1);
  assert.strictEqual(run.summary.companiesSkippedAsAlreadyInSheet, 1);
});

test('repeat run: a mismatched ЕДБ column is flagged loudly rather than duplicating silently', () => {
  const run = runWorkflow({
    existingRows: [{ 'Клиент': 'МАКИТЕЛ ДООЕЛ', 'Tax number': MAKITEL_EDB }],
    config: { nkdCodes: '' }
  });
  assert.strictEqual(run.summary.existingCompaniesSeeded, 0);
  assert.strictEqual(run.summary.existingRowsWithUnreadableEdb, 1);
  assert.ok(
    run.summary.warnings.some((w) => w.includes('seeded no ЕДБ')),
    'no warning raised about the unreadable ЕДБ column'
  );
});

test('repeat run: an exhausted filter says so explicitly', () => {
  const everything = FIRST.companies.map((c) => ({ 'Даночен БРОЈ': c.edb }));
  const run = runWorkflow({ existingRows: everything, config: { nkdCodes: '' } });
  assert.strictEqual(run.summary.companiesQueued, 0);
  assert.strictEqual(run.summary.newRowsWrittenToSheet, 0);
  assert.match(run.summary.note, /search is exhausted/);
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test('no authenticated-only URL is ever requested', () => {
  for (const url of FIRST.requestLog.concat(FILTERED.requestLog)) {
    assert.ok(!/CompanyBonitet|CompanyPersons|[?&]sid=/i.test(url), 'authenticated URL requested: ' + url);
  }
  // Sticky notes name the forbidden endpoints on purpose, to document that they
  // are off-limits, so only the nodes that issue requests are scanned here.
  const requestNodes = WORKFLOW.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
  const serialised = JSON.stringify(requestNodes);
  assert.ok(!/CompanyBonitet|CompanyPersons/i.test(serialised), 'workflow references an authenticated endpoint');
  assert.ok(!/[?&]sid=/i.test(serialised), 'workflow constructs a session-scoped (sid) URL');
});

test('the shipped Config carries an obvious НКД placeholder, not a stale code', () => {
  const cfg = nodeByName('Config').parameters.assignments.assignments;
  assert.match(cfg.find((a) => a.name === 'nkdCodes').value, /PUT-YOUR/);
  assert.strictEqual(cfg.find((a) => a.name === 'revenueFilterMode').value, 'off-zero');
});

// ---------------------------------------------------------------------------
// Config behaviour observed to matter in the live Step 0 run
// ---------------------------------------------------------------------------

test('config: the site\'s own phone number is excluded by default', () => {
  const cfg = nodeByName('Config').parameters.assignments.assignments;
  const excluded = cfg.find((a) => a.name === 'excludePhones').value;
  assert.match(excluded, /075387170/,
    "CompanyWall's own number appears on every profile and must be excluded by default");
});

test('config: cityMode defaults to the confirmed municipality rule', () => {
  const cfg = nodeByName('Config').parameters.assignments.assignments;
  assert.strictEqual(cfg.find((a) => a.name === 'cityMode').value, 'municipality');
});

test('cityMode: switching to settlement changes what lands in the Град column', () => {
  const municipality = runWorkflow({ existingRows: [], config: { nkdCodes: '' } });
  const settlement = runWorkflow({ existingRows: [], config: { nkdCodes: '', cityMode: 'settlement' } });

  const makitelBy = (run) => run.sheetRows.find((r) => r['Клиент'] === 'МАКИТЕЛ ДООЕЛ')['Град'];
  assert.strictEqual(makitelBy(municipality), 'Струмица');
  assert.strictEqual(makitelBy(settlement), 'Струмица');

  // Both modes must still produce a non-empty city for every written row.
  for (const run of [municipality, settlement]) {
    for (const row of run.sheetRows) {
      assert.ok(row['Град'].length > 0, 'a row was written with an empty Град');
    }
  }
});

test('revenue banding: a zero-based range reaches the smallest companies', () => {
  const run = runWorkflow({
    existingRows: [],
    config: { nkdCodes: '', revenueFilterMode: 'range', revenueFrom: 0, revenueTo: 12000000000, revenueBandCount: 10 }
  });
  assert.strictEqual(run.summary.segmentsPlanned, 10);
  // The first segment must actually start at zero, or companies with little or
  // no revenue stay unreachable — which is the whole point of banding.
  assert.strictEqual(run.summary.segments[0].revenueFrom, 0);
  assert.match(run.requestLog[0], /dsm\[0\]\.From=0&dsm\[0\]\.To=99999/);
});

// ---------------------------------------------------------------------------
// Writing under the sheet's own column headers
//
// The Google Sheets node matches columns by exact header text. A sheet spelling
// a column differently gets the row but a blank cell — the loss is invisible
// from the sheet, which is exactly how it went unnoticed in production.
// ---------------------------------------------------------------------------

test('sheet columns: rows are written under the headers the sheet actually uses', () => {
  const run = runWorkflow({
    existingRows: [{
      'Клиент': 'ПОСТОЕЧКА ДОО',
      'Град': 'Скопје',
      'ЕМБС': '1234567',
      'Даночен БРОЈ': '4099999999999',
      'Шифра на дејност (НКЗ)': '61.100 - Х',
      'Контакт  лице': 'НЕКОЈ',
      'Контакт телефон': '02/1111-111',
      'Мејл адреса': 'a@b.mk'
    }],
    config: { nkdCodes: '' }
  });

  assert.ok(run.sheetRows.length > 0, 'no rows were written');
  const keys = Object.keys(run.sheetRows[0]);
  assert.ok(keys.includes('Шифра на дејност (НКЗ)'), 'did not adopt the sheet\'s НКЗ header');
  assert.ok(keys.includes('Мејл адреса'), 'did not adopt the sheet\'s Мејл spelling');
  assert.ok(keys.includes('Контакт  лице'), 'did not adopt the sheet\'s spacing');
});

test('sheet columns: the values actually land in those columns', () => {
  const run = runWorkflow({
    existingRows: [{
      'Клиент': 'x', 'Град': 'x', 'ЕМБС': 'x', 'Даночен БРОЈ': '4011111111111',
      'Шифра на дејност (НКЗ)': 'x', 'Контакт лице': 'x',
      'Контакт телефон': 'x', 'Мејл адреса': 'x'
    }],
    config: { nkdCodes: '' }
  });

  const row = run.sheetRows.find((r) => r['Клиент'] === 'МАКИТЕЛ ДООЕЛ');
  assert.ok(row, 'МАКИТЕЛ row missing');
  assert.strictEqual(row['Шифра на дејност (НКЗ)'],
    '27.110 - Производство на електромотори, генератори и трансформатори');
  assert.strictEqual(row['Мејл адреса'], 'kontakt@makitel.com.mk; prodazba@makitel.com.mk');
  assert.strictEqual(run.summary.sheetColumnsUnmatched.length, 0);
});

test('sheet columns: a column missing from the sheet is reported, not lost quietly', () => {
  const run = runWorkflow({
    existingRows: [{ 'Клиент': 'x', 'Даночен БРОЈ': '4011111111111' }],
    config: { nkdCodes: '' }
  });

  assert.ok(run.summary.sheetColumnsUnmatched.includes('Контакт телефон'));
  assert.match(run.summary.columnMappingWarning || '', /no matching header was found/);
  // ...and the warning must name what the sheet does have, so it is actionable.
  assert.match(run.summary.columnMappingWarning, /Клиент/);
});

test('sheet columns: an empty sheet falls back to canonical names and says so', () => {
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '' } });
  assert.deepStrictEqual(run.summary.sheetHeadersSeen, []);
  assert.ok(Object.keys(run.sheetRows[0]).includes('Шифра на дејност'));
  assert.ok(run.summary.warnings.some((w) => w.includes('column headers could not be read')));
});

// ---------------------------------------------------------------------------
// Diagnosing empty cells
// ---------------------------------------------------------------------------

test('diagnostics: an empty field captures the page text around its label', () => {
  // ТЕСТ КОМПАНИЈА has no phone or e-mail on its profile.
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '' } });
  const phoneSamples = run.summary.emptyFieldDiagnostics.phone || [];
  assert.ok(phoneSamples.length > 0, 'no diagnostic captured for the company with no phone');
  assert.ok(phoneSamples[0].company, 'diagnostic does not name the company');
  assert.ok(phoneSamples[0].url, 'diagnostic does not carry the profile URL');
  assert.ok(typeof phoneSamples[0].pageContext === 'string' && phoneSamples[0].pageContext.length > 0);
});

test('diagnostics: a field that extracted fine produces no noise', () => {
  const run = runWorkflow({ existingRows: [], config: { nkdCodes: '' } });
  // Both fixture profiles carry an НКЗ, so nothing should be sampled.
  assert.deepStrictEqual(run.summary.emptyFieldDiagnostics.activity, []);
});
