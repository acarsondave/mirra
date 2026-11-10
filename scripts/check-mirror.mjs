#!/usr/bin/env node
// Checks that every local reference in a mirror resolves to a file.
import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';

const [root, origin] = process.argv.slice(2);
if (!root) {
	console.error('usage: node scripts/check-mirror.mjs <mirror-dir> [live-origin e.g. https://example.com]');
	process.exit(2);
}

const files = [];
(function walk (d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p); else files.push(p);
	}
})(root);

const missing = new Map();
const live = new Map();
let checked = 0;

function check (from, ref) {
	if (!ref) return;
	ref = ref.trim();
	if (/^(#|data:|mailto:|tel:|javascript:|blob:|about:)/i.test(ref)) return;
	if (/^(https?:)?\/\//i.test(ref)) {
		if (origin && ref.replace(/^\/\//, 'https://').startsWith(origin)) live.set(ref, from);
		return;
	}
	checked++;
	let clean = ref.split('#')[0].split('?')[0];
	try { clean = decodeURIComponent(clean); } catch { /* keep raw */ }
	if (!clean) return;
	const target = clean.startsWith('/') ? path.join(root, clean) : path.resolve(path.dirname(from), clean);
	const ok = fs.existsSync(target) && (fs.statSync(target).isFile() || fs.existsSync(path.join(target, 'index.html')));
	if (!ok) missing.set(`${ref}`, path.relative(root, from));
}

const cssUrls = (text) => [...text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(m => m[1]);
for (const f of files) {
	if (/\.html?$/i.test(f)) {
		const $ = cheerio.load(fs.readFileSync(f, 'utf8'));
		$('[href]').each((_, el) => { if (el.tagName !== 'base') check(f, $(el).attr('href')); });
		$('[src]').each((_, el) => check(f, $(el).attr('src')));
		$('[srcset], [data-srcset]').each((_, el) => {
			for (const part of ($(el).attr('srcset') || $(el).attr('data-srcset')).split(',')) check(f, part.trim().split(/\s+/)[0]);
		});
		$('[style]').each((_, el) => cssUrls($(el).attr('style')).forEach(u => check(f, u)));
		$('style').each((_, el) => cssUrls($(el).html()).forEach(u => check(f, u)));
	} else if (/\.css$/i.test(f)) {
		cssUrls(fs.readFileSync(f, 'utf8')).forEach(u => check(f, u));
	}
}

const html = files.filter(f => /\.html?$/i.test(f)).length;
console.log(`files: ${files.length} (html ${html}) · local refs checked: ${checked} · broken: ${missing.size} · still-live origin links: ${live.size}`);
for (const [ref, from] of [...missing].slice(0, 25)) console.log(`  BROKEN ${ref}   (in ${from})`);
for (const [ref] of [...live].slice(0, 15)) console.log(`  LIVE   ${ref}`);
process.exit(missing.size ? 1 : 0);
