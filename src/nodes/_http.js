/**
 * Shared HTTP-response reader.
 *
 * The ScrapingBee HTTP Request nodes are configured with fullResponse + neverError,
 * so a non-2xx response arrives as a normal item with a statusCode instead of
 * aborting the run. onError=continueRegularOutput covers transport-level failures,
 * which arrive as an item carrying `error`.
 */
function readHttpItem(item) {
  const json = (item && item.json) ? item.json : {};
  const status = (json.statusCode !== undefined && json.statusCode !== null) ? Number(json.statusCode) : null;

  let html = '';
  if (typeof json.body === 'string') html = json.body;
  else if (typeof json.data === 'string') html = json.data;
  else if (typeof json === 'string') html = json;

  let error = '';
  if (json.error) {
    error = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
  }
  if (!error && status !== null && status >= 400) {
    error = 'HTTP ' + status + (html ? (' — ' + String(html).slice(0, 200)) : '');
  }
  if (!error && !html) error = 'empty response body';

  return { status, html, error };
}

/** Split a comma/semicolon/newline separated config string into a clean array. */
function splitList(value) {
  if (!value) return [];
  return String(value).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
}
