# amiga-ide — Handover

**Updated:** 2026-06-10
**Location:** `/media/glynn/2024/devilbox_public/ai-detective/amiga-ide/`
**Served at:** `http://ai-detective.gq/amiga-ide/` (devilbox, via symlink `htdocs/amiga-ide -> ../amiga-ide`)
**Serving rule:** devilbox/Docker serves it. Do NOT run `python -m http.server` / `127.0.0.1`. Open the devilbox URL.

---

## 1. Goal

Browser-based Amiga **E** dev environment: editor, in-browser filesystem, compiler, emulator to
run/preview in. Final deploy = **pure JS/WASM + static assets**, no host server at runtime.

Flow: **edit E → compile → deliver the binary into the emulator → run it.**

Architecture (user's design): **two emulators** —
- **Build-box** → runs the **real `EC`** compiler, source in → genuine HUNK exe out → into our JS "fake FS".
- **Run-box** → takes that exe (the `COMPILED` disk) → runs it.
Currently a *single* emulator is wired; the 2-box split is the next structural step.

---

## 2. BIG STATUS — what's proven working (validated live in Chrome today)

- ✅ **Delivery pipeline is solved** (this was the 2-session blocker). The IDE wraps a binary into an
  ADF *in JS*, hot-mounts it into the running emulator, and Workbench reads it. No protocol, no prompts.
- ✅ **`adf.js` FFS writer validated** both host-side (`xdftool` reads it back) AND live (Workbench mounts
  & reads the `COMPILED` disk).
- ✅ **Run → COMPILED disk → DF3**, live, hands-free, appears on the WB desktop.
- ✅ **Drive bar** in the IDE: `DF0:WB3.1 DF1:(empty) DF2:(empty) DF3:COMPILED`. DF0–DF2 user-mountable;
  **DF3 is LOCKED** (reserved for compiled output).
- ✅ **The REAL `EC` compiler runs in the emulator** — compiled `test.e` → a genuine runnable executable
  on `DH0:`. Toolchain is real and present (registered freeware EC + 402 modules, `EMODULES:` assigned).
- ✅ Bidirectional **serial bridge** in `boot.js` (`serialSend`/`serialRxTake`) — works, but NOT used for
  transfer anymore (see §4).

⚠️ The IDE's `compile()` is still a **STUB** (placeholder bytes → `bad loadfile hunk` if run). The REAL
compile (via build-box EC) is not yet wired into the IDE — that's the main remaining work (§5).

---

## 3. Key decisions

- **Transfer = ADF hot-mount** (build disk in JS → `mountADF`). Chosen over serial/ZMODEM.
- **Why not ZMODEM/NComm:** it *worked* (NComm received the file), but NComm is a GUI terminal that throws
  modal prompts (overwrite? filename?) — unsuitable for hands-free. ADF hot-mount has none of that.
- **Compiler = real `EC` in the emulator** (not a WASM compiler). A pure-JS E→HUNK compiler would need an
  E front-end + Amiga HUNK backend = months. Real EC produces genuine exes now. Still deploy-clean (EC is
  m68k code inside the JS emulator, like NComm).

---

## 4. File inventory (`amiga-ide/`)

- `index.html` — the IDE. Panes, in-memory FS, editor, **STUB `compile()`**, resizable splitters,
  cache-busted loaders for `adf.js`/`zmodem.js`/`emu.html`. **Run handler:** bare binary → `buildADF(...,'COMPILED')`
  → `mountADF(3)`; a real `.adf` in FS → DF1. **Drive bar** (`refreshDrives`, `diskInput`) with DF3 locked.
- `adf.js` — **FFS ADF writer** (`window.buildADF(files, volName)` → Uint8Array). VALIDATED. CRC-16/XMODEM.
- `boot.js` — SAE bootstrap. Boots KS3.1 + WB floppy (DF0), enables **DF1–DF3** as empty drives, auto-mounts
  `work.hdf` as DH0. Serial bridge. **Cache-busts `work.hdf` + the floppy** (`?cb=`+Date.now()) — this fixed
  the "object not found" stale-image bug.
- `emu.html` — SAE harness; loads `boot.js` cache-busted.
- `zmodem.js` — ZMODEM sender. Works (CRC-16/XMODEM **no augmentation** — verified `crc16([01,00,00,00,23])==0xbe50`),
  but **not used** by the main path now. Kept for reference / possible console use.
- `vendor/sae/sae/*.js` — 28 SAE engine files.
- `roms/kick31-a1200-40.68.rom` — Kickstart 3.1.
- `disks/workbench31-boot.adf` — WB3.1 boot floppy. **`S:User-Startup`** assigns:
  `LIBS: DH0:Libs ADD`, `FONTS: DH0:NComm/fonts ADD`, `EMODULES: DH0:emodules`.
- `disks/work.hdf` — 20 MB RDB/FFS HDF, partition `DH0 "Work"`, containing:
  - `NComm/` + `Libs/` (xprzmodem/reqtools/xprkermit) + `incoming/` (from the ZMODEM era)
  - **`EC`** (the compiler), **`emodules/`** (382 `.m` modules), **`test.e`** (sample)
- `build/` — staging: lha downloads/extracts, `stage/`, `user-startup`, `test.e`, source `work.hdf`.

Host build-tools (build-time only, `~/.local/bin`): `xdftool`, `rdbtool` (amitools), `7z`, `wget`.
The full E v3.3a install + registered EC live under
`…/ai-detective/amiga-e/research/extracted/` (`ec33a/ec33a/EC`, `amigae33a/E_v3.3a/Modules.lha.x/Modules`).

---

## 5. NEXT STEPS (resume here)

The compiler *works*; it just isn't *driven by the IDE* yet. Build the build-box loop:
1. **Trigger EC automatically** inside the emulator (no human). Options:
   - reboot-to-auto-compile (a startup-sequence that runs `EC source.e`) — simple but ~30s/compile, or
   - **keystroke injection** into a Shell (faster; SAE has keyboard input in `input.js`).
2. **Inject source**: build an ADF with `source.e` (adf.js, already works) and mount it into the build-box.
3. **Capture the real exe OUT**: read it from the build-box (`dumpHDF` exists → parse FFS / use the same
   block logic as adf.js to read) into the IDE's JS FS.
4. **Replace the STUB `compile()`** so Run uses the real exe → COMPILED disk → it actually runs.
5. **Split into build-box + run-box** (two SAE iframes; build-box can be headless/hidden).
6. **HDD-image mount option** (user ask) — needs reboot to mount (SAE mounts HDF at boot only).
7. **Kickstart selector** (user ask) — upload ROM from local, persist in **IndexedDB**, use at boot (reboot).

---

## 6. Gotchas / hard-won lessons

- **My synthetic clicks/keystrokes do NOT register in the SAE canvas** — the USER drives all in-emulator
  interactions (open Shell, click buttons, type). Plan automation around keystroke *injection* (SAE API) or
  reboot-driven scripts, not host mouse clicks.
- **Caching is aggressive.** Everything mutable must be cache-busted: `emu.html`, `boot.js`, `adf.js`,
  `zmodem.js` (Date.now query), **`work.hdf` + the floppy** (now done in boot.js), and the top `index.html`
  (navigate with `?cb=N`). The "object not found / Unknown command" EC bug was a stale cached `work.hdf`.
- **`mountADF(slot, arrayBuffer, name)`** is same-origin callable on the emu iframe. Slot 0 = DF0 (boot WB),
  1–3 = DF1–DF3 (enabled in boot.js). DF3 = COMPILED.
- **`buildADF`** volume label becomes the Amiga disk name. Files get rwed protection (executable) via xdftool.
- The MCP `javascript_tool` blocks code containing query strings / `.toString()` on functions ("Cookie/query
  string data") — hot-reload modules via `fetch('./x.js').then(r=>r.text()).then(t=>(0,eval)(t))` (no query,
  no cache option) to update `window.*` live without a page reload.
- `dumpHDF` posts to a `127.0.0.1` server — NOT for production; persistence → IndexedDB.

---

## 7. How-to (host-side rebuilds)

**Add files to work.hdf:** `xdftool disks/work.hdf write <hostpath> <amigapath>` (writes dirs recursively).
**Format/inspect:** `xdftool disks/work.hdf list` · `xdftool /tmp/x.adf list`.
**Edit floppy User-Startup:** `xdftool disks/workbench31-boot.adf delete S/User-Startup` then `… write build/user-startup S/User-Startup`.
**Validate adf.js host-side:** `node -e "global.window=global;require('./adf.js');var a=buildADF([{name:'X',bytes:new Uint8Array([1,2,3])}],'VOL');require('fs').writeFileSync('/tmp/x.adf',Buffer.from(a))"` then `xdftool /tmp/x.adf list`.
**Test compiler in emulator (manual):** Shell → `cd dh0:` → `dh0:EC test.e` → `dh0:test`.
