// Step 0 report: one item, structured as the seven questions Step 0 asks.
//
// Nothing here decides anything — it reports observed behaviour so the findings
// can be reviewed before the full run is started.

const cfg = $('Config').first().json;
const sd = $getWorkflowStaticData('global');
const pages = (sd.step0 && sd.step0.searchPages) || [];
const profiles = (sd.step0 && sd.step0.profiles) || [];

const normalPages = pages.filter((p) => !p.isHighPageProbe);
const highProbe = pages.find((p) => p.isHighPageProbe) || null;

// --- Q1: did the confirmed URL return a usable page at all? ------------------
const page1 = pages.find((p) => p.page === 1) || null;
const q1 = {
  question: 'Does the confirmed nationwide search URL return results via ScrapingBee?',
  httpStatus: page1 ? page1.httpStatus : null,
  bytes: page1 ? page1.bytes : 0,
  error: page1 ? (page1.error || page1.blocked || '') : 'page 1 was not fetched',
  rowsParsed: page1 ? page1.rowCount : 0,
  profileLinkMatches: page1 ? page1.profileLinkMatches : 0,
  verdict: page1 && !page1.error && !page1.blocked && page1.rowCount > 0
    ? 'OK — results returned and parsed'
    : 'NEEDS ATTENTION — see rawExcerpt on the page 1 record'
};

// --- Q2: nationwide and all-industries? -------------------------------------
const allCities = [...new Set(normalPages.flatMap((p) => p.distinctCities || []))];
const q2 = {
  question: 'Is the result set nationwide (empty area=) and not restricted to one industry (empty at=)?',
  distinctCitiesSeen: allCities,
  distinctCityCount: allCities.length,
  verdict: allCities.length > 2
    ? 'LOOKS NATIONWIDE — ' + allCities.length + ' distinct cities across the probed pages'
    : 'INCONCLUSIVE — too few distinct cities; review the city list manually',
  note: 'Industry spread is not visible on search rows (НКЗ only appears on profile pages). '
      + 'Compare the НКЗ codes in the profile probes below to confirm multiple industries.'
};

// --- Q3: revenue inside the requested range? --------------------------------
const revMins = normalPages.map((p) => p.revenueMin).filter((v) => typeof v === 'number');
const revMaxs = normalPages.map((p) => p.revenueMax).filter((v) => typeof v === 'number');
const outside = normalPages.flatMap((p) => p.revenueOutsideRange || []);
const q3 = {
  question: 'Do returned revenues fall inside ' + cfg.revenueFrom + '–' + cfg.revenueTo + '?',
  observedMin: revMins.length ? Math.min(...revMins) : null,
  observedMax: revMaxs.length ? Math.max(...revMaxs) : null,
  rowsOutsideRange: outside,
  verdict: revMins.length === 0
    ? 'UNVERIFIED — no revenue value could be parsed from the search rows; check the row selectors'
    : (outside.length === 0 ? 'OK — every parsed revenue is inside the range'
                            : 'OUT OF RANGE — ' + outside.length + ' row(s) fall outside; see rowsOutsideRange')
};

// --- Q4: pagination behaviour ------------------------------------------------
const pageComparisons = [];
for (let i = 1; i < normalPages.length; i++) {
  const prev = normalPages[i - 1];
  const cur = normalPages[i];
  const prevSet = new Set(prev.edbList || []);
  const overlap = (cur.edbList || []).filter((e) => prevSet.has(e));
  pageComparisons.push({
    comparing: 'p=' + prev.page + ' vs p=' + cur.page,
    identical: !!prev.signature && prev.signature === cur.signature,
    overlappingCompanies: overlap.length,
    rowsOnEachPage: [prev.rowCount, cur.rowCount]
  });
}
const q4 = {
  question: 'Does &p=N return a different page of results, and what does the end of results look like?',
  pageComparisons,
  highPageProbe: highProbe ? {
    page: highProbe.page,
    httpStatus: highProbe.httpStatus,
    rowsReturned: highProbe.rowCount,
    error: highProbe.error || highProbe.blocked || '',
    behaviour: highProbe.rowCount === 0
      ? 'EMPTY LIST — the loop stop condition "zero rows" is correct'
      : 'RETURNED ' + highProbe.rowCount + ' ROWS — the site likely clamps p; the '
        + '"repeated page" and "all companies already seen" stop conditions are the ones that matter',
    rawExcerpt: highProbe.rawExcerpt || ''
  } : null,
  verdict: pageComparisons.length === 0
    ? 'UNVERIFIED — fewer than two pages were probed'
    : (pageComparisons.every((c) => !c.identical)
        ? 'OK — each probed page returned different companies'
        : 'PAGINATION SUSPECT — at least one page repeated the previous one')
};

