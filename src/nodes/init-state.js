// Initialise pagination state and the run-wide counters.
//
// Counters and the collected-company list live in workflow static data so the
// pagination loop does not have to carry a growing array through every item.
// Everything is reset here, so re-running the workflow always starts clean.

const cfg = $input.first().json;
const sd = $getWorkflowStaticData('global');

sd.stats = {
  startedAt: new Date().toISOString(),
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
  warnings: []
};
sd.collected = [];
sd.seenKeys = {};

return [{
  json: {
    ...cfg,
    page: Number(cfg.startPage) || 1,
    stop: false,
    stopReason: '',
    previousSignature: '',
    consecutiveFailures: 0,
    pagesFetched: 0
  }
}];
