// Step 0 report: one item, structured as the questions Step 0 needs answered.
//
// Nothing here decides anything — it reports observed behaviour so the findings
// can be reviewed before a full run is started.

const cfg = $('Config').first().json;
const sd = $getWorkflowStaticData('global');
const pages = (sd.step0 && sd.step0.searchPages) || [];
const profiles = (sd.step0 && sd.step0.profiles) || [];
const nkdCode = (sd.step0 && sd.step0.nkdCodeUnderTest) || '';

const baseline = pages.find((p) => p.isBaseline) || null;
const filtered = pages.filter((p) => p.isFiltered && !p.isHighPageProbe && !p.isRevenueFormProbe && !p.isTailProbe);
const tailProbe = pages.find((p) => p.isTailProbe) || null;
const filteredPage1 = filtered.find((p) => p.page === 1) || null;
const highProbe = pages.find((p) => p.isHighPageProbe) || null;
const revenueFormProbe = pages.find((p) => p.isRevenueFormProbe && !p.isTailProbe) || null;

const usable = (p) => p && !p.error && !p.blocked;

// --- Q1: does the search work at all? ---------------------------------------
const q1 = {
  question: 'Does the search URL return usable results through ScrapingBee?',
  httpStatus: baseline ? baseline.httpStatus : null,
  bytes: baseline ? baseline.bytes : 0,
  error: baseline ? (baseline.error || baseline.blocked || '') : 'baseline page was not fetched',
  rowsParsed: baseline ? baseline.rowCount : 0,
  verdict: usable(baseline) && baseline.rowCount > 0
    ? 'OK — results returned and parsed'
    : 'NEEDS ATTENTION — see rawExcerpt on the baseline record'
};

// --- Q2: does at= actually filter? ------------------------------------------
const profilesWithExpectation = profiles.filter((p) => !p.error && !p.blocked && p.expectedNkd);
const nkdMatched = profilesWithExpectation.filter((p) => p.nkdMatchesFilter === true);
const nkdMismatched = profilesWithExpectation.filter((p) => p.nkdMatchesFilter === false);
const nkdUnreadable = profilesWithExpectation.filter((p) => p.nkdMatchesFilter === null);

let nkdVerdict;
if (!nkdCode) {
  nkdVerdict = 'NOT TESTED — no НКД code configured. Set nkdCodes in Config and re-run Step 0.';
} else if (!usable(baseline) || !usable(filteredPage1)) {
  nkdVerdict = 'UNVERIFIED — the baseline or filtered search did not return a usable page.';
} else if (baseline.signature && baseline.signature === filteredPage1.signature) {
  nkdVerdict = 'FILTER IGNORED — at=' + nkdCode + ' returned exactly the same companies as the '
    + 'unfiltered search. The parameter is not doing anything; do NOT run the full scrape.';
} else if (profilesWithExpectation.length === 0) {
  nkdVerdict = 'PARTIAL — the filtered search returned a different result set, but no profile page '
    + 'could be checked to confirm the companies really fall under ' + nkdCode + '.';
} else if (nkdMismatched.length === 0) {
  nkdVerdict = 'CONFIRMED — at=' + nkdCode + ' narrowed the results, and every probed company falls '
    + 'under that НКД division.';
} else if (nkdMatched.length === 0) {
  nkdVerdict = 'WRONG CODES RETURNED — at=' + nkdCode + ' changed the result set, but none of the '
    + 'probed companies fall under it. The parameter probably expects a different value format '
    + '(an internal ID rather than the НКД code). Do NOT run the full scrape.';
} else {
  nkdVerdict = 'MIXED — ' + nkdMatched.length + ' of ' + profilesWithExpectation.length
    + ' probed companies fall under ' + nkdCode + '. A division filter may be looser than expected; '
    + 'review the codes below before running.';
}

const q2 = {
  question: 'Does at=' + (nkdCode || '<code>') + ' actually restrict the search to that НКД division?',
  codeUnderTest: nkdCode,
  baselineRowCount: baseline ? baseline.rowCount : null,
  filteredRowCount: filteredPage1 ? filteredPage1.rowCount : null,
  resultSetsIdentical: !!(baseline && filteredPage1 && baseline.signature && baseline.signature === filteredPage1.signature),
  profilesChecked: profilesWithExpectation.length,
  profilesUnderRequestedCode: nkdMatched.length,
  profilesOutsideRequestedCode: nkdMismatched.length,
  profilesWithUnreadableCode: nkdUnreadable.length,
  codesSeen: profilesWithExpectation.map((p) => ({
    name: p.name, nkd: p.activityCode, matches: p.nkdMatchesFilter
  })),
  verdict: nkdVerdict
};

