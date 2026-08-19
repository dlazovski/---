// Master de-duplication by ЕДБ, then fan out one item per company.
//
// Pagination already skips keys it has seen, but this is the explicit master
// pass: ЕДБ is unique per company. Rows with no ЕДБ fall back to the profile
// path so a parsing gap never silently drops a company.

const cfg = $('Config').first().json;
const sd = $getWorkflowStaticData('global');
const stats = sd.stats;

const maxCompanies = Number(cfg.maxCompanies) || 0;
const seen = Object.create(null);
const unique = [];

for (const row of sd.collected) {
  const key = row.edb || row.profilePath;
  if (!key) continue;
  if (seen[key]) {
    stats.duplicatesSkipped += 1;
    continue;
  }
  seen[key] = true;
  unique.push(row);
}

const selected = maxCompanies > 0 ? unique.slice(0, maxCompanies) : unique;
stats.companiesQueued = selected.length;

if (selected.length === 0) {
  stats.warnings.push('no companies collected — check the search-page selectors against a real page');
}

return selected.map((row) => ({ json: row }));
