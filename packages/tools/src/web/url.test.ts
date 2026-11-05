import { describe, expect, it } from 'vitest';
import { checkAddress, checkHostname, embeddedIPv4 } from './ip-policy.js';
import { canonicalizeUrl, parsePublicUrl } from './url.js';

const rejection = (raw: string) => {
  const result = parsePublicUrl(raw);
  return result.ok ? null : result.error.code;
};

describe('URL validation', () => {
  it('accepts public http and https URLs', () => {
    for (const url of [
      'https://example.com/',
      'http://example.com/a?b=c#d',
      'https://sub.example.org:8443/x',
      'https://93.184.215.14/',
      'https://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/',
      'https://xn--mnchen-3ya.de/', // IDN
    ]) {
      expect(parsePublicUrl(url).ok, url).toBe(true);
    }
  });

  it('allows only http and https', () => {
    for (const url of [
      'file:///C:/Windows/win.ini',
      'ftp://example.com/',
      'javascript:alert(1)',
      'data:text/html,<script>1</script>',
      'gopher://example.com/',
      'ws://example.com/',
      'chrome://settings',
    ]) {
      expect(rejection(url), url).toBe('unsupported-protocol');
    }
  });

  it('rejects malformed, relative, overlong and credentialed URLs', () => {
    expect(rejection('')).toBe('invalid-url');
    expect(rejection('not a url')).toBe('invalid-url');
    expect(rejection('/relative/path')).toBe('invalid-url');
    expect(rejection(`https://example.com/${'a'.repeat(2100)}`)).toBe('too-long');
    expect(rejection('https://user:pass@example.com/')).toBe('credentials-not-allowed');
    expect(rejection('https://user@example.com/')).toBe('credentials-not-allowed');
  });

  it('rejects unusual ports', () => {
    expect(rejection('http://example.com:22/')).toBe('blocked-port');
    expect(rejection('http://example.com:6379/')).toBe('blocked-port');
    expect(parsePublicUrl('http://example.com:80/').ok).toBe(true);
  });

  it('resolves relative redirects against a base', () => {
    const result = parsePublicUrl('/next?x=1', 'https://example.com/a/b');
    expect(result.ok && result.value.href).toBe('https://example.com/next?x=1');
  });
});

describe('SSRF protection: hosts and literal addresses', () => {
  it('blocks localhost names and internal domains', () => {
    for (const url of [
      'http://localhost/',
      'http://LOCALHOST./',
      'http://app.localhost/',
      'http://printer.local/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://metadata/',
      'http://intranet/', // single-label name
      'http://router.home.arpa/',
      'http://db.svc.cluster.local/',
    ]) {
      expect(rejection(url), url).toBe('blocked-host');
    }
  });

  it('blocks loopback, private, link-local and metadata IPv4 in every notation', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://127.1/', // short form
      'http://2130706433/', // decimal
      'http://0x7f000001/', // hex
      'http://0177.0.0.1/', // octal
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', // AWS/GCP/Azure metadata
      'http://100.100.100.200/', // Alibaba metadata (CGNAT range)
      'http://168.63.129.16/', // Azure WireServer
      'http://224.0.0.1/',
      'http://255.255.255.255/',
    ]) {
      expect(rejection(url), url).toBe('blocked-host');
    }
  });

  it('blocks loopback, unique-local, link-local and mapped IPv6', () => {
    for (const url of [
      'http://[::1]/',
      'http://[::]/',
      'http://[fe80::1]/',
      'http://[fd00:ec2::254]/', // AWS metadata over IPv6
      'http://[fc00::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[64:ff9b::a9fe:a9fe]/', // NAT64 of 169.254.169.254
      'http://[2002:7f00:1::]/', // 6to4 of 127.0.0.1
      'http://[ff02::1]/',
    ]) {
      expect(rejection(url), url).toBe('blocked-host');
    }
  });

  it('classifies resolved addresses (used for every DNS answer)', () => {
    expect(checkAddress('8.8.8.8')).toEqual({ allowed: true });
    expect(checkAddress('2606:4700:4700::1111')).toEqual({ allowed: true });
    expect(checkAddress('172.15.255.255')).toEqual({ allowed: true }); // just outside 172.16/12
    expect(checkAddress('172.32.0.1')).toEqual({ allowed: true });
    expect(checkAddress('127.0.0.1')).toMatchObject({ allowed: false, reason: 'loopback' });
    expect(checkAddress('169.254.169.254')).toMatchObject({ allowed: false });
    expect(checkAddress('::ffff:10.0.0.1')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('embedded in IPv6'),
    });
    expect(checkAddress('fe80::1%eth0')).toMatchObject({ allowed: false });
    expect(checkAddress('not-an-ip')).toMatchObject({ allowed: false });
  });

  it('extracts IPv4 addresses embedded in IPv6', () => {
    expect(embeddedIPv4('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(embeddedIPv4('64:ff9b::808:808')).toBe('8.8.8.8');
    expect(embeddedIPv4('2002:c0a8:101::')).toBe('192.168.1.1');
    expect(embeddedIPv4('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe('192.0.2.45'); // Teredo
    expect(embeddedIPv4('2606:4700::1111')).toBeUndefined();
  });

  it('host-name check allows normal public names', () => {
    expect(checkHostname('en.wikipedia.org')).toEqual({ allowed: true });
    expect(checkHostname('localhost')).toMatchObject({ allowed: false });
  });
});

describe('canonical URLs (duplicate detection)', () => {
  it('normalises case, default ports, fragments and trailing dots', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM:443/Path#section')).toBe(
      'https://example.com/Path',
    );
    expect(canonicalizeUrl('http://example.com.:80/')).toBe('http://example.com/');
  });

  it('drops tracking parameters and sorts the rest', () => {
    expect(
      canonicalizeUrl('https://ex.com/a?utm_source=x&b=2&fbclid=1&a=1&UTM_Medium=y&gclid=z'),
    ).toBe('https://ex.com/a?a=1&b=2');
    expect(canonicalizeUrl('https://ex.com/a?utm_source=x')).toBe('https://ex.com/a');
  });

  it('keeps meaningful differences', () => {
    expect(canonicalizeUrl('https://ex.com/a')).not.toBe(canonicalizeUrl('https://ex.com/a/'));
    expect(canonicalizeUrl('https://ex.com/a?id=1')).not.toBe(
      canonicalizeUrl('https://ex.com/a?id=2'),
    );
    expect(canonicalizeUrl('https://ex.com/a?x=1&x=2')).toBe('https://ex.com/a?x=1&x=2');
  });
});
