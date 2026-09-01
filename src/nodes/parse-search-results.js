// @requires-parsers
// Extract company rows from one search-results page, then decide whether to take
// the next page, move to the next segment (НКД code x revenue band), or finish.
//
// The end-of-segment condition covers several possible site behaviours, because
// which one applies is confirmed only by observation:
//   1. the page yields zero company rows;
//   2. the page repeats the previous page exactly (site clamps `p`);
//   3. every company on the page was already collected;
//   4. a per-segment safety cap on page count.
// Whole-run stops: the company cap, or too many consecutive request failures.

const cfg = $('Config').first().json;
const state = $('Build Search URL').first().json;
const sd = $getWorkflowStaticData('global');
const stats = sd.stats;

const { status, html, error } = readHttpItem($input.first());

const segments = sd.segments;
const segmentIndex = Number(state.segmentIndex) || 0;
const segment = segments[segmentIndex];
const segmentLabel = describeSegment(segment);
const page = Number(state.page) || 1;
const url = state.searchUrl;

const maxPages = Number(cfg.maxPages) || 60;
const maxCompanies = Number(cfg.maxCompanies) || 0;
const maxConsecutiveFailures = Number(cfg.maxConsecutiveFailures) || 3;

let consecutiveFailures = Number(state.consecutiveFailures) || 0;
let stop = false;
let stopReason = '';
let segmentFinished = false;
let segmentFinishReason = '';
let signature = state.previousSignature || '';
let pageRows = 0;
let newRows = 0;
let alreadyInSheet = 0;
let failureReason = error;
let parsed = null;

if (!failureReason) {
  parsed = parseSearchResults(html, { baseUrl: cfg.baseUrl });
  if (parsed.blocked) failureReason = parsed.blocked;
}

if (failureReason) {
  // Log and move on: one bad page must not kill the run.
  stats.searchRequestFailures += 1;
  stats.failedUrls.push({ stage: 'search', segment: segmentLabel, page, url, status, reason: failureReason });
  consecutiveFailures += 1;
  if (consecutiveFailures >= maxConsecutiveFailures) {
    stop = true;
    stopReason = consecutiveFailures + ' consecutive search-page failures — stopping the run';
  }
} else {
  consecutiveFailures = 0;
  stats.pagesFetched += 1;
  pageRows = parsed.rows.length;
  stats.rowsParsed += pageRows;
  parsed.warnings.forEach((w) => stats.warnings.push('[' + segmentLabel + '] page ' + page + ': ' + w));

  signature = parsed.rows
    .map((r) => r.edb || r.profilePath)
    .sort()
    .join('|');

  if (pageRows === 0) {
    segmentFinished = true;
    segmentFinishReason = parsed.noResultsMessage
      ? 'no results for this segment'
      : 'no company rows and no "no results" message — either the end, or the row markup changed';
  } else if (signature && signature === state.previousSignature) {
    segmentFinished = true;
    segmentFinishReason = 'page ' + page + ' repeated the previous page exactly';
  } else {
    for (const row of parsed.rows) {
      const key = row.edb || row.profilePath;
      if (!key) {
        stats.warnings.push('[' + segmentLabel + '] page ' + page + ': row with neither ЕДБ nor profile link, dropped');
        continue;
      }
      if (sd.sheetKeys[key]) {
        // Already in the sheet from an earlier run — skip without re-fetching it.
        stats.alreadyInSheetSkipped += 1;
        sd.seenKeys[key] = true;
        alreadyInSheet += 1;
        continue;
      }
      if (sd.seenKeys[key]) {
        stats.duplicatesSkipped += 1;
        continue;
      }
      sd.seenKeys[key] = true;
      sd.collected.push({ ...row, foundOnPage: page, foundInSegment: segmentLabel, nkdFilter: segment.activityType || '' });
      newRows += 1;
    }
    // Rows already in the sheet still prove the page was fresh, so only treat the
    // page as exhausted when it produced nothing new AND nothing already known.
    if (newRows === 0 && alreadyInSheet === 0) {
      segmentFinished = true;
      segmentFinishReason = 'page ' + page + ' contained only companies already collected in this run';
    }
  }

  if (!segmentFinished && page >= maxPages) {
    segmentFinished = true;
    segmentFinishReason = 'per-segment page cap (' + maxPages + ') reached — raise maxPages if this was not the real end';
  }
}

if (!stop && maxCompanies > 0 && sd.collected.length >= maxCompanies) {
  stop = true;
  stopReason = 'maxCompanies cap (' + maxCompanies + ') reached';
}

// --- advance: next page, next segment, or done ------------------------------
let nextSegmentIndex = segmentIndex;
let nextPage = page + 1;
let nextSignature = signature;

if (!stop && segmentFinished) {
  stats.segmentsCompleted += 1;
  stats.warnings.push(
    'segment ' + (segmentIndex + 1) + '/' + segments.length +
    ' [' + segmentLabel + '] finished after ' + page + ' page(s): ' + segmentFinishReason
  );
  if (segmentIndex + 1 < segments.length) {
    nextSegmentIndex = segmentIndex + 1;
    nextPage = 1;
    nextSignature = '';
  } else {
    stop = true;
    stopReason = 'all ' + segments.length + ' segment(s) swept; last one finished: ' + segmentFinishReason;
  }
}

const sample = (parsed && parsed.rows.length) ? parsed.rows[0] : null;

return [{
  json: {
    ...state,
    segmentIndex: nextSegmentIndex,
    segment: segments[nextSegmentIndex],
    segmentLabel: describeSegment(segments[nextSegmentIndex]),
    page: stop ? page : nextPage,
    stop,
    stopReason,
    previousSignature: nextSignature,
    consecutiveFailures,
    segmentFinished,
    segmentFinishReason,
    pagesFetched: stats.pagesFetched,
    lastPageRows: pageRows,
    lastPageNewRows: newRows,
    lastPageAlreadyInSheet: alreadyInSheet,
    totalCollected: sd.collected.length,
    lastPageFailure: failureReason || '',
    sampleRow: sample,
    sampleRowWarnings: sample ? sample.warnings : []
  }
}];
