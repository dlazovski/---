'use strict';

/*
 * CompanyWall.com.mk parsing helpers.
 *
 * Dependency-free on purpose: this file is inlined verbatim into n8n Code nodes,
 * where `require()` of external modules is not available. It is also loaded
 * directly by the offline test suite (see test/parsers.test.js).
 *
 * Everything here is defensive: the search-results markup has NOT been verified
 * live yet (see docs/step-0-verification.md), so extraction anchors on the few
 * structural facts that were confirmed, and reports warnings instead of throwing
 * when something is missing.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var ROLE_KEYWORDS = [
  'Сопственик', 'Управител', 'Содружник', 'Основач', 'Директор',
  'Прокурист', 'Овластено лице', 'Застапник', 'Ликвидатор', 'Претседател'
];

// Preference order for the "Контакт лице" sheet column: manager first, owner second.
var CONTACT_PERSON_ROLE_PREFERENCE = ['Управител', 'Сопственик'];

// Labels that plausibly terminate the "Контакти" block on a profile page.
var SECTION_END_LABELS = [
  'Основни информации', 'Финансиски', 'Финансии', 'Биланс',
  'Поврзани лица', 'Поврзани компании', 'Слични компании',
  'Дејности', 'Локација', 'Забелешк'
];

var STATUS_WORDS = [
  'Во стечај', 'Во ликвидација', 'Ликвидација', 'Стечај',
  'Блокирана', 'Блокиран', 'Избришана', 'Избришан',
  'Неактивна', 'Неактивен', 'Активна', 'Активно', 'Активен'
];

// UI strings that must never be mistaken for a person's name.
var NON_NAME_LINES = [
  'Прикажи ги сите', 'Прикажи се', 'Повеќе', 'Контакти', 'Контакт',
  'Телефон', 'Телефони', 'Е-пошта', 'Емаил', 'Меил', 'Адреса', 'Веб',
  'Веб страна', 'Основни информации', 'Лица', 'Функција', 'Име', 'Удел'
];

var EMAIL_BLOCKED_TLDS = [
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'css', 'js', 'json',
  'html', 'htm', 'ico', 'woff', 'woff2', 'ttf', 'eot', 'map'
];

// Substrings that mark an e-mail as belonging to the site/CDN, not the company.
var EMAIL_BLOCKED_DOMAIN_PARTS = [
  'companywall', 'sentry', 'wixpress', 'googleapis', 'gstatic',
  'schema.org', 'example.com', 'domain.com', 'cloudflare'
];

var COUNTRY_RE = /Република\s+Северна\s+Македониј[аи]/i;

// Phrases a results page uses when the filter matched nothing.
var NO_RESULTS_RE = /нема\s+(?:пронајдени\s+)?(?:резултати|компании|записи)|не\s+се\s+пронајдени|нема\s+податоци|no\s+results\s+found/i;

// Phone shapes, in two alternatives: international (+389 ...) and local (0XX ...).
// The structure is bounded on purpose - an open-ended run of "digits and
// separators" greedily swallows the whitespace between two adjacent numbers and
// merges them into one invalid token. Every hit is still validated by
// isValidMkPhone(), which is where the real filtering happens.
var PHONE_TOKEN_SOURCE =
  '(?<![\\d])(?:' +
  '(?:\\+|00)?\\s?389[\\s\\-\\/.]?\\(?0?\\d{1,2}\\)?[\\s\\-\\/.]?\\d{2,4}[\\s\\-\\/.]?\\d{2,4}' +
  '|' +
  '\\(?0\\d{1,2}\\)?[\\s\\-\\/.]?\\d{2,4}[\\s\\-\\/.]?\\d{2,4}' +
  ')(?![\\d])';

// dd.mm.yyyy and friends normalise to something that can look like a phone
// number, so they are rejected explicitly.
var DATE_TOKEN_RE = /^\s*\d{1,2}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*(19|20)\d{2}\s*$/;

var EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,63}/g;

// ---------------------------------------------------------------------------
// Text / HTML helpers
// ---------------------------------------------------------------------------

var NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  laquo: '«', raquo: '»', hellip: '…',
  mdash: '—', ndash: '–', shy: '', bull: '•'
};

function safeFromCodePoint(cp) {
  try {
    if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
    return String.fromCodePoint(cp);
  } catch (e) {
    return '';
  }
}

function decodeEntities(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return safeFromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return safeFromCodePoint(parseInt(d, 10)); })
    .replace(/&([a-zA-Z]+);/g, function (m, n) {
      var key = n.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
    });
}

function normalizeSpace(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[\s ]+/g, ' ').trim();
}

function looksLikeHtml(str) {
  return typeof str === 'string' && /<[a-zA-Z!/]/.test(str);
}

/**
 * Remove page chrome before falling back to whole-page extraction, so the
 * site's own footer phone/e-mail never lands in a company's row.
 */
function stripChrome(html) {
  var s = String(html === null || html === undefined ? '' : html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');
  s = s.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ');
  s = s.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ');
  return s;
}

/**
 * Convert HTML to newline-separated text. Closing tags become newlines, which is
 * what makes the confirmed `Сопственик{NAME}Управител{NAME}` block parseable:
 * each role and each name ends up on its own line.
 */
function htmlToText(html) {
  if (html === null || html === undefined) return '';
  var s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '\n');
  s = decodeEntities(s);
  s = s.replace(/ /g, ' ');
  s = s.split('\n').map(function (line) {
    return line.replace(/[ \t\r]+/g, ' ').trim();
  }).join('\n');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}

function textLines(source) {
  var text = looksLikeHtml(source) ? htmlToText(source) : String(source === null || source === undefined ? '' : source);
  return text.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
}

