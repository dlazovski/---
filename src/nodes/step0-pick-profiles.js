// Choose the profile pages to probe.
//
// One known-good control (the profile already inspected by hand) plus a spread
// of companies discovered by the search probes — different pages and different
// cities, so the "does every company list an owner/manager?" question gets a
// representative answer rather than three near-identical companies.

const cfg = $('Config').first().json;
const sd = $getWorkflowStaticData('global');

const wanted = Number(cfg.probeProfileCount) || 3;
const targets = [];
const seen = Object.create(null);

function add(url, label, edb, name) {
  if (!url || seen[url]) return;
  seen[url] = true;
  targets.push({ profileUrl: url, licaUrl: url + '/lica', label, edb: edb || '', name: name || '' });
}

if (cfg.knownProfileUrl) add(cfg.knownProfileUrl, 'known-good control (already inspected by hand)');

const rows = [];
for (const page of sd.step0.searchPages) {
  if (!page.sampleRow) continue;
  rows.push({ ...page.sampleRow, fromPage: page.page });
}

// Prefer distinct cities, then fall back to whatever else was found.
const usedCities = Object.create(null);
for (const row of rows) {
  if (targets.length >= wanted + 1) break;
  if (row.city && usedCities[row.city]) continue;
  if (row.city) usedCities[row.city] = true;
  add(row.profileUrl, 'discovered on search page ' + row.fromPage, row.edb, row.name);
}
for (const row of rows) {
  if (targets.length >= wanted + 1) break;
  add(row.profileUrl, 'discovered on search page ' + row.fromPage, row.edb, row.name);
}

if (targets.length === 0) {
  return [{ json: { profileUrl: '', licaUrl: '', label: 'NONE — no profile URLs available to probe', edb: '', name: '' } }];
}

return targets.map((t) => ({ json: t }));
