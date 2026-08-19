// @requires-parsers
// Build the Step 0 probe list: the first few result pages plus one deliberately
// high page number, so the real end-of-results behaviour can be observed rather
// than guessed.

const cfg = $input.first().json;
const sd = $getWorkflowStaticData('global');

sd.step0 = { searchPages: [], profiles: [], startedAt: new Date().toISOString() };

const pages = [];
const firstPages = Number(cfg.probeFirstPages) || 3;
for (let p = 1; p <= firstPages; p++) pages.push(p);

const highPage = Number(cfg.probeHighPage) || 999;
if (pages.indexOf(highPage) === -1) pages.push(highPage);

return pages.map((page) => ({
  json: {
    page,
    searchUrl: buildSearchUrl(cfg, page),
    isHighPageProbe: page === highPage
  }
}));
