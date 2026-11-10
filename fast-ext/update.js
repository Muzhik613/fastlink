// Opened (by fast_tab, or by hand) after new files land in an UNPACKED copy: an unpacked
// extension serves its pages straight from disk, so this runs the new code even while the
// old background is loaded, and chrome.runtime.reload() then loads the new version from disk
// (Chrome closes this tab with it). Storage, so the pairing, is kept.
setTimeout(() => chrome.runtime.reload(), 300);
