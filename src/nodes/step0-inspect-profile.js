// @requires-parsers
// Inspect one profile page and record what Step 0 asks about it: whether a plain
// (no render_js) fetch really returns the Контакти block, whether the
// formatted/digits-only phone duplication is consistent, and whether an
// owner/manager is always present on the main page.

const cfg = $('Config').first().json;
const target = $('Loop Profiles').first().json;
const sd = $getWorkflowStaticData('global');

const { status, html, error } = readHttpItem($input.first());

const record = {
  label: target.label,
  url: target.profileUrl,
  httpStatus: status,
  error: error || '',
  bytes: html ? html.length : 0
};

if (error || !target.profileUrl) {
  sd.step0.profiles.push(record);
  return [{ json: record }];
}

const parsed = parseProfile(html, {
  excludePhones: splitList(cfg.excludePhones),
  excludeEmails: splitList(cfg.excludeEmails)
});

record.blocked = parsed.blocked || '';
record.name = parsed.name;
record.address = parsed.address;
record.city = parsed.city;
record.embs = parsed.embs;
record.edb = parsed.edb;
record.activity = parsed.activity;

// Q6a: did a plain GET return the Контакти section?
const contacts = sliceContactsSection(html);
record.contactsSectionFound = contacts.length > 0;
record.contactsSectionBytes = contacts.length;
record.renderJsLikelyRequired = !(parsed.phones.length || parsed.emails.length || parsed.people.length);

// Q6b: is the formatted-vs-digits duplication consistent?
const rawPhoneTokens = extractPhones(contacts.length ? contacts : html, { format: 'normalized' });
record.phones = parsed.phones;
record.phoneCountAfterDedupe = parsed.phones.length;
record.distinctPhoneKeys = [...new Set(rawPhoneTokens)];
record.phoneDedupeCollapsedDuplicates = rawPhoneTokens.length !== record.distinctPhoneKeys.length;
record.phoneSource = parsed.phoneSource;

record.emails = parsed.emails;
record.emailSource = parsed.emailSource;

// Q6c: does this company list an owner/manager on the MAIN page?
record.people = parsed.people;
record.peopleCount = parsed.people.length;
record.contactPerson = parsed.contactPerson;
record.contactPersonRole = parsed.contactPersonRole;
record.needsLicaFallback = parsed.needsLica;
record.peopleSource = parsed.peopleSource;

record.warnings = parsed.warnings;
record.rawExcerpt = record.renderJsLikelyRequired ? String(html).slice(0, 3000) : '';

sd.step0.profiles.push(record);
return [{ json: record }];
