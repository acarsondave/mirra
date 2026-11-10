#!/usr/bin/env node
process.noDeprecation = true; // lib/ still uses url.parse()
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import scrape from '../index.mjs';
import defaults from '../lib/config/defaults.js';
import { createTransport } from './transport.js';
import { BrowserLane } from './browser.js';
import { SharedJar } from './cookies.js';
import { seedFromSitemaps } from './sitemap.js';
import { makeScope, globToRegExp } from './scope.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const program = new Command()
	.name('mirra')
	.description('Download a website for offline browsing.')
	.version(pkg.version)
	.argument('<urls...>', 'start URL(s)')
	.requiredOption('-o, --output <dir>', 'output directory (must not exist)')
	.option('-d, --depth <n>', 'link depth to follow (0 = only the start pages)', v => parseInt(v, 10), 3)
	.option('-n, --max-pages <n>', 'stop after N HTML pages (0 = unlimited)', v => parseInt(v, 10), 0)
	.addOption(new Option('-s, --scope <scope>', 'which links to follow').choices(['host', 'domain', 'prefix', 'all']).default('domain'))
	.option('-i, --include <glob...>', 'only follow links matching these globs, e.g. "*/docs/*"')
	.option('-x, --exclude <glob...>', 'never fetch URLs matching these globs, e.g. "*.zip" "*/logout*"')
	.option('--sitemap', 'also seed pages from robots.txt/sitemap.xml')
	.addOption(new Option('-r, --render <mode>', 'run pages through a real browser').choices(['auto', 'always', 'never']).default('auto'))
	.option('--no-scroll', 'do not auto-scroll rendered pages (lazy-loaded media)')
	.option('--no-js', 'strip <script> from saved pages (static snapshot that never re-hydrates)')
	.option('--no-browser', 'never launch a browser (pure HTTP, like httrack)')
	.option('--headful', 'show the browser window; you can complete interactive checks (Turnstile etc.) yourself')
	.option('--challenge-wait <s>', 'seconds to wait for a bot check to clear (default 30, 180 with --headful)', v => parseInt(v, 10))
	.addOption(new Option('--fingerprint <browser>', 'TLS/HTTP2 fingerprint to impersonate').choices(['chrome', 'firefox']).default('chrome'))
	.option('--http3', 'allow HTTP/3')
	.option('-c, --concurrency <n>', 'total parallel requests', v => parseInt(v, 10), 32)
	.option('--per-host <n>', 'parallel requests per host', v => parseInt(v, 10), 16)
	.option('--delay <ms>', 'optional throttle: average gap between requests to one host (jittered)', v => parseInt(v, 10), 0)
	.option('--retries <n>', 'retries on network errors / 429 / 5xx', v => parseInt(v, 10), 3)
	.option('--timeout <s>', 'per-request timeout in seconds', v => parseInt(v, 10), 30)
	.option('--max-size <mb>', 'skip files larger than this many MB', v => parseFloat(v), 0)
	.option('--proxy <url>', 'HTTP/SOCKS proxy, e.g. socks5://127.0.0.1:9050')
	.option('--cookies <file>', 'Netscape cookies.txt to reuse a logged-in session')
	.option('-H, --header <header...>', 'extra request header, "Name: value"')
	.option('--respect-robots', 'obey robots.txt Disallow and Crawl-delay (off by default)')
	.option('--pretty-urls', 'save /about/index.html as /about/ links')
	.option('-q, --quiet', 'only print the summary')
	.option('-v, --verbose', 'debug logging')
	.showHelpAfterError();

