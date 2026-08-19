// @requires-parsers
// Inspect one search-results page and record everything Step 0 needs to answer:
// nationwide coverage, industry spread, revenue bounds, pagination behaviour and
// the shape of the end-of-results page.

const cfg = $('Config').first().json;
const target = $('Loop Search Pages').first().json;
const sd = $getWorkflowStaticData('global');

const { status, html, error } = readHttpItem($input.first());

const record = {
  page: target.page,
  url: target.searchUrl,
  isHighPageProbe: target.isHighPageProbe === true,
  httpStatus: status,
  error: error || '',
  bytes: html ? html.length : 0
};

if (error) {
  sd.step0.searchPages.push(record);
  return [{ json: record }];
}

const parsed = parseSearchResults(html, { baseUrl: cfg.baseUrl });

record.blocked = parsed.blocked || '';
record.profileLinkMatches = parsed.linkMatches;
record.rowCount = parsed.rows.length;
record.parseWarnings = parsed.warnings;

// Identity of this page, for detecting repeats and overlaps between pages.
record.edbList = parsed.rows.map((r) => r.edb).filter(Boolean);
record.signature = record.edbList.slice().sort().join('|');

// Q2: nationwide? multiple industries? — cities are the observable proxy here.
record.distinctCities = [...new Set(parsed.rows.map((r) => r.city).filter(Boolean))];

// Q3: are the returned revenues actually inside the requested range?
const revenues = parsed.rows.map((r) => r.revenue).filter((v) => typeof v === 'number' && Number.isFinite(v));
record.revenueParsedCount = revenues.length;
record.revenueMin = revenues.length ? Math.min(...revenues) : null;
record.revenueMax = revenues.length ? Math.max(...revenues) : null;
record.revenueOutsideRange = parsed.rows
  .filter((r) => typeof r.revenue === 'number' && (r.revenue < Number(cfg.revenueFrom) || r.revenue > Number(cfg.revenueTo)))
  .map((r) => ({ name: r.name, edb: r.edb, revenue: r.revenue }));

// Q5: total result count, if the page states it anywhere.
const text = htmlToText(html);
const totalMatch = text.match(/(?:вкупно|пронајдени|резултати|компании)[^\d]{0,40}([\d.,\s]{1,15})/i)
  || text.match(/([\d.,\s]{1,15})\s*(?:резултати|компании|пронајдени)/i);
record.totalResultsHint = totalMatch ? normalizeSpace(totalMatch[0]) : '';
record.totalResultsParsed = totalMatch ? parseMkNumber(totalMatch[1]) : null;

// Highest page number offered by the pager, if the markup exposes one.
const pagerNumbers = [];
const pagerRe = /[?&]p=(\d{1,5})\b/g;
let pm;
while ((pm = pagerRe.exec(html)) !== null) pagerNumbers.push(Number(pm[1]));
record.maxPageLinkSeen = pagerNumbers.length ? Math.max(...pagerNumbers) : null;

// First row in full, so the selectors can be eyeballed against reality.
record.sampleRow = parsed.rows.length ? parsed.rows[0] : null;

// Raw excerpt for manual inspection when parsing came back empty.
record.rawExcerpt = parsed.rows.length ? '' : String(html).slice(0, 3000);

sd.step0.searchPages.push(record);
return [{ json: record }];
