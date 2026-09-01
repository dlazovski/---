// Choose the profile pages to probe.
//
// Profiles are taken from the FILTERED search probes specifically, because the
// key question is whether the companies `at=` returns actually fall under the
// requested НКД code — and only a profile page shows a company's code.
// One known-good control is included so a parsing failure can be told apart
// from a filtering failure.

const cfg = $('Config').first().json;
const sd = $getWorkflowStaticData('global');

const wanted = Number(cfg.probeProfileCount) || 3;
const targets = [];
const seen = Object.create(null);

function add(url, label, extra) {
  if (!url || seen[url]) return;
  seen[url] = true;
  targets.push({
    profileUrl: url,
    licaUrl: url + '/lica',
    label,
    edb: (extra && extra.edb) || '',
    name: (extra && extra.name) || '',
    expectedNkd: (extra && extra.expectedNkd) || ''
  });
}

if (cfg.knownProfileUrl) {
  add(cfg.knownProfileUrl, 'known-good control (already inspected by hand)');
}

// Every company seen on a filtered page, in the order they were found.
const candidates = [];
for (const page of sd.step0.searchPages) {
  if (!page.isFiltered || !page.sampleRows) continue;
  for (const row of page.sampleRows) {
    candidates.push({ ...row, fromLabel: page.label, expectedNkd: page.nkd });
  }
}

// Prefer distinct cities so the sample is not three near-identical companies.
const usedCities = Object.create(null);
for (const row of candidates) {
  if (targets.length >= wanted + 1) break;
  if (row.city && usedCities[row.city]) continue;
  if (row.city) usedCities[row.city] = true;
  add(row.profileUrl, 'from ' + row.fromLabel, row);
}
for (const row of candidates) {
  if (targets.length >= wanted + 1) break;
  add(row.profileUrl, 'from ' + row.fromLabel, row);
}

if (targets.length === 0) {
  return [{ json: { profileUrl: '', licaUrl: '', label: 'NONE — no profile URLs available to probe', edb: '', name: '', expectedNkd: '' } }];
}

return targets.map((t) => ({ json: t }));
