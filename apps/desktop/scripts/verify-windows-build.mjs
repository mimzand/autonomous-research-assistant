#!/usr/bin/env node
/**
 * Read-only verification of a Windows build in apps/desktop/release/.
 *
 *   pnpm verify:win-build            (from the repository root)
 *   node scripts/verify-windows-build.mjs [--release=<dir>] [--json]
 *
 * Checks, without executing, modifying or installing anything:
 *   - the Electron fuses of win-unpacked/<exe>, read from the binary itself
 *     (the fuse wire after the sentinel) and cross-checked with the
 *     getCurrentFuseWire() API of the @electron/fuses copy that
 *     electron-builder already depends on (no new dependency, no npx);
 *   - the PE identity of the app executable (x64, ProductName, OriginalFilename);
 *   - the embedded ASAR integrity resource, and that its hash equals the
 *     SHA-256 of the packaged app.asar header;
 *   - the NSIS installer and the portable ZIP exist and are non-empty,
 *     with their SHA-256 checksums.
 *
 * Works on Windows, Linux and macOS (only reads files). Exit code 1 on failure.
 */
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeSync,
  openSync,
  closeSync,
  ftruncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const args = process.argv.slice(2);
const releaseDir = resolve(
  args.find((a) => a.startsWith('--release='))?.slice('--release='.length) ??
    join(appDir, 'release'),
);
const asJson = args.includes('--json');

const PRODUCT_NAME = 'Autonomous Research Assistant';
const EXE_NAME = `${PRODUCT_NAME}.exe`;

/** Fuse wire V1, in wire order (from @electron/fuses FuseV1Options). */
const FUSES = [
  'RunAsNode',
  'EnableCookieEncryption',
  'EnableNodeOptionsEnvironmentVariable',
  'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation',
  'OnlyLoadAppFromAsar',
  'LoadBrowserProcessSpecificV8Snapshot',
  'GrantFileProtocolExtraPrivileges',
  // Newer than @electron/fuses 1.8.0 (which electron-builder 26 uses); Electron 44 has it.
  'WasmTrapHandlers',
];
/** Must match apps/desktop/electron-builder.yml `electronFuses` and docs/release.md. */
export const EXPECTED_FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
  // Not set in electron-builder.yml: Electron's default (enabled) is kept.
  WasmTrapHandlers: true,
};
const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const STATE = { 48: 'disabled', 49: 'enabled', 114: 'removed' };

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  if (!asJson) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/* ----------------------------- fuses ----------------------------- */

/** Reads the fuse wire directly from the binary (same algorithm as @electron/fuses). */
export function readFuseWire(buf) {
  const first = buf.indexOf(SENTINEL);
  if (first === -1) throw new Error('fuse sentinel not found (not an Electron >= 12 binary?)');
  if (buf.lastIndexOf(SENTINEL) !== first) throw new Error('more than one fuse sentinel');
  const pos = first + SENTINEL.length;
  const version = buf[pos];
  const length = buf[pos + 1];
  const fuses = {};
  for (let i = 0; i < length; i++) {
    const name = FUSES[i] ?? `Unknown${i}`;
    fuses[name] = STATE[buf[pos + 2 + i]] ?? `0x${buf[pos + 2 + i].toString(16)}`;
  }
  return { version, length, fuses };
}

