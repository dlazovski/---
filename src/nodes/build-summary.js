// Run summary. Reached once the company loop is exhausted.

const sd = $getWorkflowStaticData('global');
const stats = sd.stats || {};
const bands = sd.bands || [];

const finishedAt = new Date().toISOString();
const failures = stats.failedUrls || [];

const summary = {
  startedAt: stats.startedAt || null,
  finishedAt,

  // De-duplication against the sheet this run appended to
  existingRowsReadFromSheet: stats.existingRowsInSheet || 0,
  existingCompaniesSeeded: stats.existingEdbSeeded || 0,
  existingRowsWithUnreadableEdb: stats.existingRowsWithUnreadableEdb || 0,
  companiesSkippedAsAlreadyInSheet: stats.alreadyInSheetSkipped || 0,

  // Revenue band sweep
  revenueBandsPlanned: stats.bandsPlanned || 0,
  revenueBandsCompleted: stats.bandsCompleted || 0,
  revenueBands: bands.map((b, i) => ({ band: i + 1, from: b.from, to: b.to })),

  searchPagesFetched: stats.pagesFetched || 0,
  searchPageFailures: stats.searchRequestFailures || 0,
  companyRowsParsed: stats.rowsParsed || 0,
  duplicatesSkipped: stats.duplicatesSkipped || 0,
  companiesQueued: stats.companiesQueued || 0,

  profilesFetchedOk: stats.profilesOk || 0,
  profileFetchFailures: stats.profileFailures || 0,
  licaFallbacksNeeded: stats.licaFallbacks || 0,
  licaFetchFailures: stats.licaFailures || 0,

  newRowsWrittenToSheet: stats.rowsWritten || 0,
  rowsSkipped: stats.rowsSkipped || 0,
  companiesWithNoPhone: stats.noPhone || 0,
  companiesWithNoEmail: stats.noEmail || 0,
  companiesWithNoContactPerson: stats.noContactPerson || 0,

  totalFailures: failures.length,
  failuresByStage: failures.reduce((acc, f) => {
    acc[f.stage] = (acc[f.stage] || 0) + 1;
    return acc;
  }, {}),
  failedUrls: failures,

  // Capped: a systematic parsing problem would otherwise produce thousands.
  warnings: (stats.warnings || []).slice(0, 200),
  warningCount: (stats.warnings || []).length
};

// A run that found nothing new usually means the filter is genuinely exhausted.
if (summary.companiesQueued === 0 && summary.existingCompaniesSeeded > 0) {
  summary.note = 'No new companies found. Every company this filter returns is already in the sheet — '
    + 'the search is exhausted. To go further you need a different filter (a wider revenue range, '
    + 'or a different balance year), not another run of this one.';
} else if (summary.companiesSkippedAsAlreadyInSheet > 0) {
  summary.note = 'Skipped ' + summary.companiesSkippedAsAlreadyInSheet + ' companies that were already '
    + 'in the sheet, and appended ' + summary.newRowsWrittenToSheet + ' new ones.';
}

return [{ json: summary }];
