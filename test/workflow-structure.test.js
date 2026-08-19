'use strict';

/*
 * Structural checks on both generated workflows.
 *
 * These encode the task's hard constraints as assertions, so a later edit to the
 * builders cannot quietly drop them: every outbound request preceded by a Wait
 * node, batch size 1, all traffic through ScrapingBee, no authenticated URLs.
 * They also catch the n8n-specific wiring mistakes that a simulation can miss —
 * a $('Node Name') referring to a node that does not exist or does not run first.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = {
  main: JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/companywall-mk-scraper.json'), 'utf8')),
  step0: JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/step0-verification.json'), 'utf8'))
};

const WAIT = 'n8n-nodes-base.wait';
const HTTP = 'n8n-nodes-base.httpRequest';
const STICKY = 'n8n-nodes-base.stickyNote';

function names(wf) { return wf.nodes.map((n) => n.name); }
function byName(wf, name) { return wf.nodes.find((n) => n.name === name); }

/** name -> [downstream names], across all outputs. */
function edges(wf) {
  const out = {};
  for (const [from, conn] of Object.entries(wf.connections)) {
    out[from] = (conn.main || []).flat().map((t) => t.node);
  }
  return out;
}

/** name -> [upstream names]. */
function reverseEdges(wf) {
  const out = {};
  for (const [from, targets] of Object.entries(edges(wf))) {
    for (const t of targets) (out[t] = out[t] || []).push(from);
  }
  return out;
}

function reachable(graph, start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of (graph[cur] || [])) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

for (const [label, wf] of Object.entries(WORKFLOWS)) {
  test(`[${label}] node names are unique`, () => {
    const all = names(wf);
    assert.strictEqual(new Set(all).size, all.length, 'duplicate node name');
  });

  test(`[${label}] every connection refers to a node that exists`, () => {
    const all = new Set(names(wf));
    for (const [from, targets] of Object.entries(edges(wf))) {
      assert.ok(all.has(from), 'connection source does not exist: ' + from);
      for (const t of targets) assert.ok(all.has(t), 'connection target does not exist: ' + t);
    }
  });

  test(`[${label}] every node is wired into the graph`, () => {
    const connected = new Set();
    for (const [from, targets] of Object.entries(edges(wf))) {
      connected.add(from);
      targets.forEach((t) => connected.add(t));
    }
    for (const node of wf.nodes) {
      if (node.type === STICKY) continue;
      assert.ok(connected.has(node.name), 'node is not connected to anything: ' + node.name);
    }
  });

  test(`[${label}] every $('Node') reference resolves to a node that runs earlier`, () => {
    const all = new Set(names(wf));
    const fwd = edges(wf);
    for (const node of wf.nodes) {
      const code = node.parameters && node.parameters.jsCode;
      if (!code) continue;
      const refs = [...code.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
      for (const ref of new Set(refs)) {
        assert.ok(all.has(ref), `${node.name} references $('${ref}') which does not exist`);
        assert.ok(
          reachable(fwd, ref).has(node.name),
          `${node.name} references $('${ref}'), but ${ref} cannot reach ${node.name} — it may not have run yet`
        );
      }
    }
  });

  test(`[${label}] every outbound request is preceded by a Wait node`, () => {
    const rev = reverseEdges(wf);
    for (const node of wf.nodes) {
      if (node.type !== HTTP) continue;
      const upstream = rev[node.name] || [];
      assert.ok(upstream.length > 0, `${node.name} has no upstream node`);
      for (const up of upstream) {
        assert.strictEqual(
          byName(wf, up).type, WAIT,
          `${node.name} is reachable from ${up}, which is not a Wait node — rate limiting would be bypassed`
        );
      }
    }
  });

  test(`[${label}] Wait nodes delay between 3 and 5 seconds`, () => {
    const waits = wf.nodes.filter((n) => n.type === WAIT);
    assert.ok(waits.length > 0, 'no Wait nodes at all');
    for (const w of waits) {
      assert.strictEqual(w.parameters.unit, 'seconds', `${w.name} is not measured in seconds`);
      const amount = String(w.parameters.amount);
      assert.match(amount, /3 \+ Math\.random\(\) \* 2/, `${w.name} does not use a 3-5s delay`);
    }
  });

  test(`[${label}] all site traffic goes through the ScrapingBee endpoint`, () => {
    const https = wf.nodes.filter((n) => n.type === HTTP);
    assert.ok(https.length > 0, 'no HTTP Request nodes');
    for (const node of https) {
      assert.match(node.parameters.url, /scrapingBeeEndpoint/,
        `${node.name} does not call the ScrapingBee endpoint`);
      assert.strictEqual(node.parameters.authentication, 'genericCredentialType',
        `${node.name} has no credential configured`);
      assert.strictEqual(node.parameters.genericAuthType, 'httpQueryAuth',
        `${node.name} does not use query auth (ScrapingBee api_key)`);
      const params = node.parameters.queryParameters.parameters;
      assert.ok(params.some((p) => p.name === 'url'), `${node.name} sends no target url`);
      assert.ok(params.some((p) => p.name === 'render_js'), `${node.name} does not set render_js`);
    }
  });

  test(`[${label}] requests are issued one at a time`, () => {
    const loops = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.splitInBatches');
    assert.ok(loops.length > 0, 'no Split In Batches node');
    for (const loop of loops) {
      assert.strictEqual(loop.parameters.batchSize, 1, `${loop.name} would run several requests concurrently`);
    }
  });

  test(`[${label}] render_js defaults to false`, () => {
    const cfg = byName(wf, 'Config').parameters.assignments.assignments;
    const renderJs = cfg.find((a) => a.name === 'renderJs');
    assert.ok(renderJs, 'Config has no renderJs field');
    assert.strictEqual(renderJs.value, 'false');
  });

  test(`[${label}] the revenue filter is 5,000,000–400,000,000 with no area or industry restriction`, () => {
    const cfg = byName(wf, 'Config').parameters.assignments.assignments;
    const get = (name) => (cfg.find((a) => a.name === name) || {}).value;
    assert.strictEqual(get('revenueFrom'), 5000000);
    assert.strictEqual(get('revenueTo'), 400000000);
    assert.strictEqual(get('area'), '');
    assert.strictEqual(get('subarea'), '');
    assert.strictEqual(get('activityType'), '');
  });

  test(`[${label}] no credential IDs are baked into the exported workflow`, () => {
    for (const node of wf.nodes) {
      assert.ok(!node.credentials, `${node.name} carries a credential reference from another instance`);
    }
  });
}

// --- main-workflow specifics -------------------------------------------------

test('[main] the sheet is read before the run and appended to after', () => {
  const wf = WORKFLOWS.main;
  const sheets = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  assert.strictEqual(sheets.length, 2, 'expected exactly one read node and one append node');

  const read = sheets.find((n) => n.parameters.operation === 'read');
  const append = sheets.find((n) => n.parameters.operation === 'append');
  assert.ok(read, 'no Google Sheets read node');
  assert.ok(append, 'no Google Sheets append node');

  assert.strictEqual(append.parameters.columns.mappingMode, 'autoMapInputData');

  // Reading and appending must target the same tab, or de-duplication is meaningless.
  assert.strictEqual(read.parameters.documentId.value, append.parameters.documentId.value);
  assert.strictEqual(read.parameters.sheetName.value, append.parameters.sheetName.value);
  assert.match(read.parameters.documentId.value, /googleSheetId/);

  // An empty sheet returns no rows; without alwaysOutputData the run never starts.
  assert.strictEqual(read.alwaysOutputData, true, 'read node must set alwaysOutputData');
});

test('[main] the sheet read happens before any company is fetched', () => {
  const wf = WORKFLOWS.main;
  const fwd = edges(wf);
  const downstreamOfRead = reachable(fwd, 'Read Existing Sheet');
  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.httpRequest') continue;
    assert.ok(
      downstreamOfRead.has(node.name),
      node.name + ' can run without the existing sheet having been read — it could re-fetch known companies'
    );
  }
});

