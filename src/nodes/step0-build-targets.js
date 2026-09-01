// @requires-parsers
// Build the Step 0 probe list.
//
// The `at=` (НКД) parameter has only ever been sent empty, so its behaviour is
// entirely unverified. These probes are designed to answer three things that
// cannot be assumed:
//   - does `at=<division>` actually narrow the result set, or is it ignored?
//   - does a two-digit division cover the codes beneath it?
//   - which of the two "no revenue filter" URL forms does the site honour?

const cfg = $input.first().json;
const sd = $getWorkflowStaticData('global');

sd.step0 = { searchPages: [], profiles: [], startedAt: new Date().toISOString() };

const codes = parseNkdCodes(cfg.nkdCodes);
const code = codes.length ? codes[0] : '';
sd.step0.nkdCodeUnderTest = code;
sd.step0.nkdCodesConfigured = codes;

const probes = [];

function probe(label, overrides, page, opts) {
  const settings = { ...cfg, ...overrides };
  probes.push({
    label,
    page,
    nkd: settings.activityType || '',
    revenueFilterMode: settings.revenueFilterMode,
    isBaseline: !!(opts && opts.isBaseline),
    isFiltered: !!(settings.activityType),
    isHighPageProbe: !!(opts && opts.isHighPageProbe),
    isRevenueFormProbe: !!(opts && opts.isRevenueFormProbe),
    searchUrl: buildSearchUrl(settings, page)
  });
}

// Control: no activity filter at all. Its result count is the yardstick — if the
// filtered search returns the same thing, `at=` is being ignored.
probe('baseline — no НКД filter', { activityType: '', revenueFilterMode: 'off-zero' }, 1, { isBaseline: true });

if (code) {
  probe('filtered — at=' + code, { activityType: code, revenueFilterMode: 'off-zero' }, 1);

  const firstPages = Number(cfg.probeFirstPages) || 3;
  for (let p = 2; p <= firstPages; p++) {
    probe('filtered — at=' + code + ' page ' + p, { activityType: code, revenueFilterMode: 'off-zero' }, p);
  }

  const highPage = Number(cfg.probeHighPage) || 999;
  probe('filtered — at=' + code + ' page ' + highPage,
    { activityType: code, revenueFilterMode: 'off-zero' }, highPage, { isHighPageProbe: true });

  // Same filter, the other way of saying "no revenue restriction".
  probe('filtered — at=' + code + ', revenue block omitted',
    { activityType: code, revenueFilterMode: 'off-omit' }, 1, { isRevenueFormProbe: true });
} else {
  sd.step0.warning = 'no НКД code configured — set nkdCodes in Config, otherwise only the baseline is probed';
}

return probes.map((json) => ({ json }));
