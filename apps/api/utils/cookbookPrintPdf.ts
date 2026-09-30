import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { fetchPublicUrl } from './publicFetch';
import {
  INTERIOR_HEIGHT_PT,
  INTERIOR_WIDTH_PT,
  LAYOUT_HEIGHT_PT,
  LAYOUT_WIDTH_PT,
  type CookbookPrintLayoutPlan,
  type CookbookPrintSnapshot,
  type PrintElement,
} from './cookbookPrint';
import type { CookbookPrintIssue } from '@fridgie/shared/types';

const execFileAsync = promisify(execFile);
const BLEED_PT = 0.125 * 72;
const TRIM_WIDTH_PT = 7 * 72;
const TRIM_HEIGHT_PT = 10 * 72;

export interface CoverGeometry {
  pageWidthPt: number;
  pageHeightPt: number;
  backXPt: number;
  backWidthPt: number;
  spineXPt: number;
  spineWidthPt: number;
  frontXPt: number;
  frontWidthPt: number;
  trimTopPt: number;
  trimHeightPt: number;
  safeInsetPt: number;
  /** True only when the values came from Lulu's exact cover template. */
  providerVerified: boolean;
}

export interface CookbookPrintArtifacts {
  interior: Buffer;
  cover: Buffer;
  interiorSha256: string;
  coverSha256: string;
  interiorMd5: string;
  coverMd5: string;
  pageCount: number;
  coverGeometry: CoverGeometry;
  issues: CookbookPrintIssue[];
}

interface PreparedImage {
  image: PDFImage;
  width: number;
  height: number;
  effectiveDpi: number;
}

function hex(value: string) {
  const cleaned = /^#[0-9a-f]{6}$/i.test(value) ? value.slice(1) : '000000';
  return rgb(parseInt(cleaned.slice(0, 2), 16) / 255, parseInt(cleaned.slice(2, 4), 16) / 255, parseInt(cleaned.slice(4, 6), 16) / 255);
}

/** Space Mono covers the app's Latin recipe text. Normalize typographic marks
 * that commonly map inconsistently in provider PDF pipelines. */
