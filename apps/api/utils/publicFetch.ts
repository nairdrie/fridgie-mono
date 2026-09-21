import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

export class PublicFetchError extends Error {
  constructor(readonly code: 'UNSAFE_URL' | 'FETCH_FAILED' | 'SOURCE_TOO_LARGE', message: string) {
    super(message);
  }
}

const privateV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) privateV4.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  specialV6.addSubnet(network, prefix, 'ipv6');
}

/** Deny local, mapped, multicast, documentation and transition destinations. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !privateV4.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
  return false;
}

export function publicUrl(raw: string, allowedHosts?: (host: string) => boolean): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new PublicFetchError('UNSAFE_URL', 'Use a complete public http or https link.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      (isIP(host) && !isPublicAddress(host)) || (allowedHosts && !allowedHosts(host))) {
    throw new PublicFetchError('UNSAFE_URL', 'That link is not a supported public web address.');
  }
  url.hash = '';
  return url;
}

export async function resolvePublicAddress(url: URL, lookup: (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]> = dnsLookup): Promise<LookupAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  // Reject mixed private/public DNS answers too. The selected address is then
  // pinned into the socket lookup, so the connection cannot resolve it again.
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new PublicFetchError('UNSAFE_URL', 'That link does not resolve to a public website.');
  }
  return addresses.find(({ family }) => family === 4) ?? addresses[0]!;
}

export interface PublicFetchOptions {
  maxBytes: number;
  timeoutMs: number;
  allowedHosts?: (host: string) => boolean;
  headers?: Record<string, string>;
  maxRedirects?: number;
}
export interface PublicFetchResult { data: Buffer; headers: IncomingHttpHeaders; status: number; url: string }

function deadline<T>(task: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PublicFetchError('FETCH_FAILED', 'The website took too long to respond.')), Math.max(1, milliseconds));
    task.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Bounded reads, validated redirects, and a pinned public DNS answer per hop. */
export async function fetchPublicUrl(raw: string, options: PublicFetchOptions): Promise<PublicFetchResult> {
  let url = publicUrl(raw, options.allowedHosts);
  let headers = { ...options.headers, 'Accept-Encoding': 'identity' };
  const expires = Date.now() + options.timeoutMs;
  for (let hop = 0; hop <= (options.maxRedirects ?? 5); hop += 1) {
    const address = await deadline(resolvePublicAddress(url), expires - Date.now());
    if (Date.now() >= expires) throw new PublicFetchError('FETCH_FAILED', 'The website took too long to respond.');
    const response = await new Promise<PublicFetchResult>((resolve, reject) => {
      const originalHost = url.hostname.replace(/^\[|\]$/g, '');
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
        protocol: url.protocol,
        hostname: address.address,
        port: url.protocol === 'https:' ? 443 : 80,
        path: url.pathname + url.search,
        headers: { ...headers, Host: url.host },
        // Connect to the checked IP directly: even runtimes with incomplete
        // custom-lookup support cannot re-resolve the hostname. SNI and normal
        // certificate verification still use the original website hostname.
        servername: isIP(originalHost) ? undefined : originalHost,
        agent: false,
      }, incoming => {
        incoming.on('error', reject);
        const status = incoming.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          resolve({ data: Buffer.alloc(0), headers: incoming.headers, status, url: url.href });
          incoming.destroy();
          return;
        }
        if (Number(incoming.headers['content-length']) > options.maxBytes) {
          incoming.destroy(new PublicFetchError('SOURCE_TOO_LARGE', 'That source is too large to import.'));
          return;
        }
        // We request identity; compressed content is not interpreted as HTML or
        // handed to ffmpeg. This also avoids decompression bombs.
        const encoding = incoming.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          incoming.destroy(new PublicFetchError('FETCH_FAILED', 'The website returned an unsupported response.'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) incoming.destroy(new PublicFetchError('SOURCE_TOO_LARGE', 'That source is too large to import.'));
          else chunks.push(chunk);
        });
        incoming.on('end', () => resolve({ data: Buffer.concat(chunks), headers: incoming.headers, status, url: url.href }));
      });
      const timer = setTimeout(() => request.destroy(new PublicFetchError('FETCH_FAILED', 'The website took too long to respond.')), Math.max(1, expires - Date.now()));
      request.on('error', reject);
      request.on('close', () => clearTimeout(timer));
      request.end();
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (!response.headers.location) throw new PublicFetchError('FETCH_FAILED', 'The website returned an incomplete redirect.');
    const next = publicUrl(new URL(response.headers.location, url).href, options.allowedHosts);
    if (next.origin !== url.origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['cookie', 'authorization'].includes(key.toLowerCase()))) as typeof headers;
    }
    url = next;
  }
  throw new PublicFetchError('FETCH_FAILED', 'That link redirected too many times.');
}