program.parse();
const opts = program.opts();
const startUrls = program.args.map(u => (/^https?:\/\//i.test(u) ? u : `https://${u}`));

const log = {
	info: (m) => { if (!opts.quiet) process.stderr.write(`· ${m}\n`); },
	warn: (m) => process.stderr.write(`! ${m}\n`),
	debug: (m) => { if (opts.verbose) process.stderr.write(`  ${m}\n`); }
};

const outDir = path.resolve(opts.output);
if (fs.existsSync(outDir)) {
	log.warn(`${outDir} already exists, choose another --output directory`);
	process.exit(2);
}

const report = { started: new Date().toISOString(), saved: [], skipped: [], errors: [], blocked: [], via: { http: 0, browser: 0 } };
const stats = {
	skip: (url, reason) => { report.skipped.push({ url, reason }); log.debug(`skip ${url}: ${reason}`); },
	error: (url, reason) => { report.errors.push({ url, reason }); log.debug(`error ${url}: ${reason}`); },
	blocked: (url) => report.blocked.push(url),
	fetched: (via) => { report.via[via] = (report.via[via] || 0) + 1; }
};

const headers = {};
for (const h of opts.header || []) {
	const i = h.indexOf(':');
	if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
}

const jar = new SharedJar();
if (opts.cookies) log.info(`cookies: loaded ${jar.loadNetscape(opts.cookies)} from ${opts.cookies}`);

const browser = new BrowserLane({ headful: opts.headful, proxy: opts.proxy,
	challengeWaitMs: 1000 * (opts.challengeWait ?? (opts.headful ? 180 : 30)), maxPages: 4,
	initialCookies: () => jar.exportForBrowser(),
	log
});

const transport = createTransport({
	fingerprint: opts.fingerprint,
	proxy: opts.proxy,
	http3: Boolean(opts.http3),
	timeoutMs: opts.timeout * 1000,
	retries: opts.retries,
	perHost: opts.perHost,
	delayMs: opts.delay,
	maxBytes: opts.maxSize ? Math.round(opts.maxSize * 1024 * 1024) : 0,
	maxPages: opts.maxPages,
	respectRobots: Boolean(opts.respectRobots),
	browserEnabled: opts.browser !== false,
	render: opts.browser === false ? 'never' : opts.render,
	scroll: opts.scroll,
	stripScripts: opts.js === false,
	headers
}, { browser, jar, stats, log });

const inScope = makeScope(startUrls, opts.scope);
const includes = (opts.include || []).map(globToRegExp);
const excludes = (opts.exclude || []).map(globToRegExp);
const urlFilter = (url) => !excludes.some(re => re.test(url));
const linkFilter = (url) => inScope(url) && urlFilter(url) && (!includes.length || includes.some(re => re.test(url)));

let urls = [...startUrls];
if (opts.sitemap) {
	const extra = await seedFromSitemaps(startUrls, transport, { filter: linkFilter, limit: opts.maxPages || 5000, log });
	urls = [...new Set([...urls, ...extra])];
	log.info(`sitemap: seeded ${extra.length} URLs`);
}

class ProgressPlugin {
	apply (register) {
		register('onResourceSaved', ({ resource }) => {
			const entry = { url: resource.getUrl(), file: resource.getFilename(), type: resource.getType() || 'other' };
			report.saved.push(entry);
			if (!opts.quiet) process.stderr.write(`✓ ${String(report.saved.length).padStart(5)} ${entry.type.padEnd(5)} ${entry.url}\n`);
		});
		register('onResourceError', ({ resource, error }) => {
			report.errors.push({ url: resource.getUrl(), reason: error.message || String(error) });
			log.debug(`✗ ${resource.getUrl()}: ${error.message}`);
		});
	}
}

const extraSources = [
	{ selector: 'link[rel="preload"]', attr: 'href' },
	{ selector: 'link[rel="modulepreload"]', attr: 'href' },
	{ selector: 'link[rel="manifest"]', attr: 'href' },
	{ selector: 'link[rel="apple-touch-icon"]', attr: 'href' },
	{ selector: 'link[rel="mask-icon"]', attr: 'href' },
	{ selector: 'video', attr: 'poster' },
	{ selector: 'img[data-src]', attr: 'data-src' },
	{ selector: '*[data-srcset]', attr: 'data-srcset' },
	{ selector: 'source', attr: 'srcset' },
	{ selector: 'meta[name="twitter:image"]', attr: 'content' }
];

async function finish (code) {
	await browser.close();
	report.finished = new Date().toISOString();
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'mirra-report.json'), JSON.stringify(report, null, 2));
	const entry = report.saved[0]?.file;
	process.stderr.write(`\nmirra: ${report.saved.length} files saved (${report.via.http} via http, ${report.via.browser} via browser), ` +
		`${report.skipped.length} skipped, ${report.errors.length} errors${report.blocked.length ? `, ${report.blocked.length} still blocked by bot walls` : ''}\n`);
	if (entry) process.stderr.write(`open: ${path.join(outDir, entry)}\nreport: ${path.join(outDir, 'mirra-report.json')}\n`);
	process.exit(code);
}

let interrupted = false;
process.on('SIGINT', () => {
	if (interrupted) process.exit(130);
	interrupted = true;
	log.warn('interrupted, writing the report (press Ctrl-C again to quit now)');
	finish(130);
});

try {
	await scrape({
		urls,
		directory: outDir,
		recursive: opts.depth > 0,
		maxRecursiveDepth: opts.depth > 0 ? opts.depth : null,
		requestConcurrency: opts.concurrency,
		filenameGenerator: 'bySiteStructure',
		prettifyUrls: Boolean(opts.prettyUrls),
		sources: [...defaults.sources, ...extraSources],
		urlFilter,
		linkFilter,
		transport,
		ignoreErrors: true,
		plugins: [new ProgressPlugin()]
	});
	await finish(report.saved.length ? 0 : 1);
} catch (err) {
	log.warn(err.stack || err.message);
	await finish(1);
}
