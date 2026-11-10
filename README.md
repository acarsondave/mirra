# mirra

[![CI](https://github.com/acarsondave/mirra/actions/workflows/node.js.yml/badge.svg)](https://github.com/acarsondave/mirra/actions/workflows/node.js.yml)

A command line tool that downloads a website so you can browse it offline. It covers the same ground as HTTrack and `wget --mirror`, and it also handles the sites those tools fail on: React/Vue/Next apps that render in the browser, lazy-loaded images, and sites behind Cloudflare and similar bot protection.

```
$ mirra https://example.com -o example --sitemap
· sitemap: seeded 35 URLs
✓     1 html  https://example.com/
✓     2 css   https://example.com/wp-content/themes/site/style.css
...
mirra: 231 files saved (231 via http, 4 via browser), 0 skipped, 30 errors
open: example/example.com/index.html
```

## Install

```bash
git clone https://github.com/acarsondave/mirra && cd mirra
npm install
npx patchright install chromium   # needed for JS rendering and bot checks
npm link                          # optional, puts `mirra` on your PATH
```

You need Node 22 or newer. On a Linux server, also install `xvfb` (see [Bot protection](#bot-protection)).

## Usage

```bash
mirra https://example.com -o site                          # follows links 3 levels deep on the same domain
mirra https://docs.example.com/v2/ -o docs -s prefix -d 10  # only pages under /v2/
mirra https://example.com -o site -n 200 --sitemap -x "*/cart*" "*.zip"
mirra https://app.example.com -o app --render always --no-js
mirra https://example.com/account -o acct --cookies cookies.txt
mirra https://example.com -o site --no-browser              # plain HTTP only, fastest
```

Open `<output>/<host>/index.html` in a browser afterwards. Each run also writes `mirra-report.json`, which lists every file that was saved, skipped or failed. To confirm that a mirror has no broken references:

```bash
npm run check-mirror -- site https://example.com
```

`mirra --help` lists every option.

## How it differs from HTTrack

| | HTTrack | mirra |
|---|---|---|
| Client-rendered pages | Saves the empty app shell | Detects the shell and renders it in a browser (`--render auto`) |
| Lazy-loaded images | Missed | Scrolls rendered pages and reads `data-src` / `data-srcset` |
| TLS and HTTP/2 fingerprint | Easy to identify as a bot | Matches Chrome or Firefox, via [impit](https://github.com/apify/impit) |
| Bot checks | Blocked | Retries in a patched Chromium and reuses its cookies |
| Links to pages that weren't downloaded | Point at a missing local file | Point at the live URL |
| Discovery | Links | Links and sitemaps (`--sitemap`) |
| Logged-in content | Copy browser requests | `--cookies cookies.txt` |

By default mirra makes 32 requests in parallel (16 per host) and doesn't wait between them. It backs off when a server returns 429 or 5xx, and honours `Retry-After`. Add `--delay` and `--respect-robots` if you are crawling a site you don't run.

## Bot protection

Every request starts as a plain HTTP request with a browser fingerprint. Most sites never get further than that. If a response looks like a bot check (Cloudflare, DataDome, PerimeterX, Imperva, Akamai, AWS WAF and a few others, see `cli/detect.js`), mirra retries it a couple of times. Checks triggered by request bursts usually pass on a retry. If the check is still there, mirra loads the URL in [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), a Playwright build with the common automation leaks patched, waits for the check to finish, and passes its cookies back to the HTTP client.

Headless Chrome is easy to detect, so mirra avoids it where it can. On Linux it opens a normal browser window on a private Xvfb display, and on macOS and Windows it uses an off-screen window. If Google Chrome is installed (`npx patchright install chrome`), mirra uses it instead of the bundled Chromium. `npm run stealth-check` runs two public bot-detection pages against your setup.

mirra does not solve CAPTCHAs. When a site asks for a human click, such as Cloudflare's "Verify you are human" checkbox, run with `--headful`, tick it yourself, and the crawl carries on. Datacenter IPs get those checks much more often than home connections, so `--proxy` helps.

Pages that never get past a check are not saved. They are listed in the report, and links to them point at the live site.

## Design

The parsing, link rewriting and file layout come from [website-scraper](https://github.com/website-scraper/node-website-scraper). mirra changes it in a few places:

- `lib/request.js` accepts a `transport` function, which replaces `got` for every request.
- Links (`<a href>`) are filtered by crawl scope. Images, CSS, scripts and fonts load from any host, which matters for CDNs.
- References to pages that weren't downloaded are rewritten to absolute URLs. If a page was reached through a different link, the reference points at the local copy.
- `data-srcset` is parsed like `srcset`.

Everything else lives in `cli/`: the transport (`transport.js`), the browser (`browser.js`), the cookie jar the two share (`cookies.js`), and the CLI itself (`mirra.js`).

The upstream test suite still runs, along with tests for the changes above:

```bash
npm test
```

## Limitations

- Every run writes a fresh directory. There is no incremental update mode like `httrack --update` yet.
- Forms, search, checkout and anything else that needs a server won't work offline.
- Rendered pages keep their scripts unless you pass `--no-js`. Some single-page apps call their APIs again when they load, so a fully static snapshot (`--no-js`) can be the more faithful copy.

Only mirror sites you own or have permission to copy.

## Credits

mirra is built on [website-scraper](https://github.com/website-scraper/node-website-scraper) by Sofiia Antypenko and contributors, and uses [impit](https://github.com/apify/impit) by Apify and [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright). Thanks to all of them.

## License

MIT. See [LICENSE](LICENSE).
