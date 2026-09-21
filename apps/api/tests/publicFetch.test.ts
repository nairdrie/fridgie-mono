import { describe, expect, test } from 'bun:test';
import { fetchPublicUrl, isPublicAddress, publicUrl, resolvePublicAddress } from '../utils/publicFetch';

describe('recipe fetch URL/address safety', () => {
  test('accepts routable IPv4/IPv6 and regular HTTP(S) URLs', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) expect(isPublicAddress(address)).toBe(true);
    expect(publicUrl('https://example.com/recipe#comments').href).toBe('https://example.com/recipe');
    expect(publicUrl('http://example.com:80/recipe').port).toBe('');
  });
  test('denies private, special and encoded IP addresses, schemes, ports, credentials', () => {
    for (const address of ['0.0.0.0', '127.0.0.1', '10.2.3.4', '172.31.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.10', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::127.0.0.1', '2002:7f00:1::', '2001:db8::1']) expect(isPublicAddress(address)).toBe(false);
    for (const url of ['file:///etc/passwd', 'ftp://example.com/file', 'https://user:password@example.com/', 'http://example.com:8080/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]/', 'http://localhost/', 'http://service.local/']) expect(() => publicUrl(url)).toThrow();
  });
  test('rejects DNS rebinding and mixed private/public answers before a socket opens', async () => {
    const target = publicUrl('https://example.com/');
    await expect(resolvePublicAddress(target, async () => [{ address: '127.0.0.1', family: 4 }])).rejects.toThrow('public website');
    await expect(resolvePublicAddress(target, async () => [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }])).rejects.toThrow('public website');
    const address = await resolvePublicAddress(target, async () => [{ address: '2606:4700::1111', family: 6 }, { address: '8.8.8.8', family: 4 }]);
    expect(address).toEqual({ address: '8.8.8.8', family: 4 });
  });
  test('redirect targets must satisfy the same URL and host policy', () => {
    const allowInstagram = (host: string) => host === 'www.instagram.com';
    expect(() => publicUrl(new URL('//127.0.0.1/secrets', 'https://www.instagram.com/').href, allowInstagram)).toThrow();
    expect(() => publicUrl('https://instagram.com.evil.test/reel/Test123/', allowInstagram)).toThrow();
    expect(() => publicUrl('https://www.instagram.com@evil.test/reel/Test123/', allowInstagram)).toThrow();
  });
  test('refuses a direct private-network request without touching the network', async () => {
    await expect(fetchPublicUrl('http://169.254.169.254/latest/meta-data/', { maxBytes: 1000, timeoutMs: 50 })).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });
});
