// Run summary. Reached once the company loop is exhausted.

const sd = $getWorkflowStaticData('global');
const stats = sd.stats || {};
const segments = sd.segments || [];
const nkdCodes = sd.nkdCodes || [];

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

  // Search sweep (one segment per НКД code x revenue band)
  nkdCodesFiltered: nkdCodes,
  segmentsPlanned: stats.segmentsPlanned || 0,
  segmentsCompleted: stats.segmentsCompleted || 0,
  segments: segments.map((seg, i) => ({
    segment: i + 1,
    nkd: seg.activityType || '(all activities)',
    revenueFrom: seg.revenueFrom !== undefined ? seg.revenueFrom : null,
    revenueTo: seg.revenueTo !== undefined ? seg.revenueTo : null
  })),

  // Did the `at=` filter actually take effect?
  companiesMatchingNkdFilter: Math.max(0, (stats.profilesOk || 0) - (stats.nkdMismatched || 0) - (stats.nkdUnknown || 0)),
  companiesNotMatchingNkdFilter: stats.nkdMismatched || 0,
  companiesWithUnreadableNkd: stats.nkdUnknown || 0,

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

// If the `at=` parameter is being ignored, almost everything fetched will fall
// outside the requested НКД codes. That is worth shouting about: it means the
// search was not actually filtered, not that these companies are unusual.
const nkdChecked = summary.companiesMatchingNkdFilter + summary.companiesNotMatchingNkdFilter;
if (nkdCodes.length > 0 && nkdChecked >= 5 && summary.companiesNotMatchingNkdFilter > nkdChecked / 2) {
  summary.nkdFilterWarning =
    summary.companiesNotMatchingNkdFilter + ' of ' + nkdChecked + ' companies fetched do NOT fall under '
    + 'the requested НКД code(s) ' + nkdCodes.join(', ') + '. The `at=` search parameter is most likely '
    + 'being ignored by the site, so the search was effectively unfiltered. Verify the parameter with the '
    + 'Step 0 workflow before trusting this run.';
}

// A run that found nothing new usually means the filter is genuinely exhausted.
if (summary.companiesQueued === 0 && summary.existingCompaniesSeeded > 0) {
  summary.note = 'No new companies found. Every company this filter returns is already in the sheet — '
    + 'the search is exhausted. To go further you need a different filter (more НКД codes, or a '
    + 'different balance year), not another run of this one.';
} else if (summary.companiesSkippedAsAlreadyInSheet > 0) {
  summary.note = 'Skipped ' + summary.companiesSkippedAsAlreadyInSheet + ' companies that were already '
    + 'in the sheet, and appended ' + summary.newRowsWrittenToSheet + ' new ones.';
}

return [{ json: summary }];
