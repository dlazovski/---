// @requires-parsers
// Extract the profile-page fields and merge them with the search-results row.
//
// Default path is 2 ScrapingBee requests per company: this page carries the
// Контакти block (phones, e-mails) and the owner/manager list. The /lica
// sub-page is requested ONLY when this page lists nobody at all.

const cfg = $('Config').first().json;
const company = $('Loop Over Companies').first().json;
const sd = $getWorkflowStaticData('global');
const stats = sd.stats;

const { status, html, error } = readHttpItem($input.first());

const base = {
  _edb: company.edb,
  _profileUrl: company.profileUrl,
  _licaUrl: company.licaUrl,
  _searchName: company.name,
  _searchCity: company.city,
  _searchAddress: company.address,
  _status: company.status,
  _revenue: company.revenue,
  _employees: company.employees,
  _foundOnPage: company.foundOnPage
};

let failure = error;
let parsed = null;

if (!failure) {
  parsed = parseProfile(html, {
    excludePhones: splitList(cfg.excludePhones),
    excludeEmails: splitList(cfg.excludeEmails),
    cityMode: cfg.cityMode
  });
  if (parsed.blocked) failure = parsed.blocked;
}

if (failure) {
  stats.profileFailures += 1;
  stats.failedUrls.push({
    stage: 'profile',
    edb: company.edb,
    name: company.name,
    url: company.profileUrl,
    status,
    reason: failure
  });

  // Skip by default so a half-empty row never lands in the sheet; set
  // writePartialRows=true in Config to keep the search-page fields instead.
  const write = cfg.writePartialRows === true || cfg.writePartialRows === 'true';
  if (!write) stats.rowsSkipped += 1;

  return [{
    json: {
      ...base,
      _write: write,
      _needsLica: false,
      _failure: failure,
      'Клиент': company.name || '',
      'Град': company.city || '',
      'ЕМБС': '',
      'Даночен БРОЈ': company.edb || '',
      'Шифра на дејност': '',
      'Контакт лице': '',
      'Контакт телефон': '',
      'Меил адреса': ''
    }
  }];
}

stats.profilesOk += 1;

// The `at=` parameter's behaviour is unverified, so every profile is checked
// against the НКД filter its search segment used. A filter that is silently
// ignored shows up here as a wall of mismatches instead of thousands of
// unwanted rows in the sheet.
const nkdFilter = company.nkdFilter || '';
const nkdMatch = nkdMatchesFilter(parsed.activityCode, nkdFilter);
let nkdSkip = false;

if (nkdFilter) {
  if (nkdMatch === null) {
    stats.nkdUnknown += 1;
  } else if (nkdMatch === false) {
    stats.nkdMismatched += 1;
    // Only skip when the code was read successfully and genuinely does not match;
    // an unreadable code must never silently drop an otherwise good company.
    nkdSkip = cfg.enforceNkdMatch !== false;
    if (nkdSkip) {
      stats.rowsSkipped += 1;
      stats.warnings.push(
        (company.edb || company.name) + ': НКД ' + parsed.activityCode +
        ' does not match the requested filter ' + nkdFilter + ' — row skipped'
      );
    }
  }
}

parsed.warnings.forEach((w) => {
  if (w.indexOf('no phone') === 0 || w.indexOf('no e-mail') === 0 || w.indexOf('no Сопственик') === 0) return;
  stats.warnings.push((company.edb || company.name) + ': ' + w);
});

if (!nkdSkip) {
  if (!parsed.phones.length) stats.noPhone += 1;
  if (!parsed.emails.length) stats.noEmail += 1;
  if (parsed.needsLica) stats.licaFallbacks += 1;
}

// When a field comes back empty, keep a window of the real page text around the
// label it should have been near. An empty cell otherwise gives no clue whether
// the page lacks the data or the parser missed it; this makes the difference
// visible in the run summary without another live run.
const diagnostics = stats.fieldDiagnostics;
const SAMPLE_LIMIT = Number(cfg.diagnosticSamples) || 5;

function sampleFailure(bucket, labels) {
  if (!diagnostics[bucket] || diagnostics[bucket].length >= SAMPLE_LIMIT) return;
  diagnostics[bucket].push({
    company: company.name || company.edb,
    url: company.profileUrl,
    pageContext: captureLabelContext(html, labels, 400) || '(label not present on the page at all)'
  });
}

if (!nkdSkip) {
  if (!parsed.activity) sampleFailure('activity', 'НКЗ|НКД|Шифра\\s+на\\s+дејност');
  if (!parsed.contactPerson) sampleFailure('contactPerson', 'Управител|Сопственик|Контакт');
  if (!parsed.phones.length) sampleFailure('phone', 'Телефон|Тел|Контакт');
  if (!parsed.emails.length) sampleFailure('email', 'Е-пошта|Емаил|Меил|Мејл|Контакт');
}

return [{
  json: {
    ...base,
    _write: !nkdSkip,
    _needsLica: parsed.needsLica === true && !nkdSkip,
    _failure: '',
    _nkdFilter: nkdFilter,
    _nkdMatch: nkdMatch,
    _people: parsed.people,
    _contactPersonRole: parsed.contactPersonRole,
    _phoneSource: parsed.phoneSource,
    _emailSource: parsed.emailSource,
    _peopleSource: parsed.peopleSource,
    _warnings: parsed.warnings,

    // Sheet columns — names must match the existing sheet header exactly.
    'Клиент': parsed.name || company.name || '',
    'Град': parsed.city || company.city || '',
    'ЕМБС': parsed.embs || '',
    'Даночен БРОЈ': company.edb || parsed.edb || '',
    'Шифра на дејност': parsed.activity || '',
    'Контакт лице': parsed.contactPerson || '',
    'Контакт телефон': parsed.phones.join('; '),
    'Меил адреса': parsed.emails.join('; ')
  }
}];