function extractH1(html) {
  var m = String(html === null || html === undefined ? '' : html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return '';
  return normalizeSpace(htmlToText(m[1]));
}

/**
 * Parse a Macedonian-formatted number ("5.000.000", "12.345,67", "1 234").
 * Returns null when nothing numeric is present.
 */
function parseMkNumber(raw) {
  if (raw === null || raw === undefined) return null;
  var s = String(raw).replace(/[\s ]/g, '').replace(/[^\d.,\-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  var hasDot = s.indexOf('.') !== -1;
  var hasComma = s.indexOf(',') !== -1;
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    var cParts = s.split(',');
    if (cParts.length > 2 || cParts[cParts.length - 1].length === 3) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
    }
  } else if (hasDot) {
    var dParts = s.split('.');
    if (dParts.length > 2 || dParts[dParts.length - 1].length === 3) {
      s = s.replace(/\./g, '');
    }
  }
  var n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Address / city
// ---------------------------------------------------------------------------

/**
 * CONFIRMED rule: the city is the comma segment immediately before
 * "Република Северна Македонија" (i.e. the second-to-last segment).
 * Implemented as "drop a trailing country segment, then take the last segment"
 * so it degrades sensibly if the country suffix is absent.
 */
function cityFromAddress(address, options) {
  var opts = options || {};
  if (!address) return '';
  var parts = String(address).split(',').map(normalizeSpace).filter(function (p) { return p.length > 0; });
  if (parts.length === 0) return '';
  if (COUNTRY_RE.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
  if (parts.length === 0) return '';

  var municipality = parts[parts.length - 1];

  // Optional: the settlement rather than the municipality.
  //
  // The confirmed rule yields the municipality, which for Skopje companies is a
  // city district ("Центар", "Аеродром") rather than "Скопје". Real addresses
  // come in two shapes:
  //
  //   street, НОВО СЕЛО,       Дебарца          -> settlement differs from municipality
  //   street, СКОПЈЕ - ЦЕНТАР, ЦЕНТАР,  Центар  -> settlement repeats the municipality,
  //                                                and the city sits one segment further
  //                                                back, before the dash.
  if (opts.prefer === 'settlement' && parts.length >= 2) {
    var previous = parts[parts.length - 2];
    var settlement = previous;

    if (previous.toUpperCase() === municipality.toUpperCase() && parts.length >= 3) {
      var earlier = parts[parts.length - 3] || '';
      // Split on the LAST " - ": street names contain dashes too
      // ("БУЛЕВАР КУЗМАН ЈОСИФОВСКИ - ПИТУ бр.15 СКОПЈЕ - АЕРОДРОМ"), so only the
      // final separator marks the city/district boundary. The city is then the
      // last all-caps word of what precedes it.
      var cut = earlier.lastIndexOf(' - ');
      if (cut !== -1) {
        var tokens = earlier.slice(0, cut).split(/\s+/).filter(Boolean);
        var candidate = tokens.length ? tokens[tokens.length - 1] : '';
        if (candidate && candidate === candidate.toUpperCase() && /^\p{L}{3,}$/u.test(candidate)) {
          settlement = candidate;
        }
      }
    }

    settlement = normalizeSpace(settlement);
    if (settlement) return toTitleCase(settlement);
  }

  return municipality;
}

/** "СКОПЈЕ - ЦЕНТАР" -> "Скопје - Центар"; leaves already-cased text alone. */
function toTitleCase(text) {
  return String(text || '').split(' ').map(function (word) {
    if (!word) return word;
    if (word !== word.toUpperCase()) return word;
    return word.charAt(0) + word.slice(1).toLowerCase();
  }).join(' ');
}

/** Find the full address line (the one ending in the country name). */
function extractAddress(source) {
  var lines = textLines(source);
  var i;
  for (i = 0; i < lines.length; i++) {
    if (COUNTRY_RE.test(lines[i]) && lines[i].indexOf(',') !== -1) return normalizeSpace(lines[i]);
  }
  // Fallback: the country may have been split onto its own line by markup.
  for (i = 0; i < lines.length; i++) {
    if (!COUNTRY_RE.test(lines[i])) continue;
    var chunk = [];
    for (var j = Math.max(0, i - 3); j <= i; j++) {
      var l = lines[j];
      if (!l || l.length > 80 || l.indexOf(':') !== -1) continue;
      chunk.push(l);
    }
    if (chunk.length >= 2) return normalizeSpace(chunk.join(', '));
  }
  return '';
}

// ---------------------------------------------------------------------------
// Phones
// ---------------------------------------------------------------------------

/** Digits-only canonical form; +389/00389 prefixes become a leading 0. */
function normalizePhone(raw) {
  var d = String(raw === null || raw === undefined ? '' : raw).replace(/\D/g, '');
  if (d.indexOf('00') === 0) d = d.slice(2);
  if (d.indexOf('389') === 0) {
    var rest = d.slice(3);
    d = rest.indexOf('0') === 0 ? rest : ('0' + rest);
  }
  return d;
}

/**
 * MK numbers normalise to 8-9 digits starting 0 followed by 2-8.
 * This is what rejects revenue figures, ЕМБС (7 digits), ЕДБ (13 digits)
 * and most date-shaped strings.
 */
function isValidMkPhone(digits) {
  return /^0[2-8]\d{6,7}$/.test(String(digits || ''));
}

function extractTelHrefs(html) {
  var out = [];
  if (!looksLikeHtml(html)) return out;
  var re = /href\s*=\s*["']tel:([^"']+)["']/gi;
  var m;
  while ((m = re.exec(html)) !== null) out.push(decodeEntities(m[1]));
  return out;
}

/**
 * Extract every phone number, normalise, then de-duplicate.
 *
 * CONFIRMED requirement: the same number appears both formatted ("046/250-383")
 * and digits-only ("046250383"). Both normalise to the same key, so only one
 * survives. The human-readable variant is the one kept for the sheet.
 */
function extractPhones(source, options) {
  var opts = options || {};
  var text = looksLikeHtml(source) ? htmlToText(source) : String(source === null || source === undefined ? '' : source);
  if (looksLikeHtml(source)) {
    var tels = extractTelHrefs(source);
    if (tels.length) text = text + '\n' + tels.join('\n');
  }

  var exclude = {};
  (opts.exclude || []).forEach(function (e) {
    var k = normalizePhone(e);
    if (k) exclude[k] = true;
  });

  var seen = Object.create(null);
  var order = [];
  var re = new RegExp(PHONE_TOKEN_SOURCE, 'g');
  var m;
  while ((m = re.exec(text)) !== null) {
    var raw = m[0].trim();
    if (DATE_TOKEN_RE.test(raw)) continue;
    var body = raw.replace(/^(\+|00)/, '');
    var hasSeparator = /[\s\-\/.()]/.test(body);
    var key = normalizePhone(raw);
    if (!isValidMkPhone(key)) continue;
    // A separator-free run only counts as a phone at full 9-digit length.
    if (!hasSeparator && key.length !== 9) continue;
    if (exclude[key]) continue;
    var pretty = normalizeSpace(raw);
    if (!seen[key]) {
      seen[key] = { display: pretty, hasSeparator: hasSeparator };
      order.push(key);
    } else if (!seen[key].hasSeparator && hasSeparator) {
      // Prefer the formatted spelling of the same number.
      seen[key].display = pretty;
      seen[key].hasSeparator = true;
    }
  }

  if (opts.format === 'normalized') return order.slice();
  return order.map(function (k) { return seen[k].display; });
}

// ---------------------------------------------------------------------------
// E-mails
// ---------------------------------------------------------------------------

function extractMailtoHrefs(html) {
  var out = [];
  if (!looksLikeHtml(html)) return out;
  var re = /href\s*=\s*["']mailto:([^"'?]+)/gi;
  var m;
  while ((m = re.exec(html)) !== null) out.push(decodeEntities(m[1]).trim());
  return out;
}

function isUsableEmail(email, exclude) {
  var e = String(email || '').toLowerCase();
  if (e.length < 6 || e.length > 254) return false;
  var at = e.lastIndexOf('@');
  if (at < 1) return false;
  var domain = e.slice(at + 1);
  var tld = domain.split('.').pop();
  if (EMAIL_BLOCKED_TLDS.indexOf(tld) !== -1) return false;
  for (var i = 0; i < EMAIL_BLOCKED_DOMAIN_PARTS.length; i++) {
    if (domain.indexOf(EMAIL_BLOCKED_DOMAIN_PARTS[i]) !== -1) return false;
  }
  if (exclude && exclude[e]) return false;
  return true;
}

/** All e-mails on the page, lower-cased and de-duplicated, order preserved. */
function extractEmails(source, options) {
  var opts = options || {};
  var text = looksLikeHtml(source) ? htmlToText(source) : String(source === null || source === undefined ? '' : source);
  if (looksLikeHtml(source)) {
    var mailtos = extractMailtoHrefs(source);
    if (mailtos.length) text = text + '\n' + mailtos.join('\n');
  }

  var exclude = {};
  (opts.exclude || []).forEach(function (e) { exclude[String(e).toLowerCase().trim()] = true; });

  var seen = Object.create(null);
  var out = [];
  var re = new RegExp(EMAIL_RE.source, 'g');
  var m;
  while ((m = re.exec(text)) !== null) {
    var email = m[0].toLowerCase().replace(/[.,;:]+$/, '');
    if (!isUsableEmail(email, exclude)) continue;
    if (seen[email]) continue;
    seen[email] = true;
    out.push(email);
  }
  return out;
}

// ---------------------------------------------------------------------------
// People (Сопственик / Управител)
// ---------------------------------------------------------------------------

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, function (m) { return '\\' + m; }); }

/**
 * Word-boundary equivalent that works for Cyrillic.
 *
 * JavaScript's \b is defined over [A-Za-z0-9_] only, so /\bЕМБС\b/ never
 * matches - Cyrillic letters are not "word characters", so no boundary exists
 * between a newline and "Е". Unicode property lookarounds are the working form.
 */
function labelBoundary(word) {
  return '(?<![\\p{L}\\p{N}])(?:' + word + ')(?![\\p{L}\\p{N}])';
}

var ROLE_ALTERNATION = ROLE_KEYWORDS.map(escapeRe).join('|');
var ROLE_LINE_RE = new RegExp('^(' + ROLE_ALTERNATION + ')\\s*:?\\s*$', 'i');
var ROLE_INLINE_RE = new RegExp('^(' + ROLE_ALTERNATION + ')\\s*[:\\-\\u2013\\u2014]?\\s+(.{2,120})$', 'i');

function isRoleLine(line) { return ROLE_LINE_RE.test(String(line || '').trim()); }

function normalizeRole(raw) {
  var r = normalizeSpace(raw).replace(/[:\-–—]+$/, '').trim();
  for (var i = 0; i < ROLE_KEYWORDS.length; i++) {
    if (r.toLowerCase() === ROLE_KEYWORDS[i].toLowerCase()) return ROLE_KEYWORDS[i];
  }
  return r;
}

/** Strip ownership percentages and stray punctuation from a name. */
function cleanPersonName(raw) {
  var s = normalizeSpace(raw);
  s = s.replace(/\(?\s*\d{1,3}([.,]\d+)?\s*%\s*\)?/g, ' ');
  s = s.replace(/^[\s\-–—:,;.]+/, '').replace(/[\s\-–—:,;]+$/, '');
  return normalizeSpace(s);
}

function isPersonName(candidate) {
  var s = normalizeSpace(candidate);
  if (s.length < 3 || s.length > 120) return false;
  if (s.indexOf('@') !== -1) return false;
  if (isRoleLine(s)) return false;
  if (/^\d[\d\s.,\-\/]*$/.test(s)) return false;
  var letters = s.match(/\p{L}/gu);
  if (!letters || letters.length < 3) return false;
  for (var i = 0; i < NON_NAME_LINES.length; i++) {
    if (s.toLowerCase() === NON_NAME_LINES[i].toLowerCase()) return false;
  }
  if (/^Прикажи/i.test(s)) return false;
  return true;
}

/**
 * Parse the confirmed role/name block:
 *   Сопственик
 *   ИМЕ ПРЕЗИМЕ
 *   Управител
 *   ИМЕ ПРЕЗИМЕ
 * Also handles the "Управител: ИМЕ ПРЕЗИМЕ" single-line variant.
 */
function extractPeople(source) {
  var lines = textLines(source);
  var people = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    var inline = line.match(ROLE_INLINE_RE);
    if (inline) {
      var inlineName = cleanPersonName(inline[2]);
      if (isPersonName(inlineName)) {
        people.push({ role: normalizeRole(inline[1]), name: inlineName });
        continue;
      }
    }

    if (!isRoleLine(line)) continue;
    for (var j = i + 1; j < lines.length && j <= i + 3; j++) {
      if (isRoleLine(lines[j])) break;
      if (/^Прикажи/i.test(lines[j])) break;
      var name = cleanPersonName(lines[j]);
      if (isPersonName(name)) {
        people.push({ role: normalizeRole(line), name: name });
        break;
      }
    }
  }

  var seen = Object.create(null);
  var out = [];
  people.forEach(function (p) {
    var key = (p.role + '|' + p.name).toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(p);
  });
  return out;
}

/** Контакт лице: first Управител, else first Сопственик, else first entry. */
function pickContactPerson(people) {
  var list = people || [];
  for (var i = 0; i < CONTACT_PERSON_ROLE_PREFERENCE.length; i++) {
    var wanted = CONTACT_PERSON_ROLE_PREFERENCE[i].toLowerCase();
    for (var j = 0; j < list.length; j++) {
      if (String(list[j].role || '').toLowerCase() === wanted) return list[j];
    }
  }
  return list.length ? list[0] : null;
}

// ---------------------------------------------------------------------------
// Labelled values (ЕМБС, ЕДБ, НКЗ)
// ---------------------------------------------------------------------------

/** Look for `valueRe` in the text that follows each occurrence of `label`. */
function findAfterLabel(text, label, valueRe, windowSize) {
  var win = windowSize || 160;
  var re = new RegExp(label, 'giu');
  var m;
  while ((m = re.exec(text)) !== null) {
    var start = m.index + m[0].length;
    var zone = text.slice(start, start + win);
    var v = zone.match(valueRe);
    if (v) return v[1] !== undefined ? v[1] : v[0];
  }
  return '';
}

function extractEmbs(source) {
  var text = looksLikeHtml(source) ? htmlToText(source) : String(source || '');
  return findAfterLabel(text, labelBoundary('ЕМБС'), /(?<!\d)(\d{6,8})(?!\d)/);
}

function extractEdb(source) {
  var text = looksLikeHtml(source) ? htmlToText(source) : String(source || '');
  var byLabel = findAfterLabel(text, labelBoundary('ЕДБ'), /(?<!\d)(\d{13})(?!\d)/);
  if (byLabel) return byLabel;
  var mk = text.match(/\bMK\s?(\d{13})\b/i);
  if (mk) return mk[1];
  var any = text.match(/(?<!\d)(\d{13})(?!\d)/);
  return any ? any[1] : '';
}

/**
 * CONFIRMED on-page label is "НКЗ" (not "НКД"), value formatted as
 * "27.110 - Производство на ...". Both are accepted, plus "Шифра на дејност".
 */
/**
 * Activity code and description.
 *
 * CONFIRMED on-page label is "НКЗ" (not "НКД"), value formatted as
 * "61.100 - Жичени, безжични и сателитски телекомуникациски дејности".
 *
 * Codes appear at several levels of the classification — 61.1 (group),
 * 61.10 (class), 61.100 (sub-class) — so the digit count after the dot varies
 * and must not be pinned to three. The label is also searched at EVERY
 * occurrence, not just the first: a filter widget elsewhere on the page can
 * carry the same word, and matching only the first would read a generic sector
 * code instead of the company's own.
 */
function extractActivity(source) {
  var text = looksLikeHtml(source) ? htmlToText(source) : String(source || '');

  var zones = [];
  var labelRe = new RegExp(labelBoundary('НКЗ|НКД|Шифра\\s+на\\s+дејност'), 'giu');
  var m;
  while ((m = labelRe.exec(text)) !== null) {
    zones.push(text.slice(m.index, m.index + 600));
    if (zones.length >= 8) break;
  }
  zones.push(text);

  var CODE = '(?<!\\d)(\\d{2}\\.\\d{1,3})(?!\\d)';

  // 1. code and description on one line, separated by a dash or colon.
  var combinedRe = new RegExp(CODE + '\\s*[-\u2013\u2014:]\\s*(\\p{L}[^\\n]{0,250})', 'u');
  for (var i = 0; i < zones.length; i++) {
    var one = zones[i].match(combinedRe);
    if (one) {
      var desc = normalizeSpace(one[2]);
      return { code: one[1], description: desc, full: one[1] + ' - ' + desc, source: i < zones.length - 1 ? 'label zone' : 'whole page' };
    }
  }

  // 2. code alone on a line, description on the next.
  var codeOnlyRe = new RegExp('^' + CODE + '$', 'u');
  for (var z = 0; z < zones.length; z++) {
    var lines = zones[z].split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    for (var k = 0; k < lines.length - 1; k++) {
      if (!codeOnlyRe.test(lines[k])) continue;
      var next = normalizeSpace(lines[k + 1]).replace(/^[-\u2013\u2014\s:]+/, '');
      if (!/^\p{L}/u.test(next) || next.length < 3) continue;
      return { code: lines[k], description: next, full: lines[k] + ' - ' + next, source: 'split lines' };
    }
  }

  // 3. a bare code with no description anywhere near it. Still worth writing —
  //    the code is the part that identifies the activity.
  var bareRe = new RegExp(CODE, 'u');
  for (var b = 0; b < zones.length; b++) {
    var bare = zones[b].match(bareRe);
    if (bare) return { code: bare[1], description: '', full: bare[1], source: 'code only' };
  }

  return { code: '', description: '', full: '', source: 'not found' };
}

/**
 * A window of page text around a label, for diagnosing extraction failures.
 * Returns '' when the label is not on the page at all — itself a useful answer.
 */
function captureLabelContext(source, labelAlternation, chars) {
  var text = looksLikeHtml(source) ? htmlToText(source) : String(source || '');
  var width = Number(chars) || 400;
  var re = new RegExp(labelBoundary(labelAlternation), 'iu');
  var found = text.match(re);
  if (!found) return '';
  var from = Math.max(0, found.index - Math.floor(width / 4));
  return normalizeSpace(text.slice(from, from + width));
}

// ---------------------------------------------------------------------------
// "Контакти" section slicing
// ---------------------------------------------------------------------------

/**
 * Return the slice of HTML most likely to be the company's "Контакти" block.
 * Both a label-bounded slice and a fixed-size window are scored per occurrence,
 * because the order of on-page sections is not confirmed.
 */
function sliceContactsSection(html) {
  var body = stripChrome(html);
  var candidates = [];
  // "Контакти" appeared on none of the profiles probed live, so the section is
  // located by any of the labels that plausibly head a contact block. Longest
  // alternatives first, so the more specific label wins at a given position.
  var re = /Контакти|Контакт|Телефон|Е-пошта|Емаил|Мејл|Меил/g;
  var m;
  var seen = 0;
  while ((m = re.exec(body)) !== null && seen < 12) {
    seen += 1;
    var from = m.index;
    var bounded = body.length;
    for (var i = 0; i < SECTION_END_LABELS.length; i++) {
      var idx = body.indexOf(SECTION_END_LABELS[i], from + m[0].length);
      if (idx !== -1 && idx < bounded) bounded = idx;
    }
    candidates.push(body.slice(from, Math.min(bounded, from + 15000)));
    candidates.push(body.slice(from, Math.min(body.length, from + 15000)));
  }
  if (!candidates.length) return '';

  var best = '';
  var bestScore = -1;
  candidates.forEach(function (c) {
    var score = 0;
    if (extractEmails(c).length) score += 2;
    if (extractPhones(c).length) score += 2;
    score += Math.min(extractPeople(c).length, 4);
    // Prefer the tighter slice when scores tie.
    if (score > bestScore || (score === bestScore && best && c.length < best.length)) {
      bestScore = score;
      best = c;
    }
  });
  return bestScore > 0 ? best : candidates[0];
}

// ---------------------------------------------------------------------------
// Blocked / error page detection
// ---------------------------------------------------------------------------

/** Returns a human-readable reason string, or '' when the page looks usable. */
function detectBlockedPage(html) {
  if (html === null || html === undefined || String(html).trim() === '') return 'empty response body';
  var s = String(html);
  if (s.length < 200) return 'suspiciously short response (' + s.length + ' bytes)';
  var head = s.slice(0, 6000).toLowerCase();
  if (head.indexOf('captcha') !== -1) return 'CAPTCHA challenge detected';
  if (head.indexOf('cf-browser-verification') !== -1) return 'Cloudflare browser verification';
  if (head.indexOf('attention required') !== -1) return 'Cloudflare "Attention Required" page';
  if (head.indexOf('access denied') !== -1) return 'access denied page';
  if (head.indexOf('403 forbidden') !== -1) return 'HTTP 403 page';
  if (head.indexOf('too many requests') !== -1) return 'rate-limit page (too many requests)';
  if (!looksLikeHtml(s)) return 'response is not HTML (possibly a ScrapingBee error payload)';

  // Auth-wall detection must look at the page's own title/heading, never at body
  // text: every page's nav links to /registracija, so a body-wide keyword match
  // would flag perfectly good pages as redirects.
  var titleMatch = s.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  var identity = normalizeSpace(
    (titleMatch ? htmlToText(titleMatch[1]) : '') + ' ' + extractH1(s)
  );
  if (/registracij|registriraj|регистрациј|регистрирај|најав|najavi se|prijavi se|пријав|login|sign in/i.test(identity)) {
    return 'looks like a registration/login page (title/heading: "' + identity.slice(0, 80) + '")';
  }
  return '';
}

// ---------------------------------------------------------------------------
// Search results page
// ---------------------------------------------------------------------------

function normalizeProfilePath(href) {
  var p = String(href === null || href === undefined ? '' : href).trim();
  p = p.replace(/^https?:\/\/[^/]+/i, '');
  p = p.split('#')[0].split('?')[0];
  var parts = p.split('/').filter(function (x) { return x.length > 0; });
  if (parts.length < 3) return '';
  if (parts[0].toLowerCase() !== 'kompanija') return '';
  var slug = parts[1];
  var code = parts[2];
  if (!slug || !code) return '';
  if (!/^[A-Za-z0-9_\-]{3,}$/.test(code)) return '';
  return '/' + parts[0] + '/' + slug + '/' + code;
}

function anchorTextAt(html, hrefMatchIndex) {
  var gt = html.indexOf('>', hrefMatchIndex);
  if (gt === -1) return '';
  var close = html.indexOf('</a>', gt);
  if (close === -1 || close - gt > 4000) return '';
  return normalizeSpace(htmlToText(html.slice(gt + 1, close)));
}

function labeledValueFromLines(lines, labelRe, valueRe) {
  for (var i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue;
    var sameLine = lines[i].replace(labelRe, ' ').match(valueRe);
    if (sameLine) return sameLine[0];
    for (var j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      var v = lines[j].match(valueRe);
      if (v) return v[0];
    }
  }
  return '';
}

/**
 * Extract one record per company from a search-results page.
 *
 * The markup is UNVERIFIED, so this anchors on the only stable fact available:
 * every result links to /kompanija/{slug}/{code}. Each company's "row window"
 * is the HTML between its first link and the next distinct company's first link.
 * Everything else is label- or pattern-matched inside that window and reported
 * as a warning when missing, rather than throwing.
 */
function parseSearchResults(html, options) {
  var opts = options || {};
  var rows = [];
  var warnings = [];

  var blocked = detectBlockedPage(html);
  if (blocked) {
    return { rows: [], warnings: ['page rejected: ' + blocked], blocked: blocked, linkMatches: 0, noResultsMessage: false };
  }

  var source = String(html);
  var re = /href\s*=\s*["']((?:https?:\/\/[^"'\/]+)?\/kompanija\/[^"'\s>]+)["']/gi;
  var hits = [];
  var m;
  while ((m = re.exec(source)) !== null) {
    var path = normalizeProfilePath(m[1]);
    if (!path) continue;
    hits.push({ path: path, index: m.index, anchor: anchorTextAt(source, m.index) });
  }

  var noResultsMessage = NO_RESULTS_RE.test(htmlToText(source));

  if (!hits.length) {
    return {
      rows: [],
      warnings: [noResultsMessage
        ? 'page states there are no results for this filter'
        : 'no /kompanija/ profile links found on page (and no "no results" message — markup may have changed)'],
      blocked: '',
      linkMatches: 0,
      noResultsMessage: noResultsMessage
    };
  }

  // Group consecutive hits that point at the same company.
  var groups = [];
  hits.forEach(function (h) {
    var last = groups[groups.length - 1];
    if (last && last.path === h.path) {
      last.anchors.push(h.anchor);
      return;
    }
    groups.push({ path: h.path, start: h.index, anchors: [h.anchor] });
  });

  for (var g = 0; g < groups.length; g++) {
    var group = groups[g];
    var end = (g + 1 < groups.length) ? groups[g + 1].start : source.length;
    var windowHtml = source.slice(group.start, end);
    var windowText = htmlToText(windowHtml);
    var lines = windowText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);

    var name = '';
    group.anchors.forEach(function (a) {
      if (a && a.length > name.length && a.length < 200) name = a;
    });
    if (!name && lines.length) name = lines[0];

    var edbMatch = windowText.match(/(?<!\d)(\d{13})(?!\d)/);
    var edb = edbMatch ? edbMatch[1] : '';

    var address = extractAddress(windowText);
    var city = cityFromAddress(address, { prefer: opts.cityMode });

    var status = '';
    for (var s = 0; s < STATUS_WORDS.length; s++) {
      if (windowText.indexOf(STATUS_WORDS[s]) !== -1) { status = STATUS_WORDS[s]; break; }
    }

    var employeesRaw = labeledValueFromLines(lines, /Вработен/i, /\d[\d.,\s]*/);
    var revenueRaw = labeledValueFromLines(lines, /Приход/i, /\d[\d.,\s]*/);

    var row = {
      name: name,
      profilePath: group.path,
      profileUrl: (opts.baseUrl || 'https://www.companywall.com.mk') + group.path,
      licaUrl: (opts.baseUrl || 'https://www.companywall.com.mk') + group.path + '/lica',
      edb: edb,
      address: address,
      city: city,
      status: status,
      employeesRaw: normalizeSpace(employeesRaw),
      employees: parseMkNumber(employeesRaw),
      revenueRaw: normalizeSpace(revenueRaw),
      revenue: parseMkNumber(revenueRaw),
      warnings: []
    };

    if (!row.name) row.warnings.push('name not found');
    if (!row.edb) row.warnings.push('ЕДБ (13-digit) not found in row window');
    if (!row.address) row.warnings.push('address not found in row window');
    if (!row.city) row.warnings.push('city could not be derived from address');
    if (row.revenue === null) row.warnings.push('revenue not found in row window');

    rows.push(row);
  }

  var missingEdb = rows.filter(function (r) { return !r.edb; }).length;
  if (missingEdb) warnings.push(missingEdb + ' of ' + rows.length + ' rows have no ЕДБ');

  return { rows: rows, warnings: warnings, blocked: '', linkMatches: hits.length, noResultsMessage: noResultsMessage };
}

