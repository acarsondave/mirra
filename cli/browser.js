import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { looksLikeChallenge } from './detect.js';

// Headless Chrome is easy to fingerprint, so on Linux run a normal window on a private Xvfb display.
function startVirtualDisplay () {
	if (process.platform !== 'linux' || process.env.DISPLAY) return null;
	if (spawnSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' }).status !== 0) return null;
	const display = `:${100 + Math.floor(Math.random() * 800)}`;
	const proc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: false });
	return { display, proc };
}

export class BrowserLane {
	constructor ({ headful = false, proxy = null, maxPages = 2, navTimeoutMs = 45000, challengeWaitMs = 30000, initialCookies = async () => [], log }) {
		this.opts = { headful, proxy, navTimeoutMs, challengeWaitMs, initialCookies };
		this.maxPages = maxPages;
		this.active = 0;
		this.waiters = [];
		this.log = log;
		this.context = null;
		this.starting = null;
		this.userAgent = null;
	}

	async start () {
		if (this.context) return this.context;
		if (this.starting) return this.starting;
		this.starting = (async () => {
			let chromium;
			try {
				({ chromium } = await import('patchright'));
			} catch {
				throw new Error('Browser mode needs patchright. Run: npx patchright install chromium');
			}
			this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirra-profile-'));
			let headless = !this.opts.headful;
			const env = { ...process.env };
			if (headless) {
				this.xvfb = startVirtualDisplay();
				if (this.xvfb) {
					await new Promise(r => setTimeout(r, 400));
					env.DISPLAY = this.xvfb.display;
					headless = false;
				}
			}
			let offscreen = false;
			if (headless && process.platform !== 'linux') {
				headless = false;
				offscreen = true;
			}
			const mode = this.opts.headful ? 'visible' : this.xvfb ? `virtual display ${this.xvfb.display}` : offscreen ? 'off-screen window' : 'headless (install Xvfb for better stealth)';
			const launch = (channel) => chromium.launchPersistentContext(this.profileDir, {
				channel,
				headless,
				env,
				viewport: null,
				args: headless ? [] : ['--window-size=1920,1080', '--enable-unsafe-swiftshader', ...(offscreen ? ['--window-position=-32000,-32000'] : [])],
				proxy: this.opts.proxy ? { server: this.opts.proxy } : undefined,
				ignoreHTTPSErrors: true
			});
			try {
				this.context = await launch('chrome');
				this.log.info(`browser: Google Chrome, ${mode}`);
			} catch {
				this.context = await launch(undefined);
				this.log.info(`browser: bundled Chromium, ${mode}`);
			}
			const page = this.context.pages()[0] || await this.context.newPage();
			this.userAgent = await page.evaluate(() => navigator.userAgent);
			// Closing the last tab would close the window.
			this.keepAlive = page;
			await this.context.addCookies(await this.opts.initialCookies()).catch(() => {});
			return this.context;
		})();
		return this.starting;
	}

	async withPage (fn) {
		await this.start();
		if (this.active >= this.maxPages) await new Promise(r => this.waiters.push(r));
		this.active++;
		const page = await this.context.newPage();
		try {
			return await fn(page);
		} finally {
			await page.close().catch(() => {});
			this.active--;
			const next = this.waiters.shift();
			if (next) next();
		}
	}

	async addCookies (cookies) {
		if (!cookies.length) return;
		await this.start();
		await this.context.addCookies(cookies).catch(e => this.log.warn(`browser: cookie import failed: ${e.message}`));
	}

	async cookies () {
		return this.context ? this.context.cookies() : [];
	}

	async open (page, url) {
		// Challenge pages redirect to the real page, so goto()'s response goes stale.
		let docStatus = 0;
		page.on('response', (r) => {
			const req = r.request();
			if (req.isNavigationRequest() && req.frame() === page.mainFrame()) docStatus = r.status();
		});
		const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.navTimeoutMs });
		const deadline = Date.now() + this.opts.challengeWaitMs;
		let html = await page.content();
		let status = docStatus || (response ? response.status() : 0);
		if (this.opts.headful && looksLikeChallenge(status, html, await page.title().catch(() => ''))) {
			this.log.warn(`${new URL(url).host} wants a human check. Complete it in the browser window (waiting ${Math.round(this.opts.challengeWaitMs / 1000)}s).`);
		}
		while (looksLikeChallenge(status, html, await page.title().catch(() => '')) && Date.now() < deadline) {
			await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
			await page.waitForTimeout(1000);
			html = await page.content().catch(() => html);
			status = docStatus;
		}
		const blocked = looksLikeChallenge(docStatus, html, await page.title().catch(() => ''));
		return { response, blocked };
	}

	async autoScroll (page, maxMs = 8000) {
		await page.evaluate(async (maxMs) => {
			const start = Date.now();
			let last = -1;
			while (Date.now() - start < maxMs) {
				window.scrollBy(0, Math.max(400, window.innerHeight * 0.8));
				await new Promise(r => setTimeout(r, 250));
				const y = window.scrollY + window.innerHeight;
				if (y >= document.documentElement.scrollHeight && y === last) break;
				last = y;
			}
			window.scrollTo(0, 0);
		}, maxMs).catch(() => {});
	}

	async render (url, { scroll = true, settleMs = 1500 } = {}) {
		return this.withPage(async (page) => {
			const { response, blocked } = await this.open(page, url);
			if (!blocked) {
				await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
				if (scroll) await this.autoScroll(page);
				await page.waitForTimeout(settleMs);
			}
			const html = await page.content();
			const headers = response ? await response.allHeaders().catch(() => ({})) : {};
			return {
				url: page.url(),
				statusCode: blocked ? 403 : 200,
				headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
				body: Buffer.from(html, 'utf8'),
				blocked
			};
		});
	}

	async fetchRaw (url) {
		return this.withPage(async (page) => {
			const { response, blocked } = await this.open(page, url);
			if (!response) throw new Error(`browser: no response for ${url}`);
			let body;
			try {
				body = await response.body();
			} catch {
				body = Buffer.from(await page.content(), 'utf8');
			}
			return {
				url: page.url(),
				statusCode: blocked ? 403 : response.status(),
				headers: await response.allHeaders().catch(() => ({})),
				body,
				blocked
			};
		});
	}

	async close () {
		if (this.context) await this.context.close().catch(() => {});
		if (this.xvfb) this.xvfb.proc.kill();
		if (this.profileDir) fs.rmSync(this.profileDir, { recursive: true, force: true });
		this.context = null;
	}
}
