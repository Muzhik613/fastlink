# Uploading a new FastLink version to the Chrome Web Store

The dashboard can't be scripted, so a person does the upload. Paste-ready text is in `LISTING.md`.

**Zip for this release:** `/home/dev/code/Fastlink/fast-ext/dist/fastlink-0.4.32.zip`
(sha256 `646da865066ff3440d34541e64bd8397906ab8e4667298dfce0a6d90339a53d8`).
To rebuild it: `bash fast-ext/scripts/package.sh`.
- If the Chrome profile is on another machine, copy the zip there first.
- Example: `scp <this-host>:/home/dev/code/Fastlink/fast-ext/dist/fastlink-0.4.32.zip ~/Downloads/`.

## 0. Before you start (once per release)
- Check that https://fastlink.ytx.app/privacy shows **"Last updated: 2026-11-16"**. It must say what `fast-ext/store/PRIVACY-POLICY.md` says. If it still says 2026-11-09, publish the policy first.

## 1. Upload the package
1. In the **YTX** Chrome profile (yaakov@ytx.app), open https://chrome.google.com/webstore/devconsole.
2. Click **FastLink** in the item list.
3. In the left menu, click **Package**.
4. Top right, click **Upload new package**. Choose `fastlink-0.4.32.zip` and wait for the upload to finish.
   - **Check:** the draft shows **Version 0.4.32**.
   - If it is refused with "version must be greater", the store already has 0.4.32 or higher. Stop and report.
   - If it is refused with "key field not allowed", the wrong zip was picked: take the one from `dist/`, not a CRX build.

## 2. Store listing
1. In the left menu, click **Store listing**.
2. **Description:** replace the whole text with the "Detailed description" block from `LISTING.md` §2. It adds two bullets: file upload and hand-off.
3. Click **Save draft** (top right).

## 3. Privacy practices
1. In the left menu, click **Privacy** (labelled "Privacy practices" on some dashboards).
2. In the **debugger** justification box, replace the text with the `debugger` row from `LISTING.md` §3. It adds one sentence about hand-off.
3. Leave everything else unchanged:
   - Single purpose, other permissions, and "No remote code".
   - Data ticks: PII, Auth, Web history, Website content, User activity.
   - The three certifications and the privacy policy URL.
4. Click **Save draft**.

## 4. Submit
1. Click **Submit for review** (top right).
2. The dialog has "Publish automatically after it has passed review".
   - **Ticked** (default): users get 0.4.32 as soon as the review passes.
   - **Unticked**: the update waits for a manual **Publish** click after approval.
3. Click **Submit**.
   - **Check:** the status reads **Pending review**. Expect an in-depth review again because of `<all_urls>` and `debugger`.
4. While the review runs, the store keeps serving 0.4.14. Nothing changes for current users until it is approved.

## After approval
- Check the store page: https://chromewebstore.google.com/detail/eiifomohibgelcdhadklpmdnoblpalde. It should show Version 0.4.32.
- Store installs update within hours. To update right away: `chrome://extensions` → Developer mode → **Update**.
- In the "STATUS" block at the top of `LISTING.md`, record the version and date.

## Prompt for Claude in Chrome (alternative)
Run this in the YTX profile. Claude can't pick the file, so you choose the zip when the file dialog opens.
```
On https://chrome.google.com/webstore/devconsole, open the item "FastLink" (id eiifomohibgelcdhadklpmdnoblpalde).
1. Go to Package → "Upload new package". STOP and let me choose the file myself in the file dialog. Then confirm the draft shows version 0.4.32.
2. Go to Store listing. Replace the Description with the text I paste below (DESCRIPTION). Click Save draft.
3. Go to Privacy practices. Replace ONLY the "debugger" permission justification with the text below (DEBUGGER). Change nothing else. Click Save draft.
4. Do NOT click "Submit for review". Tell me when the drafts are saved, and I will submit myself.
DESCRIPTION: <paste LISTING.md §2 detailed description>
DEBUGGER: <paste LISTING.md §3 debugger row>
```