// ---------------------------------------------------------------------------
// Company profile page
// ---------------------------------------------------------------------------

/**
 * Extract every profile-page field needed for the sheet.
 * `options.excludePhones` / `options.excludeEmails` filter out the site's own
 * contact details if they ever leak past stripChrome().
 */
function parseProfile(html, options) {
  var opts = options || {};
  var warnings = [];

  var blocked = detectBlockedPage(html);
  if (blocked) {
    return {
      blocked: blocked,
      warnings: ['page rejected: ' + blocked],
      name: '', address: '', city: '', embs: '', edb: '',
      activityCode: '', activityDescription: '', activity: '',
      phones: [], emails: [], people: [], contactPerson: '', contactPersonRole: '',
      needsLica: false
    };
  }

  var body = stripChrome(html);
  var bodyText = htmlToText(body);
  var contacts = sliceContactsSection(html);

  var name = extractH1(html);
  if (!name) {
    var titleMatch = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) name = normalizeSpace(htmlToText(titleMatch[1])).split('|')[0].trim();
    if (name) warnings.push('company name taken from <title>, no <h1> found');
  }
  if (!name) warnings.push('company name not found');

  var address = extractAddress(bodyText);
  var city = cityFromAddress(address, { prefer: opts.cityMode });
  if (!address) warnings.push('address not found on profile page');
  if (address && !city) warnings.push('city could not be derived from address');

  var embs = extractEmbs(bodyText);
  if (!embs) warnings.push('ЕМБС not found');

  var edb = extractEdb(bodyText);
  if (!edb) warnings.push('ЕДБ not found on profile page');

  var activity = extractActivity(body);
  if (!activity.full) warnings.push('НКЗ / шифра на дејност not found');

  var phoneOpts = { exclude: opts.excludePhones || [] };
  var emailOpts = { exclude: opts.excludeEmails || [] };

  // Three widening passes: the contact section, then the page with chrome removed,
  // then the untouched HTML.
  //
  // The last resort matters because stripChrome() deletes every <footer>, <header>
  // and <nav> — including ones nested inside content cards. On layouts that put
  // contact details in such an element, the data is removed before extraction. It
  // is safe to widen: the site's own number is excluded by name and its e-mail by
  // domain, so scanning the chrome cannot introduce them.
  var phoneSource = 'Контакти';
  var phones = extractPhones(contacts, phoneOpts);
  if (!phones.length) {
    // Confirmed fallback: numbers are often repeated in the free-text description.
    phones = extractPhones(body, phoneOpts);
    phoneSource = phones.length ? 'whole page (Контакти empty)' : 'none';
  }
  if (!phones.length) {
    phones = extractPhones(html, phoneOpts);
    phoneSource = phones.length ? 'whole page including chrome (last resort)' : 'none';
  }

  var emailSource = 'Контакти';
  var emails = extractEmails(contacts, emailOpts);
  if (!emails.length) {
    emails = extractEmails(body, emailOpts);
    emailSource = emails.length ? 'whole page (Контакти empty)' : 'none';
  }
  if (!emails.length) {
    emails = extractEmails(html, emailOpts);
    emailSource = emails.length ? 'whole page including chrome (last resort)' : 'none';
  }

  var peopleSource = 'Контакти';
  var people = extractPeople(contacts);
  if (!people.length) {
    people = extractPeople(body);
    peopleSource = people.length ? 'whole page (Контакти empty)' : 'none';
  }
  if (!people.length) {
    people = extractPeople(html);
    peopleSource = people.length ? 'whole page including chrome (last resort)' : 'none';
  }

  var picked = pickContactPerson(people);

  if (!phones.length) warnings.push('no phone numbers found (allowed: cell stays blank)');
  if (!emails.length) warnings.push('no e-mail addresses found (allowed: cell stays blank)');
  if (!people.length) warnings.push('no Сопственик/Управител entry found; /lica fallback required');

  return {
    blocked: '',
    warnings: warnings,
    name: name,
    address: address,
    city: city,
    embs: embs,
    edb: edb,
    activityCode: activity.code,
    activityDescription: activity.description,
    activity: activity.full,
    phones: phones,
    phoneSource: phoneSource,
    emails: emails,
    emailSource: emailSource,
    people: people,
    peopleSource: peopleSource,
    contactPerson: picked ? picked.name : '',
    contactPersonRole: picked ? picked.role : '',
    needsLica: people.length === 0
  };
}

