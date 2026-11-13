// callWatchdog.js — every relay call answers before the relay gives up on it (fb#35).
//
// The relay fails a call 30 s after sending it, 120 s after sending once the call
// reports {type:'queued'}, and 30 s after {type:'started'} (fastlink-relay
// userRelay.js #arm). The tab queue caps a RUNNING call at 29 s, but work before the
// queue (a sealed call's unseal / replay check / tab check) and after it (the sealed
// reply) had no limit: aliya, secure 0.4.10, 11/13 09:02 + 13:04, a call that
// answered nothing and the relay timed it out silently. Here each call gets a deadline
// under the relay's, moved by its own progress frames; at the deadline it answers
// {code:'call_timeout'} and, if it never started, it is cancelled so it can never run
// later (a caller may already be retrying it).
//
// Pure: timers only, no chrome.*, so node tests drive it.

export const LIMITS = Object.freeze({
  notStarted: 25_000,   // relay: 30 s from its send (network time on both sides)
  queued: 115_000,      // relay: 120 s from its send once the call is queued
  running: 29_500,      // relay: 30 s from 'started'; the queue caps the work at 29 s
});

function timeoutReply(phase, ms) {
  const secs = Math.round(ms / 1000);
  if (phase === 'running') {
    return {
      error: 'no answer in time: the call started but did not finish',
      code: 'call_timeout',
      phase,
      hint: `FastLink did not finish this call within ${secs}s. It may have acted on the page: read the page before retrying.`,
    };
  }
  return {
    error: 'no answer in time: the call was not run',
    code: 'call_timeout',
    phase,
    hint: `FastLink did not get to start this call within ${secs}s, so it was cancelled: it did not run and will not run later. Retrying is safe. If this repeats, the connection log (FastLink options, Connection tab) shows what happened.`,
  };
}

// log(entry) records a timeout (connLog.js); limits are overridable for tests.
export function createCallWatch({ log = () => {}, limits = LIMITS, now = Date.now } = {}) {
  const calls = new Map();   // id -> { action, phase, since, timer, done, timedOut, fire }

  function arm(c, ms) {
    clearTimeout(c.timer);
    c.timer = setTimeout(c.fire, Math.max(0, ms));
  }

  // Run `work(ctl)` for call `id`: resolves with its reply, or with a call_timeout
  // reply at the deadline. ctl.timedOut() tells the work (the queue) the call was
  // answered already, so it must not start.
  function run(id, action, work) {
    return new Promise((resolve) => {
      const c = { action, phase: 'not_started', since: now(), timer: null, done: false, timedOut: false };
      const finish = (reply) => {
        if (c.done) return;
        c.done = true;
        clearTimeout(c.timer);
        calls.delete(id);
        resolve(reply);
      };
      c.fire = () => {
        if (c.done) return;
        c.timedOut = true;
        const ms = now() - c.since;
        log({ ev: 'call_timeout', action, phase: c.phase, ms });
        finish(timeoutReply(c.phase, ms));
      };
      calls.set(id, c);
      arm(c, limits.notStarted);
      const ctl = { timedOut: () => c.timedOut };
      Promise.resolve()
        .then(() => work(ctl))
        .catch((err) => ({ error: err?.message || String(err) }))
        .then(finish);
    });
  }

  // A progress frame the call sent to the relay moves its deadline the same way.
  function progress(frame) {
    const c = calls.get(frame?.id);
    if (!c) return;
    if (frame.type === 'queued' && c.phase === 'not_started') {
      c.phase = 'queued';
      arm(c, limits.queued - (now() - c.since));
    } else if (frame.type === 'started') {
      c.phase = 'running';
      arm(c, limits.running);
    }
  }

  return { run, progress, size: () => calls.size };
}
