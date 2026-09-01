'use strict';

/*
 * Does the sweep actually reach every company when the site caps pagination?
 *
 * The live Step 0 run established the constraint precisely: results come back
 * sorted by revenue descending, 20 per page, and `p` is clamped to the 3rd page —
 * so any search matching more than 60 companies silently hides the smallest ones.
 *
 * This models that site and runs the real generated node code against it. The
 * test that matters is the last one: every company must end up collected, which
 * is only possible if capped revenue bands are detected and split.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/companywall-mk-scraper.json'), 'utf8'));

const PAGE_SIZE = 20;
const PAGE_CAP = 3; // the site will not page past this — measured live

// --- a synthetic НКД 61 population, skewed toward small companies -----------

function makeCompanies(count) {
  const companies = [];
  for (let i = 0; i < count; i++) {
    // Geometric spread from 50k to ~9bn, mirroring a real revenue distribution.
    const revenue = Math.round(50000 * Math.pow(9000000000 / 50000, i / (count - 1)));
    companies.push({
      name: 'КОМПАНИЈА ' + (i + 1) + ' ДООЕЛ',
      edb: String(4030000000000 + i),
      embs: String(7000000 + i),
      code: 'CODE' + String(i).padStart(4, '0'),
      city: 'Град' + (i % 7),
      revenue,
      nkd: (i % 2 === 0) ? '61.100' : '61.900'
    });
  }
  return companies;
}

const COMPANIES = makeCompanies(137);
const BY_CODE = new Map(COMPANIES.map((c) => [c.code, c]));

function searchResultsHtml(rows) {
  const items = rows.map((c) => `
    <div class="result">
      <a href="/kompanija/kompanija-${c.code.toLowerCase()}/${c.code}"><h3>${c.name}</h3></a>
      <span class="status">Активен</span>
      <div>ЕДБ: ${c.edb}</div>
      <div>УЛИЦА 1, ${c.city.toUpperCase()}, ${c.city}, Република Северна Македонија</div>
      <div><span>Вработени</span><span>${(c.revenue % 90) + 1}</span></div>
      <div><span>Приход</span><span>${c.revenue.toLocaleString('de-DE')}</span></div>
    </div>`).join('\n');

  return `<!doctype html><html lang="mk"><head><title>Пребарување | CompanyWall</title></head>
<body><header><nav><a href="/">Почетна</a><a href="/registracija">Регистрација</a></nav></header>
<main><h1>Резултати од пребарувањето</h1>
<div class="results">${items || '<p>Нема пронајдени резултати за зададените критериуми.</p>'}</div>
</main><footer><p>info@companywall.com.mk 075387170</p></footer></body></html>`;
}

function profileHtml(c) {
  return `<!doctype html><html lang="mk"><head><title>${c.name} | CompanyWall</title></head>
<body><header><nav><a href="/registracija">Регистрација</a></nav></header>
<main>
  <h1>${c.name}</h1>
  <div><span>ЕМБС</span><span>${c.embs}</span><span>ЕДБ</span><span>${c.edb}</span></div>
  <div>Друштво ${c.name} е регистрирана на УЛИЦА 1, ${c.city.toUpperCase()}, ${c.city}, Република Северна Македонија и работи од 01.01.2010 година.</div>
  <section><h2>Основни информации</h2>
    <div><span>НКЗ</span><span>${c.nkd} - Телекомуникациски дејности</span></div>
  </section>
  <section>
    <div><a href="tel:0${(70000000 + (c.revenue % 9000000))}">0${(70000000 + (c.revenue % 9000000))}</a></div>
    <div><a href="mailto:info@k${c.code.toLowerCase()}.mk">info@k${c.code.toLowerCase()}.mk</a></div>
    <div><span>Сопственик</span><span>СОПСТВЕНИК ${c.code}</span><span>Управител</span><span>УПРАВИТЕЛ ${c.code}</span></div>
  </section>
  <p>${'Дополнителен опис на компанијата. '.repeat(20)}</p>
</main><footer><p>info@companywall.com.mk 075387170</p></footer></body></html>`;
}

/** The site: filter, sort by revenue descending, paginate, clamp the page. */
function fakeSite(url, stats) {
  if (url.includes('/prebaruvanje')) {
    stats.searchRequests++;
    const at = decodeURIComponent((url.match(/[?&]at=([^&]*)/) || [])[1] || '');
    const page = Number((url.match(/[?&]p=(\d+)/) || [])[1] || 1);
    const fromMatch = url.match(/dsm\[0\]\.From=(\d+)&dsm\[0\]\.To=(\d+)/);
    const from = fromMatch ? Number(fromMatch[1]) : null;
    const to = fromMatch ? Number(fromMatch[2]) : null;
    const revenueFiltered = fromMatch && !(from === 0 && to === 0);

    let rows = COMPANIES.filter((c) => !at || c.nkd.startsWith(at + '.'));
    if (revenueFiltered) rows = rows.filter((c) => c.revenue >= from && c.revenue <= to);
    rows.sort((a, b) => b.revenue - a.revenue);

    const effectivePage = Math.min(page, PAGE_CAP);
    const slice = rows.slice((effectivePage - 1) * PAGE_SIZE, effectivePage * PAGE_SIZE);
    return { json: { statusCode: 200, data: searchResultsHtml(slice) } };
  }

  stats.profileRequests++;
  const code = (url.match(/\/kompanija\/[^/]+\/([^/?#]+)/) || [])[1];
  const company = BY_CODE.get(code);
  if (!company) throw new Error('unknown profile requested: ' + url);
  return { json: { statusCode: 200, data: profileHtml(company) } };
}

// --- runner ------------------------------------------------------------------

function nodeByName(name) {
  const node = WORKFLOW.nodes.find((n) => n.name === name);
  if (!node) throw new Error('node not found: ' + name);
  return node;
}

function runCode(nodeName, { input = [], nodes = {}, staticData = {} }) {
  const code = nodeByName(nodeName).parameters.jsCode;
  const $input = { first: () => input[0], last: () => input[input.length - 1], all: () => input };
  const $ = (name) => ({ first: () => nodes[name][0], all: () => nodes[name] });
  return new Function('$input', '$', '$getWorkflowStaticData', code)($input, $, () => staticData);
}

function configFromWorkflow(overrides) {
  const json = {};
  for (const a of nodeByName('Config').parameters.assignments.assignments) json[a.name] = a.value;
  return [{ json: { ...json, nkdCodes: '61', ...(overrides || {}) } }];
}

function runSweep(configOverrides) {
  const staticData = {};
  const nodes = {};
  const stats = { searchRequests: 0, profileRequests: 0 };
  const sheetRows = [];

  nodes['Config'] = configFromWorkflow(configOverrides);
  nodes['Read Existing Sheet'] = [{ json: {} }];
  nodes['Init State'] = runCode('Init State', { input: nodes['Read Existing Sheet'], nodes, staticData });

  let state = nodes['Init State'];
  let guard = 0;
  for (;;) {
    if (++guard > 4000) throw new Error('sweep did not terminate');
    nodes['Build Search URL'] = runCode('Build Search URL', { input: state, nodes, staticData });
    const response = fakeSite(nodes['Build Search URL'][0].json.searchUrl, stats);
    nodes['Parse Search Results'] = runCode('Parse Search Results', { input: [response], nodes, staticData });
    state = nodes['Parse Search Results'];
    if (state[0].json.stop) break;
  }

  const companies = runCode('Dedupe Companies', { input: state, nodes, staticData });
  for (const company of companies) {
    nodes['Loop Over Companies'] = [company];
    const response = fakeSite(company.json.profileUrl, stats);
    nodes['Parse Profile'] = runCode('Parse Profile', { input: [response], nodes, staticData });
    const record = nodes['Parse Profile'];
    if (!record[0].json._write) continue;
    runCode('Prepare Sheet Row', { input: record, nodes, staticData }).forEach((r) => sheetRows.push(r.json));
  }

  const summary = runCode('Build Summary', { input: [], nodes, staticData })[0].json;
  return { companies: companies.map((c) => c.json), sheetRows, summary, stats, staticData };
}

// --- the baseline: this is the problem being solved --------------------------

const UNBANDED = runSweep({ revenueFilterMode: 'off-zero' });

test('without revenue banding the cap hides most of the population', () => {
  assert.strictEqual(UNBANDED.summary.companiesQueued, PAGE_SIZE * PAGE_CAP);
  assert.ok(COMPANIES.length > UNBANDED.summary.companiesQueued,
    'the fixture must be larger than the cap for this test to mean anything');
});

test('an unbanded sweep that hits the cap reports it instead of looking complete', () => {
  assert.ok(UNBANDED.summary.segmentsThatHitTheResultCap > 0, 'the cap was not detected');
  assert.strictEqual(UNBANDED.summary.segmentsStillTruncated, 1,
    'a segment with no revenue band cannot be split, and must be reported as truncated');
  assert.match(UNBANDED.summary.truncationWarning || '', /could not be split further/);
});

test('the companies the cap hides are the smallest ones', () => {
  const collected = new Set(UNBANDED.companies.map((c) => c.edb));
  const missed = COMPANIES.filter((c) => !collected.has(c.edb));
  const collectedRevenues = COMPANIES.filter((c) => collected.has(c.edb)).map((c) => c.revenue);
  assert.ok(missed.length > 0);
  assert.ok(Math.max(...missed.map((c) => c.revenue)) < Math.min(...collectedRevenues),
    'every missed company should be smaller than every collected one');
});

// --- the fix ------------------------------------------------------------------

const BANDED = runSweep({
  revenueFilterMode: 'range',
  revenueFrom: 0,
  revenueTo: 20000000000,
  revenueBandCount: 2 // deliberately too few, so splitting has to do the work
});

test('banding plus auto-splitting reaches every single company', () => {
  assert.strictEqual(BANDED.summary.companiesQueued, COMPANIES.length);
  const collected = new Set(BANDED.companies.map((c) => c.edb));
  const missed = COMPANIES.filter((c) => !collected.has(c.edb));
  assert.deepStrictEqual(missed.map((c) => c.name), [], 'companies were missed');
});

test('bands that hit the cap are split, and nothing is left truncated', () => {
  assert.ok(BANDED.summary.segmentsThatHitTheResultCap > 0, 'no band hit the cap — fixture too small?');
  assert.ok(BANDED.summary.segmentsAddedBySplitting > 0, 'no band was split');
  assert.strictEqual(BANDED.summary.segmentsStillTruncated, 0);
  assert.strictEqual(BANDED.summary.truncationWarning, undefined);
});

test('splitting starts from too few bands and converges without running away', () => {
  assert.strictEqual(BANDED.summary.segmentsPlanned, 2);
  assert.ok(BANDED.summary.segmentsCompleted > 2, 'splitting should have added segments');
  assert.ok(BANDED.summary.segmentsCompleted < 100,
    'segment count ran away: ' + BANDED.summary.segmentsCompleted);
});

test('every company is written exactly once despite bands overlapping after splits', () => {
  assert.strictEqual(BANDED.sheetRows.length, COMPANIES.length);
  const edbs = BANDED.sheetRows.map((r) => r['Даночен БРОЈ']);
  assert.strictEqual(new Set(edbs).size, edbs.length, 'a company was written twice');
});

test('each company profile is fetched only once, however many times it is seen', () => {
  assert.strictEqual(BANDED.stats.profileRequests, COMPANIES.length);
});

test("the site's own phone number never reaches a row", () => {
  for (const row of BANDED.sheetRows) {
    assert.ok(!row['Контакт телефон'].includes('075387170'), 'site phone leaked into ' + row['Клиент']);
    assert.ok(!row['Меил адреса'].includes('companywall'), 'site e-mail leaked into ' + row['Клиент']);
  }
});

test('the НКД filter check passes for a population that genuinely matches', () => {
  assert.strictEqual(BANDED.summary.companiesNotMatchingNkdFilter, 0);
  assert.strictEqual(BANDED.summary.companiesMatchingNkdFilter, COMPANIES.length);
  assert.strictEqual(BANDED.summary.nkdFilterWarning, undefined);
});

test('auto-split can be turned off, and then the truncation is reported honestly', () => {
  const run = runSweep({
    revenueFilterMode: 'range',
    revenueFrom: 0,
    revenueTo: 20000000000,
    revenueBandCount: 2,
    autoSplitTruncatedBands: false
  });
  assert.ok(run.summary.companiesQueued < COMPANIES.length, 'without splitting some companies must be missed');
  assert.ok(run.summary.segmentsStillTruncated > 0);
  assert.match(run.summary.truncationWarning || '', /NOT collected/);
});
