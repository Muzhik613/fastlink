// node --test — bench scorer: report-vs-live comparison reads a literal backslash-n as a newline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportContains } from '../../bench/score.js';

test('reportContains: literal \\n / \\r\\n in either side compare as newlines', () => {
  // staticform run fdc1ed25: the model copied the JSON-escaped textarea value
  const report = 'Textarea: Multi-line\\ntext here; Dropdown (select): Two';
  assert.equal(reportContains(report, 'Multi-line\ntext here'), true);
  assert.equal(reportContains('a Multi-line\\r\\ntext here b', 'Multi-line\r\ntext here'), true);
  assert.equal(reportContains('Multi-line\ntext here', 'Multi-line\\ntext here'), true);
  assert.equal(reportContains(report, 'Other text'), false);
  assert.equal(reportContains(null, 'x'), null);
});
