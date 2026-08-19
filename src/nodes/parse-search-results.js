// @requires-parsers
// Extract company rows from one search-results page and decide whether to
// continue paginating.
//
// The stop condition deliberately covers several possible end-of-results
// behaviours, because which one the site actually exhibits is NOT yet verified
// (see docs/step-0-verification.md):
//   1. the page yields zero company rows;
//   2. the page repeats the previous page exactly (site clamps `p`);
//   3. every company on the page was already collected;
//   4. a safety cap on page count;
//   5. too many consecutive request failures.

const cfg = $('Config').first().json;
const state = $('Build Search URL').first().json;
const sd = $getWorkflowStaticData('global');
const stats = sd.stats;

const { status, html, error } = readHttpItem($input.first());

const page = Number(state.page) || 1;
const url = state.searchUrl;
const maxPages = Number(cfg.maxPages) || 60;
const maxCompanies = Number(cfg.maxCompanies) || 0;
const maxConsecutiveFailures = Number(cfg.maxConsecutiveFailures) || 3;

let consecutiveFailures = Number(state.consecutiveFailures) || 0;
let stop = false;
let stopReason = '';
let signature = state.previousSignature || '';
let pageRows = 0;
let newRows = 0;
let failureReason = error;
let parsed = null;

if (!failureReason) {
  parsed = parseSearchResults(html, { baseUrl: cfg.baseUrl });
  if (parsed.blocked) failureReason = parsed.blocked;
}

if (failureReason) {
  // Log and move on: one bad page must not kill the run.
  stats.searchRequestFailures += 1;
  stats.failedUrls.push({ stage: 'search', page, url, status, reason: failureReason });
  consecutiveFailures += 1;
  if (consecutiveFailures >= maxConsecutiveFailures) {
    stop = true;
    stopReason = consecutiveFailures + ' consecutive search-page failures — stopping pagination';
  }
} else {
  consecutiveFailures = 0;
  stats.pagesFetched += 1;
  pageRows = parsed.rows.length;
  stats.rowsParsed += pageRows;
  parsed.warnings.forEach((w) => stats.warnings.push('page ' + page + ': ' + w));

  signature = parsed.rows
    .map((r) => r.edb || r.profilePath)
    .sort()
    .join('|');

  if (pageRows === 0) {
    stop = true;
    stopReason = parsed.noResultsMessage
      ? 'page ' + page + ' states there are no results for this filter (end of results)'
      : 'page ' + page + ' returned no company rows and no "no results" message — '
        + 'either the end of results, or the row markup changed (check the raw HTML)';
  } else if (signature && signature === state.previousSignature) {
    stop = true;
    stopReason = 'page ' + page + ' repeated the previous page exactly (end of results)';
  } else {
    for (const row of parsed.rows) {
      const key = row.edb || row.profilePath;
      if (!key) {
        stats.warnings.push('page ' + page + ': row with neither ЕДБ nor profile link, dropped');
        continue;
      }
      if (sd.seenKeys[key]) {
        stats.duplicatesSkipped += 1;
        continue;
      }
      sd.seenKeys[key] = true;
      sd.collected.push({ ...row, foundOnPage: page });
      newRows += 1;
    }
    if (newRows === 0) {
      stop = true;
      stopReason = 'page ' + page + ' contained only companies already collected (end of results)';
    }
  }
}

if (!stop && maxCompanies > 0 && sd.collected.length >= maxCompanies) {
  stop = true;
  stopReason = 'maxCompanies cap (' + maxCompanies + ') reached';
}
if (!stop && page >= maxPages) {
  stop = true;
  stopReason = 'maxPages safety cap (' + maxPages + ') reached — raise it if this was not the real end';
}

// Diagnostics from the first page make selector problems obvious immediately.
const sample = (parsed && parsed.rows.length) ? parsed.rows[0] : null;

return [{
  json: {
    ...state,
    page: stop ? page : page + 1,
    stop,
    stopReason,
    previousSignature: signature,
    consecutiveFailures,
    pagesFetched: stats.pagesFetched,
    lastPageRows: pageRows,
    lastPageNewRows: newRows,
    totalCollected: sd.collected.length,
    lastPageFailure: failureReason || '',
    sampleRow: sample,
    sampleRowWarnings: sample ? sample.warnings : []
  }
}];
