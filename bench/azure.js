// azure.js — the Azure portal cells, as DATA ONLY, same shape as suite.js / holdout*.js.
//
// ── NOT RUNNABLE YET — both cells carry `blocked` and run.js / score.js refuse them ──
// Azure was never scored before because of one fact (docs/ORACLE_BENCH_PROPOSAL.md §1): the
// portal renders its blades inside a CROSS-ORIGIN iframe (sandbox-N.reactblade.portal.azure.net),
// and every reader this harness had (fast_evaluate → evalIn) runs in the TOP frame only. The
// Create-VM Basics form lives in that iframe, so no field could be read back and every
// checkpoint would have been scored from vision, which the checkpoint contract forbids.
//
// These cells are written against a NARROW frame read-back owned by the extension side
// (`fast_frame_read`, see FRAME READ INTERFACE in bench/fastlink.js). Until that tool exists,
// `frameField` checkpoints return an error and score FAIL — they can never pass unearned.
// `blocked` is the enforced gate, not a convention: remove it ONLY after the METHOD RULE
// proof below has been done live.
//
// METHOD RULE PROOF OWED (the first live run, BEFORE deleting `blocked`). Every checkpoint must
// FAIL on an untouched page and PASS after the task is done BY HAND through local FastLink:
//   1. Open an untouched create form and read it with fast_frame_read. Record what Name,
//      Resource group, Region and Image read. The Region and Image DEFAULTS are the free-credit
//      risk (Azure pre-fills both): if the default Region is Japan East or the default Image
//      is Debian 12, the prompt must name different values.
//   2. Close the tab, reopen the create URL: confirm the form comes back untouched. If Azure
//      restores a previous run's draft (the aa.com localStorage lesson in fastlink.js
//      clearStorageFor), closing tabs is NOT a sufficient reset. Do NOT clearStorage
//      portal.azure.com without checking it — that origin holds the sign-in session.
//   3. Fill by hand; confirm each checkpoint passes. Then deliberately APPEND junk to the name
//      (the live failure below) and confirm the name checkpoint FAILS.
//   4. Confirm the per-tab URL trail records the portal's HASH navigations (#browse/all,
//      #create/…) — both cells score `trail` checkpoints on hash URLs.
//   5. Confirm the URL the portal moves to after Create. `DeploymentDetailsBlade` is the
//      historical shape, not a verified one. Verify it from a deployment the OWNER already
//      made or from Microsoft's docs — NEVER by clicking Create to see.
//
// Both cells need a SIGNED-IN Azure profile, so like gcpform and cfworkers they CANNOT run on the
// auth-free hvm rig. The profile's Azure account must be the one the owner benches against;
// as of 2026-09-16 `az` in WSL is signed in as yaakov@ytx.app, "Azure subscription 1".
//
// INSTALL SLOT: ALWAYS `--install secondary`, NEVER `primary`. Azure is signed in on Chrome
// Profile 6, whose stored fastlinkInstallId is `secondary`, and the live Azure run on 2026-09-16
// went through that slot. `primary` is a DIFFERENT profile that another session drives. Pointed
// there, the cell opens the portal in the wrong browser and either hits a login page or drives
// someone else's profile. run.js defaults --install to primary, so pass it explicitly:
//   node bench/run.js --client grok_runner --transport local --install secondary --test az_vmform
//   node bench/score.js az_vmform --install secondary

// The Basics-tab fields, by their visible label. Resource group / Region / Image are Fluent
// dropdowns in the blade; the read-back returns what the control SHOWS, not an internal id.
const AZ_VM_FIELDS = ['Virtual machine name', 'Resource group', 'Region', 'Image'];
const AZ_BLADE_FRAME = 'reactblade.portal.azure.net';
const AZ_CREATE_TAB = '#create/Microsoft.VirtualMachine';

