import assert from 'node:assert/strict';
import {
  getLegalPublicationStatus, getLegalSupportContact, legalConfig,
} from '../../lib/legal/config.ts';

const base = new URL(process.argv[2] || 'http://127.0.0.1:3000');
assert.equal(base.protocol, 'http:', 'Legal smoke must use local HTTP');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Only loopback hosts are allowed');
assert.ok(!base.username && !base.password, 'Credentials are not accepted');

function decode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    result[match[1].toLowerCase()] = decode(match[2]);
  }
  return result;
}

function element(html: string, tag: string, attribute: string, value: string): string {
  for (const match of html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))) {
    if (attributes(match[0])[attribute] !== value) continue;
    const start = match.index;
    const end = html.indexOf(`</${tag}>`, start);
    assert.ok(end >= start, `Missing closing ${tag}`);
    return html.slice(start, end + tag.length + 3);
  }
  assert.fail(`Missing ${tag} with ${attribute}=${value}`);
}

function textContent(html: string): string {
  return decode(html.replace(/<[^>]+>/g, '')).trim();
}

const status = getLegalPublicationStatus();
const support = getLegalSupportContact();
const titles = new Set<string>();
const descriptions = new Set<string>();

for (const locale of ['zh-CN', 'en'] as const) {
  for (const kind of ['privacy', 'terms'] as const) {
    const path = `/${locale}/${kind}`;
    const response = await fetch(new URL(path, base), {
      redirect: 'error',
      headers: { 'User-Agent': 'Twitterbot/1.0', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(45_000),
    });
    assert.equal(response.status, 200, `${path} must render`);
    assert.match(response.headers.get('content-type') || '', /text\/html/i);
    const html = await response.text();
    const htmlTag = html.match(/<html\b[^>]*>/i)?.[0];
    assert.ok(htmlTag, `${path}: missing html element`);
    assert.equal(attributes(htmlTag).lang, locale, `${path}: incorrect document language`);
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
    assert.ok(head, `${path}: metadata must be present in head for a crawler`);
    const meta = Array.from(head.matchAll(/<meta\b[^>]*>/gi), (match) => attributes(match[0]));
    const links = Array.from(head.matchAll(/<link\b[^>]*>/gi), (match) => attributes(match[0]));
    const title = textContent(head.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const description = meta.find((item) => item.name === 'description')?.content;
    assert.ok(title && description, `${path}: title and description are required`);
    titles.add(title);
    descriptions.add(description);
    const canonical = links.find((item) => item.rel === 'canonical')?.href;
    assert.ok(canonical, `${path}: canonical is required`);
    const canonicalURL = new URL(canonical);
    assert.equal(canonicalURL.pathname, path);
    assert.equal(canonicalURL.search, '');
    for (const language of ['zh-CN', 'en', 'x-default']) {
      const alternate = links.find((item) => item.rel === 'alternate' && item.hreflang === language)?.href;
      assert.ok(alternate, `${path}: missing ${language} alternate`);
      const expectedLocale = language === 'x-default' ? 'zh-CN' : language;
      assert.equal(new URL(alternate).pathname, `/${expectedLocale}/${kind}`);
      assert.equal(new URL(alternate).origin, canonicalURL.origin);
    }
    assert.equal(meta.find((item) => item.property === 'og:url')?.content, canonical);
    assert.equal(meta.find((item) => item.property === 'og:locale')?.content, locale === 'zh-CN' ? 'zh_CN' : 'en_US');
    const robots = meta.find((item) => item.name === 'robots')?.content || '';
    assert.match(robots, status.isDraft ? /\bnoindex\b/i : /\bindex\b/i);
    assert.match(robots, status.isDraft ? /\bnofollow\b/i : /\bfollow\b/i);

    const main = element(html, 'main', 'data-legal-document', kind);
    const mainTag = main.match(/<main\b[^>]*>/i)?.[0];
    assert.ok(mainTag);
    assert.equal(attributes(mainTag)['data-legal-status'], status.isDraft ? 'draft' : 'approved');
    const heading = textContent(main.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
    assert.ok(heading && title.includes(heading), `${path}: localized visible title must match metadata`);
    if (locale === 'zh-CN') assert.match(heading, /[\u3400-\u9fff]/u);
    else assert.doesNotMatch(heading, /[\u3400-\u9fff]/u);
    assert.doesNotMatch(textContent(main), /\bLegal\.[\w.]+/, `${path}: unresolved translation`);

    if (status.isDraft) {
      const note = element(main, 'aside', 'data-legal-draft', 'true');
      const noteTag = note.match(/<aside\b[^>]*>/i)?.[0];
      assert.ok(noteTag);
      assert.equal(attributes(noteTag).role, 'note');
      assert.deepEqual(attributes(noteTag)['data-missing-fields'].split(',').sort(), [...status.missingFields].sort());
      assert.ok(textContent(note).length > 40, `${path}: draft notice must be visible`);
    } else {
      assert.doesNotMatch(main, /data-legal-draft="true"/);
    }

    for (const field of ['operatorName', 'supportContact', 'effectiveDate'] as const) {
      const value = element(main, 'dd', 'data-legal-field', field);
      const valueTag = value.match(/<dd\b[^>]*>/i)?.[0];
      assert.ok(valueTag);
      assert.equal(attributes(valueTag)['data-configured'], String(!status.missingFields.includes(field)));
      assert.ok(textContent(value).length > 0, `${path}: missing configuration must be disclosed`);
      if (field === 'operatorName' && legalConfig.operatorName?.trim()) {
        assert.equal(textContent(value), legalConfig.operatorName.trim());
      }
      if (field === 'supportContact') {
        if (support) assert.ok(value.includes(`href="${support.href.replaceAll('&', '&amp;')}"`));
        else assert.doesNotMatch(value, /<a\b|mailto:/i, `${path}: do not invent a contact link`);
      }
      if (field === 'effectiveDate' && status.missingFields.includes(field)) {
        assert.doesNotMatch(textContent(value), /\d{4}/, `${path}: do not invent an effective date`);
      }
    }
    const detailsField = kind === 'privacy' ? 'privacyDetails' : 'termsDetails';
    const details = element(main, 'section', 'data-legal-field', detailsField);
    const detailsTag = details.match(/<section\b[^>]*>/i)?.[0];
    assert.ok(detailsTag);
    assert.equal(attributes(detailsTag)['data-configured'], String(Boolean(legalConfig[detailsField]?.[locale].trim())));
    assert.ok(textContent(details).length > 40, `${path}: policy details or their absence must be explained`);
    for (const destination of ['', '/pricing', '/faq', '/privacy', '/terms']) {
      const route = `/${locale}${destination}`;
      assert.ok(Array.from(html.matchAll(/<a\b[^>]*>/gi), (match) => attributes(match[0])).some((item) => item.href === route), `${path}: missing public navigation ${route}`);
    }
    console.log(`PASS ${path}: language, metadata, ${status.isDraft ? 'draft noindex' : 'approved indexing'}, configuration and navigation`);
  }
}

assert.equal(titles.size, 4, 'Every legal page needs its own localized title');
assert.equal(descriptions.size, 4, 'Every legal page needs its own localized description');
console.log('PASS legal pages: local HTTP checks only; no accounts, payments or email created');
