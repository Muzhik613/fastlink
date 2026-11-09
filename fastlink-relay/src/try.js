// try.js — relay.ytx.app/try: a signed-in user can try FastLink on their OWN paired
// browser without an AI app. Three fixed actions, no free-form commands:
//   status → which of the user's browsers are online
//   tabs   → that browser's web tabs (fast_list), minus the relay's own pages, so the
//            user picks a tab (the /try tab itself is the active one while they click)
//   read   → a short summary of the chosen tab (fast_snapshot)
//   click  → click the first link on it (fast_snapshot, then fast_click by id)
// Every step is an ordinary MCP tools/call through the user's DO (auth.js forwards it
// to /__mcp), so "Stop driving", per-site rules and the activity log apply exactly as
// they do for an AI app. This module holds only the action logic and the page.

export const TRY_ACTIONS = new Set(['status', 'tabs', 'read', 'click']);

const TEXT_MAX = 600;      // characters of page text shown
const ITEMS_MAX = 12;      // controls listed
const LABEL_MAX = 80;
const TABS_MAX = 30;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const itemLabel = (it) => clip(it.label || it.text || it.value || '', LABEL_MAX);

// The browser (and tab) to use: what the user picked, else omitted (the relay then uses
// the only online browser and its target tab, or answers with the browsers to pick from).
const target = ({ browser, tabId } = {}, args = {}) => ({
  ...args,
  ...(browser ? { browser: String(browser) } : {}),
  ...(Number.isInteger(tabId) ? { tabId } : {}),
});

// `callTool(name, args)` runs one MCP tools/call and resolves to the tool's JSON result
// (`error` set when the tool failed). `opts` = { browser, tabId, relayOrigin }.
// Returns a small JSON-safe summary.
export async function runTryAction(callTool, action, opts = {}) {
  if (!TRY_ACTIONS.has(action)) return { error: 'Unknown action.' };

  if (action === 'status') {
    const s = await callTool('fast_status', {});
    if (s.error) return { error: s.error };
    const browsers = (s.browsers || []).map((b) => ({ name: b.name, connected: !!b.connected }));
    return { browsers, paused: !!s.drivingPaused };
  }

  if (action === 'tabs') {
    const r = await callTool('fast_list', target({ browser: opts.browser }));
    if (r.error) return { error: r.error, ...(r.available ? { available: r.available } : {}) };
    const list = Array.isArray(r) ? r : (r.tabs || []);
    const tabs = list
      .filter((t) => /^https?:/.test(t.url || '') && !(opts.relayOrigin && String(t.url).startsWith(opts.relayOrigin + '/')))
      .slice(0, TABS_MAX)
      .map((t) => ({ tabId: t.id, title: clip(t.title || t.url, LABEL_MAX), url: t.url }));
    return { tabs };
  }

  const snap = await callTool('fast_snapshot', target(opts, { limit: 40 }));
  if (snap.error) return { error: snap.error, ...(snap.available ? { available: snap.available } : {}) };

  if (action === 'read') {
    const text = (snap.content || []).map((c) => c.text || '').join(' ');
    return {
      url: snap.url || '',
      title: clip(snap.title, 200),
      text: clip(text, TEXT_MAX),
      controls: snap.count ?? (snap.items || []).length,
      items: (snap.items || []).slice(0, ITEMS_MAX).map((it) => ({ tag: it.tag, label: itemLabel(it) })).filter((x) => x.label),
    };
  }

  // click: the first link that has a visible label.
  const link = (snap.items || []).find((it) => it.tag === 'a' && itemLabel(it));
  if (!link) return { error: 'This tab has no link to click. Open a page with a link (for example https://example.com) and try again.', url: snap.url || '' };
  const r = await callTool('fast_click', target(opts, { id: String(link.i) }));
  if (r.error) return { error: r.error };
  return { clicked: itemLabel(link), from: snap.url || '', url: r.url || '', urlChanged: !!r.urlChanged || !!r.navigating };
}

