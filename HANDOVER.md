# amiga-ide — Handover

**Updated:** 2026-06-10 (end of the big build session)
**Location:** `/media/glynn/2024/devilbox_public/ai-detective/amiga-ide/`
**Served at:** `http://ai-detective.gq/amiga-ide/` (devilbox, via symlink `htdocs/amiga-ide -> ../amiga-ide`)
**Serving rule:** devilbox/Docker serves the working tree directly. Do NOT run
`python -m http.server`. `.htaccess` sets no-cache for html/js/css — stale
pages cost several debugging rounds before that existed.
**Repos (both GPL-3.0, user merges PRs):**
- IDE: `git@github.com:gin0115/Amiga-E-Web-IDE.git`
- Compiler: `git@github.com:gin0115/Amiga-E-Compiler-WebBased.git` (submodule at `ecomp/`)

---

## 1. What this is now — the goal was ACHIEVED

Browser IDE for Amiga E: editor → **ecomp compiles in-browser in ~20ms**
(pure JS, no WASM needed, validated 115/115 byte-identical against Wouter van
Oortmerssen's original compiler) → binary wrapped into a disk image **in
memory** → runs on SAE (emulated A1200, real Kickstart 3.1).

The original two-emulator/"real EC in a build-box" architecture is **dead**
— ecomp replaced it. Serial/ZMODEM transfer is **deleted** (user: never
again). `work.hdf` (which existed to carry EC) is retired.

E language + v40 modules © Wouter van Oortmerssen (strlen.com — he's the
creator of E; the original is now GPL per strlen.com/amiga-e/). His
permission is granted and credited everywhere, including inside every
compiled binary.

## 2. Run modes / delivery (all in-memory, no prompts)

| Mode | Mechanism | Notes |
|---|---|---|
| Compile & Run (DOS) | ecomp `bootableAdf` (OFS, bootable) → DF0 → reboot | auto-runs, console output visible |
| Compile & Run (WB) → floppy | their `buildADF` (FFS, array of `{name, bytes}`!) → hot-mount DF3 | instant, into the RUNNING WB |
| Compile & Run (WB) → HDD | `buildHDF` — RDB (RDSK+PART, checksummed) + FFS, IDE unit 0 | reboots; rdbtool/xdftool-validated |
| ⤓ .bin / ⤓ .adf | downloads | output name field = CLI `-o` |

WB deliveries include a real TOOL `.info` (borrowed from AProf in Wouter's
distro, position-neutralised) so programs are double-clickable icons.

## 3. The emulator (boot.js)

- **ONE SAE instance ever** — SAE keeps machine state in globals; a second
  `new ScriptedAmigaEmulator()` corrupts the event scheduler (runaway
  `current_hpos`, 100% CPU). Reboot = stop → **await the async 'stopped'
  hook** (else `SAEE_AlreadyRunning`=1) → reconfigure same cfg → start.
- `bootEmulator(images, settings)`: rom/df0–df3/hdf/hdf2 (unit 0/1),
  model/fastMB/hires/vdouble/ntsc/turboFloppy (speed=0 is CLAMPED safe)/audio.
- `mountADF(slot, bytes, name)` / `ejectADF` / `resetEmulator`.
- Plain hardfiles are INVISIBLE to the A1200 boot scan — RDB is mandatory.

## 4. Input capture (hard-won UX, user-dictated)

- **Pointer lock** (`cfg.video.cursor = 2`): click screen = mouse + keyboard
  captured, mouse physically cannot leave. Release = configurable safe key
  (default **End**; End/Home/PageUp/PageDown — none exist on Amiga keyboards).
- Esc breaks pointer lock (browser law). Windowed: the IDE **forwards that
  Esc to the Amiga** then waits for a re-click. **⛶ fullscreen** uses the
  Keyboard Lock API → Esc is fully captured for the Amiga.
- Keyboard gate (registered before SAE's document-level capture listeners):
  uncaptured → SAE deaf; IDE input focused → SAE deaf regardless.
- Mouse-out release: REMOVED. Hover-mouse mode: REMOVED. (User: "never never".)

## 5. UI

- Layout: editor | right card-stack (Build&Run / Compiler+output-name /
  Project files / Disk box / Emulator settings), full-width emulator below;
  draggable gutters; emulator canvas centred via parent (#emuHost gets inline
  px sizes from SAE), WB-grey while running; screen size 1×/1.5×/2×/fit via
  `transform: scale()` on #emuHost (NEVER style SAE's canvases individually).
- CodeMirror 5 vendored in `lib/codemirror/` (tracked), custom `amigae`
  simple-mode (nested `/* */` via push/pop, `->`, `$hex` `%bin`, case-classed
  idents). `editor` is a SHIM object over `cm`. Pixel-sized by ResizeObserver.
- Themes: dark/light/workbench/solarized via CSS vars + `[data-theme]`; ALL
  pass WCAG AA — run `node tools/contrast-audit.js` after ANY palette change.
- Disk box: IndexedDB (`diskbox.js`), categories rom/disk/hdf/bin/project,
  rename+descriptions, per-item use/download/delete. ROMs keep real
  filenames; active ROM selectable. Drive chips DF0–DF2 open a disk picker
  (DF0 = boot disk); DF3 reserved for COMPILED.
- Projects: files+settings+output-name as `.project` JSON in the disk box.
- `about.html`: guides + clean screenshots (self-captured via injected
  html2canvas → user saves dialogs into `docs/img/`; NEVER reuse the user's
  annotated bug screenshots). Linked from header; Buy ROMs → Amiga Forever.

## 6. Example programs (dropdown)

fib / gfx / win / multi-file / oop / float, plus three real apps written
and playtested this session:
- **Game: Catch the Box** — mouse polling (`Mouse()`, `MouseX/Y`).
- **Game: Hangman** — VANILLAKEY keyboard, `MsgCode()`.
- **App: Todos** — REAL Intuition gadgets from `MODULE 'intuition/intuition'`
  (gadget/stringinfo/border/intuitext structs), string gadget + [Add][Wipe]
  buttons, `GADGETUP` + `MsgIaddr()` routing, `RefreshGList` after clearing
  the stringinfo, persistence to `RAM:todos.dat` (survives runs in WB mode
  since WB mode never reboots). Run via Compile & Run (WB).

## 7. Gotchas that cost real debugging time

- `IDCMP_VANILLAKEY = $200000`. `$400` is RAWKEY (scancode press/release
  pairs, +$80 on release). KeyTest harness (loop WaitIMessage + print
  class/code) is the diagnostic.
- `Box(x,y,x2,y2,0)` leaves APen=0 → following `TextF` is INVISIBLE.
  Always `Colour(1)` after clearing.
- `buildADF`/`buildHDF` take an **array** `[{name, bytes}]`, not a map.
- Programs run from the WB desktop need the wbmessage startup protocol —
  implemented in ecomp (compiler PR #2, merged). Desktop-run programs have
  NO console: `WriteF` is silently dropped (use windows, or run from Shell).
- `OpenW`'s 10th arg goes to `NewWindow.FirstGadget` — real gadgets work
  from E with zero compiler changes.
- The user's WB boot disk is stock; the old rig's `s/user-startup` (DH0
  assigns) was deleted from the ADF (`.bak` kept). Disk box may hold user
  copies under any name — boot-disk matching is by name heuristic or DF0 chip.
- JS→E source injection: escaping hell; prefer writing `main.e` to disk and
  generating the payload with `JSON.stringify` (twice). E string literals
  cannot contain raw newline bytes.

## 8. Open / next

- HDD delivery (RDB unit 0) not yet user-verified end-to-end live (floppy
  mode is the proven daily path).
- `prog.info` could set a default tool / console wrapper so `WriteF` output
  is visible from desktop launches.
- **amiga-e.com**: user owns it (Plesk + Namecheap DNS seen) — public
  hosting next. Repo is publish-clean (gitignore: roms/disks/vendor/build;
  modules tracked with permission; LICENSE GPL-3.0 + NOTICE).
- Compiler-side polish list lives in the ecomp memory/status notes
  (corpus unknown-member tail, Gadget() builtin, .m writer extras).
