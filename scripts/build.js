#!/usr/bin/env node
'use strict';

/*
 * Assemble the importable n8n workflow JSON files.
 *
 * n8n Code nodes cannot require() shared modules, so the tested parser library
 * (src/lib/parsers.js) is inlined into every node that declares
 * `// @requires-parsers`. Keeping the logic in one tested file and generating the
 * JSON avoids the usual n8n failure mode: five copy-pasted parsers that drift.
 *
 *   node scripts/build.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = fs.readFileSync(path.join(ROOT, 'src/lib/parsers.js'), 'utf8');
const HTTP_HELPERS = fs.readFileSync(path.join(ROOT, 'src/nodes/_http.js'), 'utf8');

const BANNER = [
  '// ---------------------------------------------------------------------------',
  '// GENERATED — do not edit here.',
  '// Source: src/nodes/{FILE} (+ inlined src/lib/parsers.js)',
  '// Edit the source, then run: node scripts/build.js',
  '// ---------------------------------------------------------------------------',
  ''
].join('\n');

function loadCode(file) {
  const src = fs.readFileSync(path.join(ROOT, 'src/nodes', file), 'utf8');
  const parts = [BANNER.replace('{FILE}', file)];

  if (src.includes('@requires-parsers')) {
    parts.push('// ===== inlined from src/lib/parsers.js =====');
    parts.push(LIB);
    parts.push('');
  }
  if (src.includes('readHttpItem') || src.includes('splitList')) {
    parts.push('// ===== inlined from src/nodes/_http.js =====');
    parts.push(HTTP_HELPERS);
    parts.push('');
  }
  parts.push('// ===== node logic =====');
  parts.push(src);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Node factories
// ---------------------------------------------------------------------------

const CONFIG_REF = "$('Config').first().json";

function manualTrigger(name, position) {
  return { parameters: {}, id: name, name, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position };
}

function setNode(name, fields, position) {
  return {
    parameters: {
      assignments: {
        assignments: fields.map((f, i) => ({
          id: name.toLowerCase().replace(/\W+/g, '-') + '-' + i,
          name: f.name,
          value: f.value,
          type: f.type
        }))
      },
      includeOtherFields: false,
      options: {}
    },
    id: name, name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position
  };
}

function codeNode(name, file, position) {
  return {
    parameters: { jsCode: loadCode(file) },
    id: name, name, type: 'n8n-nodes-base.code', typeVersion: 2, position
  };
}

/**
 * Rate-limit gate. A fresh random 3-5s delay per request, per the site's
 * request to avoid bursts of search traffic.
 */
function waitNode(name, position) {
  return {
    parameters: { amount: '={{ 3 + Math.random() * 2 }}', unit: 'seconds' },
    id: name, name, type: 'n8n-nodes-base.wait', typeVersion: 1.1, position, webhookId: name
  };
}

/**
 * All site traffic goes through ScrapingBee.
 *
 * fullResponse keeps the status code for error reporting; retryOnFail covers
 * transient ScrapingBee failures; onError=continueRegularOutput means a request
 * that fails all retries becomes a logged, skipped item instead of killing the run.
 */