// All resources, read from the TOP frame. Resource identity comes from ARM ids in hrefs
// (…/resource/subscriptions/<sub>/resourceGroups/<rg>/providers/<type>/<name>), never from
// hashed classes. UNVERIFIED which frame this grid renders in: if it is inside the reactblade
// iframe, `resources` reads [] on a populated account, `frames` says so, and this reader has to
// move to a frame read-back before the cell is unblocked. Do not guess — read it on the first
// live run. No field is named `value`/`result` (evalIn unwraps those).
const AZ_ALL_RESOURCES = `() => {
  const names = [];
  for (const a of document.querySelectorAll('a[href*="/resource/subscriptions/"]')) {
    // providers/<namespace>/<type>/<NAME>[/overview|/subtype/…]: the name is the 3rd segment, so a
    // blade suffix like /overview is never mistaken for a resource.
    const m = (a.getAttribute('href') || '').match(/\\/resourceGroups\\/[^/]+\\/providers\\/[^/]+\\/[^/]+\\/([^/?#]+)/i);
    if (m && !names.includes(decodeURIComponent(m[1]))) names.push(decodeURIComponent(m[1]));
  }
  const frames = [...document.querySelectorAll('iframe')].map((f) => { try { return new URL(f.src).host; } catch { return ''; } });
  return {
    url: location.href,
    resources: names,
    firstResource: names[0] || '',
    lastResource: names[names.length - 1] || '',
    frames: [...new Set(frames.filter(Boolean))],
  };
}`;