/** Parse the /lica sub-page (used only when the profile page listed nobody). */
function parseLica(html) {
  var blocked = detectBlockedPage(html);
  if (blocked) return { blocked: blocked, people: [], contactPerson: '', contactPersonRole: '' };
  var people = extractPeople(stripChrome(html));
  var picked = pickContactPerson(people);
  return {
    blocked: '',
    people: people,
    contactPerson: picked ? picked.name : '',
    contactPersonRole: picked ? picked.role : ''
  };
}

// ---------------------------------------------------------------------------
// Search URL builder
// ---------------------------------------------------------------------------

/**
 * Build the confirmed search URL. Parameter names, order and the raw (unencoded)
 * dsm[...] bracket syntax are reproduced exactly as verified against the live
 * site; only revenue bounds, bly and the page number are variable.
 */
function buildSearchUrl(config, page) {
  var cfg = config || {};
  var base = cfg.baseUrl || 'https://www.companywall.com.mk';

  var parts = [
    'cr=' + (cfg.currency || 'MKD'),
    'n=', 'mv=', 'r=', 'c=', 'cp=',
    'at=' + encodeURIComponent(String(cfg.activityType || '').trim()),
    'area=' + (cfg.area || ''),
    'subarea=' + (cfg.subarea || ''),
    'sbjact=' + (cfg.subjectActive || 't'),
    'blckd=', 'dbf=', 'dbt=', 'type=',
    'bly=' + (cfg.balanceYear || 2025)
  ];

  // How the revenue metric slot (dsm[0], Code 201) is expressed:
  //   'range'    - a real revenue filter between revenueFrom and revenueTo
  //   'off-zero' - slot present but unfiltered, mirroring how the URL's own
  //                dsm[1] slot (Code 48, From=0, To=0) expresses "no filter"
  //   'off-omit' - the dsm[0] triplet is dropped from the URL entirely
  // Which of the two "off" forms the site actually honours is unverified;
  // Step 0 compares them. See docs/step-0-verification.md.
  var mode = cfg.revenueFilterMode || 'range';
  if (mode === 'range') {
    parts.push(
      'dsm[0].Code=201',
      'dsm[0].From=' + (cfg.revenueFrom !== undefined ? cfg.revenueFrom : 5000000),
      'dsm[0].To=' + (cfg.revenueTo !== undefined ? cfg.revenueTo : 400000000)
    );
  } else if (mode === 'off-zero') {
    parts.push('dsm[0].Code=201', 'dsm[0].From=0', 'dsm[0].To=0');
  }

  parts.push(
    'dsm[1].Code=48', 'dsm[1].From=0', 'dsm[1].To=0',
    'dsm[-1].Code=0', 'dsm[-1].From=0', 'dsm[-1].To=0',
    'distinctcodes=',
    'xpnd=true',
    'p=' + (page || 1)
  );

  return base + '/prebaruvanje?' + parts.join('&');
}

