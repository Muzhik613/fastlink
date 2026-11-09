// The relay approved a write for `expectOrigin` (per-site consent,
// gated on that exact tab). If the tab has since moved to another site, the
// write must not run there. Pure: `tabUrl(tabId)` is injected (chrome.tabs in
// the extension, a stub in tests).
//
// Returns { args } with expectOrigin stripped, or { error } to send back instead.
export async function checkExpectedSite(action, args, tabUrl) {
  if (!args || !('expectOrigin' in args)) return { args };
  const { expectOrigin, ...rest } = args;
  if (typeof expectOrigin !== 'string' || !expectOrigin || typeof rest.tabId !== 'number') return { args: rest };
  let now = '';
  try { now = new URL(await tabUrl(rest.tabId)).origin; } catch { /* closed / unreadable */ }
  if (now === expectOrigin) return { args: rest };
  return {
    args: rest,
    error: { error: `This tab is now on ${now || 'an unknown page'}, not ${expectOrigin}, so "${action}" was not run. Read the page again, then retry.`, siteChanged: true },
  };
}
