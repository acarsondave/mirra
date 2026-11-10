const locs = (xml) => [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map(m => m[1].replace(/&amp;/g, '&'));

export async function seedFromSitemaps (startUrls, transport, { filter, limit, log }) {
	const found = new Set();
	for (const start of startUrls) {
		const origin = new URL(start).origin;
		const robots = await transport.robotsFor(new URL(start));
		const maps = new Set([...(robots?.getSitemaps() || []), `${origin}/sitemap.xml`]);
		const seen = new Set();
		const queue = [...maps];
		while (queue.length && found.size < limit) {
			const sm = queue.shift();
			if (seen.has(sm)) continue;
			seen.add(sm);
			const xml = await transport.fetchText(sm).catch(() => null);
			if (!xml) continue;
			for (const loc of locs(xml)) {
				if (/<sitemapindex/i.test(xml)) { if (seen.size < 50) queue.push(loc); continue; }
				if (filter(loc)) found.add(loc);
				if (found.size >= limit) break;
			}
			log.debug(`sitemap ${sm}: ${found.size} URLs so far`);
		}
	}
	return [...found];
}
