// @requires-parsers
// Inspect one search-results page and record what Step 0 needs: whether the
// НКД filter narrowed anything, nationwide coverage, pagination behaviour, and
// the shape of the end-of-results page.

const cfg = $('Config').first().json;
const target = $('Loop Search Pages').first().json;
const sd = $getWorkflowStaticData('global');

const { status, html, error } = readHttpItem($input.first());

const record = {
  label: target.label,
  page: target.page,
  nkd: target.nkd,
  revenueFilterMode: target.revenueFilterMode,
  isBaseline: target.isBaseline === true,
  isFiltered: target.isFiltered === true,
  isHighPageProbe: target.isHighPageProbe === true,
  isRevenueFormProbe: target.isRevenueFormProbe === true,
  url: target.searchUrl,
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
record.noResultsMessage = parsed.noResultsMessage === true;
record.parseWarnings = parsed.warnings;

// Identity of this page, for detecting repeats between pages and between probes.
record.edbList = parsed.rows.map((r) => r.edb).filter(Boolean);
record.signature = record.edbList.slice().sort().join('|');

// Nationwide? Cities are the only observable proxy on a results row.
record.distinctCities = [...new Set(parsed.rows.map((r) => r.city).filter(Boolean))];

// Total result count, if the page states one anywhere.
const text = htmlToText(html);
const totalMatch = text.match(/(?:вкупно|пронајдени|резултати|компании)[^\d]{0,40}([\d.,\s]{1,15})/i)
  || text.match(/([\d.,\s]{1,15})\s*(?:резултати|компании|пронајдени)/i);
record.totalResultsHint = totalMatch ? normalizeSpace(totalMatch[0]) : '';
record.totalResultsParsed = totalMatch ? parseMkNumber(totalMatch[1]) : null;

// Highest page number the pager links to, if the markup exposes one.
const pagerNumbers = [];
const pagerRe = /[?&]p=(\d{1,5})\b/g;
let pm;
while ((pm = pagerRe.exec(html)) !== null) pagerNumbers.push(Number(pm[1]));
record.maxPageLinkSeen = pagerNumbers.length ? Math.max(...pagerNumbers) : null;

// A handful of rows, so profile probes can be spread across different companies.
record.sampleRows = parsed.rows.slice(0, 5).map((r) => ({
  name: r.name, edb: r.edb, city: r.city, profileUrl: r.profileUrl, revenue: r.revenue
}));

// Raw excerpt for manual inspection when parsing came back empty.
record.rawExcerpt = parsed.rows.length ? '' : String(html).slice(0, 3000);

sd.step0.searchPages.push(record);
return [{ json: record }];
