// Options page: the "Secure browser lock" card. Shown only in the secure build.
import { SECURE_BUILD } from './build.js';
import { loadLock, isLocked, lockKeyId, lockSettings, setLock, setAllowlist, clearLock, normalizeAllowlist } from './lock.js';

const $ = (id) => document.getElementById(id);

function msg(text, kind) {
  const el = $('lock-msg');
  el.textContent = text || '';
  el.className = kind ? `msg ${kind}` : 'msg';
}

function paint() {
  const s = lockSettings();
  $('lock-status').textContent = isLocked()
    ? `Locked. Key id ${lockKeyId()}; ${s.allowlist.length} allowed site(s).`
    : 'Not locked: this browser refuses every call until a lock code is saved.';
  $('lock-allow').value = s.allowlist.join('\n');
  $('lock-remote-add').checked = s.remoteAdd;
  $('lock-eval').checked = s.allowEval;
  $('lock-code').value = '';
}

async function onSave() {
  const code = $('lock-code').value.trim();
  const list = normalizeAllowlist($('lock-allow').value);
  const remoteAdd = $('lock-remote-add').checked;
  const allowEval = $('lock-eval').checked;
  try {
    if (code) await setLock(code, list, { remoteAdd, allowEval });
    else if (isLocked()) await setAllowlist(list, { remoteAdd, allowEval });
    else { msg('Paste the lock code first.', 'err'); return; }
    paint();
    msg(code ? 'Lock saved. Calls sealed with the previous code no longer work.' : 'Allowed sites saved.', 'ok');
  } catch (e) {
    msg(e?.message || String(e), 'err');
  }
}

async function onClear() {
  if (!confirm('Unlock this browser? This also unpairs it from the relay. To use it again it must be revoked and paired again (the relay keeps refusing the old pairing).')) return;
  await clearLock();
  paint();
  msg('Unlocked and unpaired.', 'ok');
}

if (SECURE_BUILD) {
  $('lock-card').hidden = false;
  $('lock-save').addEventListener('click', onSave);
  $('lock-clear').addEventListener('click', onClear);
  loadLock().then(paint);
}
