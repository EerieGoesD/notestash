# Platform + billing analysis prompt

Take a deep look at this app. Read the code and the features. Specifically check:
what the app's core job is, what device/context it's actually used in, and whether
it has any backend, server, network calls, accounts, or cloud sync. Also note the
tech stack and how cross-platform it already is - INCLUDING whether a browser
extension already exists in the repo or is a viable delivery target.

I want TWO things, and ONE clear recommendation per platform for each (not a survey):
  (1) Whether it's worth shipping on each new platform: iOS, iPadOS, macOS, tvOS,
      visionOS, Android, ChromeOS, Xbox, and as a browser extension (Chrome / Edge / Firefox).
  (2) The best billing model for each platform worth shipping on.

ALWAYS end your answer with a bottom-line table (see PART 3). No matter how long the
analysis runs, the final thing I see must be that table.

===========================================================================
BUDGET - READ THIS FIRST, IT OVERRIDES EVERYTHING BELOW
===========================================================================
This is a one-shot judgment task, not a research project. Obey all of these:

- DO NOT spawn subagents. Not one, not in parallel, not in the background. Do the
  whole thing yourself in this conversation.
- HARD CAP: 5 web lookups for the entire answer. If you want a 6th, stop and ask me.
- Read the code with targeted reads and greps. Do not read every file in the repo,
  do not read node_modules, build output, or lockfiles.
- Budget roughly: read the app, then answer. If you have been working for more than
  a few minutes without producing analysis, you have gone wrong - stop and answer
  from what you have.
- If you hit any budget limit, produce the answer anyway with what you know and mark
  the uncertain cells UNVERIFIED. A delivered answer with two soft spots beats a
  perfect answer I never see.
- Do not narrate your research plan. Do not list what you are about to check. Just
  read what you need and write the answer.

===========================================================================
STEP 0 - CAPABILITY GATE (do this before ANY web lookup)
===========================================================================
Read the app first. Then write a short CAPABILITY LIST: the privileged OS
capabilities the app actually depends on. Check for exactly these:

  background execution / background services · background clipboard monitoring ·
  global OS hotkeys · screen or region capture · microphone or camera ·
  accessibility APIs · arbitrary filesystem access beyond its own sandbox ·
  reaching into other running apps · always-on network or a server backend ·
  device pairing / sync between machines

For each, say "uses it" or "does not use it", citing the file and line where you
verified it. Most apps use NONE of these. A self-contained single-window GUI app
that reads and writes its own data files, uses ordinary copy/paste into focused
fields, and opens a native file picker uses none of them.

Then apply this gate:

- Capability list is EMPTY -> there is no sandbox question on any platform. Do ZERO
  platform-capability lookups. Every verdict below turns on form factor, audience,
  and built-in redundancy, which are judgment calls you make from the app plus what
  you already know. Say so in one line and go straight to PART 0.
- Capability list is NON-EMPTY -> look up ONLY the platforms where one of those
  capabilities is genuinely in doubt AND the answer would flip the verdict. One
  lookup per genuinely decisive question, within the 5-lookup cap.

The rule that decides every lookup: **if the fact cannot change a Yes to a No, do
not look it up.** Do not verify a restriction the app never touches.

===========================================================================
ACCEPTED PLATFORM PREMISES - TREAT AS GIVEN, DO NOT RE-VERIFY
===========================================================================
The following are my own stated premises. Use them as accepted background. Only
verify one if the app's capability list actually depends on it and it is decisive.

- **iPadOS** keeps a user-facing clipboard, has limited file access via the Files app
  and document providers, and can add a hardware keyboard, trackpad/pointer, Apple
  Pencil, and multi-window. It has NO general background utility services, NO global
  OS hotkeys outside the focused app, NO background clipboard monitoring, and NO
  arbitrary cross-app reach.
- **tvOS** has no user-facing clipboard, no general filesystem, no background utility
  services, no global hotkeys, no keyboard/pointer by default (Siri Remote or a paired
  game controller), tightly capped persistent local storage, and a shared 10-foot screen.
- **visionOS** runs many iPad apps in a compatibility mode. Input is eyes/hands/voice,
  with a virtual keyboard and support for a paired physical keyboard. Per-app sandbox,
  constrained background and cross-app reach. Tiny but high-income install base.