// ---------------------------------------------------------------------------
// НКД / НКЗ activity filter
// ---------------------------------------------------------------------------

/** Split a config string of activity codes into a clean list. */
function parseNkdCodes(value) {
  if (value === null || value === undefined) return [];
  return String(value)
    .split(/[,;\n\s]+/)
    .map(function (c) { return c.trim(); })
    .filter(function (c) { return c.length > 0; });
}

/** A division is two digits ("46"); a full code carries a dot ("46.900"). */
function isNkdDivision(code) {
  return /^\d{1,2}$/.test(String(code || '').trim());
}

/**
 * Does an activity code from a profile page fall under the requested filter?
 *
 * A division filter ("46") matches any code beneath it ("46.900"). A full code
 * matches itself. Returns null when the company's code is unknown, so callers
 * can tell "does not match" apart from "could not tell".
 */
function nkdMatchesFilter(activityCode, filter) {
  var f = String(filter === null || filter === undefined ? '' : filter).trim();
  if (!f) return true;

  var c = String(activityCode === null || activityCode === undefined ? '' : activityCode).trim();
  if (!c) return null;

  if (c === f) return true;
  if (isNkdDivision(f)) {
    // Compare on the division number so "46" matches "46.900" but not "460.1".
    return c.indexOf(f + '.') === 0;
  }
  return c.indexOf(f) === 0;
}

