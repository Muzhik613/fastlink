// notifyHook.js — page MAIN world, for fast_watch {notifications:true} (actions/watch.js).
// Registered as a document_start content script on the origins that have a notify watch
// (apps such as Messages for web keep their own reference to Notification from startup, so
// a hook added after load never sees their calls), and injected once more when a watch starts.
// Wraps the two ways a page shows a notification so each call is also announced as a
// 'fastlink-notify' DOM event (detail = JSON string: a string crosses into the isolated
// world). The page's call is unchanged. Idempotent. Completion value: JSON {permission, early}.
(() => {
  const permission = (() => { try { return Notification.permission; } catch { return 'unsupported'; } })();
  if (!globalThis.__fastlinkNotifyHooked) {
    globalThis.__fastlinkNotifyEarly = document.readyState === 'loading';
    const announce = (via, title, opts) => {
      try {
        const o = opts && typeof opts === 'object' ? opts : {};
        let data = null;
        try { data = o.data === undefined ? null : JSON.parse(JSON.stringify(o.data)); } catch { data = null; }
        document.dispatchEvent(new CustomEvent('fastlink-notify', { detail: JSON.stringify({ via, title: String(title ?? ''), body: o.body == null ? null : String(o.body), tag: o.tag == null ? null : String(o.tag), timestamp: o.timestamp ?? null, data }) }));
      } catch { /* never break the page's notification */ }
    };
    try {
      const P = globalThis.ServiceWorkerRegistration?.prototype;
      if (P && typeof P.showNotification === 'function') {
        const orig = P.showNotification;
        P.showNotification = function showNotification(title, opts) { announce('showNotification', title, opts); return orig.apply(this, arguments); };
      }
    } catch { /* no service workers here */ }
    try {
      const N = globalThis.Notification;
      if (typeof N === 'function') {
        const Wrapped = function Notification(title, opts) { announce('Notification', title, opts); return new.target ? Reflect.construct(N, [title, opts], new.target) : N(title, opts); };
        Object.setPrototypeOf(Wrapped, N);
        Wrapped.prototype = N.prototype;
        globalThis.Notification = Wrapped;
      }
    } catch { /* leave Notification alone */ }
    globalThis.__fastlinkNotifyHooked = true;
  }
  return JSON.stringify({ permission, early: !!globalThis.__fastlinkNotifyEarly });
})();
