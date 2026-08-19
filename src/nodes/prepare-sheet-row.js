// Reduce the record to exactly the eight sheet columns.
//
// The Google Sheets node uses autoMapInputData, so the keys emitted here must
// match the sheet header exactly — and nothing else may be emitted, or stray
// fields would be offered for mapping.

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

return $input.all().map((item) => {
  const src = item.json;

  if (!src['Контакт лице']) stats.noContactPerson += 1;
  stats.rowsWritten += 1;

  const row = {};
  for (const column of COLUMNS) {
    const value = src[column];
    row[column] = (value === undefined || value === null) ? '' : String(value);
  }
  return { json: row };
});