// ---------------------------------------------------------------------------
// Search segments
// ---------------------------------------------------------------------------

/**
 * Expand the configured filters into the list of searches to run.
 *
 * A segment is one (activity code x revenue band) combination, and each is paged
 * to its own end. This is both a filter and a paging strategy: a single search can
 * only be paged as deep as the site allows, so splitting the work along whichever
 * dimensions are configured makes companies past that depth reachable.
 *
 * With no activity codes and no revenue banding, this yields exactly one segment —
 * the plain unfiltered search.
 */
function buildSearchSegments(config) {
  var cfg = config || {};

  var codes = parseNkdCodes(cfg.nkdCodes);
  if (!codes.length) codes = [''];

  var bands;
  if ((cfg.revenueFilterMode || 'range') === 'range') {
    bands = buildRevenueBands(cfg.revenueFrom, cfg.revenueTo, cfg.revenueBandCount, cfg.revenueBandFloor);
  } else {
    bands = [null];
  }

  var segments = [];
  for (var i = 0; i < codes.length; i++) {
    for (var j = 0; j < bands.length; j++) {
      segments.push({
        activityType: codes[i],
        revenueFilterMode: bands[j] ? 'range' : (cfg.revenueFilterMode || 'range'),
        revenueFrom: bands[j] ? bands[j].from : undefined,
        revenueTo: bands[j] ? bands[j].to : undefined
      });
    }
  }
  return segments;
}

