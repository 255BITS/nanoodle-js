/*
 * qrModules — self-contained QR code generator (module matrix output).
 *
 * Derived from the "QR Code generator library" by Project Nayuki
 * (https://www.nayuki.io/page/qr-code-generator-library), trimmed to
 * byte mode + ECC level M + automatic mask selection. Algorithm unmodified.
 *
 * Copyright (c) Project Nayuki. (MIT License)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 */
export function qrModules(text) {
  // ---- UTF-8 encode the text into bytes ----
  var data = [];
  var enc = encodeURIComponent(text);
  for (var ei = 0; ei < enc.length; ei++) {
    var ch = enc.charAt(ei);
    if (ch === "%") { data.push(parseInt(enc.substr(ei + 1, 2), 16)); ei += 2; }
    else data.push(ch.charCodeAt(0));
  }

  // ---- Tables for ECC level M (index = version; index 0 unused) ----
  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function numDataCodewords(ver) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
  }

  // ---- Choose the smallest version that fits (byte mode) ----
  var version = -1;
  for (var v = 1; v <= 40; v++) {
    var used = 4 + (v < 10 ? 8 : 16) + data.length * 8;
    if (used <= numDataCodewords(v) * 8) { version = v; break; }
  }
  if (version < 0) throw new RangeError("Data too long");

  // ---- Bit buffer: mode + char count + data, terminator, padding ----
  var bb = [];
  function appendBits(val, len) {
    for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }
  appendBits(4, 4); // byte-mode indicator
  appendBits(data.length, version < 10 ? 8 : 16);
  for (var di = 0; di < data.length; di++) appendBits(data[di], 8);
  var capacityBits = numDataCodewords(version) * 8;
  appendBits(0, Math.min(4, capacityBits - bb.length));
  appendBits(0, (8 - bb.length % 8) % 8);
  for (var padByte = 0xEC; bb.length < capacityBits; padByte ^= 0xEC ^ 0x11)
    appendBits(padByte, 8);
  var dataCodewords = [];
  for (var ci = 0; ci * 8 < bb.length; ci++) dataCodewords.push(0);
  for (var bi = 0; bi < bb.length; bi++)
    dataCodewords[bi >>> 3] |= bb[bi] << (7 - (bi & 7));

  // ---- Reed-Solomon over GF(2^8/0x11D) ----
  function rsMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    var root = 1;
    for (var d = 0; d < degree; d++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }
  function rsRemainder(dat, divisor) {
    var result = divisor.map(function () { return 0; });
    for (var i = 0; i < dat.length; i++) {
      var factor = dat[i] ^ result.shift();
      result.push(0);
      for (var j = 0; j < divisor.length; j++)
        result[j] ^= rsMultiply(divisor[j], factor);
    }
    return result;
  }

  // ---- Split into blocks, append ECC, interleave ----
  var numBlocks = NUM_BLOCKS[version];
  var blockEccLen = ECC_PER_BLOCK[version];
  var rawCodewords = Math.floor(numRawDataModules(version) / 8);
  var numShortBlocks = numBlocks - rawCodewords % numBlocks;
  var shortBlockLen = Math.floor(rawCodewords / numBlocks);
  var blocks = [];
  var rsDiv = rsDivisor(blockEccLen);
  for (var b = 0, k = 0; b < numBlocks; b++) {
    var dat = dataCodewords.slice(k, k + shortBlockLen - blockEccLen + (b < numShortBlocks ? 0 : 1));
    k += dat.length;
    var ecc = rsRemainder(dat, rsDiv);
    if (b < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  var allCodewords = [];
  for (var p = 0; p < blocks[0].length; p++) {
    for (var q = 0; q < blocks.length; q++) {
      if (p != shortBlockLen - blockEccLen || q >= numShortBlocks)
        allCodewords.push(blocks[q][p]);
    }
  }

  // ---- Module grid ----
  var size = version * 4 + 17;
  var modules = [];
  var isFunction = [];
  for (var r = 0; r < size; r++) {
    var row = [], frow = [];
    for (var c = 0; c < size; c++) { row.push(false); frow.push(false); }
    modules.push(row);
    isFunction.push(frow);
  }

  function setFunctionModule(x, y, isDark) {
    modules[y][x] = isDark;
    isFunction[y][x] = true;
  }
  function getBitOf(x, i) {
    return ((x >>> i) & 1) != 0;
  }
  function drawFinderPattern(x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        var xx = x + dx, yy = y + dy;
        if (0 <= xx && xx < size && 0 <= yy && yy < size)
          setFunctionModule(xx, yy, dist != 2 && dist != 4);
      }
    }
  }
  function drawAlignmentPattern(x, y) {
    for (var dy = -2; dy <= 2; dy++) {
      for (var dx = -2; dx <= 2; dx++)
        setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) != 1);
    }
  }
  function alignmentPatternPositions() {
    if (version == 1) return [];
    var numAlign = Math.floor(version / 7) + 2;
    var step = (version == 32) ? 26 :
      Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var pos = size - 7; result.length < numAlign; pos -= step)
      result.splice(1, 0, pos);
    return result;
  }
  // ECC level M has formatBits = 0, so format data = mask alone.
  function drawFormatBits(mask) {
    var fdata = 0 << 3 | mask;
    var rem = fdata;
    for (var i = 0; i < 10; i++)
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = (fdata << 10 | rem) ^ 0x5412;
    for (var a = 0; a <= 5; a++)
      setFunctionModule(8, a, getBitOf(bits, a));
    setFunctionModule(8, 7, getBitOf(bits, 6));
    setFunctionModule(8, 8, getBitOf(bits, 7));
    setFunctionModule(7, 8, getBitOf(bits, 8));
    for (var i2 = 9; i2 < 15; i2++)
      setFunctionModule(14 - i2, 8, getBitOf(bits, i2));
    for (var i3 = 0; i3 < 8; i3++)
      setFunctionModule(size - 1 - i3, 8, getBitOf(bits, i3));
    for (var i4 = 8; i4 < 15; i4++)
      setFunctionModule(8, size - 15 + i4, getBitOf(bits, i4));
    setFunctionModule(8, size - 8, true); // always dark
  }
  function drawVersion() {
    if (version < 7) return;
    var rem = version;
    for (var i = 0; i < 12; i++)
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = version << 12 | rem;
    for (var j = 0; j < 18; j++) {
      var color = getBitOf(bits, j);
      var a = size - 11 + j % 3;
      var bpos = Math.floor(j / 3);
      setFunctionModule(a, bpos, color);
      setFunctionModule(bpos, a, color);
    }
  }
  function drawFunctionPatterns() {
    for (var i = 0; i < size; i++) {
      setFunctionModule(6, i, i % 2 == 0);
      setFunctionModule(i, 6, i % 2 == 0);
    }
    drawFinderPattern(3, 3);
    drawFinderPattern(size - 4, 3);
    drawFinderPattern(3, size - 4);
    var alignPatPos = alignmentPatternPositions();
    var numAlign = alignPatPos.length;
    for (var i5 = 0; i5 < numAlign; i5++) {
      for (var j = 0; j < numAlign; j++) {
        if (!(i5 == 0 && j == 0 || i5 == 0 && j == numAlign - 1 || i5 == numAlign - 1 && j == 0))
          drawAlignmentPattern(alignPatPos[i5], alignPatPos[j]);
      }
    }
    drawFormatBits(0); // dummy; overwritten after mask choice
    drawVersion();
  }
  function drawCodewords(cw) {
    var i = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right == 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) == 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFunction[y][x] && i < cw.length * 8) {
            modules[y][x] = getBitOf(cw[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }
  function applyMask(mask) {
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 == 0; break;
          case 1: invert = y % 2 == 0; break;
          case 2: invert = x % 3 == 0; break;
          case 3: invert = (x + y) % 3 == 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 == 0; break;
          case 5: invert = x * y % 2 + x * y % 3 == 0; break;
          case 6: invert = (x * y % 2 + x * y % 3) % 2 == 0; break;
          default: invert = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
        }
        if (!isFunction[y][x] && invert)
          modules[y][x] = !modules[y][x];
      }
    }
  }
  var PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;
  function finderPenaltyCountPatterns(runHistory) {
    var n = runHistory[1];
    var core = n > 0 && runHistory[2] == n && runHistory[3] == n * 3 && runHistory[4] == n && runHistory[5] == n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
      + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  }
  function finderPenaltyAddHistory(currentRunLength, runHistory) {
    if (runHistory[0] == 0) currentRunLength += size; // light border on initial run
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }
  function finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
    if (currentRunColor) {
      finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += size; // light border on final run
    finderPenaltyAddHistory(currentRunLength, runHistory);
    return finderPenaltyCountPatterns(runHistory);
  }
  function getPenaltyScore() {
    var result = 0;
    var x, y, runColor, run, runHistory;
    for (y = 0; y < size; y++) {
      runColor = false; run = 0; runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < size; x++) {
        if (modules[y][x] == runColor) {
          run++;
          if (run == 5) result += PENALTY_N1;
          else if (run > 5) result++;
        } else {
          finderPenaltyAddHistory(run, runHistory);
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = modules[y][x];
          run = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, run, runHistory) * PENALTY_N3;
    }
    for (x = 0; x < size; x++) {
      runColor = false; run = 0; runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < size; y++) {
        if (modules[y][x] == runColor) {
          run++;
          if (run == 5) result += PENALTY_N1;
          else if (run > 5) result++;
        } else {
          finderPenaltyAddHistory(run, runHistory);
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = modules[y][x];
          run = 1;
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, run, runHistory) * PENALTY_N3;
    }
    for (y = 0; y < size - 1; y++) {
      for (x = 0; x < size - 1; x++) {
        var color = modules[y][x];
        if (color == modules[y][x + 1] && color == modules[y + 1][x] && color == modules[y + 1][x + 1])
          result += PENALTY_N2;
      }
    }
    var dark = 0;
    for (y = 0; y < size; y++) {
      for (x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
      }
    }
    var total = size * size;
    var kk = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += kk * PENALTY_N4;
    return result;
  }

  // ---- Assemble: function patterns, codewords, best-of-8 mask ----
  drawFunctionPatterns();
  drawCodewords(allCodewords);
  var bestMask = 0;
  var minPenalty = Infinity;
  for (var m = 0; m < 8; m++) {
    applyMask(m);
    drawFormatBits(m);
    var penalty = getPenaltyScore();
    if (penalty < minPenalty) { bestMask = m; minPenalty = penalty; }
    applyMask(m); // undo (XOR)
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);

  return modules;
}

/**
 * Render a QR as terminal text using half-block characters (two module rows per
 * text line), with a 2-module quiet zone. Dark modules are "on" (background),
 * matching how phone cameras expect QR contrast on a dark terminal is inverted —
 * so this emits LIGHT blocks for light modules over the terminal default, which
 * scans reliably on both dark and light terminals.
 */
export function qrTerminal(text) {
  const m = qrModules(text);
  const size = m.length, border = 2, dim = size + border * 2;
  const at = (x, y) => x >= border && x < size + border && y >= border && y < size + border
    ? m[y - border][x - border] : false;
  const lines = [];
  for (let y = 0; y < dim; y += 2) {
    let line = "";
    for (let x = 0; x < dim; x++) {
      const top = at(x, y), bot = at(x, y + 1);
      // light modules are drawn (block chars), dark modules are terminal background
      line += top && bot ? " " : top ? "\u2584" : bot ? "\u2580" : "\u2588";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