- **Xbox** apps ship as UWP through the same Microsoft Store / Partner Center account,
  in a restricted console sandbox: no user-facing clipboard, no general filesystem, no
  background utility services, no global hotkeys, controller-first input with no
  guaranteed keyboard or pointer, on a shared 10-foot TV. An existing Windows desktop
  build does NOT carry over - UWP must declare the Xbox device family and pass its own
  certification. (Check the app's own packaging manifest for its declared device family;
  that is a file read, not a web lookup.)
- **Browser extension (Manifest V3)** cannot touch other native apps, the filesystem
  beyond the downloads API, the mic in the background, or global OS hotkeys outside the
  browser. Background is a non-persistent service worker. Offscreen documents exist for
  DOM/WASM work. Remote code is banned by CSP. Screen reach is limited: captureVisibleTab
  and tabCapture see the tab, desktopCapture needs an explicit user pick, and none of it
  is silent arbitrary OS-screen access. Clipboard read/write needs a user gesture and a
  focused document.
- **Extension store billing is dead everywhere.** Chrome Web Store payments ended
  Feb 1 2021, Edge's paid path was tied to that same dead Chrome licensing API, and
  Firefox AMO never had one. Billing must be external: ExtensionPay, your own
  license-key / Stripe checkout, or a companion account.
- **ChromeOS** has no first-class native app format. Apps arrive only via (a) an Android
  app through Play, (b) a web app / PWA, (c) a Linux app via Crostini, (d) a browser
  extension through the Chrome Web Store.

If you believe one of these premises is now WRONG in a way that flips a verdict, that
is one of your 5 lookups - spend it and tell me what changed. Otherwise take them as read.

===========================================================================
PART 0 - CATEGORY-NATIVE CHANNELS (identify these FIRST)
===========================================================================
Work out the app's PRODUCT CATEGORY from the code and features, and the
marketplaces/channels that category actually sells through - its "home turf." The
enumerated list is CONSUMER-OS-centric; many categories sell primarily through
category-native marketplaces that are NOT on that list. If the consumer OS stores are
a poor category fit, the category-native channel is the real answer - surface it as a
FIRST-CLASS target, not a footnote, and do not force a Yes on a consumer store just
because it is on the list.

Keep this section SHORT. If the app is a mainstream consumer app whose home turf IS
the consumer OS stores, say that in two lines and move on. Do not walk the list below
looking for something exotic to say.

Most important sub-case - PLUGIN / EXTENSION that runs INSIDE a host application:
if the core job is an add-on for a host (a DAW, a browser, a design tool, an IDE, a
CMS, a game engine, an office suite), the HOST'S ecosystem is usually the primary
channel and the consumer OS stores are often a category MISMATCH. Identify the host,
its plugin formats, and its marketplace(s). Judge fit against the host, not the phone.

Category-native channels to check ONLY when the category actually matches (this list
is illustrative; name the one or two that fit and skip the rest):
- Audio / music plugins (VST3 / AU / AAX / CLAP): own site with a license key and a
  merchant-of-record checkout (Paddle / FastSpring / Lemon Squeezy) or Gumroad, Plugin
  Boutique, Splice, ADSR, KVR Marketplace. iOS/Android are usually a poor fit (AUv3 is
  the narrow exception).
- IDE / editor extensions: VS Code Marketplace / Open VSX, JetBrains Marketplace.
- Design-tool plugins: Figma Community, Adobe Exchange, Sketch.
- Web-platform add-ons: WordPress plugin directory, Shopify App Store.
- Game / 3D asset and mod channels: Steam Workshop, Unity Asset Store, Fab, Blender
  Market, itch.io.
- Direct / self-serve for any pro tool: own website with a license key and a
  merchant-of-record checkout - sidesteps every store cut, no built-in discovery.

For each channel you deem relevant, apply the SAME PART 1 fit+reach test and the SAME
PART 2 billing logic, and add a row in the PART 3 table.

