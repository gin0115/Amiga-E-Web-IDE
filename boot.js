// SAE bootstrap for the Amiga E Web IDE.
//
// Boots Kickstart + Workbench with images and machine settings supplied by
// the IDE (bootEmulator(images, settings)), exposes runtime disk control
// (mountADF/ejectADF) and reset. No serial/parallel bridges: delivery into
// the emulated system is done purely by disk images built in JS and
// hot-mounted (fast, clean, no prompts).

(function () {
  'use strict';

  var SAE_BASE = './vendor/sae/sae';
  var SAE_FILES = [
    'prototypes', 'utils', 'dms', 'config', 'roms', 'memory', 'autoconf',
    'expansion', 'events', 'gayle', 'ide', 'filesys', 'hardfile', 'dongle',
    'input', 'serpar', 'custom', 'blitter', 'copper', 'playfield', 'video',
    'audio', 'cia', 'disk', 'rtc', 'm68k', 'cpu', 'amiga',
  ];

  // mirrored SAE config constants (const-scoped inside config.js)
  var MODELS = { A500: 0, A500P: 1, A600: 2, A1000: 3, A1200: 5, A2000: 6, A3000: 7, A4000: 8 };
  var SAE_VIDEO_API_CANVAS = 0;
  var SAE_ERR_NONE = 0;
  var SAE_FLOPPY_DD = 1;

  var sae = null;
  var scriptsLoaded = false;
  var stopWaiters = [];

  // sae.stop() is asynchronous — the machine spins down and fires the
  // 'stopped' hook later. Starting before that yields SAEE_AlreadyRunning(1).
  function stopAndWait() {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      stopWaiters.push(finish);
      try { sae.stop(); } catch (e) { finish(); }
      setTimeout(finish, 3000);          // safety net
    });
  }

  function status(msg, isError) {
    (isError ? console.error : console.log)('[amiga-ide]', msg);
    if (window.onEmuStatus) window.onEmuStatus(msg, !!isError);
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.async = false;
      tag.onload = resolve;
      tag.onerror = function () { reject(new Error('SAE script failed: ' + src)); };
      document.head.appendChild(tag);
    });
  }

  async function loadSaeScripts() {
    if (scriptsLoaded) return;
    for (var i = 0; i < SAE_FILES.length; i++) {
      await loadScript(SAE_BASE + '/' + SAE_FILES[i] + '.js');
    }
    scriptsLoaded = true;
  }

  function computeCrc(buf) {
    var fn = globalThis.SAEF_crc32;
    if (typeof fn !== 'function') return 0;
    return fn(buf, 0, buf.byteLength) >>> 0;
  }

  // images: {rom: Uint8Array, df0: Uint8Array, df1?, df2?, df3?, hdf?, hdfName?}
  // settings: {model:'A1200', fastMB:2, hires:true, vdouble:true, ntsc:false}
  window.bootEmulator = async function bootEmulator(images, settings, hostId) {
    settings = settings || {};
    if (!images || !images.rom) { status('No Kickstart ROM provided.', true); return false; }
    if (!images.df0) { status('No boot disk (DF0) provided.', true); return false; }

    try {
      status('Loading SAE engine…');
      await loadSaeScripts();

      var ScriptedAmigaEmulator = globalThis.ScriptedAmigaEmulator;
      if (typeof ScriptedAmigaEmulator !== 'function') {
        throw new Error('SAE did not register ScriptedAmigaEmulator');
      }

      // SAE keeps machine state in globals — a second instance corrupts the
      // event scheduler (runaway current_hpos, 100% CPU). Create ONCE, then
      // stop/reconfigure/restart the same instance for every reboot.
      if (sae) {
        status('Stopping previous machine…');
        await stopAndWait();
      } else {
        var host = document.getElementById(hostId || 'emuHost');
        if (host) host.innerHTML = '';
        sae = new ScriptedAmigaEmulator();
      }
      var cfg = sae.getConfig();
      var model = MODELS[settings.model] !== undefined ? MODELS[settings.model] : MODELS.A1200;
      sae.setModel(model, null);

      cfg.memory.rom.name = 'kickstart.rom';
      cfg.memory.rom.data = images.rom;
      cfg.memory.rom.size = images.rom.byteLength;
      cfg.memory.rom.crc32 = computeCrc(images.rom);

      var fastMB = settings.fastMB != null ? settings.fastMB : 2;
      cfg.memory.z2FastSize = (fastMB | 0) << 20;

      // floppies: DF0 boot + DF1-DF3 present (DF3 reserved for COMPILED)
      cfg.floppy.drive[0].file.name = images.df0Name || 'boot.adf';
      cfg.floppy.drive[0].file.data = images.df0;
      cfg.floppy.drive[0].file.size = images.df0.byteLength;
      for (var d = 1; d <= 3; d++) {
        cfg.floppy.drive[d].type = SAE_FLOPPY_DD;
        var img = d === 1 ? images.df1 : d === 2 ? images.df2 : images.df3;
        if (img) {
          cfg.floppy.drive[d].file.name = 'df' + d + '.adf';
          cfg.floppy.drive[d].file.data = img;
          cfg.floppy.drive[d].file.size = img.byteLength;
        }
      }

      // hard disks via Gayle IDE (plain hardfiles mount as their own volumes)
      var hdfs = [];
      if (images.hdf) hdfs.push({ data: images.hdf, name: images.hdfName || 'work.hdf' });
      if (images.hdf2) hdfs.push({ data: images.hdf2, name: images.hdf2Name || 'compiled.hdf' });
      for (var u = 0; u < hdfs.length; u++) {
        if (!(cfg.mount && cfg.mount.config && cfg.mount.config[u])) break;
        if (typeof sae.setMountInfoDefaults === 'function') sae.setMountInfoDefaults(u);
        if (cfg.chipset && !cfg.chipset.ide) cfg.chipset.ide = 1;
        var ci = cfg.mount.config[u].ci;
        ci.controller_type = 1;     // mainboard IDE
        ci.controller_unit = u;
        ci.blocksize = 512;
        ci.file.name = hdfs[u].name;
        ci.file.data = hdfs[u].data;
        ci.file.size = hdfs[u].data.byteLength;
      }

      cfg.video.id = hostId || 'emuHost';
      cfg.video.enabled = true;
      cfg.video.api = SAE_VIDEO_API_CANVAS;
      cfg.video.hresolution = settings.hires === false ? 0 : 1;
      cfg.video.vresolution = settings.vdouble === false ? 0 : 1;
      var w = settings.hires === false ? 360 : 720;
      var h = settings.vdouble === false ? 284 : 568;
      cfg.video.size_win.width = w;
      cfg.video.size_win.height = h;
      if (cfg.video.size_fs) { cfg.video.size_fs.width = w; cfg.video.size_fs.height = h; }
      if (settings.ntsc != null && cfg.chipset) cfg.chipset.ntsc = !!settings.ntsc;
      if (settings.turboFloppy !== false && cfg.floppy) cfg.floppy.speed = 0;  // 0 = turbo
      if (cfg.audio) cfg.audio.enabled = settings.audio !== false;

      if (cfg.hook && cfg.hook.log) {
        cfg.hook.log.error = function (err, msg) { console.error('[SAE]', err, msg); };
      }
      if (cfg.hook && cfg.hook.event) {
        cfg.hook.event.started = function () { status('Running.'); };
        cfg.hook.event.stopped = function () {
          status('Stopped.');
          var w = stopWaiters; stopWaiters = [];
          w.forEach(function (f) { f(); });
        };
      }

      status('Starting emulator…');
      var err = sae.start();
      if (err === 1) {                   // SAEE_AlreadyRunning: one more spin-down
        await stopAndWait();
        err = sae.start();
      }
      if (err !== SAE_ERR_NONE && err !== undefined) {
        throw new Error('SAE start failed with code ' + err);
      }
      window.sae = sae;
      return true;
    } catch (e) {
      status(e.message || String(e), true);
      return false;
    }
  };

  // hot-mount a disk image into the running emulator (the delivery mechanism)
  window.mountADF = function mountADF(slot, bytes, name) {
    if (!sae) { status('Emulator not running.', true); return false; }
    var cfg = sae.getConfig();
    var drive = cfg.floppy && cfg.floppy.drive && cfg.floppy.drive[slot];
    if (!drive) { status('No floppy drive ' + slot, true); return false; }
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    drive.file.name = name || ('df' + slot + '.adf');
    drive.file.data = data;
    drive.file.size = data.byteLength;
    if (sae.insertFloppy) {
      try { sae.insertFloppy(slot, data, drive.file.name); } catch (e) { /* config path is enough */ }
    }
    status('Mounted ' + drive.file.name + ' in DF' + slot + ':');
    return true;
  };

  window.ejectADF = function ejectADF(slot) {
    if (!sae) return false;
    try { if (sae.ejectFloppy) sae.ejectFloppy(slot); } catch (e) { /* ok */ }
    var cfg = sae.getConfig();
    var drive = cfg.floppy && cfg.floppy.drive && cfg.floppy.drive[slot];
    if (drive) { drive.file.name = ''; drive.file.data = null; drive.file.size = 0; }
    status('Ejected DF' + slot + ':');
    return true;
  };

  window.resetEmulator = function resetEmulator(hard) {
    if (!sae) return false;
    try { sae.reset(hard !== false); status('Reset.'); return true; }
    catch (e) { status('Reset failed: ' + e.message, true); return false; }
  };

  window.stopEmulator = function stopEmulator() {
    if (!sae) return;
    try { sae.stop(); } catch (e) { /* ok */ }
    sae = null;
    window.sae = null;
  };
})();
