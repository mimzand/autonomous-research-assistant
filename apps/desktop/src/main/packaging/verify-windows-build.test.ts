/**
 * Phase 7.7.1: the read-only Windows build verifier (scripts/verify-windows-build.mjs).
 * Keeps its expected fuses in sync with electron-builder.yml and docs/release.md,
 * and checks the binary parsers on synthetic input (no Windows build needed).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../../../../..');
const scriptPath = join(repo, 'apps/desktop/scripts/verify-windows-build.mjs');

interface FuseWire {
  version: number;
  length: number;
  fuses: Record<string, string>;
}
interface HeaderPieces {
  length: number;
  pieces: [number, Buffer][];
}
interface Verifier {
  EXPECTED_FUSES: Record<string, boolean>;
  readFuseWire(buf: Buffer): FuseWire;
  payloadHeaderPieces(buf: Buffer): HeaderPieces | undefined;
}

const load = async (): Promise<Verifier> =>
  (await import(pathToFileURL(scriptPath).href)) as Verifier;

const SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX';
const wire = (states: number[]) =>
  Buffer.concat([
    Buffer.from('MZ padding '),
    Buffer.from(SENTINEL),
    Buffer.from([1, states.length, ...states]),
    Buffer.from(' trailer'),
  ]);

describe('verify-windows-build (Phase 7.7.1)', () => {
  it('expects exactly the fuses configured in electron-builder.yml', async () => {
    const { EXPECTED_FUSES } = await load();
    const config = readFileSync(join(repo, 'apps/desktop/electron-builder.yml'), 'utf8');
    const block = /^electronFuses:\r?\n((?:[ \t]+.*\r?\n)+)/m.exec(config)?.[1] ?? '';
    const configured = Object.fromEntries(
      [...block.matchAll(/^\s+(\w+):\s*(true|false)\s*$/gm)].map((m) => [
        (m[1] ?? '').replace(/^enable(?=[A-Z])/, 'Enable').replace(/^\w/, (c) => c.toUpperCase()),
        m[2] === 'true',
      ]),
    );
    expect(Object.keys(configured).length).toBeGreaterThanOrEqual(8);
    for (const [name, value] of Object.entries(configured)) {
      expect(EXPECTED_FUSES[name], name).toBe(value);
    }
    // The only expected fuse not set in the config keeps Electron's default (enabled).
    const unset = Object.keys(EXPECTED_FUSES).filter((name) => !(name in configured));
    expect(unset).toEqual(['WasmTrapHandlers']);
    expect(EXPECTED_FUSES['WasmTrapHandlers']).toBe(true);
  });

  it('reads the fuse wire after the sentinel', async () => {
    const { readFuseWire } = await load();
    const read = readFuseWire(wire([48, 49, 48, 48, 49, 49, 48, 49, 49]));
    expect(read.version).toBe(1);
    expect(read.length).toBe(9);
    expect(read.fuses).toEqual({
      RunAsNode: 'disabled',
      EnableCookieEncryption: 'enabled',
      EnableNodeOptionsEnvironmentVariable: 'disabled',
      EnableNodeCliInspectArguments: 'disabled',
      EnableEmbeddedAsarIntegrityValidation: 'enabled',
      OnlyLoadAppFromAsar: 'enabled',
      LoadBrowserProcessSpecificV8Snapshot: 'disabled',
      GrantFileProtocolExtraPrivileges: 'enabled',
      WasmTrapHandlers: 'enabled',
    });
    expect(readFuseWire(wire([48, 114])).fuses['EnableCookieEncryption']).toBe('removed');
  });

  it('refuses binaries without exactly one fuse sentinel', async () => {
    const { readFuseWire } = await load();
    expect(() => readFuseWire(Buffer.from('MZ no sentinel here'))).toThrow(/sentinel not found/);
    expect(() => readFuseWire(Buffer.concat([wire([48]), wire([49])]))).toThrow(/more than one/);
  });

  it('locates the 7z payload headers of an NSIS installer at their original offsets', async () => {
    const { payloadHeaderPieces } = await load();
    // kEncodedHeader, kPackInfo, packPos 1000 (2-byte 7z NUMBER 0x83 0xe8), one stream,
    // kSize 67, then the rest of the Phase 7.7 installer's encoded header.
    const packPos = 1000;
    const packSize = 67;
    const encoded = Buffer.from(
      '170683e8010943' + '00070b01000123030101055d002000000c9aba0a01f882b9300000',
      'hex',
    );
    const nextOffset = packPos + packSize;
    const start = Buffer.alloc(32);
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]).copy(start);
    start.writeBigUInt64LE(BigInt(nextOffset), 12);
    start.writeBigUInt64LE(BigInt(encoded.length), 20);
    // An installer stand-in: stub, start header, (file data), packed header, encoded header.
    const prefix = 500;
    const buf = Buffer.alloc(prefix + 32 + nextOffset + encoded.length + 10);
    buf.write('MZ');
    start.copy(buf, prefix);
    buf.fill(0x5a, prefix + 32 + packPos, prefix + 32 + packPos + packSize);
    encoded.copy(buf, prefix + 32 + nextOffset);

    const result = payloadHeaderPieces(buf);
    expect(result?.length).toBe(32 + nextOffset + encoded.length);
    expect(result?.pieces.map(([offset, piece]) => [offset, piece.length])).toEqual([
      [0, 32],
      [32 + packPos, packSize],
      [32 + nextOffset, encoded.length],
    ]);
    expect(result?.pieces[1]?.[1].every((b) => b === 0x5a)).toBe(true);
    expect(payloadHeaderPieces(Buffer.from('MZ no payload'))).toBeUndefined();
  });

  it('documents the verifier instead of an npx @electron/fuses command', () => {
    const release = readFileSync(join(repo, 'docs/release.md'), 'utf8');
    // Mentioned only to explain why it fails; never as a command line.
    expect(release).not.toMatch(/^\s*npx @electron\/fuses/m);
    expect(release).toContain('pnpm verify:win-build');
    const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(root.scripts['verify:win-build']).toContain('verify:win-build');
  });
});
