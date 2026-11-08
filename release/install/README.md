# Installing FastLink (self-updating policy install)

FastLink is installed by a browser **policy** that points Chrome at FastLink's own update
feed (`release/updates.xml`). Chrome installs it and updates it by itself about every
5 hours (or right away: `chrome://extensions` → Developer mode → **Update**).
Extension id: `ockcjadbkdfgfllidpcoamcepahfmlpf`.

| OS | Status | Installer |
|---|---|---|
| Linux (Google Chrome, Chromium deb/snap) | Works, tested 11-07 on Chromium 156 | `install-linux.sh` |
| Windows | **Pending decision.** Chrome honors a non-Web-Store force-install only on domain-joined or cloud-managed (CBCM) PCs | none yet |
| macOS | **Pending decision.** Same rule: MDM- or CBCM-managed Macs only | none yet |

## Linux

```sh
sudo sh install-linux.sh          # writes the policy for Chrome and Chromium
# fully quit and restart the browser
sudo sh install-linux.sh --remove # uninstall
```

It writes `fastlink.json` into `/etc/opt/chrome/policies/managed/`,
`/etc/chromium/policies/managed/` and `/etc/chromium-browser/policies/managed/`.
In a container, mount a directory holding that file at `/etc/chromium/policies/managed`
(read-only).

### Moving an existing unpacked install (keeps the pairing)

The unpacked copy and the policy copy have the same extension id, so the policy copy
inherits the unpacked copy's storage: relay pairing and browser name stay (tested 11-07:
unpacked → policy, storage intact).

1. Run the installer.
2. Stop loading the unpacked copy: drop `--load-extension=…` from the launcher, and in
   `chrome://extensions` do **not** press Remove on the unpacked card (Remove deletes the
   storage and the pairing). Just restart the browser without the flag.
3. Restart the browser. `chrome://extensions` shows FastLink "Installed by your
   administrator"; `fast_status` shows the browser connected on the feed's version.
   FastLink's welcome page opens once (Chrome counts it as a fresh install); it says
   "This browser is paired". Close it. (svm-ytx moved this way on 11-07.)
4. Delete the unpacked folder (it is no longer used).

If the pairing was lost anyway (for example the unpacked copy was removed first): revoke
the old browser entry, then pair again from FastLink's welcome page with a code from
https://relay.ytx.app/pair/new, using the same name.

Note: Chrome blocks DevTools on force-installed extensions by default
(`DeveloperToolsAvailability`). That doesn't affect FastLink's work; it only matters if you
want to debug the extension's service worker.

## Website "Install" page (text for the ytx site)

> **Install FastLink**
>
> FastLink connects Claude to your own Chrome. Install it once; it keeps itself up to date.
>
> **Linux**
> 1. Download [install-linux.sh](https://raw.githubusercontent.com/Muzhik613/fastlink/main/release/install/install-linux.sh) and run `sudo sh install-linux.sh`.
> 2. Fully quit Chrome and open it again. FastLink appears in the toolbar.
> 3. On FastLink's welcome page, enter a pairing code from https://relay.ytx.app/pair/new and name this browser.
>
> **Windows and Mac:** coming soon.
