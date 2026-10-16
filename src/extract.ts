// Pull a one-time code or a verification link out of an email.
// Email content is untrusted: these helpers only read text. They never fetch, open or follow anything.

export interface EmailContent {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwnj: '', zwj: '', shy: '', copy: '©', reg: '®', middot: '·', bull: '•', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function normalizeText(text: string): string {
  return text
    // Zero-width characters are used to pad preheaders and can split a code in two.
    .replace(/[​-‍⁠﻿͏­]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Visible text of an HTML email: drops head/style/script and attributes, keeps block structure as line breaks. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|tr|td|th|li|ul|ol|h[1-6]|table|tbody|thead|blockquote|section|article|header|footer|center|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return normalizeText(decodeHtmlEntities(text));
}

function textSources(content: EmailContent): string[] {
  const sources: string[] = [];
  if (content.text?.trim()) sources.push(normalizeText(content.text));
  if (content.html?.trim()) sources.push(htmlToText(content.html));
  return sources;
}

// ---------------------------------------------------------------------------
// Codes

const CODE_KEYWORD = /\b(?:verification|verify|one[- ]?time|passcodes?|otp|codes?|pin|2fa|mfa|two[- ]factor|authentication|confirmation)\b|验证码|校验码|动态码|确认码|安全码|登录码|验证|驗證碼|驗證|認証|コード|인증|código|codice|bestätigungscode/gi;
// 4-8 digits, optionally grouped as "123 456" / "123-456", or 4-8 uppercase letters and digits ("K7XF9Q", "XKF-7QD").
const CODE_CANDIDATE = /(?<![A-Za-z0-9])(?:\d{3,4}[- ]\d{3,4}|[A-Z0-9]{3,4}-[A-Z0-9]{3,4}|[A-Z0-9]{4,8})(?![A-Za-z0-9])/g;
// Labels that make the number something else: order numbers, phone numbers, postal codes, promo codes.
const NOT_A_CODE_PREFIX = /(?:order|invoice|receipt|ticket|case|account|acct|card|phone|mobile|tel|fax|zip|postal|post code|promo|promotion|coupon|discount|voucher|referral|reference|ref|tracking|serial|version|ending in|ends in|订单|单号|发票|邮编|电话|手机|尾号|优惠)\s*(?:number|no\.?|id|code|号码|号|码)?\s*[#:：]?\s*$/i;
const CURRENCY_PREFIX = /(?:[$€£¥￥₹]|\b(?:usd|eur|gbp|cny|rmb|jpy)\b)\s*$/i;
const UNIT_SUFFIX = /^\s*(?:%|元|円|(?:usd|eur|gbp|px|pt|em|ms|kb|mb|gb|tb|km|kg|mg|ml|hz|mhz|ghz)(?![a-z]))/i;
const URL_OR_EMAIL = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
const YEAR = /^(?:19|20)\d{2}$/;
const MIN_CODE_SCORE = 20;

interface ScoredValue {
  value: string;
  score: number;
}

function keywordRanges(text: string): Array<[number, number]> {
  return [...text.matchAll(CODE_KEYWORD)].map((match) => [match.index!, match.index! + match[0].length]);
}

function codeCandidates(text: string, subjectLength: number): ScoredValue[] {
  // Blank out links and addresses (keeping offsets) so digits inside them are never mistaken for a code.
  const scan = text.replace(URL_OR_EMAIL, (match) => ' '.repeat(match.length));
  const keywords = keywordRanges(scan);
  const results: ScoredValue[] = [];
  for (const match of scan.matchAll(CODE_CANDIDATE)) {
    const raw = match[0];
    const start = match.index!;
    const end = start + raw.length;
    const value = raw.replace(/[- ]/g, '');
    if (value.length < 4 || value.length > 8) continue;
    const digitsOnly = /^\d+$/.test(value);
    if (!digitsOnly && !(/\d/.test(value) && /[A-Z]/.test(value))) continue;

    // Part of a longer number, date, time or version ("2026-10-15", "10:30", "1.234").
    const before = scan.slice(Math.max(0, start - 40), start);
    const after = scan.slice(end, end + 20);
    if (/\d[-/:.,]$/.test(before)) continue;
    if (/^[-/:.,]\d/.test(after)) continue;
    if (raw.includes(' ') && (/\d $/.test(before) || /^ \d/.test(after))) continue;
    if (CURRENCY_PREFIX.test(before) || UNIT_SUFFIX.test(after)) continue;
    if (/\(\d{3}\)\s*$|\+\d[\d\s-]*$/.test(before)) continue; // phone numbers

    let nearest = Infinity;
    let keywordBefore = false;
    for (const [kStart, kEnd] of keywords) {
      const distance = kEnd <= start ? start - kEnd : kStart >= end ? kStart - end : Infinity;
      if (distance < nearest) {
        nearest = distance;
        keywordBefore = kEnd <= start;
      }
    }
    const lineStart = scan.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = scan.indexOf('\n', end);
    const standalone = scan.slice(lineStart, lineEnd === -1 ? scan.length : lineEnd).trim() === raw;

    if (!digitsOnly && nearest > 40 && !standalone) continue;
    let score = digitsOnly ? (value.length === 6 ? 8 : 4) : 0;
    if (nearest <= 40) score += 50 - Math.floor(nearest / 2) + (keywordBefore ? 5 : 0);
    else if (nearest <= 120) score += 15;
    if (standalone) score += 25;
    if (start < subjectLength) score += 10;
    if (digitsOnly && value.length === 4 && YEAR.test(value)) score -= 30;
    if (/#\s*$/.test(before) || NOT_A_CODE_PREFIX.test(before)) score -= 60;
    results.push({ value, score });
  }
  return results;
}

// Highest score at or above the minimum; ties go to the earliest occurrence.
function best(candidates: ScoredValue[], minimum: number): string | null {
  let winner: ScoredValue | null = null;
  for (const candidate of candidates) {
    if (candidate.score < minimum) continue;
    if (!winner || candidate.score > winner.score) winner = candidate;
  }
  return winner?.value ?? null;
}

/**
 * The most likely one-time code (4-8 digits, or 4-8 uppercase letters and digits) in the email,
 * preferring numbers next to words like "code", "OTP" or 验证码. Separators are removed ("123-456" → "123456").
 * Returns null rather than guessing when nothing looks like a code.
 */
export function extractCode(content: EmailContent): string | null {
  const subject = normalizeText(content.subject ?? '');
  const sources = textSources(content);
  for (const body of sources.length ? sources : ['']) {
    const prefix = subject ? `${subject}\n\n` : '';
    const found = best(codeCandidates(prefix + body, subject.length), MIN_CODE_SCORE);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Links

interface LinkOccurrence {
  url: string;
  label: string;
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const BARE_URL = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"。，；：！？）】」』]+$/;

const LINK_SKIP = /unsubscribe|opt[-_\s]?out|email[-_\s]?preferences|notification[-_\s]?settings|manage[-_\s]?(?:your[-_\s]?)?(?:subscription|email|notification|preference)|list-manage\.com|退订|取消订阅/i;
const LINK_STRONG_LABEL = /verif|confirm|activat|validat|magic[-_\s]?link|sign[-_\s]?in|log[-_\s]?in|sign[-_\s]?up|reset[-_\s]?(?:your[-_\s]?)?password|accept[-_\s]?(?:the[-_\s]?)?invit|验证|驗證|确认|確認|激活|登录|登入|注册|重置密码|認証|인증/i;
const LINK_WEAK_LABEL = /continue|get[-_\s]?started|complete|finish|accept|join|click here|点击|點擊/i;
const LINK_STRONG_URL = /verif|confirm|activat|validat|magic|auth|login|log-in|signin|sign-in|sign_in|callback|reset|password|token|otp|invit/i;
const LINK_NEGATIVE = /privacy|terms|policy|legal|help|support|faq|docs|documentation|blog|careers|jobs|contact|about|community|download|app[-_\s]?store|google[-_\s]?play|view (?:it |this email )?in (?:your |a )?browser|web version|didn'?t (?:request|sign|ask)|did not (?:request|sign|ask)|wasn'?t (?:you|me)|not you|report|secure your account|block/i;
const SOCIAL_HOST = /(?:^|\.)(?:twitter\.com|x\.com|facebook\.com|fb\.com|linkedin\.com|instagram\.com|youtube\.com|youtu\.be|tiktok\.com|discord\.gg|t\.me|apps\.apple\.com|play\.google\.com|medium\.com)$/i;
const CLICK_TRACKER = /(?:^|\.)(?:sendgrid\.net|mailgun\.org|mandrillapp\.com|list-manage\.com|hubspotlinks\.com|mjt\.lu|awstrack\.me|mailchimp\.com|ct\.sendgrid\.net)$|^(?:click|clicks|links?|track|tracking|email|e|t|r)\./i;
const STATIC_ASSET = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js)$/i;
const MIN_LINK_SCORE = 25;

function htmlLinks(html: string): LinkOccurrence[] {
  const links: LinkOccurrence[] = [];
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|style|script|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  for (const match of stripped.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = HREF.exec(match[1]);
    if (!href) continue;
    const url = decodeHtmlEntities(href[1] ?? href[2] ?? href[3] ?? '').trim();
    let label = htmlToText(match[2]);
    if (!label) label = decodeHtmlEntities(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[2])?.slice(1).find(Boolean) ?? '');
    links.push({ url, label });
  }
  return links;
}

function textLinks(text: string): LinkOccurrence[] {
  const links: LinkOccurrence[] = [];
  for (const match of text.matchAll(BARE_URL)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    const start = match.index!;
    // The label of a bare link is the text before it on its line, or the previous line when it stands alone.
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    let label = text.slice(lineStart, start).replace(BARE_URL, ' ').trim();
    if (!label && lineStart > 0) {
      const previous = text.slice(0, lineStart).trimEnd();
      label = previous.slice(previous.lastIndexOf('\n') + 1).replace(BARE_URL, ' ').trim();
    }
    links.push({ url, label: label.slice(-120) });
  }
  return links;
}

function scoreLink(link: LinkOccurrence): ScoredValue | null {
  let parsed: URL;
  try {
    parsed = new URL(link.url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (/[\u0000-\u001f\u007f]/.test(link.url)) return null;
  const location = `${parsed.pathname}${parsed.search}`;
  if (LINK_SKIP.test(link.label) || LINK_SKIP.test(parsed.hostname) || LINK_SKIP.test(location)) return null;
  if (STATIC_ASSET.test(parsed.pathname)) return null;

  let score = 0;
  if (LINK_STRONG_LABEL.test(link.label)) score += 40;
  else if (LINK_WEAK_LABEL.test(link.label)) score += 10;
  if (LINK_STRONG_URL.test(location)) score += 30;
  const parts = [...parsed.pathname.split('/'), ...[...parsed.searchParams.values()]];
  if (parts.some((part) => part.length >= 16 && /\d/.test(part) && /[A-Za-z]/.test(part))) score += 15;
  if (LINK_NEGATIVE.test(link.label) || LINK_NEGATIVE.test(parsed.pathname)) score -= 40;
  if (SOCIAL_HOST.test(parsed.hostname)) score -= 40;
  if ((parsed.pathname === '/' || parsed.pathname === '') && !parsed.search) score -= 20;
  // Prefer a direct link over the same action wrapped in a click-tracking redirect.
  if (CLICK_TRACKER.test(parsed.hostname) || /\/(?:ls|wf)\/click\b/i.test(parsed.pathname)) score -= 15;
  return { value: parsed.href, score };
}

/**
 * The most likely verification, confirmation or magic sign-in link in the email.
 * Skips unsubscribe/preference links, images, social and policy links. Returns null when no link qualifies.
 */
export function extractLink(content: EmailContent): string | null {
  const occurrences = [
    ...(content.html ? htmlLinks(content.html) : []),
    ...textSources(content).flatMap(textLinks),
  ];
  const scored = occurrences.map(scoreLink).filter((link): link is ScoredValue => link !== null);
  return best(scored, MIN_LINK_SCORE);
}
