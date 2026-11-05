import { BlockList, isIP } from 'node:net';

/**
 * SSRF address policy. A fetch may only connect to globally routable unicast
 * addresses. Everything that can reach this machine, the local network or a
 * cloud provider's internal services is refused.
 */

export type AddressVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

type Range = readonly [network: string, prefix: number, reason: string];

/** One BlockList per range, so a match can report why it was refused. */
function compile(ranges: readonly Range[], type: 'ipv4' | 'ipv6') {
  return ranges.map(([net, prefix, reason]) => {
    const list = new BlockList();
    list.addSubnet(net, prefix, type);
    return { list, reason };
  });
}

const v4Ranges: readonly Range[] = [
  ['0.0.0.0', 8, 'unspecified ("this network")'],
  ['10.0.0.0', 8, 'private network'],
  ['100.64.0.0', 10, 'carrier-grade NAT (also cloud metadata, e.g. 100.100.100.200)'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (includes cloud metadata 169.254.169.254)'],
  ['172.16.0.0', 12, 'private network'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private network'],
  ['198.18.0.0', 15, 'benchmarking network'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved (includes broadcast)'],
];
const V4 = compile(v4Ranges, 'ipv4');

/** Public addresses that still serve cloud-internal endpoints. */
const V4_SPECIAL: Record<string, string> = {
  '168.63.129.16': 'cloud metadata (Azure WireServer)',
};

const v6Ranges: readonly Range[] = [
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['100::', 64, 'discard-only'],
  ['2001:db8::', 32, 'documentation'],
  ['fc00::', 7, 'unique local (includes AWS metadata fd00:ec2::254)'],
  ['fe80::', 10, 'link-local'],
  ['fec0::', 10, 'site-local (deprecated)'],
  ['ff00::', 8, 'multicast'],
];
const V6 = compile(v6Ranges, 'ipv6');

function v4Reason(ip: string): string | undefined {
  return V4_SPECIAL[ip] ?? V4.find(({ list }) => list.check(ip, 'ipv4'))?.reason;
}

/** Expands an IPv6 address to its 8 hextets. Input must already be a valid IPv6 literal. */
function hextets(ip: string): number[] {
  let text = ip.toLowerCase();
  // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1).
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((h) => parseInt(h, 16));
}

const toV4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** IPv4 address embedded in an IPv6 address by a translation mechanism, if any. */
export function embeddedIPv4(ip: string): string | undefined {
  const h = hextets(ip);
  if (h.length !== 8) return undefined;
  const [h0, h1, h2, h3, h4, h5, h6 = 0, h7 = 0] = h;
  const zeros = (...xs: (number | undefined)[]) => xs.every((x) => x === 0);
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d (deprecated).
  if (zeros(h0, h1, h2, h3, h4) && (h5 === 0xffff || h5 === 0)) return toV4(h6, h7);
  // IPv4-translated ::ffff:0:a.b.c.d
  if (zeros(h0, h1, h2, h3) && h4 === 0xffff && h5 === 0) return toV4(h6, h7);
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48.
  if (h0 === 0x64 && h1 === 0xff9b) return toV4(h6, h7);
  // 6to4 2002:AABB:CCDD::/48
  if (h0 === 0x2002 && h1 !== undefined && h2 !== undefined) return toV4(h1, h2);
  // Teredo 2001:0::/32 - client IPv4 is the bitwise inverse of the last 32 bits.
  if (h0 === 0x2001 && h1 === 0) return toV4(~h6 & 0xffff, ~h7 & 0xffff);
  return undefined;
}

/** Decides whether a resolved IP address may be connected to. */
export function checkAddress(address: string): AddressVerdict {
  const ip = address.replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // Strip brackets and zone id.
  const family = isIP(ip);
  if (family === 4) {
    const reason = v4Reason(ip);
    return reason ? { allowed: false, reason } : { allowed: true };
  }
  if (family === 6) {
    const blocked = V6.find(({ list }) => list.check(ip, 'ipv6'));
    if (blocked) return { allowed: false, reason: blocked.reason };
    const inner = embeddedIPv4(ip);
    if (inner !== undefined) {
      const verdict = checkAddress(inner);
      if (!verdict.allowed)
        return { allowed: false, reason: `${verdict.reason} (embedded in IPv6)` };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: 'not an IP address' };
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
]);
const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.home.arpa',
  '.corp',
  '.private',
  '.in-addr.arpa',
  '.ip6.arpa',
  '.svc',
  '.cluster.local',
];

/**
 * Refuses host names that point at this machine, the local network or cloud
 * metadata by convention. DNS answers are checked separately (see checkAddress),
 * so this is defence in depth, not the only control.
 */
export function checkHostname(hostname: string): AddressVerdict {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return { allowed: false, reason: 'empty host name' };
  if (isIP(host.replace(/^\[|\]$/g, ''))) return checkAddress(host);
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return { allowed: false, reason: `local or internal host name "${host}"` };
  }
  if (!host.includes('.')) {
    return { allowed: false, reason: `single-label host name "${host}" (local network)` };
  }
  return { allowed: true };
}
