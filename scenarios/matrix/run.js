'use strict';

// Fixture-matrix harness: POSTs every mock-erp/fixtures/data payload to the
// API and asserts the expected status; for accepted render cases (expect 201,
// render:true) it optionally waits for terminal state and asserts nothing
// failed. Expectations live next to the fixtures (_expectations.json).
//
//   node scenarios/matrix/run.js            # post + assert statuses
//   node scenarios/matrix/run.js --render   # also wait for renders to complete
//
// env: PDF_API (default http://localhost:3000)

const fs = require('fs');
const path = require('path');

const PDF_API = process.env.PDF_API || 'http://localhost:3000';
const DATA = path.join(__dirname, '..', '..', 'mock-erp', 'fixtures', 'data');
const WAIT_RENDER = process.argv.includes('--render');

const { pollUntilTerminal } = require('../client/download');

let pass = 0, fail = 0;
function ok(m) { console.log(`  ✓ ${m}`); pass++; }
function bad(m) { console.error(`  ✗ ${m}`); fail++; }

async function main() {
  const expectations = JSON.parse(fs.readFileSync(path.join(DATA, '_expectations.json'), 'utf8'));
  console.log(`\nFixture matrix: ${Object.keys(expectations).length} cases against ${PDF_API}\n`);

  for (const [name, exp] of Object.entries(expectations)) {
    const file = path.join(DATA, `${name}.json`);
    const raw = fs.readFileSync(file, 'utf8');

    const res = await fetch(`${PDF_API}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw, // sent verbatim — parser_truncated stays broken on the wire
    });
    const body = await res.json().catch(() => ({}));

    if (res.status !== exp.expect) {
      bad(`${name}: expected ${exp.expect}, got ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
      continue;
    }

    if (exp.expect === 400) {
      const detail = body.errors?.[0] || body.documents?.[0]?.errors?.[0] || body.error;
      ok(`${name}: rejected 400 (${String(detail).slice(0, 90)})`);
      continue;
    }

    if (exp.render && WAIT_RENDER) {
      const job = await pollUntilTerminal(body.id, { quiet: true });
      const counts = `${job.completedDocuments}/${job.totalDocuments}`;
      if (job.status === 'completed') ok(`${name}: 201 -> rendered ${counts}`);
      else bad(`${name}: 201 but terminal=${job.status} (${counts}, failed=${job.failedDocuments})`);
    } else {
      ok(`${name}: accepted ${res.status} (job ${body.id})`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(fail ? '\nRESULT: FAILED\n' : '\nRESULT: PASSED\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('matrix harness crashed:', e.message); process.exit(1); });
