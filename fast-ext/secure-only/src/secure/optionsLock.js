// Options page: the "Secure browser lock" card. scripts/build-secure.sh adds this script
// to the secure build's options.html; it inserts the card above the pairing card.
import { loadLock, isLocked, lockKeyId, lockSettings, setLock, setAllowlist, clearLock, normalizeAllowlist, evaluateState, EVAL_OFF_USER_SCRIPTS } from './lock.js';
import { userScriptsAllowed } from './evaluate.js';

const $ = (id) => document.getElementById(id);

const CARD = `
      <h2>Secure browser lock</h2>
      <p class="desc">This is the secure FastLink build. It accepts only encrypted calls from the one machine that holds the lock code, and only on the sites listed below. The relay never sees the code, the commands or the pages.</p>
      <p class="desc" id="lock-status"></p>
      <label for="lock-code">Lock code (from <code>node fast-dxt/server/index.js lock &lt;browser&gt;</code> on the driving machine)</label>
      <input type="password" id="lock-code" placeholder="43 characters; leave empty to keep the current one" autocomplete="off" spellcheck="false" />
      <label for="lock-allow" style="margin-top:10px;">Allowed sites (one per line: <code>www.bank.com</code>, or <code>*.bank.com</code> for the site and its subdomains)</label>
      <textarea id="lock-allow" rows="7" spellcheck="false" style="width:100%; font-family:monospace;"></textarea>
      <label style="margin-top:8px; display:flex; gap:8px; align-items:center;"><input type="checkbox" id="lock-remote-add" style="width:auto;" /> Let the driving machine add allowed sites (it can always remove them)</label>
      <label style="margin-top:4px; display:flex; gap:8px; align-items:center;"><input type="checkbox" id="lock-eval" style="width:auto;" /> Allow page JavaScript (fast_evaluate). Page scripts can send data to any site; allow it only if the driving scripts need it. It also needs Chrome's "Allow User Scripts" switch on FastLink's Details page.</label>
      <div class="row" style="gap:8px; margin-top:10px;">
        <button type="button" id="lock-save" class="primary">Save lock</button>
        <button type="button" id="lock-clear">Unlock</button>
      </div>
      <div id="lock-msg" class="msg"></div>`;

function insertCard() {
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'lock-card';
  card.innerHTML = CARD;
  const pair = $('pair-card');
  pair.parentNode.insertBefore(card, pair);
}

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
  // Page JavaScript allowed here but Chrome's switch is off: say so now, not mid-flow (feedback #25).
  if (evaluateState(userScriptsAllowed()) === EVAL_OFF_USER_SCRIPTS) {
    $('lock-status').textContent += ' Page JavaScript is allowed but will not run: turn on "Allow User Scripts" at chrome://extensions → FastLink → Details.';
  }
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

insertCard();
$('lock-save').addEventListener('click', onSave);
$('lock-clear').addEventListener('click', onClear);
loadLock().then(paint);
