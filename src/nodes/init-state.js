// @requires-parsers
// Seed the run: de-duplicate against what is already in the sheet, and split the
// revenue filter into bands to sweep.
//
// Input is the existing sheet's rows (the Read Existing Sheet node runs with
// alwaysOutputData, so an empty sheet still produces one empty item here).
// Counters and the collected-company list live in workflow static data, reset
// here so every run starts clean.

const cfg = $('Config').first().json;
const existingRows = $input.all();
const sd = $getWorkflowStaticData('global');

sd.stats = {
  startedAt: new Date().toISOString(),
  existingRowsInSheet: 0,
  existingEdbSeeded: 0,
  existingRowsWithUnreadableEdb: 0,
  alreadyInSheetSkipped: 0,
  segmentsPlanned: 0,
  segmentsCompleted: 0,
  segmentsHitResultCap: 0,
  segmentsSplit: 0,
  segmentsTruncated: 0,
  truncatedSegments: [],
  maxRowsPerPage: 0,
  nkdMismatched: 0,
  nkdUnknown: 0,
  pagesFetched: 0,
  searchRequestFailures: 0,
  rowsParsed: 0,
  duplicatesSkipped: 0,
  companiesQueued: 0,
  profilesOk: 0,
  profileFailures: 0,
  licaFallbacks: 0,
  licaFailures: 0,
  noPhone: 0,
  noEmail: 0,
  noContactPerson: 0,
  rowsWritten: 0,
  rowsSkipped: 0,
  failedUrls: [],
  warnings: [],
  sheetHeadersSeen: [],
  sheetColumnMap: {},
  sheetColumnsUnmatched: [],
  columnsWithDataButNoHeader: [],
  fieldDiagnostics: { activity: [], contactPerson: [], phone: [], email: [] }
};
sd.collected = [];
sd.seenKeys = {};
sd.sheetKeys = {};
sd.sheetHeaders = [];

// --- de-duplicate against the existing sheet --------------------------------
const edbColumn = cfg.sheetEdbColumn || 'Даночен БРОЈ';

for (const item of existingRows) {
  const row = item.json || {};
  // An empty item from alwaysOutputData is not a row.
  if (Object.keys(row).length === 0) continue;
  sd.stats.existingRowsInSheet += 1;

  // The keys of a returned row ARE the sheet's header text, which is the only
  // way to learn how the columns are actually spelled.
  if (sd.sheetHeaders.length === 0) sd.sheetHeaders = Object.keys(row);

  const edb = normalizeEdb(row[edbColumn]);
  if (!edb) {
    sd.stats.existingRowsWithUnreadableEdb += 1;
    continue;
  }
  if (edb.length !== 13) {
    // Most likely the cell was rendered in scientific notation by Sheets.
    sd.stats.existingRowsWithUnreadableEdb += 1;
    sd.stats.warnings.push('existing sheet row has an ЕДБ that is not 13 digits: "' + edb + '"');
  }
  if (!sd.seenKeys[edb]) {
    sd.seenKeys[edb] = true;
    sd.sheetKeys[edb] = true;
    sd.stats.existingEdbSeeded += 1;
  }
}

if (sd.stats.existingRowsInSheet > 0 && sd.stats.existingEdbSeeded === 0) {
  sd.stats.warnings.push(
    'read ' + sd.stats.existingRowsInSheet + ' existing sheet rows but seeded no ЕДБ — check that '
    + 'the column is named "' + edbColumn + '"; the run would otherwise re-add companies you already have'
  );
}

// --- plan the sweep ---------------------------------------------------------
// One segment per (НКД code x revenue band). Each is paged to its own end, so
// splitting the work is both the filter and the way past the site's pagination
// depth cap.
const segments = buildSearchSegments(cfg);
sd.segments = segments;
sd.stats.segmentsPlanned = segments.length;

const nkdCodes = parseNkdCodes(cfg.nkdCodes);
sd.nkdCodes = nkdCodes;

if (nkdCodes.length === 0) {
  sd.stats.warnings.push('no НКД codes configured — searching all activities');
}

return [{
  json: {
    segmentIndex: 0,
    segment: segments[0],
    segmentLabel: describeSegment(segments[0]),
    segmentCount: segments.length,
    page: Number(cfg.startPage) || 1,
    stop: false,
    stopReason: '',
    previousSignature: '',
    consecutiveFailures: 0,
    existingEdbSeeded: sd.stats.existingEdbSeeded
  }
}];