/**
 * Split a segment's revenue band in two.
 *
 * Used when a segment hits the site's result cap: its companies cannot all be
 * paged to, so the band is halved and both halves are swept instead. The split
 * point is the geometric midpoint, not the arithmetic one — company counts are
 * heavily skewed toward the low end, so an arithmetic midpoint would leave
 * almost everything in the lower half and need splitting again immediately.
 *
 * Returns null when the segment carries no revenue band, or the band is already
 * too narrow to divide.
 */
function splitSegmentByRevenue(segment, minWidth) {
  var seg = segment || {};
  if (seg.revenueFrom === undefined || seg.revenueTo === undefined) return null;

  var from = Number(seg.revenueFrom);
  var to = Number(seg.revenueTo);
  var floor = Number(minWidth);
  if (!Number.isFinite(floor) || floor < 1) floor = 1000;

  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (to <= from || (to - from) < floor) return null;

  var mid = Math.round(Math.sqrt(Math.max(from, 1) * to));
  if (mid <= from || mid >= to) mid = from + Math.floor((to - from) / 2);
  if (mid <= from || mid >= to) return null;

  // revenueFilterMode must travel with the band. buildSearchUrl merges the
  // segment over the config, so a band that does not carry the mode inherits an
  // "off" mode from the config and emits an unfiltered URL — every band would
  // then return the same unfiltered result set and be split again forever.
  return [
    Object.assign({}, seg, { revenueFilterMode: 'range', revenueFrom: from, revenueTo: mid }),
    Object.assign({}, seg, { revenueFilterMode: 'range', revenueFrom: mid + 1, revenueTo: to })
  ];
}

/** One-line description of a segment, for logs and the run summary. */
function describeSegment(segment) {
  var s = segment || {};
  var bits = [];
  bits.push(s.activityType ? ('НКД ' + s.activityType) : 'all activities');
  if (s.revenueFrom !== undefined && s.revenueTo !== undefined) {
    bits.push('revenue ' + s.revenueFrom + '–' + s.revenueTo);
  } else {
    bits.push('any revenue');
  }
  return bits.join(', ');
}

