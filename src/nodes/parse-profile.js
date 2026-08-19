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
    excludeEmails: splitList(cfg.excludeEmails)
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
parsed.warnings.forEach((w) => {
  if (w.indexOf('no phone') === 0 || w.indexOf('no e-mail') === 0 || w.indexOf('no Сопственик') === 0) return;
  stats.warnings.push((company.edb || company.name) + ': ' + w);
});

if (!parsed.phones.length) stats.noPhone += 1;
if (!parsed.emails.length) stats.noEmail += 1;
if (parsed.needsLica) stats.licaFallbacks += 1;

return [{
  json: {
    ...base,
    _write: true,
    _needsLica: parsed.needsLica === true,
    _failure: '',
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
