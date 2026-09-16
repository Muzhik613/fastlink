// node --test fast-runner/test/  — the recorder's opt-out: FASTRUN_RECORD=off never starts ffmpeg and
// yields the exact `video` value finish() writes onto the runs.jsonl row. No capture, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startRecording, stopRecording, recordingDisabled } from '../recorder.mjs';

test('FASTRUN_RECORD=off: row video is {recorded:false, reason:"disabled"}, nothing is started', async () => {
  const env = { FASTRUN_RECORD: 'off' };
  const t0 = Date.now();
  const started = await startRecording('rectestoff', { env });
  assert.deepEqual(started, { recorded: false, reason: 'disabled' });
  // finish() does `run.video = await stopRecording(run.id, run.video)` and writes run.video to the row.
  const video = await stopRecording('rectestoff', started);
  assert.deepEqual(video, { recorded: false, reason: 'disabled' });
  assert.ok(Date.now() - t0 < 500, 'disabled must not shell out to record.sh');
  assert.equal(existsSync('/tmp/fastlink-record/rectestoff'), false);
});

test('recording is on by default; only "off" disables it', () => {
  assert.equal(recordingDisabled({}), false);
  assert.equal(recordingDisabled({ FASTRUN_RECORD: 'on' }), false);
  assert.equal(recordingDisabled({ FASTRUN_RECORD: '0' }), false);
  assert.equal(recordingDisabled({ FASTRUN_RECORD: 'OFF' }), true);
});
