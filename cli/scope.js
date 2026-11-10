const stripWww = (h) => h.replace(/^www\./, '');

export function makeScope (startUrls, scope) {
	const starts = startUrls.map(u => new URL(u));
	return (raw) => {
		let u;
		try { u = new URL(raw); } catch { return false; }
		if (!/^https?:$/.test(u.protocol)) return false;
		return starts.some(s => {
			const host = stripWww(u.hostname);
			const base = stripWww(s.hostname);
			switch (scope) {
				case 'all': return true;
				case 'host': return host === base;
				case 'prefix': {
					const dir = s.pathname.endsWith('/') ? s.pathname : s.pathname.replace(/[^/]*$/, '');
					return host === base && u.pathname.startsWith(dir);
				}
				default: return host === base || host.endsWith(`.${base}`);
			}
		});
	};
}

export function globToRegExp (glob) {
	const re = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
	return new RegExp(`^${re}$`, 'i');
}
