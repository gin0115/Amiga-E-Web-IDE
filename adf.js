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

  // RDB-formatted 1MB hardfile: the A1200 boot scan reads the Rigid Disk
  // Block to find partitions — plain FFS-at-0 images are invisible to it.
  // Geometry: 64 cyls x 1 head x 32 sectors; cyl 0 = RDB, cyls 1-63 = FFS.
  global.buildHDF = function (files, volumeName) {
    var SECTORS = 32, CYLS = 64, RESERVED_CYLS = 1;
    var total = CYLS * SECTORS;                    // 2048 blocks = 1 MB
    var partBlocks = (CYLS - RESERVED_CYLS) * SECTORS;
    var vol = buildVolume(files, volumeName, partBlocks);

    var img = new Uint8Array(total * BSIZE);
    img.set(vol, RESERVED_CYLS * SECTORS * BSIZE);
    var dv = new DataView(img.buffer);
    var set32 = function (off, val) { dv.setUint32(off, val >>> 0, false); };
    var text = function (off, s) {
      for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
    };
    var bstr = function (off, s) {
      dv.setUint8(off, s.length);
      text(off + 1, s);
    };
    var rdbsum = function (base, longs) {
      set32(base + 8, 0);
      var sum = 0;
      for (var i = 0; i < longs; i++) sum = (sum + dv.getUint32(base + i * 4, false)) >>> 0;
      set32(base + 8, ((~sum) + 1) >>> 0);
    };

    // ---- RDSK (block 0) ----
    text(0, 'RDSK');
    set32(4, 64);              // size in longs
    set32(12, 7);              // hostID
    set32(16, BSIZE);
    set32(20, 0x17);           // flags: last drive/LUN/ID
    set32(24, 0xffffffff);     // no bad blocks
    set32(28, 1);              // partition list -> block 1
    set32(32, 0xffffffff);     // no fs headers
    set32(36, 0xffffffff);     // no drive init
    for (var r = 40; r < 64; r += 4) set32(r, 0xffffffff);
    set32(64, CYLS);
    set32(68, SECTORS);
    set32(72, 1);              // heads
    set32(76, 1);              // interleave
    set32(80, CYLS);           // park
    set32(128, 0);             // rdbBlocksLo
    set32(132, SECTORS - 1);   // rdbBlocksHi
    set32(136, RESERVED_CYLS); // loCylinder
    set32(140, CYLS - 1);      // hiCylinder
    set32(144, SECTORS);       // blocks per cylinder
    set32(152, 1);             // highRDSKBlock
    text(160, 'ECOMP   ');
    text(168, 'COMPILED DISK   ');
    text(184, '1.0 ');
    rdbsum(0, 64);

    // ---- PART (block 1) ----
    var P = BSIZE;
    text(P, 'PART');
    set32(P + 4, 64);
    set32(P + 12, 7);          // hostID
    set32(P + 16, 0xffffffff); // no next partition
    set32(P + 20, 0);          // flags: not bootable, do automount
    bstr(P + 36, 'ECOMP0');    // device name (volume name comes from FFS root)
    set32(P + 128, 16);        // DosEnvVec: table size
    set32(P + 132, BSIZE / 4); // longs per block
    set32(P + 140, 1);         // surfaces
    set32(P + 144, 1);         // sectors per block
    set32(P + 148, SECTORS);   // blocks per track
    set32(P + 152, 2);         // reserved blocks
    set32(P + 164, RESERVED_CYLS);  // lowCyl
    set32(P + 168, CYLS - 1);  // highCyl
    set32(P + 172, 30);        // buffers
    set32(P + 180, 0x00ffffff);// maxTransfer
    set32(P + 184, 0x7ffffffe);// mask
    set32(P + 188, 0);         // boot priority
    set32(P + 192, 0x444f5301);// dosType DOS\1 (FFS)
    rdbsum(P, 64);

    return img;
  };
})(window);