// The page body (auth.js wraps it in its standard htmlPage). `email` is shown so the
// user can see which account they are signed in as.
export function tryPageBody(email, escapeHtml) {
  return `<p>Signed in as <b>${escapeHtml(email || 'your account')}</b>. These buttons act on your own browser that is paired to this account, the same way your AI assistant would.</p>
<p class="muted">Pair a browser first: install FastLink and click "Sign in &amp; connect" with this Google account. Then open any website (for example https://example.com) in that browser.</p>
<div class="row"><label>Browser <select id="browser"><option value="">(the one online)</option></select></label>
  <label>Tab <select id="tab"><option value="">(open a website first)</option></select></label>
  <button type="button" class="ghost" id="refresh">Refresh</button></div>
<div class="row">
  <button type="button" class="primary" data-action="read">Read this tab</button>
  <button type="button" class="ghost" data-action="click">Click its first link</button>
</div>
<pre id="out" class="code2" style="white-space:pre-wrap">Ready.</pre>
<p class="muted">Only these fixed actions are available here. "Stop driving" and your per-site rules in the extension apply, and each action is recorded in your 30-day activity log.</p>
<script>
(function(){
  var out=document.getElementById('out'), sel=document.getElementById('browser'), tab=document.getElementById('tab');
  function run(action){
    if(action==='read'||action==='click') out.textContent='Working…';
    return fetch('/try/run',{method:'POST',headers:{'content-type':'application/json','x-fastlink-try':'1'},
      body:JSON.stringify({action:action,browser:sel.value||undefined,tabId:tab.value?Number(tab.value):undefined})})
      .then(function(r){return r.json();});
  }
  function tabs(){
    return run('tabs').then(function(d){
      var keep=tab.value; tab.length=0;
      if(d.error){ var e=document.createElement('option'); e.value=''; e.textContent='(no tabs: '+d.error.slice(0,60)+')'; tab.appendChild(e); return; }
      if(!d.tabs.length){ var o0=document.createElement('option'); o0.value=''; o0.textContent='(open a website first, then Refresh)'; tab.appendChild(o0); return; }
      d.tabs.forEach(function(t){ var o=document.createElement('option'); o.value=t.tabId; o.textContent=t.title; o.title=t.url; tab.appendChild(o); });
      if(keep && [].some.call(tab.options,function(o){return o.value===keep;})) tab.value=keep;
    });
  }
  function show(action,d){
    if(d.error){ out.textContent='Error: '+d.error+(d.available?'\\nOnline: '+d.available.join(', '):''); return; }
    if(action==='read'){
      var lines=['Title: '+d.title,'URL: '+d.url,'Controls on the page: '+d.controls,'',d.text||'(no text)',''];
      (d.items||[]).forEach(function(it){ lines.push('- '+it.tag+': '+it.label); });
      out.textContent=lines.join('\\n'); return;
    }
    if(action==='click'){ out.textContent='Clicked "'+d.clicked+'"\\nfrom '+d.from+'\\nnow at '+(d.url||'(navigating)'); return; }
  }
  function status(){
    run('status').then(function(d){
      if(d.error){ out.textContent='Error: '+d.error; return; }
      var keep=sel.value; sel.length=1;
      d.browsers.forEach(function(b){ var o=document.createElement('option'); o.value=b.name; o.textContent=b.name+(b.connected?' (online)':' (offline)'); o.disabled=!b.connected; sel.appendChild(o); });
      sel.value=keep;
      out.textContent=d.browsers.length? (d.paused?'Driving is paused in the extension (Stop driving). Resume it to try the buttons.':'Ready. Pick a tab, then press a button.') : 'No browser is paired to this account yet.';
      if(d.browsers.some(function(b){return b.connected;})) return tabs();
    }).catch(function(){ out.textContent='Error: could not reach the relay.'; });
  }
  document.querySelectorAll('[data-action]').forEach(function(b){
    b.addEventListener('click',function(){ var a=b.getAttribute('data-action'); if(!tab.value){ out.textContent='Pick a tab first (open a website in your browser, then Refresh).'; return; } run(a).then(function(d){show(a,d);}).catch(function(){ out.textContent='Error: could not reach the relay.'; }); });
  });
  document.getElementById('refresh').addEventListener('click',status);
  sel.addEventListener('change',tabs);
  status();
})();
</script>`;
}