test('[main] the revenue band sweep is configured and covers the full range', () => {
  const cfg = WORKFLOWS.main.nodes.find((n) => n.name === 'Config').parameters.assignments.assignments;
  const bandCount = cfg.find((a) => a.name === 'revenueBandCount');
  assert.ok(bandCount, 'Config has no revenueBandCount field');
  assert.ok(bandCount.value >= 1, 'revenueBandCount must be at least 1');

  const { buildRevenueBands } = require('../src/lib/parsers.js');
  const from = cfg.find((a) => a.name === 'revenueFrom').value;
  const to = cfg.find((a) => a.name === 'revenueTo').value;
  const bands = buildRevenueBands(from, to, bandCount.value);

  assert.strictEqual(bands[0].from, from);
  assert.strictEqual(bands[bands.length - 1].to, to);
  for (let i = 1; i < bands.length; i++) {
    assert.strictEqual(bands[i].from, bands[i - 1].to + 1, 'bands are not contiguous');
  }
});

test('[main] the sheet ID is an obvious placeholder, not a stale real ID', () => {
  const cfg = WORKFLOWS.main.nodes.find((n) => n.name === 'Config').parameters.assignments.assignments;
  const id = cfg.find((a) => a.name === 'googleSheetId').value;
  assert.match(id, /PUT-YOUR/, 'the sheet ID should be a placeholder the user must replace');
});

test('[step0] the verification workflow writes nowhere', () => {
  const types = WORKFLOWS.step0.nodes.map((n) => n.type);
  assert.ok(!types.includes('n8n-nodes-base.googleSheets'), 'Step 0 must not write to the sheet');
});

// --- generated code must be syntactically valid in every node ---------------

for (const [label, wf] of Object.entries(WORKFLOWS)) {
  test(`[${label}] every generated Code node parses as a function body`, () => {
    const codeNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code');
    assert.ok(codeNodes.length > 0, 'no Code nodes');
    for (const node of codeNodes) {
      assert.doesNotThrow(
        () => new Function('$input', '$', '$getWorkflowStaticData', node.parameters.jsCode),
        'syntax error in generated code for node: ' + node.name
      );
      assert.match(node.parameters.jsCode, /GENERATED — do not edit here/,
        node.name + ' is missing the generated-file banner');
    }
  });

  test(`[${label}] nodes that parse HTML actually have the parser library inlined`, () => {
    const needsParsers = wf.nodes.filter(
      (n) => n.type === 'n8n-nodes-base.code' && /@requires-parsers/.test(n.parameters.jsCode)
    );
    assert.ok(needsParsers.length > 0, 'no node declares @requires-parsers');
    for (const node of needsParsers) {
      assert.match(node.parameters.jsCode, /function parseSearchResults\(/,
        node.name + ' declares @requires-parsers but the library was not inlined');
    }
  });
}
