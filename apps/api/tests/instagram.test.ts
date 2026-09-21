import { describe, expect, test } from 'bun:test';
import { collectInstagramSource, instagramCaption, instagramLink, isInstagramMediaHost, isInstagramUrl, parseInstagramPage } from '../utils/instagram';
import type { fetchPublicUrl } from '../utils/publicFetch';

const url = 'https://www.instagram.com/reel/Fridgie_123/';
const fixture = await Bun.file(`${import.meta.dir}/fixtures/instagram-reel-page.html`).text();
const page = (body: unknown, extra = '') => `<html><head><link rel="canonical" href="${url}">${extra}</head><body><script type="application/json">${JSON.stringify(body)}</script></body></html>`;
const fetchResult = (html = fixture, status = 200, finalUrl = url): typeof fetchPublicUrl => async () => ({ data: Buffer.from(html), status, url: finalUrl, headers: { 'content-type': 'text/html' } });

describe('Instagram URLs', () => {
  test('normalizes direct, plural, creator, post, short-domain, and tracking forms', () => {
    for (const value of [url, 'http://instagram.com/reels/Fridgie_123/?igsh=abc&utm_source=share', 'https://m.instagram.com/reel/Fridgie_123/', 'https://www.instagram.com/fixture_cook/reel/Fridgie_123/', 'https://instagr.am/reel/Fridgie_123/']) {
      expect(instagramLink(value)?.url).toBe(url);
      expect(instagramLink(value)?.shortcode).toBe('Fridgie_123');
    }
    expect(instagramLink('https://www.instagram.com/p/Fridgie_123/')?.shortcode).toBe('Fridgie_123');
    expect(instagramLink('https://www.instagram.com/tv/Fridgie_123/')?.shortcode).toBe('Fridgie_123');
  });
  test('recognizes share tokens without pretending they are post IDs', () => {
    for (const path of ['share/reel/Token123', 'share/reels/Token123', 'share/p/Token123', 'share/Token123']) {
      expect(instagramLink(`https://www.instagram.com/${path}/?igsh=tracking`)).toEqual({ kind: 'share', shortcode: null, url: `https://www.instagram.com/${path}/` });
    }
  });
  test('rejects stories, profiles, invalid paths and host lookalikes', () => {
    for (const value of ['https://www.instagram.com/chef/', 'https://www.instagram.com/stories/chef/123456/', 'https://www.instagram.com/reel/', 'https://www.instagram.com/reel/valid123/comments/', 'https://instagram.com.evil.test/reel/valid123/', 'https://evilinstagram.com/reel/valid123/', 'file://instagram.com/reel/valid123/', 'https://user:pass@instagram.com/reel/valid123/']) expect(instagramLink(value)).toBeNull();
    expect(isInstagramUrl('https://instagram.com.evil.test/reel/valid123/')).toBe(false);
    expect(isInstagramMediaHost('scontent.cdninstagram.com')).toBe(true);
    expect(isInstagramMediaHost('cdninstagram.com.evil.test')).toBe(false);
  });
});

