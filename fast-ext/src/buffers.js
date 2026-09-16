// In-flight network request tracking for fast_wait {networkIdle}. webRequest is
// the only source that sees every request type (fetch, XHR, image, beacon), and
// this counter is its single consumer since the console/network READ tools were
// deleted (they owned the ring buffers that used to live here).

const pendingNet = new Map();

export function pendingNetCount(tabId) {
  let n = 0;
  for (const rec of pendingNet.values()) if (rec.tabId === tabId) n++;
  return n;
}

export function startBufferListeners() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [reqId, rec] of pendingNet) {
      if (rec.tabId === tabId) pendingNet.delete(reqId);
    }
  });

  chrome.webRequest.onBeforeRequest.addListener(onNetStart, { urls: ['<all_urls>'] });
  chrome.webRequest.onCompleted.addListener(onNetEnd,    { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred.addListener(onNetEnd, { urls: ['<all_urls>'] });
}

function onNetStart(d) {
  if (d.tabId < 0) return;
  pendingNet.set(d.requestId, { tabId: d.tabId });
}

function onNetEnd(d) {
  pendingNet.delete(d.requestId);
}
