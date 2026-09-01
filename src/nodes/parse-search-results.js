// @requires-parsers
// Extract company rows from one search-results page, then decide whether to take
// the next page, move to the next segment (НКД code x revenue band), or finish.
//
// The end-of-segment condition covers several possible site behaviours, because
// which one applies is confirmed only by observation:
//   1. the page yields zero company rows;
//   2. the page is short — fewer rows than a full page, so it is the last one;
//   3. the page repeats the previous page exactly (site clamps `p`);
//   4. a per-segment safety cap on page count.
// Whole-run stops: the company cap, or too many consecutive request failures.
//
// Reaching the clamp on a still-full page means the site would not let us page
// any further, NOT that the segment ran out — results are sorted by revenue
// descending, so the companies past the cap are simply invisible. When that
// happens the revenue band is halved and both halves are swept instead.

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
const maxSegments = Number(cfg.maxSegments) || 400;

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
let hitResultCap = false;

function collectRows() {
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
}

if (!failureReason) {
  parsed = parseSearchResults(html, { baseUrl: cfg.baseUrl, cityMode: cfg.cityMode });
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
  if (pageRows > (stats.maxRowsPerPage || 0)) stats.maxRowsPerPage = pageRows;
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
    hitResultCap = page > 1;
    segmentFinishReason = 'page ' + page + ' repeated the previous page exactly';
  } else if (stats.maxRowsPerPage && pageRows < stats.maxRowsPerPage) {
    // A short page is the genuine last page of this segment.
    collectRows();
    segmentFinished = true;
    segmentFinishReason = 'page ' + page + ' returned ' + pageRows + ' rows (fewer than a full page)';
  } else {
    collectRows();
  }

  // Note: "every company on this page was already collected" is deliberately NOT
  // an end-of-segment condition. Once a band has been split, the halves re-return
  // companies the parent band already collected, and treating that as the end
  // would stop each half on its first page.

  if (!segmentFinished && page >= maxPages) {
    segmentFinished = true;
    hitResultCap = true;
    segmentFinishReason = 'per-segment page cap (' + maxPages + ') reached';
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

  // The site caps how far a search can be paged, and orders results by revenue
  // descending — so a segment that stops at the cap is hiding its smallest
  // companies. Halve its revenue band and sweep both halves instead.
  if (hitResultCap) {
    stats.segmentsHitResultCap += 1;

    const autoSplit = cfg.autoSplitTruncatedBands !== false;
    const halves = autoSplit
      ? splitSegmentByRevenue(segment, Number(cfg.minBandWidth) || 1000)
      : null;

    if (halves && segments.length + 2 <= maxSegments) {
      segments.splice(segmentIndex + 1, 0, halves[0], halves[1]);
      stats.segmentsSplit += 1;
      stats.warnings.push(
        '[' + segmentLabel + '] hit the site result cap with a full page — split into ' +
        describeSegment(halves[0]) + ' and ' + describeSegment(halves[1])
      );
    } else {
      stats.segmentsTruncated += 1;
      stats.truncatedSegments.push(segmentLabel);
      stats.warnings.push(
        '[' + segmentLabel + '] hit the site result cap and could NOT be split (' +
        (!autoSplit ? 'auto-split disabled'
          : (!halves ? 'no revenue band to divide, or band already too narrow'
                     : 'segment limit of ' + maxSegments + ' reached')) +
        ') — companies in this band are being missed'
      );
    }
  }

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
    hitResultCap,
    segmentCount: segments.length,
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