function scrapingBeeNode(name, targetUrlExpr, position) {
  return {
    parameters: {
      method: 'GET',
      url: `={{ ${CONFIG_REF}.scrapingBeeEndpoint }}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpQueryAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'url', value: targetUrlExpr },
          { name: 'render_js', value: `={{ ${CONFIG_REF}.renderJs }}` }
        ]
      },
      options: {
        timeout: 120000,
        response: {
          response: { fullResponse: true, responseFormat: 'text', outputPropertyName: 'data' }
        }
      }
    },
    id: name, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 5000,
    onError: 'continueRegularOutput'
  };
}

function ifBooleanNode(name, leftExpr, operation, position) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: name.toLowerCase().replace(/\W+/g, '-'),
            leftValue: leftExpr,
            rightValue: '',
            operator: { type: 'boolean', operation, singleValue: true }
          }
        ],
        combinator: 'and'
      },
      looseTypeValidation: true,
      options: {}
    },
    id: name, name, type: 'n8n-nodes-base.if', typeVersion: 2, position
  };
}

function splitInBatchesNode(name, position) {
  return {
    parameters: { batchSize: 1, options: {} },
    id: name, name, type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position
  };
}

function googleSheetsAppendNode(name, position) {
  return {
    parameters: {
      resource: 'sheet',
      operation: 'append',
      documentId: { __rl: true, value: `={{ ${CONFIG_REF}.googleSheetId }}`, mode: 'id' },
      sheetName: { __rl: true, value: `={{ ${CONFIG_REF}.googleSheetName }}`, mode: 'name' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: {}
    },
    id: name, name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position
  };
}

/**
 * Reads the rows already in the target sheet, so a follow-up run can skip
 * companies that were appended by an earlier one.
 *
 * alwaysOutputData matters: an empty sheet returns no rows, and without it the
 * downstream node would be skipped and the whole run would never start.
 */
function googleSheetsReadNode(name, position) {
  return {
    parameters: {
      resource: 'sheet',
      operation: 'read',
      documentId: { __rl: true, value: `={{ ${CONFIG_REF}.googleSheetId }}`, mode: 'id' },
      sheetName: { __rl: true, value: `={{ ${CONFIG_REF}.googleSheetName }}`, mode: 'name' },
      options: {}
    },
    id: name, name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5, position,
    alwaysOutputData: true
  };
}

function noOpNode(name, position) {
  return { parameters: {}, id: name, name, type: 'n8n-nodes-base.noOp', typeVersion: 1, position };
}

function stickyNote(name, content, position, width, height, color) {
  return {
    parameters: { content, height: height || 300, width: width || 420, color: color || 4 },
    id: name, name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position
  };
}

/** connections spec: { NodeName: [[{node,index}], [...]] } — outer array is per output. */
function buildConnections(spec) {
  const out = {};
  for (const [from, outputs] of Object.entries(spec)) {
    out[from] = {
      main: outputs.map((targets) =>
        targets.map((t) => ({ node: t.node, type: 'main', index: t.index || 0 }))
      )
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared config fields
// ---------------------------------------------------------------------------

const SEARCH_CONFIG_FIELDS = [
  { name: 'baseUrl', value: 'https://www.companywall.com.mk', type: 'string' },
  { name: 'scrapingBeeEndpoint', value: 'https://app.scrapingbee.com/api/v1/', type: 'string' },
  { name: 'renderJs', value: 'false', type: 'string' },
  // НКД / НКЗ activity filter, sent as `at=`. Comma-separated. A two-digit
  // division ("46") is intended to cover every code beneath it ("46.900").
  { name: 'nkdCodes', value: 'PUT-YOUR-NKD-DIVISION-HERE', type: 'string' },
  // 'range' | 'off-zero' | 'off-omit' — see buildSearchUrl().
  { name: 'revenueFilterMode', value: 'off-zero', type: 'string' },
  { name: 'revenueFrom', value: 5000000, type: 'number' },
  { name: 'revenueTo', value: 400000000, type: 'number' },
  { name: 'balanceYear', value: 2025, type: 'number' },
  { name: 'area', value: '', type: 'string' },
  { name: 'subarea', value: '', type: 'string' },
  // CompanyWall's own number appears in the page chrome of every profile. It is
  // already excluded by stripping header/footer, but naming it here is the
  // belt-and-braces version — it must never reach a company's row.
  { name: 'excludePhones', value: '075387170', type: 'string' },
  { name: 'excludeEmails', value: '', type: 'string' },
  // 'municipality' = the confirmed rule (Skopje companies get Центар / Аеродром).
  // 'settlement'   = the city proper (those companies get Скопје).
  { name: 'cityMode', value: 'municipality', type: 'string' }
];

module.exports = {
  loadCode, manualTrigger, setNode, codeNode, waitNode, scrapingBeeNode,
  ifBooleanNode, splitInBatchesNode, googleSheetsAppendNode, googleSheetsReadNode, noOpNode,
  stickyNote, buildConnections, SEARCH_CONFIG_FIELDS, ROOT
};

if (require.main === module) {
  const buildMain = require('./build-main-workflow.js');
  const buildStep0 = require('./build-step0-workflow.js');

  const outDir = path.join(ROOT, 'workflows');
  fs.mkdirSync(outDir, { recursive: true });

  const targets = [
    { file: 'companywall-mk-scraper.json', workflow: buildMain() },
    { file: 'step0-verification.json', workflow: buildStep0() }
  ];

  for (const t of targets) {
    const dest = path.join(outDir, t.file);
    fs.writeFileSync(dest, JSON.stringify(t.workflow, null, 2) + '\n');
    const kb = (fs.statSync(dest).size / 1024).toFixed(1);
    console.log('wrote ' + path.relative(ROOT, dest) + ' (' + t.workflow.nodes.length + ' nodes, ' + kb + ' KB)');
  }
}
