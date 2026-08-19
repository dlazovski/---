'use strict';

/*
 * End-to-end simulation of the generated workflow.
 *
 * This executes the ACTUAL jsCode from workflows/companywall-mk-scraper.json in a
 * minimal stand-in for the n8n Code-node runtime ($input, $(), static data), with
 * fixture HTML standing in for ScrapingBee responses. It exercises the parts that
 * the parser unit tests cannot: pagination state, the stop condition, static-data
 * counters, the /lica branch, profile-failure skipping and the final sheet row.
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

/** Fixture-backed stand-in for the ScrapingBee HTTP Request nodes. */
function fakeFetch(targetUrl) {
  if (targetUrl.includes('/prebaruvanje')) {
    const page = Number((targetUrl.match(/[?&]p=(\d+)/) || [])[1] || 1);
    if (page === 1) return { json: { statusCode: 200, data: fixture('search-page.html') } };
    return { json: { statusCode: 200, data: fixture('search-empty.html') } };
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
}

/** Run the whole workflow against the fixtures and return everything observable. */
function runWorkflow() {
  const staticData = {};
  const nodes = {};
  const sheetRows = [];

  nodes['Config'] = configFromWorkflow();
  nodes['Init State'] = runCode('Init State', { input: nodes['Config'], nodes, staticData });

  // --- search pagination loop ---
  let state = nodes['Init State'];
  let guard = 0;
  for (;;) {
    if (++guard > 20) throw new Error('pagination loop did not terminate');
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
  return { pagination, companies: companies.map((c) => c.json), sheetRows, summary, staticData };
}

// ---------------------------------------------------------------------------

const RUN = runWorkflow();

test('workflow: pagination stops on the empty results page', () => {
  assert.strictEqual(RUN.pagination.stop, true);
  assert.match(RUN.pagination.stopReason, /no company rows|end of results/);
  assert.strictEqual(RUN.summary.searchPagesFetched, 2);
});

test('workflow: every company on the results page is queued exactly once', () => {
  assert.strictEqual(RUN.companies.length, 3);
  assert.strictEqual(RUN.summary.companiesQueued, 3);
  const edbs = RUN.companies.map((c) => c.edb);
  assert.strictEqual(new Set(edbs).size, 3);
});

test('workflow: a failed profile fetch is logged and skipped, not fatal', () => {
  assert.strictEqual(RUN.summary.profileFetchFailures, 1);
  assert.strictEqual(RUN.summary.rowsSkipped, 1);
  const failure = RUN.summary.failedUrls.find((f) => f.stage === 'profile');
  assert.ok(failure, 'the failed profile URL was not recorded');
  assert.match(failure.url, /ZZ99xyQq/);
  // ...and the run still completed for the other two companies.
  assert.strictEqual(RUN.sheetRows.length, 2);
});

test('workflow: sheet rows carry exactly the eight expected columns, in order', () => {
  const EXPECTED = [
    'Клиент', 'Град', 'ЕМБС', 'Даночен БРОЈ',
    'Шифра на дејност', 'Контакт лице', 'Контакт телефон', 'Меил адреса'
  ];
  for (const row of RUN.sheetRows) {
    assert.deepStrictEqual(Object.keys(row), EXPECTED);
  }
});

test('workflow: the fully-populated company produces a complete row', () => {
  const row = RUN.sheetRows.find((r) => r['Клиент'] === 'МАКИТЕЛ ДООЕЛ');
  assert.ok(row, 'МАКИТЕЛ row missing');
  assert.deepStrictEqual(row, {
    'Клиент': 'МАКИТЕЛ ДООЕЛ',
    'Град': 'Струмица',
    'ЕМБС': '7145263',
    'Даночен БРОЈ': '4027015512345',
    'Шифра на дејност': '27.110 - Производство на електромотори, генератори и трансформатори',
    'Контакт лице': 'ГОРАН СТОЈАНОВ',
    'Контакт телефон': '046/250-383; +389 70 123 456',
    'Меил адреса': 'kontakt@makitel.com.mk; prodazba@makitel.com.mk'
  });
});

test('workflow: the /lica fallback fires only for the company with no people listed', () => {
  assert.strictEqual(RUN.summary.licaFallbacksNeeded, 1);
  const row = RUN.sheetRows.find((r) => r['Клиент'] === 'ТЕСТ КОМПАНИЈА ДОО');
  assert.ok(row, 'ТЕСТ КОМПАНИЈА row missing');
  assert.strictEqual(row['Контакт лице'], 'ДЕЈАН НИКОЛОВ');
});

test('workflow: missing phone/e-mail leaves blank cells rather than failing the row', () => {
  const row = RUN.sheetRows.find((r) => r['Клиент'] === 'ТЕСТ КОМПАНИЈА ДОО');
  assert.strictEqual(row['Контакт телефон'], '');
  assert.strictEqual(row['Меил адреса'], '');
  assert.strictEqual(RUN.summary.companiesWithNoPhone, 1);
  assert.strictEqual(RUN.summary.companiesWithNoEmail, 1);
});

test('workflow: the summary reconciles with what was actually written', () => {
  const s = RUN.summary;
  assert.strictEqual(s.rowsWrittenToSheet, RUN.sheetRows.length);
  assert.strictEqual(s.profilesFetchedOk + s.profileFetchFailures, s.companiesQueued);
  assert.strictEqual(s.rowsWrittenToSheet + s.rowsSkipped, s.companiesQueued);
  assert.ok(s.startedAt && s.finishedAt);
});

test('workflow: the search URL sent for page 1 is the confirmed URL', () => {
  const expected = 'https://www.companywall.com.mk/prebaruvanje?cr=MKD&n=&mv=&r=&c=&cp=&at=&area=&subarea=' +
    '&sbjact=t&blckd=&dbf=&dbt=&type=&bly=2025&dsm[0].Code=201&dsm[0].From=5000000&dsm[0].To=400000000' +
    '&dsm[1].Code=48&dsm[1].From=0&dsm[1].To=0&dsm[-1].Code=0&dsm[-1].From=0&dsm[-1].To=0' +
    '&distinctcodes=&xpnd=true&p=1';
  const staticData = {};
  const nodes = { Config: configFromWorkflow() };
  nodes['Init State'] = runCode('Init State', { input: nodes.Config, nodes, staticData });
  const built = runCode('Build Search URL', { input: nodes['Init State'], nodes, staticData });
  assert.strictEqual(built[0].json.searchUrl, expected);
});

test('workflow: no authenticated-only URL is ever constructed', () => {
  const allUrls = [
    ...RUN.companies.map((c) => c.profileUrl),
    ...RUN.companies.map((c) => c.licaUrl)
  ];
  for (const url of allUrls) {
    assert.ok(!/CompanyBonitet|CompanyPersons|[?&]sid=/i.test(url), 'authenticated URL constructed: ' + url);
  }
  // Check the nodes that actually issue requests. Sticky notes mention the
  // forbidden endpoints by name precisely to document that they are off-limits,
  // so scanning the whole serialised workflow would flag its own documentation.
  const requestNodes = WORKFLOW.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
  const serialised = JSON.stringify(requestNodes);
  assert.ok(!/CompanyBonitet|CompanyPersons/i.test(serialised), 'workflow references an authenticated endpoint');
  assert.ok(!/[?&]sid=/i.test(serialised), 'workflow constructs a session-scoped (sid) URL');
});