describe('Instagram page evidence', () => {
  test('reads public OpenGraph caption, escaped lines, creator, cover and video', () => {
    const source = parseInstagramPage(fixture, url)!;
    expect(source.caption).toBe('Lemon chickpeas\n1 can chickpeas\n2 tbsp lemon juice\nToss together. Serves 2.');
    expect(source.author).toBe('@fixture_cook');
    expect(source.canonicalUrl).toBe(url);
    expect(source.photoURL).toContain('scontent.cdninstagram.com/fixture.jpg');
    expect(source.videoUrl).toContain('video.cdninstagram.com/fixture.mp4');
    expect(source.cookieHeader).toBeNull();
    expect(source.transcript).toBe('');
  });
  test('parses exact-post GraphQL/Relay data without reading recommended posts', () => {
    const source = parseInstagramPage(page({ payload: { xdt_shortcode_media: {
      shortcode: 'Fridgie_123', owner: { username: 'fixture_cook' },
      edge_media_to_caption: { edges: [{ node: { text: '1 can beans\nWarm the beans.' } }] },
      video_url: 'https://video.fbcdn.net/clip.mp4', display_url: 'https://scontent.cdninstagram.com/cover.jpg', video_duration: 42,
      related: { shortcode: 'OtherPost_12', caption: { text: 'This recipe must not be imported.' } },
    } } }), url)!;
    expect(source.caption).toBe('1 can beans\nWarm the beans.');
    expect(source.durationSec).toBe(42);
    expect(source.authorHandle).toBe('fixture_cook');
  });
  test('supports matching JSON-LD VideoObject and legacy sharedData', () => {
    const jsonLd = page({ '@type': 'VideoObject', url, description: '1 cup rice\nCook the rice.', author: { name: 'Fixture Cook' }, contentUrl: 'https://video.cdninstagram.com/rice.mp4' }).replace('application/json', 'application/ld+json');
    expect(parseInstagramPage(jsonLd, url)?.author).toBe('Fixture Cook');
    const legacy = `<script>window._sharedData = ${JSON.stringify({ entry_data: { PostPage: [{ graphql: { shortcode_media: { shortcode: 'Fridgie_123', caption: { text: '1 apple\nSlice it.' } } } }] } })};</script>`;
    expect(parseInstagramPage(legacy, url)?.caption).toBe('1 apple\nSlice it.');
  });
  test('does not mix metadata with an unrelated canonical post or untrusted media URL', () => {
    expect(parseInstagramPage(fixture, 'https://www.instagram.com/reel/OtherPost_12/')).toBeNull();
    const malicious = fixture.replaceAll('https://video.cdninstagram.com/fixture.mp4?token=video', 'http://127.0.0.1/video.mp4').replaceAll('https://scontent.cdninstagram.com/fixture.jpg?token=cover', 'https://evil.test/photo.jpg');
    expect(parseInstagramPage(malicious, url)?.videoUrl).toBeNull();
    expect(parseInstagramPage(malicious, url)?.photoURL).toBeNull();
    expect(parseInstagramPage(page({ '@type': 'VideoObject', url: 'https://www.instagram.com/reel/OtherPost_12/', description: 'Different recipe' }), url)).toBeNull();
  });
  test('refuses explicitly private matching-post data even if it contains a caption', () => {
    const html = page({ shortcode: 'Fridgie_123', owner: { username: 'private_cook', is_private: true }, caption: { text: '1 apple. Slice it.' } });
    expect(parseInstagramPage(html, url)).toBeNull();
  });
  test('does not treat login pages or a title alone as a recipe caption', () => {
    expect(parseInstagramPage('<meta property="og:title" content="Instagram"><form id="loginForm"></form>', url)).toBeNull();
    expect(parseInstagramPage('<meta property="og:title" content="Lemon chickpeas">', url)).toBeNull();
    expect(instagramCaption('Log in to see photos and videos.').caption).toBe('');
  });
});

describe('Instagram public collection failures and redirects', () => {
  test('resolves a share redirect into the canonical post', async () => {
    const source = await collectInstagramSource('https://www.instagram.com/share/reel/Token123/', fetchResult());
    expect(source.canonicalUrl).toBe(url);
    expect(source.shortcode).toBe('Fridgie_123');
  });
  test('uses known canonical markup for share pages without a redirect', async () => {
    expect((await collectInstagramSource('https://www.instagram.com/share/Token123/', fetchResult(fixture, 200, 'https://www.instagram.com/share/Token123/'))).shortcode).toBe('Fridgie_123');
  });
  test('rejects a redirect to a different known post', async () => {
    await expect(collectInstagramSource(url, fetchResult(fixture, 200, 'https://www.instagram.com/reel/OtherPost_12/'))).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
  });
  test('reports login/private walls, rate limits, missing posts and unsupported URLs', async () => {
    await expect(collectInstagramSource(url, fetchResult('', 200, 'https://www.instagram.com/accounts/login/'))).rejects.toMatchObject({ code: 'INSTAGRAM_LOGIN_REQUIRED', status: 422 });
    await expect(collectInstagramSource(url, fetchResult('<form id="loginForm"></form>'))).rejects.toMatchObject({ code: 'INSTAGRAM_LOGIN_REQUIRED' });
    await expect(collectInstagramSource(url, fetchResult('', 403))).rejects.toMatchObject({ code: 'INSTAGRAM_LOGIN_REQUIRED' });
    await expect(collectInstagramSource(url, fetchResult('', 429))).rejects.toMatchObject({ code: 'INSTAGRAM_RATE_LIMITED', status: 429 });
    await expect(collectInstagramSource(url, fetchResult('', 404))).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
    await expect(collectInstagramSource('https://www.instagram.com/fixture_cook/', fetchResult())).rejects.toMatchObject({ code: 'UNSUPPORTED_VIDEO_URL', status: 400 });
  });
});
