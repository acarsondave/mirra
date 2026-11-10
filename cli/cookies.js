import fs from 'node:fs';
import { CookieJar, Cookie } from 'tough-cookie';

export class SharedJar extends CookieJar {
	constructor () {
		super(undefined, { looseMode: true, rejectPublicSuffixes: false });
	}

	// Netscape cookies.txt format, as exported by most cookie extensions.
	loadNetscape (file) {
		const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
		let n = 0;
		for (let line of lines) {
			let httpOnly = false;
			if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice(10); }
			if (!line.trim() || line.startsWith('#')) continue;
			const [domain, , cpath, secure, expires, name, value = ''] = line.split('\t');
			if (!name) continue;
			const cookie = new Cookie({
				key: name, value, domain: domain.replace(/^\./, ''), path: cpath || '/',
				secure: secure === 'TRUE', httpOnly,
				expires: Number(expires) > 0 ? new Date(Number(expires) * 1000) : 'Infinity'
			});
			const host = cookie.domain;
			this.setCookieSync(cookie, `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`, { ignoreError: true });
			n++;
		}
		return n;
	}

	async importBrowserCookies (cookies) {
		for (const c of cookies) {
			const cookie = new Cookie({
				key: c.name, value: c.value, domain: c.domain.replace(/^\./, ''), path: c.path,
				secure: c.secure, httpOnly: c.httpOnly,
				expires: c.expires > 0 ? new Date(c.expires * 1000) : 'Infinity'
			});
			await this.setCookie(cookie, `https://${cookie.domain}${cookie.path}`, { ignoreError: true }).catch(() => {});
		}
	}

	async exportForBrowser () {
		const all = (await this.serialize()).cookies || [];
		return all.map(c => ({
			name: c.key, value: c.value, domain: c.hostOnly ? c.domain : `.${c.domain}`, path: c.path || '/',
			secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly),
			expires: c.expires && c.expires !== 'Infinity' ? Math.floor(new Date(c.expires).getTime() / 1000) : -1
		}));
	}
}