===========================================================================
PART 1 - SHOULD THIS APP EXIST ON THAT PLATFORM?
===========================================================================
This is a PRODUCT question, not an engineering question. Ask: "does this kind of app
belong on that platform, and is there a real audience for it there?" - NOT "how hard
is it to build there."

Decide the verdict on FIT and REACH first, before any effort/cost talk:
1. Form-factor fit - the core use case genuinely makes sense on that platform
   (phone vs laptop vs desktop vs tablet vs inside-the-browser). Judge the use case,
   not the codebase.
2. Real audience - people on that platform actively seek out and use this kind of app.
   A crowded market of competitors is EVIDENCE OF DEMAND, not a reason to avoid it (it
   affects how you position/price, not whether it fits).
3. Not redundant - two separate checks, BOTH must pass:
   (a) It reaches users the platforms I already ship on don't.
   (b) The host (the OS, or the browser itself) does NOT already ship this exact
       feature built in. If the platform bundles the core feature for free (a built-in
       clipboard history, screen recorder, notes app, or a browser's built-in translate
       / reading mode / image-text copy), that is a REACH FAILURE - you are selling what
       the device already does. Call it out explicitly and treat it as a strong mark
       against shipping.

CRITICAL distinction - two different kinds of "hard," do not confuse them:
- The platform FORBIDS or cripples the core feature. Real FIT FAILURE -> No.
- The platform just needs a from-scratch rewrite in another framework. This is only a
  COST. It NEVER by itself turns a good fit+reach into a No. Report it as a heads-up;
  assume I'm willing to pay it if the product fit is there.

Effort rules:
- "Easy to build because the framework is cross-platform" is NOT a reason to port.
- "Hard to build because it needs a full rewrite" is NOT a reason to skip a platform
  that genuinely fits and has reach. Rewrite cost is a price tag, not a veto.
- Ongoing maintenance burden is real, worth a one-line mention, and does not override
  a genuine fit+reach pass.
- iOS: the $99/year Apple fee and review friction are COST, not fit. The fit verdict
  stands or falls on whether mobile suits the use case. Note separately whether iPadOS
  is a meaningfully better or worse fit than iPhone.
- iPadOS: judge it as its OWN tablet+keyboard context, NOT a bigger iPhone. Does a
  large touchscreen, often with a hardware keyboard, trackpad, Pencil, and multi-window,
  suit the core job better or worse than a phone or a laptop? Usually ships as the SAME
  universal binary as iOS, so marginal build cost is near zero - that is cost, not a veto.
- macOS: judge purely as "is Mac a real, distinct desktop audience for THIS category."
  Do NOT reason "a Windows build already does this job" (Mac users are different people)
  and do NOT let "it's a rewrite" count against it.
- tvOS: judge by whether a shared, 10-foot, remote-driven living-room context suits the
  core job - NOT whether iOS already covers it.
- visionOS: judge as its OWN spatial-computing audience. A tiny install base is a REACH
  caution affecting pricing and priority, NOT a fit failure; a blocked core capability IS
  a fit failure.
- Android: same fit/reach test. If already shipped, ask "is it worth continuing to
  invest in" on the same conditions.
- ChromeOS: judge fit by whether ANY of its four delivery paths lets the core feature
  work. Run redundancy 3(b) hard, because ChromeOS bundles a lot natively. A browser
  extension is often the STRONGEST ChromeOS path - cross-reference the Browser Extension
  verdict before ruling, and do not double-build. The form factor (keyboard laptop) is
  usually a good fit; the failure, if any, is the delivery path or built-in redundancy.
- Xbox: judge by whether a shared, 10-foot, controller-driven console context suits the
  core job - NOT whether the Windows build already does this job.
- Browser extension: treat as its OWN cross-OS delivery target. One MV3 codebase reaches
  Chrome, Edge, and (with minor tweaks) Firefox across Windows, macOS, Linux, and ChromeOS
  at once - count that breadth in its favor. Judge fit by whether the core job lives
  INSIDE the browser. If the core feature only needs what is on a web page or visible tab,
  it is a strong, cheap fit. If it fundamentally needs native apps, arbitrary OS screen
  regions, the filesystem, background mic, or global hotkeys, the extension is a CRIPPLED
  SUBSET, not a real substitute - say so plainly and call it a partial fit. Run redundancy
  3(b) hard against the browser's built-ins AND against my own products - an extension
  should reach a DIFFERENT context, not cannibalize a desktop app I already sell. If one
  already exists, ask "is it worth continuing to invest in, and worth expanding to Edge +
  Firefox," not "should it exist."
