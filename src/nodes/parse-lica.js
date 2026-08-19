// @requires-parsers
// Fallback only: the profile page listed no Сопственик/Управител at all, so the
// full /lica list is fetched and re-parsed. Everything else on the row is kept.

const record = $('Parse Profile').first().json;
const sd = $getWorkflowStaticData('global');
const stats = sd.stats;

const { status, html, error } = readHttpItem($input.first());

let failure = error;
let parsed = null;

if (!failure) {
  parsed = parseLica(html);
  if (parsed.blocked) failure = parsed.blocked;
}

if (failure || !parsed.contactPerson) {
  if (failure) {
    stats.licaFailures += 1;
    stats.failedUrls.push({
      stage: 'lica',
      edb: record._edb,
      url: record._licaUrl,
      status,
      reason: failure
    });
  }
  // No contact person anywhere — the cell stays blank, the row is still written.
  stats.noContactPerson += 1;
  return [{ json: { ...record, _needsLica: false, _licaFailure: failure || 'no owner/manager listed on /lica either' } }];
}

return [{
  json: {
    ...record,
    _needsLica: false,
    _licaFailure: '',
    _people: parsed.people,
    _contactPersonRole: parsed.contactPersonRole,
    _peopleSource: '/lica fallback',
    'Контакт лице': parsed.contactPerson
  }
}];
