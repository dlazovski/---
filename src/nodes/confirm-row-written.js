// Did the append actually land?
//
// The Google Sheets node continues on error, so a row that failed every retry
// would otherwise vanish silently: the run reports it as written and the sheet
// never receives it. Counting the failures here means the summary can say so,
// and the next run's de-duplication will fetch that company again — nothing is
// permanently lost, but it must not go unnoticed.

const sd = $getWorkflowStaticData('global');
const stats = sd.stats;

const items = $input.all();

for (const item of items) {
  const json = item.json || {};
  if (!json.error) continue;

  const attempted = $('Prepare Sheet Row').first().json || {};
  const message = typeof json.error === 'string'
    ? json.error
    : (json.error.message || JSON.stringify(json.error));

  stats.sheetWriteFailures += 1;
  stats.rowsWritten = Math.max(0, (stats.rowsWritten || 0) - 1);
  stats.failedSheetWrites.push({
    company: attempted['Клиент'] || '',
    edb: attempted['Даночен БРОЈ'] || '',
    reason: message
  });
}

return items;