- Network effect: if the app pairs devices or moves data between them, shipping on both
  sides makes BOTH more useful. Count that in favor.

PART 1 output, per platform - keep each to about 4 lines, no padding:
- Ship it? Yes / No / Maybe - one or two lines, driven by fit + reach.
- Why: which fit/reach conditions it meets or fails. If No, say explicitly whether it's
  a real fit failure (the platform won't let the app do its job, or the host already
  ships the feature) or just not worth the reach - never a No that's secretly about
  rewrite difficulty.
- If No because of a fit failure: one line on whether a DIFFERENT product shape could
  serve that platform, flagged clearly as a separate product, not a port.
- Rough effort + maintenance note, reported as cost, separate from the verdict.

ALSO consider, ONE LINE EACH, and only if the category plausibly fits - skip anything
clearly irrelevant, do not pad:
Linux desktop (Snap / Flatpak) · Web app / PWA · Safari Web Extension (packaged in a
macOS or iOS app, App Store distribution, App Store billing) · alternative Android
stores (Amazon, Samsung Galaxy Store, Huawei AppGallery, F-Droid, sideload) · Setapp ·
off-store desktop (winget / Homebrew / notarized .dmg / MSIX / direct download) ·
Steam / itch.io · Meta Quest.

Architecture heads-up (NOT a fit driver): if a target needs a rewrite, one line on the
realistic shared-codebase options (Flutter, .NET MAUI, React Native, Kotlin / Compose
Multiplatform, Tauri, Electron, Qt, Capacitor). If cross-device sync is core, flag
whether a companion account or sync backend is required - that same backend is what
would satisfy subscription condition 1.

Then run PART 2 ONLY for platforms marked Yes/Maybe, plus the desktop store I already
ship on, plus the browser extension if it is an existing or recommended target.

===========================================================================
PART 2 - BILLING MODEL
===========================================================================
ONE clear recommendation per platform. The right model differs by store.

DESKTOP (Microsoft Store / Mac App Store): default to a one-time fee. Paid-upfront
works fine here. Price per store norms (Mac utility buyers tolerate higher prices than
the Microsoft Store).

MOBILE (Google Play + iOS): do NOT recommend paid-upfront - mobile discovery kills paid
downloads and Play has no "trial then pay" for one-time purchases. Default to: free app
with a limited free tier + a paywall selling a ONE-TIME lifetime unlock (non-consumable
IAP). Subscription only if a condition below genuinely holds, and even then offered
ALONGSIDE a one-time unlock. Never subscription-only.

IPADOS: bills identically to iOS. If it ships as a universal iPhone+iPad app, the SAME
purchase covers both - do not charge twice. Same default as mobile. A distinct iPad-only
tier ONLY if the iPad build adds materially more value (Pencil, multi-window work).

CHROMEOS: no billing of its own. Bill through whichever delivery path it ships on -
Android build follows the Play rules, web/PWA uses web billing or a license key,
extension follows the extension rules.

XBOX: bills through the Microsoft Store, so paid-upfront IS allowed (unlike Apple's
consoles). Default to a one-time fee at Microsoft Store norms. Free + limited tier +
one-time unlock is also fine if the app suits try-before-buy. If reach fails, mark n/a
rather than inventing a price.

BROWSER EXTENSION: billing must be EXTERNAL (see accepted premises). Default to: free
extension + a ONE-TIME lifetime unlock through an external processor. Price LOWER than
a desktop one-time - browser-utility buyers expect cheap or free. Give a concrete price
and say where the paywall sits.

TVOS / VISIONOS: App Store only, no paid-upfront. Default to free + limited tier +
ONE-TIME lifetime unlock. Guideline 3.1.2 applies identically. tvOS priced LOW (paid
utility buyers are rare there; if reach fails, mark n/a); visionOS priced like a Mac
utility or higher, small but high-income base.

