// @requires-parsers
// Reduce the record to the eight sheet columns, keyed by the sheet's OWN header
// text.
//
// The Google Sheets node matches columns by exact header name, so a sheet
// spelling a column "Шифра на дејност (НКЗ)" or "Мејл адреса" silently drops
// anything written under the canonical spelling — the row appears, that cell is
// just blank. Headers learnt from the existing rows are matched to the canonical
// names, and anything that cannot be matched while carrying a value is reported.

const sd = $getWorkflowStaticData('global');
const stats = sd.stats;

const COLUMNS = [
  'Клиент',
  'Град',
  'ЕМБС',
  'Даночен БРОЈ',
  'Шифра на дејност',
  'Контакт лице',
  'Контакт телефон',
  'Меил адреса'
];

// Resolved once per run and cached.
if (!sd.columnMapping) {
  sd.columnMapping = matchSheetColumns(COLUMNS, sd.sheetHeaders || []);
  stats.sheetHeadersSeen = sd.columnMapping.headersSeen;
  stats.sheetColumnMap = sd.columnMapping.map;
  stats.sheetColumnsUnmatched = sd.columnMapping.unmatched;

  if ((sd.sheetHeaders || []).length === 0) {
    stats.warnings.push(
      'the sheet returned no rows, so its column headers could not be read — writing under the '
      + 'canonical names. If a column is spelled differently in the sheet, its values will be dropped.'
    );
  }
}

const mapping = sd.columnMapping.map;
const droppable = {};

const rows = $input.all().map((item) => {
  const src = item.json;

  if (!src['Контакт лице']) stats.noContactPerson += 1;
  stats.rowsWritten += 1;

  const row = {};
  for (const column of COLUMNS) {
    const raw = src[column];
    const value = (raw === undefined || raw === null) ? '' : String(raw);
    row[mapping[column]] = value;

    // A value that has nowhere to go is the failure worth shouting about: the
    // row still lands, so the loss is invisible from the sheet alone.
    if (value && sd.columnMapping.unmatched.indexOf(column) !== -1) droppable[column] = true;
  }
  return { json: row };
});

Object.keys(droppable).forEach((column) => {
  if (stats.columnsWithDataButNoHeader.indexOf(column) === -1) {
    stats.columnsWithDataButNoHeader.push(column);
  }
});

return rows;
