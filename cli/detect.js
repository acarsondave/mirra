const CHALLENGE_MARKERS = [
	'cf-chl', '_cf_chl_opt', 'challenge-platform', 'cf-browser-verification', 'cf_chl_prog',
	'captcha-delivery.com', 'geo.captcha-delivery', 'datadome',
	'px-captcha', '_pxhd', 'perimeterx',
	'_incapsula_resource', 'incapsula incident',
	'/_sec/cp_challenge', 'bm-verify', 'sec-if-cpt',
	'awswaf', 'aws-waf-token', 'challenge.js',
	'kpsdk', 'vercel security checkpoint', 'ddos-guard'
];
const CHALLENGE_TITLES = [
	'just a moment', 'attention required', 'access denied', 'access to this page has been denied',
	'pardon our interruption', 'security check', 'checking your browser', 'please wait', 'ddos-guard',
	'vercel security checkpoint', 'it needs a human touch', 'are you a robot', 'verify you are human',
	'human verification', 'request blocked', 'blocked', 'bot or not'
];

export function looksLikeChallenge (status, html, title = '') {
	if (!html) return status === 403 || status === 429 || status === 503;
	const head = html.slice(0, 60000).toLowerCase();
	const t = (title || (head.match(/<title[^>]*>([^<]*)/) || [])[1] || '').trim().toLowerCase();
	const markerHit = CHALLENGE_MARKERS.some(m => head.includes(m));
	const titleHit = CHALLENGE_TITLES.some(m => t.startsWith(m));
	// DataDome's block page uses the site name as its title.
	if ((status === 403 || status === 405) && markerHit) return true;
	// Normal pages also load challenge scripts, so a 200 needs both signals.
	if (status === 403 || status === 405 || status === 429 || status === 503) return markerHit || titleHit;
	return markerHit && titleHit;
}

// Little visible text plus scripts usually means the content is rendered client side.
export function looksLikeSpaShell (html) {
	if (!html || html.length > 400000) return false;
	const lower = html.toLowerCase();
	const scripts = (lower.match(/<script\b/g) || []).length;
	if (scripts === 0) return false;
	const body = lower.split(/<body[^>]*>/)[1] || lower;
	const text = body
		.replace(/<script[\s\S]*?<\/script>/g, ' ')
		.replace(/<style[\s\S]*?<\/style>/g, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const mountPoint = /id=["'](root|app|__next|__nuxt|svelte|q-app)["']/.test(lower);
	return text.length < 200 || (mountPoint && text.length < 600);
}