Only recommend a subscription (any platform) if at least one is genuinely true:
1. Ongoing infrastructure cost - servers, hosted accounts, cloud sync, real per-user cost.
2. Professional / income-generating use - a tool people depend on to do paid work, not
   merely "usable at work."
3. Daily-habit use WITH volume - opened most days AND realistic install volume to make a
   low conversion rate pay off.

Judgment rules:
- A competitor charging a subscription is NOT proof it's right for me. High ratings and
  large review counts come mostly from free users rating whether the app works, not from
  happy subscribers. Never treat them as validation.
- The $99/year Apple fee is a fixed cost amortized across all sales; it does NOT justify
  a subscription. An external payment provider's cut is a transaction fee, not a recurring
  per-user cost.
- Apple guideline 3.1.2: subscriptions must deliver ongoing value. A subscription that
  just unlocks a static, finished feature set can be rejected at review; a one-time unlock
  is always safe.
- If none of the 3 hold, say so plainly: one-time on desktop, free + one-time lifetime
  unlock on mobile and in the browser extension.

PART 2 output, per shippable platform - keep it tight:
- Verdict, one or two lines.
- Which of the 3 conditions it meets or fails, briefly.
- Concrete prices + currency.
- Where the paywall sits on mobile AND in the extension: what free keeps vs what the
  unlock grants.
- Feature suggestions, BOTH, per platform:
  - Required: any feature the app MUST add to be viable there. If none, write
    "none - good as-is" and say why in one line.
  - Optional upsell: any feature that would justify the higher end of the range. If none
    needed, say so plainly.
  Do not invent filler. Only list a feature if it genuinely moves the price or the verdict.
- If you recommend a subscription: exactly what the app would need to add to justify it.

===========================================================================
PART 3 - BOTTOM LINE (ALWAYS REQUIRED, PUT IT LAST)
===========================================================================
End with a single bottom-line table. Mandatory even if the analysis is long and even if
some platforms are a No. Do not add commentary after the table - the table is last.

One row per platform (iOS, iPadOS, macOS, tvOS, visionOS, Android, ChromeOS, Xbox,
browser extension, plus the desktop store I already ship on, plus Web/PWA or Linux only
if covered above).

| Platform | Ship it? | Billing model | Price (currency) | Must-add features | One-line reason |

Rules:
- "Ship it?" matches the Part 1 verdict exactly.
- Billing and Price pull straight from Part 2. If a platform is a No, write "n/a" in
  both - do not invent a model for a platform you said not to ship on.
- Subscription AND one-time together go in the same cells
  (e.g. "Free + sub or lifetime unlock" / "$9.99/yr or $24.99 once").
- "Must-add features" pulls straight from the Required feature line in Part 2 - the
  thing the app MUST add to be viable there, in a few words. If nothing is needed, write
  "good as-is". If the platform is a No, write "n/a". Do not put optional upsells here.
- If a platform is already covered by another row (e.g. ChromeOS served by the browser
  extension), say so in the reason cell rather than inventing a separate build.
- Keep every cell to a short phrase.

Extra rows are REQUIRED, not optional. Beyond the main platform rows above, every
non-major channel you marked Yes or Maybe anywhere in the answer gets its own row, so I
can see at a glance where else this should be sold. That means:
- Any PART 0 category-native channel you deemed relevant. These can be the MAIN rows
  when the consumer OS stores are a category mismatch.
- Any alternative or off-store channel from the PART 1 one-liner list that passed:
  alternative Android stores (Amazon, Samsung Galaxy Store, Huawei AppGallery, F-Droid,
  sideload) · Setapp · off-store desktop (winget / Homebrew / notarized .dmg / MSIX /
  direct download from my own site) · Steam / itch.io · Meta Quest · Safari Web
  Extension · Linux (Snap / Flatpak) · Web app / PWA.
- Channels you considered and ruled out get NO row - keep them in the Part 1 one-liners.
- If you genuinely found no worthwhile channel beyond the major stores, add a single
  final row reading "Other stores | No | n/a | n/a | n/a | nothing beyond the majors is
  worth the listing upkeep" so I know you actually checked rather than forgot.

Nothing after the table. The table is the last thing in your answer.