// --- Q3: which "no revenue filter" URL form should be used? -----------------
let revenueFormVerdict;
if (!usable(filteredPage1) || !usable(revenueFormProbe)) {
  revenueFormVerdict = 'UNVERIFIED — one of the two forms did not return a usable page.';
} else if (filteredPage1.signature === revenueFormProbe.signature) {
  revenueFormVerdict = 'EITHER WORKS — both forms returned the same companies. Keep the default '
    + "revenueFilterMode = 'off-zero'.";
} else {
  revenueFormVerdict = 'THE FORMS DIFFER — off-zero returned ' + filteredPage1.rowCount
    + ' rows, off-omit returned ' + revenueFormProbe.rowCount + '. Use whichever returns more, '
    + 'and check its companies really are unrestricted by revenue.';
}

const q3 = {
  question: 'With the revenue filter removed, which URL form does the site honour?',
  offZeroRowCount: filteredPage1 ? filteredPage1.rowCount : null,
  offOmitRowCount: revenueFormProbe ? revenueFormProbe.rowCount : null,
  verdict: revenueFormVerdict
};

// --- Q4: pagination ----------------------------------------------------------
const pageComparisons = [];
const ordered = filtered.slice().sort((a, b) => a.page - b.page);
for (let i = 1; i < ordered.length; i++) {
  const prev = ordered[i - 1];
  const cur = ordered[i];
  const prevSet = new Set(prev.edbList || []);
  pageComparisons.push({
    comparing: 'p=' + prev.page + ' vs p=' + cur.page,
    identical: !!prev.signature && prev.signature === cur.signature,
    overlappingCompanies: (cur.edbList || []).filter((e) => prevSet.has(e)).length,
    rowsOnEachPage: [prev.rowCount, cur.rowCount]
  });
}

const q4 = {
  question: 'Does &p=N return a different page, and what does the end of results look like?',
  pageComparisons,
  highPageProbe: highProbe ? {
    page: highProbe.page,
    rowsReturned: highProbe.rowCount,
    statesNoResults: highProbe.noResultsMessage,
    error: highProbe.error || highProbe.blocked || '',
    behaviour: highProbe.rowCount === 0
      ? 'EMPTY LIST — the "zero rows" stop condition is correct'
      : 'RETURNED ' + highProbe.rowCount + ' ROWS — the site clamps p; the "repeated page" and '
        + '"all companies already seen" stop conditions are the ones that matter'
  } : null,
  verdict: pageComparisons.length === 0
    ? 'UNVERIFIED — fewer than two filtered pages were probed'
    : (pageComparisons.every((c) => !c.identical)
        ? 'OK — each probed page returned different companies'
        : 'PAGINATION SUSPECT — at least one page repeated the previous one')
};

// --- Q5: volume, and is the result set being truncated? ---------------------
const ordered5 = filtered.slice().sort((a, b) => a.page - b.page);
const lastReachable = ordered5.length ? ordered5[ordered5.length - 1] : null;
const rowsPerPage = filtered.map((p) => p.rowCount).filter((n) => n > 0);
const typicalPerPage = rowsPerPage.length ? Math.max(...rowsPerPage) : 0;

// The site clamps `p` to the last page, so p=999 coming back identical to the
// last page probed tells us exactly how many pages this search can reach.
const clampedToLastPage = !!(highProbe && lastReachable && highProbe.signature
  && highProbe.signature === lastReachable.signature);
const reachablePages = clampedToLastPage ? lastReachable.page : null;
const reachableCompanies = (reachablePages && typicalPerPage) ? reachablePages * typicalPerPage : null;

// Every ЕДБ the unrestricted search could reach.
const reachableEdb = new Set(filtered.flatMap((p) => p.edbList || []));
const tailRows = tailProbe ? (tailProbe.edbList || []) : [];
const tailUnseen = tailRows.filter((e) => !reachableEdb.has(e));
const truncated = tailUnseen.length > 0;

// Lowest revenue the unrestricted search still showed — the truncation cutoff.
const cutoffRevenue = lastReachable && typeof lastReachable.revenueMin === 'number'
  ? lastReachable.revenueMin : null;

let volumeVerdict;
if (!tailProbe) {
  volumeVerdict = 'UNVERIFIED — the tail probe did not run (no НКД code configured?)';
} else if (tailProbe.error || tailProbe.blocked) {
  volumeVerdict = 'UNVERIFIED — the tail probe failed: ' + (tailProbe.error || tailProbe.blocked);
} else if (truncated) {
  volumeVerdict = 'TRUNCATED — the plain search can only reach '
    + (reachableCompanies !== null ? ('about ' + reachableCompanies + ' companies (' + reachablePages + ' pages)') : 'a limited number of companies')
    + ', but a low-revenue search surfaced ' + tailUnseen.length + ' more that it never showed. '
    + 'Results are sorted by revenue descending and cut off'
    + (cutoffRevenue !== null ? (' below about ' + cutoffRevenue) : '')
    + '. Set revenueFilterMode = "range" with revenueFrom = 0 so the sweep is split into '
    + 'revenue bands — otherwise every smaller company is unreachable.';
} else if (reachableCompanies !== null) {
  volumeVerdict = 'COMPLETE (~' + reachableCompanies + ' companies, roughly '
    + Math.max(1, Math.round((reachableCompanies * 2 * 4) / 60)) + ' minutes) — a low-revenue '
    + 'search surfaced nothing the plain search had not already reached, so the whole result '
    + 'set is within reach without revenue banding.';
} else {
  volumeVerdict = 'UNKNOWN — could not establish how many pages the search reaches. '
    + 'Run the main workflow with maxCompanies set to a small number first.';
}

