import * as chai from 'chai';
chai.should();
import '../../utils/assertions.js';
import fs from 'fs';
import scrape from 'mirra';
import { looksLikeChallenge, looksLikeSpaShell } from '../../../cli/detect.js';

const testDirname = './test/functional/mirra/.tmp';

const pages = {
	'http://example.com/': '<html><body><a href="/in.html">in</a><a href="/blocked.html">b</a><a href="http://other.com/x">o</a><img src="http://cdn.other.com/a.png"></body></html>',
	'http://example.com/in.html': '<html><body>in</body></html>',
	'http://cdn.other.com/a.png': 'PNG'
};

function fakeTransport (requested) {
	return async ({ url }) => {
		requested.push(url);
		if (!(url in pages)) return null; // e.g. bot wall / robots / limits
		const html = url.endsWith('/') || url.endsWith('.html');
		return { url, statusCode: 200, headers: { 'content-type': html ? 'text/html' : 'image/png' }, body: Buffer.from(pages[url]) };
	};
}

describe('Functional: mirra extensions', () => {
	afterEach(() => fs.rmSync(testDirname, { recursive: true, force: true }));

	it('follows only in-scope links, fetches requisites anywhere, and keeps unmirrored links live', async () => {
		const requested = [];
		await scrape({
			urls: ['http://example.com/'],
			directory: testDirname,
			recursive: true,
			maxRecursiveDepth: 2,
			filenameGenerator: 'bySiteStructure',
			linkFilter: (u) => new URL(u).hostname === 'example.com',
			transport: fakeTransport(requested)
		});
		requested.should.not.include('http://other.com/x');
		requested.should.include('http://cdn.other.com/a.png');
		const index = fs.readFileSync(`${testDirname}/example.com/index.html`, 'utf8');
		index.should.include('href="in.html"');
		index.should.include('href="http://example.com/blocked.html"'); // transport skipped it → live URL, not a dead local path
		index.should.include('href="http://other.com/x"');
		index.should.include('src="../cdn.other.com/a.png"');
	});

	it('detects bot-wall interstitials without flagging real pages', () => {
		looksLikeChallenge(403, '<html><head><title>Just a moment...</title></head><script src="/cdn-cgi/challenge-platform/x"></script></html>').should.equal(true);
		looksLikeChallenge(200, '<html><head><title>Shop</title></head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><p>lots of products</p></html>').should.equal(false);
		looksLikeChallenge(403, '<html><title>Forbidden</title>nope</html>').should.equal(false);
	});

	it('recognises client-rendered app shells', () => {
		looksLikeSpaShell('<html><body><div id="root"></div><script src="/app.js"></script></body></html>').should.equal(true);
		looksLikeSpaShell(`<html><body><main>${'Real server-rendered content. '.repeat(40)}</main><script src="/a.js"></script></body></html>`).should.equal(false);
	});
});
