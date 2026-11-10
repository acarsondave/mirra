import { Impit } from 'impit';
import robotsParser from 'robots-parser';
import * as cheerio from 'cheerio';
import { looksLikeChallenge, looksLikeSpaShell } from './detect.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

function headersToObject (headers) {
	const out = {};
	headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
	return out;
}

function retryAfterMs (value) {
	if (!value) return null;
	const s = Number(value);
	if (Number.isFinite(s)) return Math.min(s * 1000, 120000);
	const at = Date.parse(value);
	return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 120000) : null;
}

const isHtml = (headers) => /text\/html|application\/xhtml/i.test(headers['content-type'] || '');

// Limits requests in flight per host, with an optional jittered gap between them.
class HostGate {
	constructor (concurrency, delayMs) {
		this.concurrency = concurrency;
		this.delayMs = delayMs;
		this.hosts = new Map();
	}
	state (host) {
		if (!this.hosts.has(host)) this.hosts.set(host, { active: 0, queue: [], next: 0, delayMs: this.delayMs });
		return this.hosts.get(host);
	}
	setMinDelay (host, ms) {
		const s = this.state(host);
		s.delayMs = Math.max(s.delayMs, ms);
	}
	async run (host, fn) {
		const s = this.state(host);
		if (s.active >= this.concurrency) await new Promise(r => s.queue.push(r));
		s.active++;
		try {
			const now = Date.now();
			const wait = Math.max(0, s.next - now);
			s.next = Math.max(now, s.next) + s.delayMs * (0.5 + Math.random());
			if (wait) await sleep(wait);
			return await fn();
		} finally {
			s.active--;
			const n = s.queue.shift();
			if (n) n();
		}
	}
}

