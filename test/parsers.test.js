'use strict';

/*
 * Offline tests for the CompanyWall parsers.
 *
 * The fixtures under test/fixtures are SYNTHETIC. They reproduce the page
 * structures that were confirmed in the task brief (address format, the
 * "Сопственик{NAME}Управител{NAME}" block, the formatted/digits-only phone
 * duplication, the "27.110 - ..." НКЗ format), but they are not captures of
 * live pages. Replace them with real ScrapingBee output during Step 0 to turn
 * these into true regression tests. See docs/step-0-verification.md.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const P = require('../src/lib/parsers.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

// ---------------------------------------------------------------------------
// City derivation — the two CONFIRMED real examples from the brief
// ---------------------------------------------------------------------------

test('cityFromAddress: confirmed example 1 (Струмица)', () => {
  const addr = 'ДИМИТАР ВЛАХОВ 29, СТРУМИЦА, Струмица, Република Северна Македонија';
  assert.strictEqual(P.cityFromAddress(addr), 'Струмица');
});

test('cityFromAddress: confirmed example 2 (Дебарца, no duplicated uppercase city)', () => {
  const addr = 'НАСЕЛЕНО МЕСТО БЕЗ УЛИЧЕН СИСТЕМ, НОВО СЕЛО, Дебарца, Република Северна Македонија';
  assert.strictEqual(P.cityFromAddress(addr), 'Дебарца');
});

test('cityFromAddress: degrades gracefully without the country suffix', () => {
  assert.strictEqual(P.cityFromAddress('УЛИЦА 1, Кавадарци'), 'Кавадарци');
  assert.strictEqual(P.cityFromAddress(''), '');
  assert.strictEqual(P.cityFromAddress('Скопје'), 'Скопје');
});

// ---------------------------------------------------------------------------
// Phones — normalise-then-dedupe is the whole point
// ---------------------------------------------------------------------------

test('normalizePhone: formatted and digits-only forms collapse to one key', () => {
  assert.strictEqual(P.normalizePhone('046/250-383'), '046250383');
  assert.strictEqual(P.normalizePhone('046250383'), '046250383');
  assert.strictEqual(P.normalizePhone('+389 46 250 383'), '046250383');
  assert.strictEqual(P.normalizePhone('0038946250383'), '046250383');
});

test('extractPhones: CONFIRMED duplication (046/250-383 vs 046250383) yields one entry', () => {
  const phones = P.extractPhones('Тел: 046/250-383 046250383');
  assert.deepStrictEqual(phones, ['046/250-383']);
});

test('extractPhones: keeps the human-readable spelling even when digits come first', () => {
  const phones = P.extractPhones('046250383 046/250-383');
  assert.deepStrictEqual(phones, ['046/250-383']);
});

test('extractPhones: multiple distinct numbers are all kept, in order', () => {
  const phones = P.extractPhones('046/250-383, 02/3112-233, 070 123 456');
  assert.deepStrictEqual(phones, ['046/250-383', '02/3112-233', '070 123 456']);
});

test('extractPhones: rejects ЕДБ, ЕМБС, revenue figures and dates', () => {
  assert.deepStrictEqual(P.extractPhones('ЕДБ 4027015512345'), []);
  assert.deepStrictEqual(P.extractPhones('ЕМБС 7145263'), []);
  assert.deepStrictEqual(P.extractPhones('Приход 128.450.000 МКД'), []);
  assert.deepStrictEqual(P.extractPhones('Датум на основање 05.08.2004'), []);
  assert.deepStrictEqual(P.extractPhones('Период 2020 - 2024'), []);
});

test('extractPhones: zero phones is a valid, non-throwing result', () => {
  assert.deepStrictEqual(P.extractPhones('Нема внесени контакти'), []);
  assert.deepStrictEqual(P.extractPhones(''), []);
  assert.deepStrictEqual(P.extractPhones(null), []);
});

test('extractPhones: normalized output format on request', () => {
  const phones = P.extractPhones('046/250-383 046250383 +389 70 123 456', { format: 'normalized' });
  assert.deepStrictEqual(phones, ['046250383', '070123456']);
});

test('extractPhones: exclude list drops the site\'s own number', () => {
  const phones = P.extractPhones('046/250-383 02/3112-233', { exclude: ['023112233'] });
  assert.deepStrictEqual(phones, ['046/250-383']);
});

// ---------------------------------------------------------------------------
// E-mails
// ---------------------------------------------------------------------------

test('extractEmails: dedupes, lower-cases and drops site/asset addresses', () => {
  const html = '<a href="mailto:Kontakt@Firma.mk">Kontakt@Firma.mk</a> ' +
               '<span>kontakt@firma.mk</span> <span>prodazba@firma.mk</span> ' +
               '<img src="logo@2x.png"> info@companywall.com.mk';
  assert.deepStrictEqual(P.extractEmails(html), ['kontakt@firma.mk', 'prodazba@firma.mk']);
});

test('extractEmails: picks up mailto-only addresses', () => {
  assert.deepStrictEqual(P.extractEmails('<a href="mailto:only@here.mk">Пиши ни</a>'), ['only@here.mk']);
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

test('extractPeople: parses the CONFIRMED Сопственик/Управител block', () => {
  const html = '<div><span>Сопственик</span><span>ПЕТАР ПЕТРОВСКИ</span>' +
               '<span>Управител</span><span>ГОРАН СТОЈАНОВ</span>' +
               '<a href="/lica">Прикажи ги сите</a></div>';
  assert.deepStrictEqual(P.extractPeople(html), [
    { role: 'Сопственик', name: 'ПЕТАР ПЕТРОВСКИ' },
    { role: 'Управител', name: 'ГОРАН СТОЈАНОВ' }
  ]);
});

test('extractPeople: strips ownership percentages', () => {
  const html = '<tr><td>Сопственик</td><td>АНА ЈОВАНОВСКА</td><td>25%</td></tr>';
  assert.deepStrictEqual(P.extractPeople(html), [{ role: 'Сопственик', name: 'АНА ЈОВАНОВСКА' }]);
});

test('extractPeople: handles the inline "Управител: ИМЕ" variant', () => {
  assert.deepStrictEqual(P.extractPeople('<p>Управител: ГОРАН СТОЈАНОВ</p>'), [
    { role: 'Управител', name: 'ГОРАН СТОЈАНОВ' }
  ]);
});

test('extractPeople: never treats "Прикажи ги сите" as a name', () => {
  const html = '<span>Управител</span><a href="/lica">Прикажи ги сите</a>';
  assert.deepStrictEqual(P.extractPeople(html), []);
});

test('pickContactPerson: Управител wins over Сопственик regardless of order', () => {
  const people = [
    { role: 'Сопственик', name: 'ПЕТАР ПЕТРОВСКИ' },
    { role: 'Управител', name: 'ГОРАН СТОЈАНОВ' }
  ];
  assert.strictEqual(P.pickContactPerson(people).name, 'ГОРАН СТОЈАНОВ');
});

test('pickContactPerson: falls back to Сопственик when no Управител is listed', () => {
  const people = [{ role: 'Сопственик', name: 'ПЕТАР ПЕТРОВСКИ' }];
  assert.strictEqual(P.pickContactPerson(people).name, 'ПЕТАР ПЕТРОВСКИ');
});

test('pickContactPerson: takes the first manager when several are listed', () => {
  const people = [
    { role: 'Управител', name: 'ГОРАН СТОЈАНОВ' },
    { role: 'Управител', name: 'МАРИЈА АНГЕЛОВА' }
  ];
  assert.strictEqual(P.pickContactPerson(people).name, 'ГОРАН СТОЈАНОВ');
});

test('pickContactPerson: empty list returns null, not a throw', () => {
  assert.strictEqual(P.pickContactPerson([]), null);
});

// ---------------------------------------------------------------------------
// Labelled values
// ---------------------------------------------------------------------------

test('extractActivity: CONFIRMED "НКЗ" label and "27.110 - ..." format', () => {
  const a = P.extractActivity('<div><span>НКЗ</span><span>27.110 - Производство на електромотори</span></div>');
  assert.strictEqual(a.code, '27.110');
  assert.strictEqual(a.description, 'Производство на електромотори');
  assert.strictEqual(a.full, '27.110 - Производство на електромотори');
});

test('extractActivity: also accepts the НКД label and split-line layout', () => {
  const a = P.extractActivity('<div>НКД</div><div>46.900</div><div>Неспецијализирана трговија</div>');
  assert.strictEqual(a.full, '46.900 - Неспецијализирана трговија');
});

test('extractEmbs / extractEdb: read the labelled values, not neighbouring numbers', () => {
  const html = '<span>ЕМБС</span><span>7145263</span><span>ЕДБ</span><span>4027015512345</span>';
  assert.strictEqual(P.extractEmbs(html), '7145263');
  assert.strictEqual(P.extractEdb(html), '4027015512345');
});

test('parseMkNumber: Macedonian thousand/decimal separators', () => {
  assert.strictEqual(P.parseMkNumber('5.000.000'), 5000000);
  assert.strictEqual(P.parseMkNumber('128.450.000'), 128450000);
  assert.strictEqual(P.parseMkNumber('12.345,67'), 12345.67);
  assert.strictEqual(P.parseMkNumber('34'), 34);
  assert.strictEqual(P.parseMkNumber('нема'), null);
});

// ---------------------------------------------------------------------------
// Full profile parse
// ---------------------------------------------------------------------------

test('parseProfile: extracts every sheet field from the profile fixture', () => {
  const r = P.parseProfile(fixture('profile-makitel.html'));
  assert.strictEqual(r.blocked, '');
  assert.strictEqual(r.name, 'МАКИТЕЛ ДООЕЛ');
  assert.strictEqual(r.city, 'Струмица');
  assert.strictEqual(r.embs, '7145263');
  assert.strictEqual(r.edb, '4027015512345');
  assert.strictEqual(r.activity, '27.110 - Производство на електромотори, генератори и трансформатори');
  assert.strictEqual(r.contactPerson, 'ГОРАН СТОЈАНОВ');
  assert.strictEqual(r.contactPersonRole, 'Управител');
  assert.strictEqual(r.needsLica, false);
});

test('parseProfile: phone duplication collapses and both e-mails survive', () => {
  const r = P.parseProfile(fixture('profile-makitel.html'));
  assert.deepStrictEqual(r.phones, ['046/250-383', '+389 70 123 456']);
  assert.deepStrictEqual(r.emails, ['kontakt@makitel.com.mk', 'prodazba@makitel.com.mk']);
});

test('parseProfile: the site\'s own footer contact details never leak into a row', () => {
  const r = P.parseProfile(fixture('profile-makitel.html'));
  assert.ok(!r.emails.some((e) => e.includes('companywall')), 'companywall e-mail leaked');
  assert.ok(!r.phones.some((p) => P.normalizePhone(p) === '023112233'), 'companywall phone leaked');
});

test('parseProfile: flags the /lica fallback when nobody is listed', () => {
  const r = P.parseProfile(fixture('profile-no-people.html'));
  assert.strictEqual(r.needsLica, true);
  assert.strictEqual(r.contactPerson, '');
  assert.strictEqual(r.city, 'Дебарца');
  assert.strictEqual(r.embs, '6011223');
  assert.strictEqual(r.activity, '46.900 - Неспецијализирана трговија на големо');
});

test('parseProfile: missing phones/e-mails are warnings, never errors', () => {
  const r = P.parseProfile(fixture('profile-no-people.html'));
  assert.deepStrictEqual(r.phones, []);
  assert.deepStrictEqual(r.emails, []);
  assert.ok(r.warnings.some((w) => w.includes('no phone numbers found')));
});

test('parseLica: reads the full owner/manager list from the sub-page', () => {
  const r = P.parseLica(fixture('lica.html'));
  assert.strictEqual(r.people.length, 3);
  assert.strictEqual(r.contactPerson, 'ДЕЈАН НИКОЛОВ');
  assert.strictEqual(r.contactPersonRole, 'Управител');
});

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

test('parseSearchResults: one record per company, absolute and relative links alike', () => {
  const r = P.parseSearchResults(fixture('search-page.html'));
  assert.strictEqual(r.rows.length, 3);
  assert.deepStrictEqual(r.rows.map((x) => x.edb), ['4027015512345', '4030999888777', '4057011223344']);
  assert.deepStrictEqual(r.rows.map((x) => x.city), ['Струмица', 'Дебарца', 'Битола']);
  assert.strictEqual(r.rows[0].profileUrl, 'https://www.companywall.com.mk/kompanija/makitel-dooel/MM7EwwsC');
  assert.strictEqual(r.rows[0].licaUrl, 'https://www.companywall.com.mk/kompanija/makitel-dooel/MM7EwwsC/lica');
});

test('parseSearchResults: reads name, status, employees and revenue from the row window', () => {
  const r = P.parseSearchResults(fixture('search-page.html'));
  assert.strictEqual(r.rows[0].name, 'МАКИТЕЛ ДООЕЛ');
  assert.strictEqual(r.rows[0].status, 'Активен');
  assert.strictEqual(r.rows[0].employees, 34);
  assert.strictEqual(r.rows[0].revenue, 128450000);
  assert.strictEqual(r.rows[2].status, 'Блокиран');
  assert.strictEqual(r.rows[2].revenue, 355000000);
});

test('parseSearchResults: an empty result page yields zero rows (pagination stop signal)', () => {
  const r = P.parseSearchResults(fixture('search-empty.html'));
  assert.strictEqual(r.rows.length, 0);
  assert.ok(r.warnings.length > 0);
});

test('normalizeProfilePath: accepts profile links, rejects sub-pages and noise', () => {
  assert.strictEqual(P.normalizeProfilePath('/kompanija/makitel-dooel/MM7EwwsC'), '/kompanija/makitel-dooel/MM7EwwsC');
  assert.strictEqual(P.normalizeProfilePath('https://www.companywall.com.mk/kompanija/x/AB12cdEf?a=1'), '/kompanija/x/AB12cdEf');
  assert.strictEqual(P.normalizeProfilePath('/kompanija/makitel-dooel/MM7EwwsC/lica'), '/kompanija/makitel-dooel/MM7EwwsC');
  assert.strictEqual(P.normalizeProfilePath('/prebaruvanje?p=2'), '');
});

// ---------------------------------------------------------------------------
// Blocked-page detection
// ---------------------------------------------------------------------------

test('detectBlockedPage: recognises CAPTCHA, empty and non-HTML responses', () => {
  assert.ok(P.detectBlockedPage('').includes('empty'));
  assert.ok(P.detectBlockedPage('<html><body>Please complete the CAPTCHA' + 'x'.repeat(500) + '</body></html>').includes('CAPTCHA'));
  assert.ok(P.detectBlockedPage('{"message":"Invalid api key"}').length > 0);
  assert.strictEqual(P.detectBlockedPage(fixture('search-page.html')), '');
  assert.strictEqual(P.detectBlockedPage(fixture('profile-makitel.html')), '');
});

test('parseSearchResults / parseProfile surface blocks instead of throwing', () => {
  const captcha = '<html><body>Attention Required! Cloudflare' + 'x'.repeat(600) + '</body></html>';
  assert.strictEqual(P.parseSearchResults(captcha).rows.length, 0);
  assert.ok(P.parseSearchResults(captcha).blocked.length > 0);
  assert.ok(P.parseProfile(captcha).blocked.length > 0);
});

// ---------------------------------------------------------------------------
// URL builder
// ---------------------------------------------------------------------------

test('buildSearchUrl: reproduces the confirmed URL exactly, with p appended', () => {
  const url = P.buildSearchUrl({ revenueFrom: 5000000, revenueTo: 400000000, balanceYear: 2025 }, 1);
  assert.strictEqual(
    url,
    'https://www.companywall.com.mk/prebaruvanje?cr=MKD&n=&mv=&r=&c=&cp=&at=&area=&subarea=&sbjact=t' +
    '&blckd=&dbf=&dbt=&type=&bly=2025&dsm[0].Code=201&dsm[0].From=5000000&dsm[0].To=400000000' +
    '&dsm[1].Code=48&dsm[1].From=0&dsm[1].To=0&dsm[-1].Code=0&dsm[-1].From=0&dsm[-1].To=0' +
    '&distinctcodes=&xpnd=true&p=1'
  );
});

test('buildSearchUrl: page number is the only thing that changes between pages', () => {
  const cfg = { revenueFrom: 5000000, revenueTo: 400000000, balanceYear: 2025 };
  assert.strictEqual(P.buildSearchUrl(cfg, 1).replace('&p=1', '&p=2'), P.buildSearchUrl(cfg, 2));
});

// ---------------------------------------------------------------------------
// Regression tests for bugs found while building this workflow
// ---------------------------------------------------------------------------

test('regression: a nav link to /registracija must not flag a page as an auth wall', () => {
  const html = '<html><head><title>МАКИТЕЛ ДООЕЛ | CompanyWall</title></head><body>' +
    '<nav><a href="/registracija">Регистрација</a><a href="/najava">Најави се</a></nav>' +
    '<h1>МАКИТЕЛ ДООЕЛ</h1>' + 'содржина '.repeat(80) + '</body></html>';
  assert.strictEqual(P.detectBlockedPage(html), '');
});

test('regression: a genuine registration page IS flagged', () => {
  const html = '<html><head><title>Регистрација | CompanyWall</title></head><body>' +
    '<h1>Регистрирај се</h1>' + 'текст '.repeat(120) + '</body></html>';
  assert.ok(P.detectBlockedPage(html).includes('registration/login'));
});

test('regression: adjacent phone numbers separated by whitespace are not merged', () => {
  // A greedy "digits and separators" tokenizer swallows the gap between two
  // numbers and produces one invalid 18-digit token, losing both.
  assert.deepStrictEqual(P.extractPhones('046250383 070123456'), ['046250383', '070123456']);
  assert.deepStrictEqual(P.extractPhones('046/250-383 02/3112-233'), ['046/250-383', '02/3112-233']);
});

test('regression: Cyrillic labels are matched despite JS \\b not working on them', () => {
  // /\bЕМБС\b/ never matches: Cyrillic letters are not \w, so no boundary exists.
  assert.strictEqual(P.extractEmbs('ЕМБС\n7145263'), '7145263');
  assert.strictEqual(P.extractEdb('ЕДБ\n4027015512345'), '4027015512345');
  // ...and the boundary still does its job: ЕМБС must not match inside a word.
  assert.strictEqual(P.extractEmbs('ХЕМБСКИ 7145263'), '');
});