export const AZURE = [
  {
    id: 'az_resources',
    name: 'Authed cloud portal list (Azure All resources)',
    purpose: 'A read of the heaviest authenticated console we have: hash-routed Fx shell, slow-hydrating virtualized grid, blades possibly in a cross-origin iframe. STRICTLY READ-ONLY.',
    // PENDING AN OWNER DECISION. As of 2026-09-16 the subscription is EMPTY: `az resource list`
    // and `az group list` both return []. The correct answer is then "no resources", which a
    // model can say without ever reading the page, so no checkpoint can fail on an untouched
    // page. Seeding one or two FREE resources (e.g. an empty VNet or NSG) would fix that, but it
    // changes the owner's account, so it is his call. Nobody creates them on his behalf.
    blocked: 'az_resources: the Azure subscription is empty (az resource list = []), so "no resources" passes without reading the page. Waiting on the owner to seed free resources. Also unverified: which frame the All resources grid renders in.',
    url: 'https://portal.azure.com/#browse/all',
    reset: { closeUrlPatterns: ['portal.azure.com'] },
    // READ-ONLY BY CONSTRUCTION. This runs against a REAL Azure account that can spend real
    // money. The task is navigate + read; the prompt says so explicitly. Nothing here creates,
    // starts, stops, deletes, tags or edits a resource. Do NOT add a mutating step to this test.
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://portal.azure.com/#browse/all , wait for the All resources list to load, and report the NAME, TYPE and RESOURCE GROUP of every resource listed, in the order shown. This is READ-ONLY: do NOT create, start, stop, delete, tag, move or change anything.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Azure portal', urlIncludes: 'portal.azure.com' },
      { kind: 'trail', name: 'reached the All resources view', urlIncludes: '#browse/all' },
      // An empty grid gives the live checkpoints nothing to read, so they FAIL rather than
      // crediting "none". That is why the cell is blocked, not a reason to weaken them.
      { kind: 'live', name: 'reported the FIRST resource the grid lists', tab: 'portal.azure.com', fn: AZ_ALL_RESOURCES, pick: 'firstResource' },
      { kind: 'live', name: 'reported the LAST resource the grid lists (a truncated read misses it)', tab: 'portal.azure.com', fn: AZ_ALL_RESOURCES, pick: 'lastResource' },
    ],
  },

  {
    id: 'az_vmform',
    name: 'Cross-origin iframe form (Azure Create VM Basics)',
    purpose: 'The hardest form we have: the whole Basics tab sits in a CROSS-ORIGIN iframe no DOM tool can read or reach, so writes go through coordinates and trusted typing, and every write is blind unless read back. Catches the live append bug (vision fill left "fastlink-bench-vmany validany valid" in the name box).',
    blocked: 'az_vmform: needs fast_frame_read (a read-back of field values inside the cross-origin reactblade iframe), which is not built yet. Until it is, no field checkpoint can be scored.',
    url: 'https://portal.azure.com/#create/Microsoft.VirtualMachine',
    // Every run must start from an UNTOUCHED form. Closing the create tab is the reset; whether
    // Azure restores a draft on reopen is METHOD RULE PROOF item 2 (header).
    reset: { closeUrlPatterns: [AZ_CREATE_TAB] },
    // NO PROVISIONING BY CONSTRUCTION. This runs against a REAL Azure subscription that can bill
    // the owner. The task fills the Basics tab and STOPS. The prompt forbids "Review + create" and
    // "Create". The Resource group is a NEW name via "Create new", which only stages a name in the
    // form: Azure creates nothing until a deployment is submitted. A cell that could spend the
    // owner's money is a defect. Do NOT add a step past the Basics tab.
    //
    // WHAT THE SCORER CAN AND CANNOT PROVE ABOUT THAT:
    //   • "Create" NOT clicked: provable. Create submits a deployment and the portal navigates away
    //     from #create/… to a deployment blade, so the URL TRAIL shows it (`trailNever` below).
    //   • "Review + create" NOT clicked: NOT provable. It switches tabs INSIDE the iframe and
    //     leaves the top-frame URL on #create/Microsoft.VirtualMachine. Only the PROMPT guards it.
    //     Review + create validates and does not provision on its own, but it puts the Create
    //     button one click away. Do not assume the trail check covers it.
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://portal.azure.com/#create/Microsoft.VirtualMachine and, on the Basics tab ONLY, set: Virtual machine name = fastlink-bench-vm (the box must contain exactly that, nothing appended), Resource group = a NEW resource group named fastlink-bench-rg (use "Create new"), Region = Japan East, Image = Debian 12 "Bookworm" - x64 Gen2. Do NOT click "Review + create", do NOT click "Create", and do NOT open any other tab of the wizard — this is a real Azure account and nothing may be provisioned. Then report what each of the four fields contains.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Create VM form', urlIncludes: AZ_CREATE_TAB },
      // EQUALS, never includes. The live failure: a vision fill APPENDED instead of replacing and
      // left "fastlink-bench-vmany validany valid". A contains-check scores that as a pass.
      // `equals` is strict String equality: no trimming or case folding. Untouched: "" → FAIL.
      { kind: 'frameField', name: 'VM name EQUALS fastlink-bench-vm (nothing appended)', tab: AZ_CREATE_TAB, frame: AZ_BLADE_FRAME, fields: AZ_VM_FIELDS, field: 'Virtual machine name', expect: { equals: 'fastlink-bench-vm' } },
      // Anchored both ends so appended junk fails. Azure shows a staged group as "(New) <name>".
      // Untouched: the account has no groups, so the dropdown is empty → FAIL.
      { kind: 'frameField', name: 'Resource group = (New) fastlink-bench-rg', tab: AZ_CREATE_TAB, frame: AZ_BLADE_FRAME, fields: AZ_VM_FIELDS, field: 'Resource group', expect: { regex: '^(\\(new\\)\\s*)?fastlink-bench-rg$' } },
      // Region and Image are PRE-FILLED by Azure. Japan East / Debian 12 are chosen because they
      // should not be the defaults. METHOD RULE PROOF item 1 must confirm that.
      { kind: 'frameField', name: 'Region = Japan East (Azure pre-fills a default)', tab: AZ_CREATE_TAB, frame: AZ_BLADE_FRAME, fields: AZ_VM_FIELDS, field: 'Region', expect: { regex: '^(\\(asia pacific\\)\\s*)?japan east$' } },
      { kind: 'frameField', name: 'Image = Debian 12 (Azure pre-fills Ubuntu)', tab: AZ_CREATE_TAB, frame: AZ_BLADE_FRAME, fields: AZ_VM_FIELDS, field: 'Image', expect: { regex: '^debian 12\\b' } },
      // The no-provisioning guard is folded into a checkpoint that ALSO needs real work (holdout2
      // rule), so an untouched page cannot score it. It proves Create only, NOT Review + create.
      { kind: 'frameField', name: 'Create NOT clicked (no deployment in the URL trail) and the name is still in the form', tab: AZ_CREATE_TAB, frame: AZ_BLADE_FRAME, fields: AZ_VM_FIELDS, field: 'Virtual machine name', expect: { equals: 'fastlink-bench-vm' }, trailNever: ['DeploymentDetailsBlade', 'Microsoft_Azure_Deployment'] },
    ],
  },
];