function printableText(value: string): string {
  return value.normalize('NFC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

async function loadFontBytes(): Promise<Uint8Array> {
  const configured = process.env.COOKBOOK_PRINT_FONT_PATH;
  const candidates = [
    configured,
    new URL('../../mobile/assets/fonts/SpaceMono-Regular.ttf', import.meta.url).pathname,
    new URL('../assets/fonts/SpaceMono-Regular.ttf', import.meta.url).pathname,
  ].filter((item): item is string => !!item);
  for (const path of candidates) {
    try { return await readFile(path); } catch { /* Try the packaged fallback. */ }
  }
  throw new Error('PRINT_FONT_NOT_FOUND');
}

function scalePoint(element: PrintElement) {
  const scaleX = INTERIOR_WIDTH_PT / LAYOUT_WIDTH_PT;
  const scaleY = INTERIOR_HEIGHT_PT / LAYOUT_HEIGHT_PT;
  const scaleFont = Math.min(scaleX, scaleY);
  return { scaleX, scaleY, scaleFont };
}

function drawText(page: PDFPage, font: PDFFont, element: Extract<PrintElement, { kind: 'text' }>) {
  const { scaleX, scaleY, scaleFont } = scalePoint(element);
  const size = element.fontSize * scaleFont;
  const lineHeight = element.lineHeight * scaleY;
  const x = element.x * scaleX;
  const width = element.width * scaleX;
  for (const [index, source] of element.lines.entries()) {
    let line = printableText(source);
    let measured = 0;
    try { measured = font.widthOfTextAtSize(line, size); } catch {
      line = line.replace(/[^\x20-\x7E\u00C0-\u024F]/g, '?');
      measured = font.widthOfTextAtSize(line, size);
    }
    const alignedX = element.align === 'center' ? x + Math.max(0, (width - measured) / 2)
      : element.align === 'right' ? x + Math.max(0, width - measured) : x;
    page.drawText(line, {
      x: alignedX,
      y: INTERIOR_HEIGHT_PT - element.top * scaleY - size - index * lineHeight,
      size,
      font,
      color: hex(element.color),
      maxWidth: width,
    });
  }
}

async function downloadImage(url: string): Promise<Buffer> {
  const result = await fetchPublicUrl(url, {
    maxBytes: 20_000_000,
    timeoutMs: 15_000,
    headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.2', 'User-Agent': 'Fridgie-Print/1.0' },
  });
  if (result.status < 200 || result.status >= 300) throw new Error(`IMAGE_HTTP_${result.status}`);
  return result.data;
}

async function prepareImage(pdf: PDFDocument, bytes: Buffer, boxWidthPt: number, boxHeightPt: number, crop: { x: number; y: number; zoom: number }): Promise<PreparedImage> {
  const source = sharp(bytes, { failOn: 'error', limitInputPixels: 50_000_000 }).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new Error('IMAGE_DIMENSIONS_MISSING');
  const targetAspect = boxWidthPt / boxHeightPt;
  const sourceAspect = metadata.width / metadata.height;
  const zoom = Math.max(1, Math.min(3, crop.zoom));
  let cropWidth: number;
  let cropHeight: number;
  if (sourceAspect > targetAspect) {
    cropHeight = metadata.height / zoom;
    cropWidth = cropHeight * targetAspect;
  } else {
    cropWidth = metadata.width / zoom;
    cropHeight = cropWidth / targetAspect;
  }
  cropWidth = Math.max(1, Math.min(metadata.width, cropWidth));
  cropHeight = Math.max(1, Math.min(metadata.height, cropHeight));
  const left = Math.max(0, Math.min(metadata.width - cropWidth, (metadata.width - cropWidth) * crop.x));
  const top = Math.max(0, Math.min(metadata.height - cropHeight, (metadata.height - cropHeight) * crop.y));
  const targetWidth = Math.max(300, Math.min(2400, Math.round(boxWidthPt / 72 * 300)));
  const targetHeight = Math.max(300, Math.min(3000, Math.round(boxHeightPt / 72 * 300)));
  const normalized = await source
    .extract({ left: Math.round(left), top: Math.round(top), width: Math.max(1, Math.round(cropWidth)), height: Math.max(1, Math.round(cropHeight)) })
    .resize(targetWidth, targetHeight, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return {
    image: await pdf.embedJpg(normalized),
    width: metadata.width,
    height: metadata.height,
    effectiveDpi: Math.min(cropWidth / (boxWidthPt / 72), cropHeight / (boxHeightPt / 72)),
  };
}

async function drawInteriorElement(options: {
  page: PDFPage;
  pdf: PDFDocument;
  font: PDFFont;
  element: PrintElement;
  imageBytes: Map<string, Buffer | Error>;
  imageCache: Map<string, PreparedImage>;
  issues: CookbookPrintIssue[];
  pageNumber: number;
}) {
  const { page, pdf, font, element, imageBytes, imageCache, issues, pageNumber } = options;
  const { scaleX, scaleY } = scalePoint(element);
  if (element.kind === 'text') return drawText(page, font, element);
  if (element.kind === 'rect') {
    page.drawRectangle({ x: element.x * scaleX, y: INTERIOR_HEIGHT_PT - (element.top + element.height) * scaleY, width: element.width * scaleX, height: element.height * scaleY, color: hex(element.color) });
    return;
  }
  if (element.kind === 'rule') {
    page.drawLine({ start: { x: element.x * scaleX, y: INTERIOR_HEIGHT_PT - element.top * scaleY }, end: { x: (element.x + element.width) * scaleX, y: INTERIOR_HEIGHT_PT - element.top * scaleY }, color: hex(element.color), thickness: (element.thickness ?? 1) * Math.min(scaleX, scaleY) });
    return;
  }
  if (element.kind === 'qr') {
    const qr = await QRCode.toBuffer(element.value, { type: 'png', margin: 1, width: 600, errorCorrectionLevel: 'M', color: { dark: '#173F35', light: '#FFFFFF' } });
    const embedded = await pdf.embedPng(qr);
    page.drawImage(embedded, { x: element.x * scaleX, y: INTERIOR_HEIGHT_PT - (element.top + element.size) * scaleY, width: element.size * scaleX, height: element.size * scaleY });
    return;
  }
  const bytes = imageBytes.get(element.url);
  if (!bytes || bytes instanceof Error) {
    page.drawRectangle({ x: element.x * scaleX, y: INTERIOR_HEIGHT_PT - (element.top + element.height) * scaleY, width: element.width * scaleX, height: element.height * scaleY, color: hex('#E8ECE7') });
    issues.push({ code: 'missing-image', severity: element.role === 'cover' ? 'error' : 'warning', message: 'An image could not be loaded for print.', recipeId: element.recipeId, pageNumber });
    return;
  }
  const key = `${element.url}:${element.width}:${element.height}:${element.crop.x}:${element.crop.y}:${element.crop.zoom}`;
  let prepared = imageCache.get(key);
  if (!prepared) {
    prepared = await prepareImage(pdf, bytes, element.width * scaleX, element.height * scaleY, element.crop);
    imageCache.set(key, prepared);
  }
  page.drawImage(prepared.image, { x: element.x * scaleX, y: INTERIOR_HEIGHT_PT - (element.top + element.height) * scaleY, width: element.width * scaleX, height: element.height * scaleY });
  if (prepared.effectiveDpi < 200) {
    issues.push({
      code: 'low-resolution-image', severity: prepared.effectiveDpi < 120 ? 'error' : 'warning',
      message: `This photo is about ${Math.round(prepared.effectiveDpi)} PPI at print size; 300 PPI is recommended.`,
      recipeId: element.recipeId, pageNumber,
    });
  }
}

function defaultCoverGeometry(snapshot: CookbookPrintSnapshot, plan: CookbookPrintLayoutPlan): CoverGeometry {
  if (snapshot.sku === 'matte-softcover') {
    const spineWidthPt = plan.spineWidthInches * 72;
    return {
      pageWidthPt: BLEED_PT * 2 + TRIM_WIDTH_PT * 2 + spineWidthPt,
      pageHeightPt: BLEED_PT * 2 + TRIM_HEIGHT_PT,
      backXPt: BLEED_PT,
      backWidthPt: TRIM_WIDTH_PT,
      spineXPt: BLEED_PT + TRIM_WIDTH_PT,
      spineWidthPt,
      frontXPt: BLEED_PT + TRIM_WIDTH_PT + spineWidthPt,
      frontWidthPt: TRIM_WIDTH_PT,
      trimTopPt: BLEED_PT,
      trimHeightPt: TRIM_HEIGHT_PT,
      safeInsetPt: 0.5 * 72,
      providerVerified: true,
    };
  }
  // Casewrap hinges and wrap vary by page band. This is intentionally preview
  // geometry only; production checkout requires exact values from a Lulu custom
  // cover template (providerVerified=true).
  const wrap = 0.75 * 72;
  const spineWidthPt = plan.spineWidthInches * 72;
  return {
    pageWidthPt: wrap * 2 + TRIM_WIDTH_PT * 2 + spineWidthPt,
    pageHeightPt: wrap * 2 + TRIM_HEIGHT_PT,
    backXPt: wrap,
    backWidthPt: TRIM_WIDTH_PT,
    spineXPt: wrap + TRIM_WIDTH_PT,
    spineWidthPt,
    frontXPt: wrap + TRIM_WIDTH_PT + spineWidthPt,
    frontWidthPt: TRIM_WIDTH_PT,
    trimTopPt: wrap,
    trimHeightPt: TRIM_HEIGHT_PT,
    safeInsetPt: 0.75 * 72,
    providerVerified: false,
  };
}

export interface CoverTypographyLine {
  role: 'title' | 'subtitle' | 'byline';
  text: string;
  x: number;
  y: number;
  width: number;
  size: number;
  lineHeight: number;
}

export interface CoverTypographyPlan {
  safeBox: { x: number; y: number; width: number; height: number };
  panel: { x: number; y: number; width: number; height: number };
  title: CoverTypographyLine[];
  subtitle: CoverTypographyLine[];
  byline: CoverTypographyLine[];
}

interface CoverFontMetrics {
  widthOfTextAtSize(value: string, size: number): number;
}

function coverFontText(font: CoverFontMetrics, value: string, size: number): string {
  const normalized = printableText(value).replace(/\s+/g, ' ').trim();
  try {
    font.widthOfTextAtSize(normalized, size);
    return normalized;
  } catch {
    const latinFallback = normalized.replace(/[^\x20-\x7E\u00C0-\u024F]/g, '?');
    try {
      font.widthOfTextAtSize(latinFallback, size);
      return latinFallback;
    } catch {
      return latinFallback.replace(/[^\x20-\x7E]/g, '?');
    }
  }
}

function splitCoverToken(font: CoverFontMetrics, token: string, size: number, maxWidth: number): string[] {
  const parts: string[] = [];
  let part = '';
  for (const glyph of Array.from(token)) {
    const candidate = `${part}${glyph}`;
    if (part && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      parts.push(part);
      part = glyph;
    } else {
      part = candidate;
    }
  }
  if (part) parts.push(part);
  return parts;
}

function wrapCoverText(font: CoverFontMetrics, value: string, size: number, maxWidth: number): string[] {
  const normalized = coverFontText(font, value, size);
  if (!normalized) return [];
  const lines: string[] = [];
  let line = '';
  for (const token of normalized.split(' ')) {
    const candidate = line ? `${line} ${token}` : token;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      line = '';
    }
    if (font.widthOfTextAtSize(token, size) <= maxWidth) {
      line = token;
      continue;
    }
    const tokenParts = splitCoverToken(font, token, size, maxWidth);
    lines.push(...tokenParts.slice(0, -1));
    line = tokenParts.at(-1) ?? '';
  }
  if (line) lines.push(line);
  return lines;
}

/** Plans the front-cover copy from the embedded font's actual measurements.
 * All coordinates refer to PDF baseline space and stay inside the trim-safe box. */
export function planCoverTypography(options: {
  title: string;
  subtitle?: string;
  byline: string;
  geometry: CoverGeometry;
  font: CoverFontMetrics;
}): CoverTypographyPlan {
  const { geometry, font } = options;
  const safeX = geometry.frontXPt + geometry.safeInsetPt;
  const safeWidth = Math.max(1, geometry.frontWidthPt - geometry.safeInsetPt * 2);
  const trimBottom = geometry.pageHeightPt - geometry.trimTopPt - geometry.trimHeightPt;
  const safeBottom = trimBottom + geometry.safeInsetPt;
  const safeTop = geometry.pageHeightPt - geometry.trimTopPt - geometry.safeInsetPt;
  const safeHeight = Math.max(1, safeTop - safeBottom);
  const safeBox = { x: safeX, y: safeBottom, width: safeWidth, height: safeHeight };

  let titleSize = 25;
  let subtitleSize = 10;
  let bylineSize = 10;
  let titleLineHeight = 34;
  let subtitleLineHeight = 15;
  let bylineLineHeight = 15;
  let titleGap = 14;
  let bylineGap = 18;
  let titleLines: string[] = [];
  let subtitleLines: string[] = [];
  let bylineLines: string[] = [];
  let blockHeight = 0;

  for (let titlePointSize = 25; titlePointSize >= 12; titlePointSize -= 1) {
    titleSize = titlePointSize;
    subtitleSize = Math.max(8, Math.round(titlePointSize * 0.4));
    bylineSize = subtitleSize;
    titleLineHeight = titleSize + Math.max(5, Math.round(titleSize * 0.36));
    subtitleLineHeight = subtitleSize + 5;
    bylineLineHeight = bylineSize + 5;
    titleGap = Math.max(10, Math.round(titleSize * 0.56));
    bylineGap = Math.max(12, Math.round(titleSize * 0.72));
    titleLines = wrapCoverText(font, options.title || 'My Cookbook', titleSize, safeWidth);
    subtitleLines = options.subtitle ? wrapCoverText(font, options.subtitle, subtitleSize, safeWidth) : [];
    bylineLines = wrapCoverText(font, options.byline || 'Fridgie cook', bylineSize, safeWidth);
    blockHeight = titleLines.length * titleLineHeight
      + (subtitleLines.length ? titleGap + subtitleLines.length * subtitleLineHeight : 0)
      + bylineGap + bylineLines.length * bylineLineHeight;
    if (blockHeight <= safeHeight) break;
  }

  const preferredTop = safeBottom + safeHeight * 0.72;
  const blockTop = Math.min(safeTop, Math.max(safeBottom + blockHeight, preferredTop));
  let cursor = blockTop;
  const placeLines = (
    role: CoverTypographyLine['role'],
    values: string[],
    size: number,
    lineHeight: number,
  ): CoverTypographyLine[] => values.map(text => {
    const width = font.widthOfTextAtSize(text, size);
    const line = {
      role,
      text,
      x: safeX + Math.max(0, (safeWidth - width) / 2),
      y: cursor - size,
      width,
      size,
      lineHeight,
    };
    cursor -= lineHeight;
    return line;
  });

  const title = placeLines('title', titleLines, titleSize, titleLineHeight);
  if (subtitleLines.length) cursor -= titleGap;
  const subtitle = placeLines('subtitle', subtitleLines, subtitleSize, subtitleLineHeight);
  cursor -= bylineGap;
  const byline = placeLines('byline', bylineLines, bylineSize, bylineLineHeight);
  const panelPadding = 14;
  const trimTop = geometry.pageHeightPt - geometry.trimTopPt;
  const panelBottom = Math.max(trimBottom, cursor - panelPadding);
  const panelTop = Math.min(trimTop, blockTop + panelPadding);
  const panelX = Math.max(geometry.frontXPt, safeX - 12);
  const panelRight = Math.min(geometry.frontXPt + geometry.frontWidthPt, safeX + safeWidth + 12);

  return {
    safeBox,
    panel: { x: panelX, y: panelBottom, width: panelRight - panelX, height: panelTop - panelBottom },
    title,
    subtitle,
    byline,
  };
}

async function createCover(options: {
  snapshot: CookbookPrintSnapshot;
  plan: CookbookPrintLayoutPlan;
  fontBytes: Uint8Array;
  imageBytes: Map<string, Buffer | Error>;
  issues: CookbookPrintIssue[];
  geometry?: CoverGeometry;
}): Promise<{ bytes: Buffer; geometry: CoverGeometry }> {
  const { snapshot, plan, fontBytes, imageBytes, issues } = options;
  const geometry = options.geometry ?? defaultCoverGeometry(snapshot, plan);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  pdf.setTitle(snapshot.title);
  pdf.setAuthor(snapshot.byline);
  pdf.setCreator(`Fridgie cookbook renderer ${snapshot.layoutVersion}`);
  pdf.setProducer('Fridgie');
  pdf.setCreationDate(new Date(snapshot.createdAt));
  pdf.setModificationDate(new Date(snapshot.createdAt));
  const page = pdf.addPage([geometry.pageWidthPt, geometry.pageHeightPt]);
  const trimBottom = geometry.pageHeightPt - geometry.trimTopPt - geometry.trimHeightPt;
  page.setBleedBox(0, 0, geometry.pageWidthPt, geometry.pageHeightPt);
  page.setTrimBox(
    geometry.backXPt,
    trimBottom,
    geometry.backWidthPt + geometry.spineWidthPt + geometry.frontWidthPt,
    geometry.trimHeightPt,
  );
  const palette = snapshot.theme === 'classic'
    ? { background: '#F0E8D9', ink: '#2E342F', accent: '#947650' }
    : snapshot.theme === 'photo-forward'
      ? { background: '#F3DED5', ink: '#173F35', accent: '#C97860' }
      : { background: '#DCEDE2', ink: '#173F35', accent: '#23785E' };
  page.drawRectangle({ x: 0, y: 0, width: geometry.pageWidthPt, height: geometry.pageHeightPt, color: hex(palette.background) });
  const coverRecipe = snapshot.recipes.find(recipe => recipe.recipeId === snapshot.coverRecipeId);
  const coverBytes = coverRecipe?.photoURL ? imageBytes.get(coverRecipe.photoURL) : undefined;
  if (coverRecipe?.photoURL && coverBytes && !(coverBytes instanceof Error)) {
    const prepared = await prepareImage(pdf, coverBytes, geometry.frontWidthPt, geometry.trimHeightPt, snapshot.coverCrop);
    page.drawImage(prepared.image, { x: geometry.frontXPt, y: geometry.pageHeightPt - geometry.trimTopPt - geometry.trimHeightPt, width: geometry.frontWidthPt, height: geometry.trimHeightPt });
    if (prepared.effectiveDpi < 200) issues.push({ code: 'low-resolution-image', severity: prepared.effectiveDpi < 150 ? 'error' : 'warning', message: `The cover photo is about ${Math.round(prepared.effectiveDpi)} PPI at print size; choose a larger image for a crisp cover.`, recipeId: coverRecipe.recipeId });
  } else if (coverRecipe?.photoURL) {
    issues.push({ code: 'missing-image', severity: 'error', message: 'The selected cover photo could not be prepared.', recipeId: snapshot.coverRecipeId });
  }
  const typography = planCoverTypography({
    title: snapshot.title,
    subtitle: snapshot.subtitle,
    byline: snapshot.byline,
    geometry,
    font,
  });
  page.drawRectangle({ ...typography.panel, color: hex('#FFFDF7'), opacity: 0.9 });
  for (const line of [...typography.title, ...typography.subtitle, ...typography.byline]) {
    page.drawText(line.text, {
      x: line.x,
      y: line.y,
      size: line.size,
      font,
      color: hex(line.role === 'subtitle' ? palette.accent : palette.ink),
      maxWidth: typography.safeBox.width,
    });
  }

  const backSafeX = geometry.backXPt + geometry.safeInsetPt;
  const backSafeWidth = geometry.backWidthPt - geometry.safeInsetPt * 2;
  page.drawText('A personal collection made with Fridgie', { x: backSafeX, y: geometry.pageHeightPt * 0.53, size: 10, font, color: hex(palette.ink), maxWidth: backSafeWidth });
  page.drawText(`${snapshot.recipes.length} recipes`, { x: backSafeX, y: geometry.pageHeightPt * 0.49, size: 9, font, color: hex(palette.accent), maxWidth: backSafeWidth });
  // Leave a clear, opaque block for provider-applied manufacturing/barcode marks.
  page.drawRectangle({ x: backSafeX, y: geometry.trimTopPt + geometry.safeInsetPt, width: 126, height: 72, color: hex('#FFFFFF') });

  // Official guidance avoids spine text at 80 pages or fewer.
  if (plan.pages.length > 80 && geometry.spineWidthPt >= 18) {
    const spineSize = Math.min(10, geometry.spineWidthPt * 0.38);
    const label = printableText(snapshot.title).slice(0, 72);
    page.drawText(label, {
      x: geometry.spineXPt + (geometry.spineWidthPt - spineSize) / 2,
      y: geometry.trimTopPt + geometry.safeInsetPt,
      size: spineSize,
      font,
      color: hex(palette.ink),
      rotate: degrees(90),
      maxWidth: geometry.trimHeightPt - geometry.safeInsetPt * 2,
    });
  }
  if (snapshot.sku === 'matte-hardcover' && !geometry.providerVerified) {
    issues.push({ code: 'provider-validation', severity: 'error', message: 'Hardcover checkout needs exact casewrap geometry from a Lulu custom cover template.' });
  }
  return { bytes: Buffer.from(await pdf.save({ useObjectStreams: true, addDefaultPage: false })), geometry };
}

export async function renderCookbookPdfs(snapshot: CookbookPrintSnapshot, plan: CookbookPrintLayoutPlan, options: { coverGeometry?: CoverGeometry; fetchImage?: (url: string) => Promise<Buffer> } = {}): Promise<CookbookPrintArtifacts> {
  const fontBytes = await loadFontBytes();
  const issues = [...plan.issues];
  const urls = new Set<string>();
  for (const page of plan.pages) for (const element of page.elements) if (element.kind === 'image') urls.add(element.url);
  const coverRecipe = snapshot.recipes.find(recipe => recipe.recipeId === snapshot.coverRecipeId);
  if (coverRecipe?.photoURL) urls.add(coverRecipe.photoURL);
  const fetchImage = options.fetchImage ?? downloadImage;
  const imageBytes = new Map<string, Buffer | Error>(await Promise.all([...urls].map(async url => {
    try { return [url, await fetchImage(url)] as const; }
    catch (error) { return [url, error instanceof Error ? error : new Error('IMAGE_FETCH_FAILED')] as const; }
  })));

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  pdf.setTitle(snapshot.title);
  pdf.setAuthor(snapshot.byline);
  pdf.setSubject('Personal printed cookbook');
  pdf.setCreator(`Fridgie cookbook renderer ${snapshot.layoutVersion}`);
  pdf.setProducer('Fridgie');
  pdf.setCreationDate(new Date(snapshot.createdAt));
  pdf.setModificationDate(new Date(snapshot.createdAt));
  const imageCache = new Map<string, PreparedImage>();
  for (const planned of plan.pages) {
    const page = pdf.addPage([INTERIOR_WIDTH_PT, INTERIOR_HEIGHT_PT]);
    page.setTrimBox(BLEED_PT, BLEED_PT, TRIM_WIDTH_PT, TRIM_HEIGHT_PT);
    page.setBleedBox(0, 0, INTERIOR_WIDTH_PT, INTERIOR_HEIGHT_PT);
    for (const element of planned.elements) {
      try { await drawInteriorElement({ page, pdf, font, element, imageBytes, imageCache, issues, pageNumber: planned.pageNumber }); }
      catch {
        issues.push({ code: element.kind === 'image' ? 'missing-image' : 'text-overflow', severity: 'error', message: `Page ${planned.pageNumber} could not be rendered completely.`, pageNumber: planned.pageNumber, recipeId: element.kind === 'image' ? element.recipeId : planned.recipeId });
      }
    }
    if (planned.kind !== 'title' && planned.kind !== 'dedication') {
      const pageLabel = String(planned.pageNumber);
      page.drawText(pageLabel, {
        x: planned.pageNumber % 2 === 0 ? 0.62 * 72 : INTERIOR_WIDTH_PT - 0.82 * 72,
        y: 0.36 * 72,
        size: 7,
        font,
        color: hex('#687A70'),
      });
    }
  }
  const interior = Buffer.from(await pdf.save({ useObjectStreams: true, addDefaultPage: false }));
  const coverResult = await createCover({ snapshot, plan, fontBytes, imageBytes, issues, geometry: options.coverGeometry });
  const digest = (algorithm: 'sha256' | 'md5', bytes: Buffer) => createHash(algorithm).update(bytes).digest('hex');
  return {
    interior,
    cover: coverResult.bytes,
    interiorSha256: digest('sha256', interior),
    coverSha256: digest('sha256', coverResult.bytes),
    interiorMd5: digest('md5', interior),
    coverMd5: digest('md5', coverResult.bytes),
    pageCount: plan.pages.length,
    coverGeometry: coverResult.geometry,
    issues,
  };
}

/** Rasterizes the actual generated PDF, so mobile preview pixels cannot drift
 * from the artifact submitted to the printer. */
export async function rasterizePdf(pdf: Buffer, options: { dpi?: number; format?: 'png' | 'jpeg'; firstPage?: number; lastPage?: number } = {}): Promise<Buffer[]> {
  const directory = await mkdtemp(join(tmpdir(), 'fridgie-print-'));
  const input = join(directory, 'input.pdf');
  const prefix = join(directory, 'page');
  const format = options.format ?? 'jpeg';
  try {
    await writeFile(input, pdf);
    const args = [`-${format}`, '-r', String(options.dpi ?? 110)];
    if (options.firstPage) args.push('-f', String(options.firstPage));
    if (options.lastPage) args.push('-l', String(options.lastPage));
    args.push(input, prefix);
    await execFileAsync(process.env.PDFTOPPM_PATH || 'pdftoppm', args, { timeout: 120_000, maxBuffer: 2_000_000 });
    const names = (await readdir(directory)).filter(name => name.startsWith('page-') && (name.endsWith('.jpg') || name.endsWith('.png'))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return await Promise.all(names.map(name => readFile(join(directory, name))));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
