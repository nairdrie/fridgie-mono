import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  framesFromFile,
  isTikTokUrl,
  parseWatchPage,
  pickSubtitleTrack,
  webVttToText,
} from '../utils/tiktok'

describe('isTikTokUrl', () => {
  test('matches TikTok hosts and their subdomains', () => {
    expect(isTikTokUrl('https://www.tiktok.com/@chef/video/123')).toBe(true)
    expect(isTikTokUrl('https://tiktok.com/@chef/video/123')).toBe(true)
    expect(isTikTokUrl('https://vm.tiktok.com/ZMabc123/')).toBe(true)
    expect(isTikTokUrl('https://m.tiktok.com/v/123')).toBe(true)
  })

  test('rejects hosts that merely contain the string', () => {
    // The old check was `hostname.includes('tiktok.com')`, so both of these took
    // the TikTok branch — which then fetched and downloaded whatever they served.
    expect(isTikTokUrl('https://nottiktok.com.evil.test/x')).toBe(false)
    expect(isTikTokUrl('https://eviltiktok.com/x')).toBe(false)
    expect(isTikTokUrl('https://www.cheffatty.com/recipes/x')).toBe(false)
    expect(isTikTokUrl('not a url')).toBe(false)
  })
})

describe('parseWatchPage', () => {
  test('reads the rehydration blob from a real watch page', async () => {
    const html = await Bun.file(`${import.meta.dir}/fixtures/tiktok-watch-page.html`).text()
    const item = parseWatchPage(html)

    expect(item).not.toBeNull()
    expect(item!.desc).toContain('Scramble up ur name')
    expect(item!.author.nickname).toBeTruthy()
    expect(item!.video.duration).toBeGreaterThan(0)
    expect(item!.video.playAddr).toContain('http')
    expect(item!.video.subtitleInfos).toHaveLength(2)
  })

  test('returns null rather than throwing on a page it cannot read', () => {
    // A challenge page, a redesign, or a deleted video all land here, and none
    // of them should cost us the caption that oEmbed already returned.
    expect(parseWatchPage('<html><body>captcha</body></html>')).toBeNull()
    expect(parseWatchPage('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{ not json </script>')).toBeNull()
    expect(parseWatchPage('')).toBeNull()
  })
})

describe('pickSubtitleTrack', () => {
  const track = (over: Record<string, unknown>) => ({
    LanguageCodeName: 'eng-US', Url: 'https://x.test/eng.vtt', Format: 'webvtt', Source: 'ASR', ...over,
  })
  const item = (subtitleInfos: unknown[]) => ({ video: { subtitleInfos } })

  test('prefers the original English track over a machine translation', () => {
    // The original carries the numbers; MT rewrites them into another language's
    // conventions and back.
    expect(pickSubtitleTrack(item([
      track({ LanguageCodeName: 'spa-ES', Source: 'MT', Url: 'https://x.test/spa.vtt' }),
      track({ Url: 'https://x.test/eng.vtt' }),
    ]))).toBe('https://x.test/eng.vtt')
  })

  test('falls back through non-English rather than giving up', () => {
    expect(pickSubtitleTrack(item([
      track({ LanguageCodeName: 'kor-KR', Source: 'ASR', Url: 'https://x.test/kor.vtt' }),
    ]))).toBe('https://x.test/kor.vtt')
  })

  test('accepts the lower-cased field spellings too', () => {
    expect(pickSubtitleTrack(item([
      { languageCodeName: 'eng-US', url: 'https://x.test/lower.vtt', format: 'webvtt', source: 'ASR' },
    ]))).toBe('https://x.test/lower.vtt')
  })

  test('returns null when the video has no usable track', () => {
    // Exactly what a video with no speech reports — claInfo.noCaptionReason.
    expect(pickSubtitleTrack(item([]))).toBeNull()
    expect(pickSubtitleTrack({ video: {} })).toBeNull()
    expect(pickSubtitleTrack(item([track({ Url: undefined })]))).toBeNull()
  })
})

describe('webVttToText', () => {
  test('strips cue numbers, timings and tags', () => {
    const vtt = [
      'WEBVTT', '',
      '1', '00:00:00.000 --> 00:00:02.500', 'Add <b>two tablespoons</b> of gochujang', '',
      '2', '00:00:02.500 --> 00:00:05.000', 'and a splash of sesame oil', '',
    ].join('\n')
    expect(webVttToText(vtt)).toBe('Add two tablespoons of gochujang and a splash of sesame oil')
  })

  test('collapses the rolling repeats TikTok ASR emits', () => {
    // TikTok re-sends the same line across consecutive cues as the caption
    // scrolls; without this the transcript triples in length and in cost.
    const vtt = [
      'WEBVTT', '',
      '00:00:00.000 --> 00:00:01.000', 'brown the pork', '',
      '00:00:01.000 --> 00:00:02.000', 'brown the pork', '',
      '00:00:02.000 --> 00:00:03.000', 'then add the cabbage', '',
    ].join('\n')
    expect(webVttToText(vtt)).toBe('brown the pork then add the cabbage')
  })

  test('survives an empty or header-only track', () => {
    expect(webVttToText('WEBVTT\n\n')).toBe('')
    expect(webVttToText('')).toBe('')
  })
})

describe('framesFromFile', () => {
  const hasFfmpeg = Bun.which('ffmpeg') !== null && Bun.which('ffprobe') !== null

  test.skipIf(!hasFfmpeg)('samples evenly spaced JPEG stills', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fridgie-test-'))
    try {
      const videoPath = join(dir, 'test.mp4')
      // A synthetic 16s clip rather than a committed binary fixture.
      const make = Bun.spawn([
        'ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi',
        '-i', 'testsrc=size=1080x1920:rate=30:duration=16',
        '-pix_fmt', 'yuv420p', '-y', videoPath,
      ], { stdout: 'ignore', stderr: 'ignore' })
      expect(await make.exited).toBe(0)

      const frames = await framesFromFile(videoPath)

      // 16s at one frame per 8s, floored at the 3-frame minimum.
      expect(frames).toHaveLength(3)
      for (const frame of frames) {
        // Valid base64 that starts with the JPEG SOI marker.
        const bytes = Buffer.from(frame, 'base64')
        expect(bytes[0]).toBe(0xff)
        expect(bytes[1]).toBe(0xd8)
        expect(bytes.length).toBeGreaterThan(1000)
      }
      // Distinct moments, not the same frame three times.
      expect(new Set(frames).size).toBe(3)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test.skipIf(!hasFfmpeg)('caps the frame count on a long video', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fridgie-test-'))
    try {
      const videoPath = join(dir, 'long.mp4')
      const make = Bun.spawn([
        'ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi',
        '-i', 'testsrc=size=640x360:rate=10:duration=180',
        '-pix_fmt', 'yuv420p', '-y', videoPath,
      ], { stdout: 'ignore', stderr: 'ignore' })
      expect(await make.exited).toBe(0)

      // 180s would want 23 frames; the cap keeps the image bill bounded.
      expect(await framesFromFile(videoPath)).toHaveLength(8)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  test('returns no frames rather than throwing when the file is unreadable', async () => {
    // Covers a truncated download and a machine with no ffmpeg alike: the
    // import must fall back to caption-and-transcript, not fail.
    expect(await framesFromFile('/nonexistent/video.mp4')).toEqual([])
  })
})