/** @electron/fuses as installed for electron-builder (it is not a direct dependency). */
function loadFusesPackage() {
  try {
    const fromApp = createRequire(join(appDir, 'package.json'));
    const fromBuilder = createRequire(fromApp.resolve('electron-builder/package.json'));
    const fromLib = createRequire(fromBuilder.resolve('app-builder-lib/package.json'));
    const pkgPath = fromLib.resolve('@electron/fuses/package.json');
    const api = fromLib('@electron/fuses');
    return { api, version: JSON.parse(readFileSync(pkgPath, 'utf8')).version };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------ PE ------------------------------- */

function parsePe(buf) {
  if (buf.toString('latin1', 0, 2) !== 'MZ') throw new Error('not an MZ executable');
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('PE signature missing');
  const coff = pe + 4;
  const machine = buf.readUInt16LE(coff);
  const sections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const characteristics = buf.readUInt16LE(coff + 18);
  const opt = coff + 20;
  const magic = buf.readUInt16LE(opt);
  const dataDirs = opt + (magic === 0x20b ? 112 : 96);
  const resRva = buf.readUInt32LE(dataDirs + 2 * 8);
  const secTable = opt + optSize;
  const secs = [];
  for (let i = 0; i < sections; i++) {
    const s = secTable + i * 40;
    secs.push({
      name: buf.toString('latin1', s, s + 8).replace(/\0+$/, ''),
      vsize: buf.readUInt32LE(s + 8),
      rva: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      raw: buf.readUInt32LE(s + 20),
    });
  }
  const toOffset = (rva) => {
    const s = secs.find((x) => rva >= x.rva && rva < x.rva + Math.max(x.vsize, x.rawSize));
    return s ? rva - s.rva + s.raw : -1;
  };
  return { machine, magic, characteristics, resRva, secs, toOffset };
}

const MACHINES = { 0x14c: 'x86 (i386)', 0x8664: 'x64 (AMD64)', 0xaa64: 'arm64' };

/** Walks the resource tree; returns [{ type, name, lang, data: Buffer }]. */
function readResources(buf, pe) {
  const base = pe.toOffset(pe.resRva);
  if (!pe.resRva || base < 0) return [];
  const label = (field) =>
    field & 0x80000000
      ? (() => {
          const at = base + (field & 0x7fffffff);
          return buf.toString('utf16le', at + 2, at + 2 + buf.readUInt16LE(at) * 2);
        })()
      : field;
  const entries = (dirOff) => {
    const named = buf.readUInt16LE(dirOff + 12);
    const ids = buf.readUInt16LE(dirOff + 14);
    const out = [];
    for (let i = 0; i < named + ids; i++) {
      const e = dirOff + 16 + i * 8;
      out.push({ id: label(buf.readUInt32LE(e)), target: buf.readUInt32LE(e + 4) });
    }
    return out;
  };
  const out = [];
  for (const t of entries(base)) {
    if (!(t.target & 0x80000000)) continue;
    for (const n of entries(base + (t.target & 0x7fffffff))) {
      if (!(n.target & 0x80000000)) continue;
      for (const l of entries(base + (n.target & 0x7fffffff))) {
        if (l.target & 0x80000000) continue;
        const d = base + l.target;
        const off = pe.toOffset(buf.readUInt32LE(d));
        const size = buf.readUInt32LE(d + 4);
        if (off >= 0)
          out.push({ type: t.id, name: n.id, lang: l.id, data: buf.subarray(off, off + size) });
      }
    }
  }
  return out;
}

/**
 * Parses the StringFileInfo strings of the VS_VERSIONINFO resource (RT_VERSION = 16).
 * Each block: wLength, wValueLength (in WCHARs for text), wType, szKey, padding to
 * 4 bytes, value, padding, children.
 */
export function versionStrings(resources) {
  const ver = resources.find((r) => r.type === 16);
  const out = {};
  if (!ver) return out;
  const buf = ver.data;
  const align = (n) => (n + 3) & ~3;
  const walk = (start, end, depth) => {
    let off = start;
    while (off + 6 <= end) {
      const length = buf.readUInt16LE(off);
      if (length === 0) break;
      const valueLength = buf.readUInt16LE(off + 2);
      const type = buf.readUInt16LE(off + 4);
      let k = off + 6;
      while (k + 1 < off + length && buf.readUInt16LE(k) !== 0) k += 2;
      const key = buf.toString('utf16le', off + 6, k);
      const valueStart = align(k + 2);
      const valueBytes = type === 1 ? valueLength * 2 : valueLength;
      // depth: 0 VS_VERSIONINFO, 1 StringFileInfo, 2 language table, 3 String.
      if (depth === 3 && type === 1) {
        out[key] = buf.toString('utf16le', valueStart, valueStart + valueBytes).replace(/\0+$/, '');
      } else {
        walk(align(valueStart + valueBytes), off + length, depth + 1);
      }
      off = align(off + length);
    }
  };
  walk(0, buf.length, 0);
  return out;
}

/* ------------------------------ asar ----------------------------- */

/** The header string Electron hashes for ASAR integrity (pickle: size@12, string@16). */
function asarHeaderString(asarPath) {
  const buf = readFileSync(asarPath);
  const len = buf.readUInt32LE(12);
  return buf.subarray(16, 16 + len);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sha256File = (path) =>
  new Promise((ok, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('error', fail)
      .on('end', () => ok(hash.digest('hex')));
  });

/* ------------------------------ main ----------------------------- */

async function main() {
  const report = { releaseDir, fuses: null, exe: {}, integrity: [], artifacts: {} };
  const exePath = join(releaseDir, 'win-unpacked', EXE_NAME);
  check('win-unpacked executable exists', existsSync(exePath), exePath);
  if (!existsSync(exePath)) return finish(report);
  const exe = readFileSync(exePath);

  // Fuses: read from the binary, then cross-check with @electron/fuses.
  const wire = readFuseWire(exe);
  report.fuses = wire;
  check('fuse wire found', wire.version === 1, `version ${wire.version}, ${wire.length} fuses`);
  for (const [name, enabled] of Object.entries(EXPECTED_FUSES)) {
    const actual = wire.fuses[name];
    check(
      `fuse ${name}`,
      actual === (enabled ? 'enabled' : 'disabled'),
      `${actual} (expected ${enabled ? 'enabled' : 'disabled'})`,
    );
  }
  const pkg = loadFusesPackage();
  if (pkg.api) {
    const viaApi = await pkg.api.getCurrentFuseWire(exePath);
    const agree = FUSES.every((name, i) => {
      const s = viaApi[i];
      return (STATE[s] ?? String(s)) === wire.fuses[name];
    });
    report.fusesPackage = pkg.version;
    check(
      '@electron/fuses getCurrentFuseWire agrees',
      agree,
      `@electron/fuses ${pkg.version} (via electron-builder)`,
    );
  } else {
    check('@electron/fuses package resolvable', false, pkg.error);
  }

  // PE identity of the app executable.
  const pe = parsePe(exe);
  const res = readResources(exe, pe);
  const strings = versionStrings(res);
  const product = strings.ProductName;
  report.exe = {
    machine: MACHINES[pe.machine] ?? pe.machine,
    size: exe.length,
    versionInfo: strings,
  };
  if (!asJson) console.log(`      version info: ${JSON.stringify(strings)}`);
  check('app executable is x64', pe.machine === 0x8664 && pe.magic === 0x20b, report.exe.machine);
  check('app ProductName', product === PRODUCT_NAME, String(product));
  check('app InternalName', strings.InternalName === PRODUCT_NAME, String(strings.InternalName));
  check(
    'app FileVersion',
    /^\d+\.\d+\.\d+/.test(strings.FileVersion ?? ''),
    String(strings.FileVersion),
  );

  // ASAR integrity resource vs. the packaged app.asar.
  const integrity = res.filter(
    (r) => /integrity/i.test(String(r.type)) || /integrity/i.test(String(r.name)),
  );
  check(
    'ASAR integrity resource present',
    integrity.length === 1,
    integrity.map((r) => `${r.type}/${r.name}`).join(', ') || 'none',
  );
  if (integrity.length === 1) {
    let entries = [];
    try {
      entries = JSON.parse(integrity[0].data.toString('utf8'));
    } catch {
      check('ASAR integrity resource is JSON', false);
    }
    report.integrity = entries;
    for (const entry of entries) {
      const asarPath = join(releaseDir, 'win-unpacked', String(entry.file).replaceAll('\\', '/'));
      const actual = existsSync(asarPath) ? sha256(asarHeaderString(asarPath)) : 'missing';
      check(
        `integrity ${entry.file} ${entry.alg}`,
        entry.alg === 'SHA256' && actual === entry.value,
        `resource ${entry.value.slice(0, 16)}…, header ${actual.slice(0, 16)}…`,
      );
    }
    check(
      'integrity covers resources\\app.asar',
      entries.some((e) => e.file === 'resources\\app.asar'),
    );
  }

  // Installer and portable ZIP.
  const files = existsSync(releaseDir) ? readdirSync(releaseDir) : [];
  const setup = files.find((f) => /-win-x64-setup\.exe$/.test(f));
  const zip = files.find((f) => /-win-x64-portable\.zip$/.test(f));
  for (const [kind, name] of [
    ['installer', setup],
    ['portable ZIP', zip],
  ]) {
    const path = name ? join(releaseDir, name) : '';
    const size = name ? statSync(path).size : 0;
    check(
      `${kind} exists and is non-empty`,
      size > 0,
      name ? `${name} (${size} bytes)` : 'not found',
    );
    if (size > 0) report.artifacts[kind] = { file: name, size, sha256: await sha256File(path) };
  }
  if (setup) {
    const buf = readFileSync(join(releaseDir, setup));
    const spe = parsePe(buf);
    const sres = readResources(buf, spe);
    const sstrings = versionStrings(sres);
    const sproduct = sstrings.ProductName;
    report.artifacts.installer.versionInfo = sstrings;
    if (!asJson) console.log(`      installer version info: ${JSON.stringify(sstrings)}`);
    report.artifacts.installer.stub = MACHINES[spe.machine] ?? spe.machine;
    report.artifacts.installer.product = sproduct;
    // NSIS installer stubs are 32-bit by design; the payload decides the app architecture.
    check(
      'installer is a PE (NSIS stub)',
      spe.machine === 0x14c || spe.machine === 0x8664,
      report.artifacts.installer.stub,
    );
    check('installer ProductName', sproduct === PRODUCT_NAME, String(sproduct));
    const sevenZip = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    const archives =
      buf.indexOf(sevenZip) === -1
        ? 0
        : buf.indexOf(sevenZip) === buf.lastIndexOf(sevenZip)
          ? 1
          : 2;
    check(
      'installer embeds exactly one app payload (7z)',
      archives === 1,
      `${archives} archive(s)`,
    );
    if (archives === 1) comparePayload(buf, join(releaseDir, 'win-unpacked'));
  }
  if (zip) {
    const buf = readFileSync(join(releaseDir, zip));
    check('portable ZIP is a ZIP', buf.readUInt32LE(0) === 0x04034b50);
    check('portable ZIP contains the app executable', buf.includes(Buffer.from(EXE_NAME)));
  }
  return finish(report);
}

/** 7z variable-length NUMBER: returns [value, bytesUsed]. */
function read7zNumber(buf, at) {
  const first = buf[at];
  let mask = 0x80;
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if ((first & mask) === 0) {
      const high = first & (mask - 1);
      return [value + high * 2 ** (8 * i), i + 1];
    }
    value += buf[at + 1 + i] * 2 ** (8 * i);
    mask >>= 1;
  }
  return [value, 9];
}

/**
 * Locates the headers of the installer's embedded 7z payload, so they can be
 * written at their original offsets into a sparse file of the payload's length
 * (no file data is copied). Any 7-Zip can list such a file. Returns undefined
 * when the header is not the usual encoded (kEncodedHeader) form.
 */
export function payloadHeaderPieces(buf) {
  const start = buf.indexOf(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
  if (start === -1) return undefined;
  const nextOffset = Number(buf.readBigUInt64LE(start + 12));
  const nextSize = Number(buf.readBigUInt64LE(start + 20));
  const at = (offset, size) => buf.subarray(start + offset, start + offset + size);
  const next = at(32 + nextOffset, nextSize);
  if (next[0] !== 0x17 || next[1] !== 0x06) return undefined; // kEncodedHeader, kPackInfo
  const [packPos, posLen] = read7zNumber(next, 2);
  const [streams, nLen] = read7zNumber(next, 2 + posLen);
  if (streams !== 1 || next[2 + posLen + nLen] !== 0x09) return undefined; // one stream, kSize
  const [packSize] = read7zNumber(next, 3 + posLen + nLen);
  return {
    length: 32 + nextOffset + nextSize,
    pieces: [
      [0, at(0, 32)],
      [32 + packPos, at(32 + packPos, packSize)],
      [32 + nextOffset, next],
    ],
  };
}

/**
 * Lists the installer's 7z payload (headers carved into a temporary ~1 KB archive,
 * listed read-only with an existing 7-Zip) and compares every file's size and CRC32
 * with win-unpacked. Skipped when no 7-Zip is installed; nothing is extracted.
 */
export function comparePayload(setupBuf, unpackedDir) {
  const candidates = ['7z', '7za', '7zz', 'C:\\Program Files\\7-Zip\\7z.exe'];
  const tool = candidates.find((c) => spawnSync(c, ['i'], { stdio: 'ignore' }).status === 0);
  if (!tool) {
    if (!asJson)
      console.log('SKIP  installer payload == win-unpacked  — no 7-Zip installed (optional check)');
    return;
  }
  const carved = payloadHeaderPieces(setupBuf);
  if (!carved) {
    check('installer payload headers readable', false, 'unexpected 7z header layout');
    return;
  }
  const tmp = mkdtempSync(join(tmpdir(), 'rka-verify-'));
  const headersPath = join(tmp, 'payload-headers.7z');
  const fd = openSync(headersPath, 'w');
  for (const [offset, piece] of carved.pieces) writeSync(fd, piece, 0, piece.length, offset);
  ftruncateSync(fd, carved.length);
  closeSync(fd);
  const run = spawnSync(tool, ['l', '-slt', headersPath], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  rmSync(tmp, { recursive: true, force: true });
  const files = [];
  let entry = {};
  for (const line of `${run.stdout}\n`.split(/\r?\n/)) {
    const m = /^(Path|Size|CRC) = (.*)$/.exec(line);
    if (m) entry[m[1]] = m[2];
    if (line === '' && entry.Path) {
      if (entry.CRC) files.push(entry);
      entry = {};
    }
  }
  const payload = files;
  const bad = [];
  const listed = new Set();
  for (const f of payload) {
    const rel = f.Path.replaceAll('\\', '/');
    listed.add(rel);
    const path = join(unpackedDir, rel);
    if (!existsSync(path)) {
      bad.push(`${rel} missing`);
      continue;
    }
    const data = readFileSync(path);
    const crc = crc32(data).toString(16).toUpperCase().padStart(8, '0');
    if (crc !== f.CRC || String(data.length) !== f.Size) bad.push(rel);
  }
  const walk = (dir, prefix = '') =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
    );
  const extra = walk(unpackedDir).filter((f) => !listed.has(f));
  check(
    'installer payload == win-unpacked (size + CRC32)',
    payload.length > 0 && bad.length === 0 && extra.length === 0,
    `${payload.length} files, ${bad.length} different, ${extra.length} not in installer`,
  );
}

function finish(report) {
  const failed = results.filter((r) => !r.ok);
  if (asJson) console.log(JSON.stringify({ ...report, results }, null, 2));
  else {
    for (const [kind, a] of Object.entries(report.artifacts))
      console.log(`SHA-256 ${kind}: ${a.sha256}  ${a.file}`);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