// --- Q5: how many results in total? -----------------------------------------
const rowsPerPage = normalPages.map((p) => p.rowCount).filter((n) => n > 0);
const typicalPerPage = rowsPerPage.length ? Math.max(...rowsPerPage) : 0;
const maxPageLink = Math.max(0, ...normalPages.map((p) => p.maxPageLinkSeen || 0));
const statedTotal = normalPages.map((p) => p.totalResultsParsed).find((v) => typeof v === 'number' && v > 0) || null;
const estimatedTotal = statedTotal || (maxPageLink && typicalPerPage ? maxPageLink * typicalPerPage : null);
const q5 = {
  question: 'Roughly how many companies does this filter return? (expectation was ~400)',
  rowsPerPageObserved: rowsPerPage,
  typicalRowsPerPage: typicalPerPage,
  highestPageNumberLinkedInPager: maxPageLink || null,
  totalStatedOnPage: statedTotal,
  totalResultsHints: normalPages.map((p) => p.totalResultsHint).filter(Boolean),
  estimatedTotalCompanies: estimatedTotal,
  verdict: !estimatedTotal
    ? 'UNKNOWN — no total count and no pager links found; run the main workflow with maxCompanies set to a small number first'
    : (estimatedTotal > 1500
        ? 'FAR HIGHER THAN EXPECTED (~' + estimatedTotal + ') — flag before running the full scrape'
        : (estimatedTotal < 100
            ? 'FAR LOWER THAN EXPECTED (~' + estimatedTotal + ') — flag before running the full scrape'
            : 'IN THE EXPECTED BALLPARK (~' + estimatedTotal + ')'))
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
      name: p.name,
      phonesAfterDedupe: p.phones,
      distinctNormalisedKeys: p.distinctPhoneKeys,
      duplicatesCollapsed: p.phoneDedupeCollapsedDuplicates
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
      name: p.name,
      peopleCount: p.peopleCount,
      contactPerson: p.contactPerson,
      role: p.contactPersonRole,
      needsLica: p.needsLicaFallback
    })),
    verdict: usableProfiles.length === 0
      ? 'UNVERIFIED'
      : (needLica.length === 0
          ? 'The main page listed an owner/manager for every probed company — /lica stays a rare fallback'
          : needLica.length + ' of ' + usableProfiles.length + ' probed companies listed nobody — '
            + 'the /lica fallback does get used')
  },

  activityCodesSeen: [...new Set(usableProfiles.map((p) => p.activity).filter(Boolean))]
};

return [{
  json: {
    reportGeneratedAt: new Date().toISOString(),
    filter: {
      revenueFrom: cfg.revenueFrom,
      revenueTo: cfg.revenueTo,
      balanceYear: cfg.balanceYear,
      area: cfg.area || '(empty — nationwide)',
      activityType: cfg.activityType || '(empty — all industries)'
    },
    q1_searchUrlWorks: q1,
    q2_nationwideAllIndustries: q2,
    q3_revenueInRange: q3,
    q4_pagination: q4,
    q5_totalVolume: q5,
    q6_profilePages: q6,
    q7_nextStep: 'Review the verdicts above. If all read OK, open the main workflow, set the Google '
               + 'Sheet ID in the Config node, and run it. If any verdict says NEEDS ATTENTION / '
               + 'UNVERIFIED / SUSPECT, report it back before running the full scrape.',
    rawSearchPageRecords: pages,
    rawProfileRecords: profiles
  }
}];