// Exports (no-op inside n8n Code nodes, where `module` is not defined)
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module && module.exports) {
  module.exports = {
    ROLE_KEYWORDS: ROLE_KEYWORDS,
    decodeEntities: decodeEntities,
    normalizeSpace: normalizeSpace,
    htmlToText: htmlToText,
    textLines: textLines,
    stripChrome: stripChrome,
    extractH1: extractH1,
    parseMkNumber: parseMkNumber,
    cityFromAddress: cityFromAddress,
    toTitleCase: toTitleCase,
    extractAddress: extractAddress,
    normalizePhone: normalizePhone,
    isValidMkPhone: isValidMkPhone,
    extractPhones: extractPhones,
    extractEmails: extractEmails,
    extractPeople: extractPeople,
    pickContactPerson: pickContactPerson,
    labelBoundary: labelBoundary,
    extractEmbs: extractEmbs,
    extractEdb: extractEdb,
    extractActivity: extractActivity,
    captureLabelContext: captureLabelContext,
    sliceContactsSection: sliceContactsSection,
    detectBlockedPage: detectBlockedPage,
    normalizeProfilePath: normalizeProfilePath,
    parseSearchResults: parseSearchResults,
    parseProfile: parseProfile,
    parseLica: parseLica,
    buildSearchUrl: buildSearchUrl,
    parseNkdCodes: parseNkdCodes,
    isNkdDivision: isNkdDivision,
    nkdMatchesFilter: nkdMatchesFilter,
    buildSearchSegments: buildSearchSegments,
    splitSegmentByRevenue: splitSegmentByRevenue,
    describeSegment: describeSegment
  };
}

// ---------------------------------------------------------------------------
// Google Sheet column matching
// ---------------------------------------------------------------------------

/**
 * Reduce a sheet header to a comparable key.
 *
 * The Google Sheets node matches columns by exact header text, so a sheet
 * spelling its column "Шифра на дејност (НКЗ)" or "Мејл адреса" silently drops
 * everything written under the canonical name. Parentheticals, spacing and
 * punctuation are removed, and ј is folded to и so Мејл and Меил compare equal.
 */
function normalizeSheetHeader(header) {
  return String(header === null || header === undefined ? '' : header)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\u0458/g, '\u0438')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Map canonical column names onto the sheet's actual headers.
 *
 * Falls back to the canonical name when nothing matches, and reports which ones
 * did not match so the caller can say so rather than silently losing the value.
 */
function matchSheetColumns(canonicalNames, sheetHeaders) {
  var index = {};
  (sheetHeaders || []).forEach(function (header) {
    var key = normalizeSheetHeader(header);
    if (key && !Object.prototype.hasOwnProperty.call(index, key)) index[key] = header;
  });

  var keys = Object.keys(index);
  var map = {};
  var unmatched = [];

  (canonicalNames || []).forEach(function (name) {
    var key = normalizeSheetHeader(name);

    if (Object.prototype.hasOwnProperty.call(index, key)) {
      map[name] = index[key];
      return;
    }

    // Prefix match, for headers that add or drop a qualifier. Kept to reasonably
    // long keys so short names cannot collide with unrelated columns.
    var hit = null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.length < 4 || key.length < 4) continue;
      if (k.indexOf(key) === 0 || key.indexOf(k) === 0) { hit = k; break; }
    }

    if (hit) {
      map[name] = index[hit];
    } else {
      map[name] = name;
      unmatched.push(name);
    }
  });

  return { map: map, unmatched: unmatched, headersSeen: (sheetHeaders || []).slice() };
}

// ---------------------------------------------------------------------------
// Revenue band partitioning
// ---------------------------------------------------------------------------

/**
 * Split a revenue range into contiguous, non-overlapping sub-ranges whose union
 * is exactly the original range.
 *
 * Why: a single search can only be paged as deep as the site allows. Sweeping the
 * same overall filter in slices keeps each sub-search short enough to reach its
 * own end, so companies past any pagination depth cap become reachable.
 *
 * Spacing is geometric, not linear, because company counts are heavily skewed
 * toward the low end of a revenue range — equal-width bands would put almost
 * everything in the first slice and defeat the point.
 */
/** Default floor for the first band when a range starts at 0. */
function config_floor(value) {
  var v = Number(value);
  return (Number.isFinite(v) && v > 0) ? v : 100000;
}

function buildRevenueBands(from, to, count, zeroBandFloor) {
  var f = Number(from);
  var t = Number(to);
  var n = Math.floor(Number(count) || 1);

  if (!Number.isFinite(f) || !Number.isFinite(t) || t <= f) return [{ from: f, to: t }];
  if (n <= 1 || f < 0) return [{ from: f, to: t }];

  // Geometric spacing needs a positive anchor. A range starting at 0 gets its
  // first band carved off at a floor, and the rest spaced from there — otherwise
  // the low bands would be a few MKD wide and waste most of the sweep.
  var floor = Number(config_floor(arguments[3]));
  var anchor = f > 0 ? f : floor;
  if (!(anchor > 0) || t <= anchor) return [{ from: f, to: t }];

  var bands = [];
  var lo = f;
  var spacedCount = n;

  if (f === 0) {
    bands.push({ from: 0, to: anchor - 1 });
    lo = anchor;
    spacedCount = n - 1;
    if (spacedCount < 1) return bands.concat([{ from: lo, to: t }]);
  }

  var ratio = t / anchor;

  for (var i = 1; i <= spacedCount; i++) {
    var hi;
    if (i === spacedCount) {
      hi = t;
    } else {
      hi = Math.round(anchor * Math.pow(ratio, i / spacedCount)) - 1;
      if (hi > t) hi = t;
    }
    if (hi < lo) continue;
    bands.push({ from: lo, to: hi });
    if (hi >= t) break;
    lo = hi + 1;
  }

  return bands.length ? bands : [{ from: f, to: t }];
}

/**
 * ЕДБ as it is used for de-duplication: digits only.
 *
 * Values read back from Google Sheets may arrive as numbers, or with stray
 * formatting, so both sides of the comparison are reduced to digits.
 */
function normalizeEdb(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\D/g, '');
}

if (typeof module !== 'undefined' && module && module.exports) {
  module.exports.buildRevenueBands = buildRevenueBands;
  module.exports.normalizeSheetHeader = normalizeSheetHeader;
  module.exports.matchSheetColumns = matchSheetColumns;
  module.exports.normalizeEdb = normalizeEdb;
}
