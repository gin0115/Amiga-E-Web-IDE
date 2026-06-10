// Minimal Amiga FFS (DOS\1) ADF writer.
//
// Builds an 880 KB DD floppy image (1760 x 512-byte blocks) containing a flat
// list of files in the root directory, then exposes window.buildADF(files, vol)
// -> Uint8Array, ready to hand to the SAE rig's mountADF().
//
// First cut, deliberately scoped:
//   * FFS only (DOS\1) — data blocks are raw 512 bytes (simpler/safer than OFS).
//   * flat root directory (no subdirs).
//   * each file up to 72 data blocks (~36 KB) — no file-extension blocks yet.
//   * non-bootable (a data disk you read from a Shell).
//
// Block formats follow the standard AmigaDOS layout (cf. adflib). BSIZE = 512.
(function (global) {
  'use strict';

  var BSIZE   = 512;
  var HT_SIZE = 72;            // standard hash table size
  var MAX_DBLK = (BSIZE / 4) - 56; // 72 data-block pointers per header

  // numBlocks: 1760 = DD floppy; larger = plain (non-RDB) hardfile, which
  // AmigaDOS treats as one big volume with the same FFS layout
  function buildVolume(files, volumeName, numBlocks) {
    files = files || [];
    volumeName = (volumeName || 'IDE').replace(/[^\x20-\x7e]/g, '').slice(0, 30) || 'IDE';
    var NBLOCKS = numBlocks || 1760;
    var ROOT = (2 + NBLOCKS - 1) >> 1;     // driver's midpoint calc (880 on a floppy)
    var BITMAP = ROOT + 1;
    if (NBLOCKS - 2 > 4064) throw new Error('volume too large for single bitmap block');

    var disk = new Uint8Array(NBLOCKS * BSIZE);      // zero-filled
    var dv = new DataView(disk.buffer);

    var set32 = function (off, val) { dv.setUint32(off, val >>> 0, false); };
    var get32 = function (off) { return dv.getUint32(off, false) >>> 0; };

    // -- block allocation -------------------------------------------------
    var used = {};
    used[0] = used[1] = true;          // bootblock (not in bitmap anyway)
    used[ROOT] = used[BITMAP] = true;
    var scan = 2;
    function alloc() {
      while (used[scan]) scan++;
      if (scan >= NBLOCKS) throw new Error('disk full');
      used[scan] = true;
      return scan++;
    }

    // -- standard block checksum (stored = two's complement of the sum) ---
    function checksum(blockBase, csumFieldOff) {
      set32(blockBase + csumFieldOff, 0);
      var sum = 0;
      for (var i = 0; i < BSIZE; i += 4) sum = (sum + get32(blockBase + i)) >>> 0;
      set32(blockBase + csumFieldOff, ((~sum) + 1) >>> 0);
    }

    // -- AmigaDOS filename hash (international mode OFF) -------------------
    function nameHash(name) {
      var h = name.length;
      for (var i = 0; i < name.length; i++) {
        var c = name.charCodeAt(i);
        if (c >= 97 && c <= 122) c -= 32; // toupper a-z
        h = (h * 13 + c) & 0x7ff;
      }
      return h % HT_SIZE;
    }

    function writeName(base, off, name) {
      var n = name.slice(0, 30);
      dv.setUint8(base + off, n.length);
      for (var i = 0; i < n.length; i++) dv.setUint8(base + off + 1 + i, n.charCodeAt(i) & 0xff);
    }

    // -- bootblock: just the FFS DOS type (non-bootable) -----------------
    dv.setUint8(0, 0x44); dv.setUint8(1, 0x4F); dv.setUint8(2, 0x53); dv.setUint8(3, 0x01); // 'DOS\1'
    set32(8, ROOT); // rootblock hint (harmless on a data disk)

    // -- root block -------------------------------------------------------
    var rootBase = ROOT * BSIZE;
    set32(rootBase + 0, 2);          // type = T_HEADER
    set32(rootBase + 12, HT_SIZE);   // hash table size
    set32(rootBase + 312, 0xFFFFFFFF); // bm_flag = valid
    set32(rootBase + 316, BITMAP);   // bm_pages[0]
    writeName(rootBase, 432, volumeName);
    set32(rootBase + 508, 1);        // secType = ST_ROOT

    // -- add files --------------------------------------------------------
    files.forEach(function (f) {
      var bytes = f.bytes instanceof Uint8Array ? f.bytes
                : (f.bytes ? new Uint8Array(f.bytes) : new Uint8Array(0));
      var name = String(f.name).split(/[\/:]/).pop().slice(0, 30) || 'file';
      var nData = Math.ceil(bytes.length / BSIZE);
      if (nData > MAX_DBLK) {
        throw new Error('"' + name + '" is ' + bytes.length +
          ' bytes; first-cut writer handles up to ' + (MAX_DBLK * BSIZE) + ' bytes/file');
      }

      var hdr = alloc();
      var hdrBase = hdr * BSIZE;

      // data blocks (FFS: raw bytes, no per-block header)
      var first = 0;
      for (var i = 0; i < nData; i++) {
        var b = alloc();
        if (i === 0) first = b;
        var srcStart = i * BSIZE;
        disk.set(bytes.subarray(srcStart, Math.min(srcStart + BSIZE, bytes.length)), b * BSIZE);
        // pointer table is filled from the END backwards: dataBlocks[i] -> slot (MAX-1-i)
        set32(hdrBase + 24 + (MAX_DBLK - 1 - i) * 4, b);
      }

      // file header block
      set32(hdrBase + 0, 2);           // type = T_HEADER
      set32(hdrBase + 4, hdr);         // header_key = own block
      set32(hdrBase + 8, nData);       // high_seq = # data block ptrs
      set32(hdrBase + 16, first);      // first_data
      set32(hdrBase + 324, bytes.length); // byte_size
      writeName(hdrBase, 432, name);
      set32(hdrBase + 500, ROOT);      // parent = root
      set32(hdrBase + 508, 0xFFFFFFFD); // secType = ST_FILE (-3)

      // link into the root hash table (chain on collision via nextSameHash@496)
      var slot = rootBase + 24 + nameHash(name) * 4;
      if (get32(slot) === 0) {
        set32(slot, hdr);
      } else {
        var cur = get32(slot);
        while (get32(cur * BSIZE + 496) !== 0) cur = get32(cur * BSIZE + 496);
        set32(cur * BSIZE + 496, hdr);
      }

      checksum(hdrBase, 20);
    });

    // -- bitmap block (1 = free, 0 = used; covers blocks 2..1759) ---------
    var bmBase = BITMAP * BSIZE;
    var nMapBlocks = NBLOCKS - 2;                  // 1758
    var nLongs = Math.ceil(nMapBlocks / 32);       // 55
    for (var L = 0; L < nLongs; L++) set32(bmBase + 4 + L * 4, 0xFFFFFFFF); // all free
    for (var blk in used) {
      blk = +blk;
      if (blk < 2) continue;                       // bootblock not represented
      var idx = blk - 2;
      var lo = bmBase + 4 + ((idx >> 5) * 4);
      set32(lo, get32(lo) & ~(1 << (idx & 31)));   // clear = used
    }
    checksum(bmBase, 0);

    // -- root checksum last (its hash table is now populated) -------------
    checksum(rootBase, 20);

    return disk;
  }

  global.buildADF = function (files, volumeName) {
    return buildVolume(files, volumeName, 1760);
  };
  // 1 MB plain hardfile (2048 blocks) — mounts via IDE as its own HD volume
  global.buildHDF = function (files, volumeName) {
    return buildVolume(files, volumeName, 2048);
  };
})(window);
