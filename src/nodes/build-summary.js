// Run summary. Reached once the company loop is exhausted.

const sd = $getWorkflowStaticData('global');
const stats = sd.stats || {};

const finishedAt = new Date().toISOString();
const failures = stats.failedUrls || [];

const summary = {
  startedAt: stats.startedAt || null,
  finishedAt,

  searchPagesFetched: stats.pagesFetched || 0,
  searchPageFailures: stats.searchRequestFailures || 0,
  companyRowsParsed: stats.rowsParsed || 0,
  duplicatesSkipped: stats.duplicatesSkipped || 0,
  companiesQueued: stats.companiesQueued || 0,

  profilesFetchedOk: stats.profilesOk || 0,
  profileFetchFailures: stats.profileFailures || 0,
  licaFallbacksNeeded: stats.licaFallbacks || 0,
  licaFetchFailures: stats.licaFailures || 0,

  rowsWrittenToSheet: stats.rowsWritten || 0,
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

return [{ json: summary }];
