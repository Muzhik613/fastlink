// Options page: the "Secure browser lock" card. Shown only in the secure build.
import { SECURE_BUILD } from './build.js';
import { loadLock, isLocked, lockKeyId, currentAllowlist, remoteAddAllowed, setLock, setAllowlist, clearLock, normalizeAllowlist } from './lock.js';

const $ = (id) => document.getElementById(id);

function msg(text, kind) {
  const el = $('lock-msg');
  el.textContent = text || '';
  el.className = kind ? `msg ${kind}` : 'msg';
}

function paint() {
  $('lock-status').textContent = isLocked()
    ? `Locked. Key id ${lockKeyId()}; ${currentAllowlist().length} allowed site(s).`
    : 'Not locked: this browser refuses every call until a lock code is saved.';
  $('lock-allow').value = currentAllowlist().join('\n');
  $('lock-remote-add').checked = remoteAddAllowed();
  $('lock-code').value = '';
}

async function onSave() {
  const code = $('lock-code').value.trim();
  const list = normalizeAllowlist($('lock-allow').value);
  const remoteAdd = $('lock-remote-add').checked;
  try {
    if (code) await setLock(code, list, { remoteAdd });
    else if (isLocked()) await setAllowlist(list, { remoteAdd });
    else { msg('Paste the lock code first.', 'err'); return; }
    paint();
    msg(code ? 'Lock saved. Calls sealed with the previous code no longer work.' : 'Allowed sites saved.', 'ok');
  } catch (e) {
    msg(e?.message || String(e), 'err');
  }
}

async function onClear() {
  if (!confirm('Unlock this browser? It will refuse every call until a lock code is saved again.')) return;
  await clearLock();
  paint();
  msg('Unlocked.', 'ok');
}

if (SECURE_BUILD) {
  $('lock-card').hidden = false;
  $('lock-save').addEventListener('click', onSave);
  $('lock-clear').addEventListener('click', onClear);
  loadLock().then(paint);
}