const q5 = {
  question: 'How many companies does the НКД filter return, and can the search actually reach them all?',
  rowsPerPageObserved: rowsPerPage,
  typicalRowsPerPage: typicalPerPage,
  pageNumberClampedBySite: clampedToLastPage,
  reachablePages,
  reachableCompanies,
  lowestRevenueStillVisible: cutoffRevenue,
  tailProbe: tailProbe ? {
    url: tailProbe.url,
    rowsReturned: tailProbe.rowCount,
    companiesNotReachableWithoutBanding: tailUnseen.length,
    sample: (tailProbe.sampleRows || []).slice(0, 3)
  } : null,
  resultSetIsTruncated: truncated,
  estimatedRuntimeMinutes: reachableCompanies !== null
    ? Math.max(1, Math.round((reachableCompanies * 2 * 4) / 60)) : null,
  verdict: volumeVerdict
};

// --- Q6: profile pages -------------------------------------------------------
const usableProfiles = profiles.filter((p) => !p.error && !p.blocked);
const needRenderJs = usableProfiles.filter((p) => p.renderJsLikelyRequired);
const withDuplicatePhones = usableProfiles.filter((p) => p.phoneDedupeCollapsedDuplicates);
const withPhones = usableProfiles.filter((p) => (p.phones || []).length > 0);
const needLica = usableProfiles.filter((p) => p.needsLicaFallback);

const q6 = {
  question: 'Do profile pages render fully without render_js, is the phone duplication consistent, '
          + 'and does every company list an owner/manager on the main page?',
  profilesProbed: profiles.length,
  profilesUsable: usableProfiles.length,

  renderJs: {
    profilesWithNoContactDataAtAll: needRenderJs.length,
    verdict: usableProfiles.length === 0
      ? 'UNVERIFIED — no profile page could be fetched'
      : (needRenderJs.length === 0
          ? 'CONFIRMED — a plain GET returns the Контакти data; render_js is NOT needed'
          : needRenderJs.length + ' of ' + usableProfiles.length + ' profiles returned no contact data — '
            + 'try render_js=true on those and compare')
  },

  phoneDuplication: {
    profilesWithPhones: withPhones.length,
    profilesWhereDedupeCollapsedDuplicates: withDuplicatePhones.length,
    perProfile: usableProfiles.map((p) => ({
      name: p.name, phonesAfterDedupe: p.phones, duplicatesCollapsed: p.phoneDedupeCollapsedDuplicates
    })),
    verdict: withPhones.length === 0
      ? 'UNVERIFIED — no profile returned a phone number'
      : (withDuplicatePhones.length > 0
          ? 'CONFIRMED — formatted/digits-only duplication occurs and normalise-then-dedupe removes it'
          : 'NO DUPLICATION SEEN on these profiles — the dedupe is harmless either way')
  },

  ownerManager: {
    profilesWithAtLeastOnePerson: usableProfiles.length - needLica.length,
    profilesNeedingLicaFallback: needLica.length,
    perProfile: usableProfiles.map((p) => ({
      name: p.name, peopleCount: p.peopleCount, contactPerson: p.contactPerson, role: p.contactPersonRole
    })),
    verdict: usableProfiles.length === 0
      ? 'UNVERIFIED'
      : (needLica.length === 0
          ? 'The main page listed an owner/manager for every probed company — /lica stays a rare fallback'
          : needLica.length + ' of ' + usableProfiles.length + ' probed companies listed nobody — '
            + 'the /lica fallback does get used')
  }
};

const blocking = [q1.verdict, q2.verdict, q3.verdict, q4.verdict, q5.verdict]
  .filter((v) => /NEEDS ATTENTION|IGNORED|WRONG CODES|SUSPECT|NOT TESTED|TRUNCATED/.test(v));

return [{
  json: {
    reportGeneratedAt: new Date().toISOString(),
    filter: {
      nkdCodes: cfg.nkdCodes,
      nkdCodeUnderTest: nkdCode,
      revenueFilterMode: cfg.revenueFilterMode,
      balanceYear: cfg.balanceYear,
      area: cfg.area || '(empty — nationwide)'
    },
    safeToRunFullScrape: blocking.length === 0,
    blockingFindings: blocking,

    q1_searchWorks: q1,
    q2_nkdFilterWorks: q2,
    q3_revenueFilterRemoval: q3,
    q4_pagination: q4,
    q5_volumeAndTruncation: q5,
    q6_profilePages: q6,
    q7_nextStep: blocking.length === 0
      ? 'All checks passed. Set googleSheetId in the main workflow, run it with maxCompanies=5 as a '
        + 'smoke test, then set maxCompanies=0 for the full run.'
      : 'Do NOT run the full scrape yet — see blockingFindings above and report them back.',

    rawSearchPageRecords: pages,
    rawProfileRecords: profiles
  }
}];