export function createTransport (cfg, { browser, jar, stats, log }) {
	const impit = new Impit({
		browser: cfg.fingerprint,
		proxyUrl: cfg.proxy || undefined,
		ignoreTlsErrors: true,
		timeout: cfg.timeoutMs,
		followRedirects: true,
		maxRedirects: 10,
		cookieJar: jar,
		http3: cfg.http3
	});
	const gate = new HostGate(cfg.perHost, cfg.delayMs);
	const robotsCache = new Map();
	const walledHosts = new Set();
	let pages = 0;

	async function robotsFor (u) {
		const origin = u.origin;
		if (!robotsCache.has(origin)) {
			robotsCache.set(origin, (async () => {
				try {
					const res = await impit.fetch(`${origin}/robots.txt`);
					const txt = res.ok ? await res.text() : '';
					const robots = robotsParser(`${origin}/robots.txt`, txt);
					const delay = robots.getCrawlDelay('mirra');
					if (delay) gate.setMinDelay(u.host, Math.min(delay * 1000, 30000));
					return robots;
				} catch {
					return null;
				}
			})());
		}
		return robotsCache.get(origin);
	}

	async function httpFetch (url, headers) {
		let lastErr;
		for (let attempt = 0; attempt <= cfg.retries; attempt++) {
			try {
				const res = await impit.fetch(url, { headers });
				const h = headersToObject(res.headers);
				const len = Number(h['content-length'] || 0);
				if (cfg.maxBytes && len > cfg.maxBytes) {
					stats.skip(url, `larger than --max-size (${len} bytes)`);
					return null;
				}
				const body = Buffer.from(await res.arrayBuffer());
				if (RETRYABLE.has(res.status) && attempt < cfg.retries && !looksLikeChallenge(res.status, body.toString('utf8', 0, 60000))) {
					const wait = retryAfterMs(h['retry-after']) ?? (1000 * 2 ** attempt + Math.random() * 500);
					log.debug(`retry ${attempt + 1}/${cfg.retries} ${res.status} ${url} in ${Math.round(wait)}ms`);
					await sleep(wait);
					continue;
				}
				return { url: res.url || url, statusCode: res.status, headers: h, body };
			} catch (err) {
				lastErr = err;
				if (attempt < cfg.retries) await sleep(1000 * 2 ** attempt + Math.random() * 500);
			}
		}
		throw lastErr;
	}

	async function viaBrowser (url, wantHtml) {
		const r = wantHtml ? await browser.render(url, { scroll: cfg.scroll }) : await browser.fetchRaw(url);
		// Reuse the clearance cookies for plain HTTP requests.
		await jar.importBrowserCookies(await browser.cookies());
		if (r.blocked) stats.blocked(url);
		return { ...r, via: 'browser' };
	}

	function postProcess (result) {
		if (!cfg.stripScripts || !isHtml(result.headers)) return result;
		const $ = cheerio.load(result.body.toString('utf8'));
		$('script').remove();
		$('link[rel="modulepreload"], link[rel="preload"][as="script"]').remove();
		return { ...result, body: Buffer.from($.html(), 'utf8') };
	}

	async function transport ({ url, options, resource }) {
		const u = new URL(url);
		if (!/^https?:$/.test(u.protocol)) return null;
		if (cfg.respectRobots) {
			const robots = await robotsFor(u);
			if (robots && robots.isAllowed(url, 'mirra') === false) {
				stats.skip(url, 'disallowed by robots.txt');
				return null;
			}
		}
		const headers = { ...(cfg.headers || {}) };
		if (options?.headers?.referer) headers.referer = options.headers.referer;

		return gate.run(u.host, async () => {
			let result;
			try {
				result = { ...(await httpFetch(url, headers)), via: 'http' };
			} catch (err) {
				if (!cfg.browserEnabled) throw err;
				log.debug(`http failed for ${url} (${err.message}); trying browser`);
				result = await viaBrowser(url, false);
			}
			if (!result || result.url === undefined) return null;

			let text = isHtml(result.headers) || result.statusCode >= 400 ? result.body.toString('utf8', 0, 200000) : '';

			// Challenges triggered by request bursts usually pass on a short retry.
			for (let i = 0; i < 2 && looksLikeChallenge(result.statusCode, text); i++) {
				await sleep(1500 * (i + 1) + Math.random() * 1000);
				const again = await httpFetch(url, headers).catch(() => null);
				if (!again) break;
				result = { ...again, via: 'http' };
				text = isHtml(result.headers) || result.statusCode >= 400 ? result.body.toString('utf8', 0, 200000) : '';
			}
			if (cfg.browserEnabled && looksLikeChallenge(result.statusCode, text)) {
				if (!walledHosts.has(u.host)) log.info(`${u.host} is serving a bot check, retrying in the browser`);
				walledHosts.add(u.host);
				result = await viaBrowser(url, isHtml(result.headers) || /\/$|\.html?$/i.test(u.pathname));
			} else if (cfg.browserEnabled && isHtml(result.headers) && result.statusCode < 400 &&
				(cfg.render === 'always' || (cfg.render === 'auto' && looksLikeSpaShell(text)))) {
				log.debug(`rendering ${url}`);
				result = await viaBrowser(url, true);
			}

			if (result.blocked) {
				stats.error(url, 'blocked by a human check (try --headful)');
				return null;
			}
			if (result.statusCode >= 400) {
				stats.error(url, `HTTP ${result.statusCode}`);
				return null;
			}
			if (isHtml(result.headers) && resource && resource.getDepth() > 0) {
				if (cfg.maxPages && pages >= cfg.maxPages) {
					stats.skip(url, '--max-pages reached');
					return null;
				}
			}
			if (isHtml(result.headers)) pages++;
			if (cfg.maxBytes && result.body.length > cfg.maxBytes) {
				stats.skip(url, `larger than --max-size (${result.body.length} bytes)`);
				return null;
			}
			stats.fetched(result.via);
			return postProcess(result);
		});
	}

	transport.fetchText = async (url) => {
		const r = await httpFetch(url, cfg.headers || {});
		return r && r.statusCode < 400 ? r.body.toString('utf8') : null;
	};
	transport.robotsFor = robotsFor;
	return transport;
}
