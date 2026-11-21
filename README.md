# LocaleGuard

LocaleGuard checks how localized pages lay out in Chromium. Give it the URLs for each language and the viewport sizes you support. The local CLI measures rendered text, checks the edges of the document, and compares corresponding controls across languages. Each finding includes measurements and an annotated screenshot.

## Try the GitHub Alpha on your site

Download `localeguard-0.1.3-alpha.1.tgz` from the release assets. In a project using Node.js 22, 24 or 26, place the archive in the current directory and run the following commands. [Alpha download and checksum](https://github.com/dylantsouy/LocaleGuard/releases/tag/v0.1.3-alpha.1)

```sh
npm install --save-dev ./localeguard-0.1.3-alpha.1.tgz
npx playwright install chromium
```

Copy the [sample config](https://github.com/dylantsouy/LocaleGuard/blob/v0.1.3-alpha.1/localeguard.config.json) to `localeguard.config.json`. Replace the example pages with two language URLs for the same page on a site you maintain. Keep the baseline language and the viewports you want to check. Then run the local binary.

```sh
npx --offline localeguard scan --config localeguard.config.json
```

Open the printed HTML path. Check each target's scan status and compare a finding with its original screenshot. A completed scan with an error-severity finding writes its reports and exits with code 1. Share one concrete observation, including your locales, viewport and the result you saw. [Alpha feedback form](https://github.com/dylantsouy/LocaleGuard/issues/new?template=alpha-feedback.yml)

## Run the included example

From this checkout, use Node.js 22, 24 or 26 LTS with npm. Install dependencies and the matching Chromium build. The installation also compiles the TypeScript CLI.

```sh
npm ci
npx playwright install chromium
```

On a minimal Linux machine, use `npx playwright install --with-deps chromium` to install the required system libraries. Playwright associates each library release with specific browser builds. [Playwright browser installation](https://playwright.dev/docs/browsers)

Start the fixture in one terminal and leave it running.

```sh
npm run fixture
```

In a second terminal in the same checkout, run the scanner.

```sh
npm run scan -- --config localeguard.config.json
```

The fixture listens on `127.0.0.1:4173`. The example scans English and German catalog and checkout pages at 1280 × 800 and 390 × 844. Expect **8 targets, 5 errors, 0 warnings, 0 failed scans** and exit code **1**. The German order button and delivery note lose text. On mobile, the shipping banner also extends beyond the page. The delivery-options button has room to wrap.

Open the printed `index.html` path in a browser. Expand a target to inspect its findings. Open **Review candidates and export annotations** to compare original and annotated screenshots, enter verdicts and export a JSON file. Each invocation starts with blank labels. Export before closing the page. Share the entire run directory to preserve its relative links. Stop the fixture with Ctrl+C.

The checkout also supports the package binary through npm. Offline mode resolves the local project without fetching a registry package.

```sh
npx --offline localeguard scan --config localeguard.config.json
```

The Alpha is distributed as a GitHub Release tarball. The package retains npm's private flag.

## Use a local tarball in another project

Run `npm pack` in the checkout. In a separate npm project, install the resulting archive, install Chromium and supply your own JSON config.

```sh
npm install /path/to/localeguard-0.1.3-alpha.1.tgz
npx playwright install chromium
npx --offline localeguard --help
npx --offline localeguard scan --config localeguard.config.json
```

The archive contains the compiled executable, README and license. Save the JSON example below as `localeguard.config.json` with your own URLs. To smoke-test a tarball from the source checkout on Windows or Linux, run `npm run test:package -- ./localeguard-0.1.3-alpha.1.tgz` after installing Chromium. It creates an empty temporary npm project and tests the installed binary against a loopback server.

## Scan your pages

Save a JSON file with one entry per logical page. Each entry names its reference language explicitly. Use URLs that open the intended language directly.

```json
{
  "pages": [{
    "name": "Pricing",
    "baseline": "en",
    "locales": {
      "en": "http://localhost:3000/en/pricing",
      "de": "http://localhost:3000/de/preise"
    }
  }],
  "viewports": [
    { "name": "desktop", "width": 1280, "height": 800 },
    { "name": "mobile", "width": 390, "height": 844 }
  ],
  "outputDir": "./localeguard-reports",
  "concurrency": 2,
  "timeoutMs": 30000
}
```

Pass the file to `npm run scan -- --config path/to/config.json`. Relative output paths resolve from the config file's directory. If you omit `--config`, the CLI reads `localeguard.config.json` in the current directory.

| Field | Behavior |
| --- | --- |
| `pages` | Nonempty array of uniquely named pages. Each baseline must be a key in that page's `locales`. A single locale runs the four single-page checks. |
| `locales` | Language tags accepted by `Intl.getCanonicalLocales`, mapped to absolute HTTP(S) URLs. Each tag also sets the browser context locale. |
| `viewports` | Nonempty array of uniquely named viewport sizes. Width and height are integers from 1 to 4096 CSS pixels. The mobile example tests responsive width with a desktop Chromium user agent. |
| `outputDir` | Defaults to `./localeguard-reports`. The scanner creates a fresh run directory. |
| `concurrency` | 1–8 active targets. Defaults to 2. |
| `timeoutMs` | 1000–120000 milliseconds. Defaults to 30000 for browser launch and the inspection of each target, including evidence capture. |

## What produces a finding

| Rule ID | Severity | Decision and evidence |
| --- | --- | --- |
| `page-overflow` | Error | The scrollable root exceeds the viewport width by more than the larger of 4 px and 1% of viewport width. Records document width, viewport width, excess and a contributing element when located. |
| `text-clipped` | Error | A rendered text fragment extends more than 3 px beyond the inner edge of the nearest clipping box on that axis. The box must use `overflow: hidden` or `clip`. Records the axis, clip interval, text interval and excess. Nested inline text is measured with DOM ranges. |
| `element-offscreen` | Warning | At least 24 px **and** 25% of a content element's width lie beyond a horizontal viewport edge. A fully offscreen element remains uncertain unless a keyboard-reveal link or collapsed CSS menu can be shown to move into view, receive a hit and return to its original state. The probe temporarily applies Chromium CSS pseudo-states. |
| `content-overlap` | Warning | Deep intersections use two hit stacks. For smaller intersections across separate blocks, local screenshots isolate the two text runs and measure coincident or adjacent ink. A compressed track with ambiguous ink or an unstable crop can produce an `uncertain` warning. The rule also checks five hit points for a completely obstructed control. |
| `locale-layout-shift` | Warning | On the same page and viewport, a keyed link or button changes from one line to at least three. Width differs by at most 10%, height grows by at least 16 px and a factor of 1.6, and its box newly overlaps an adjacent visible control by at least 8 px in both directions. Records the sibling selector and overlap dimensions. |

After load, LocaleGuard waits for fonts and two animation frames, then checks for matching rule measurements at least 200 ms apart. Changing measurements have a two-second settling window within the target deadline. Pages that keep changing return a scan failure. Content inserted after that window can escape detection. LocaleGuard compares controls with a matching unique `data-localeguard-key` or HTML `id`, element tag and explicit ARIA role. Missing or ambiguous matches are skipped.

```html
<button data-localeguard-key="checkout-submit">Place order</button>
```

Text ellipsis, line clamps, common CSS image-replacement techniques, hidden content and scrollable panels receive special handling. Visible controls inside a labeled carousel still receive local clipping checks. One clipped label can carry evidence on both axes. A document overflow finding already identifies its measured contributor, so the report omits that element's duplicate edge warning. Use `data-localeguard-ignore` on a known intentional subtree to omit its element measurements. Root overflow still measures the scrolling experience for the whole page.

## Results and exit codes

`report.json` has `schemaVersion: 1` and an ordered `results` array. Each target includes its page, configured URL and language, viewport, scan status, comparison status and issues. Each issue has a stable rule ID, severity, target metadata, CSS selector, description, evidence and a relative PNG path. A red border marks the element or its visible edge. If the overflowing document has no identified contributor, the screenshot marks the viewport edge.

| Code | Meaning |
| --- | --- |
| 0 | All targets completed with zero error-severity findings. Warnings can still be present. |
| 1 | All targets completed and at least one error-severity finding was recorded. |
| 2 | An operational failure occurred, such as invalid config, browser launch failure, HTTP failure, timeout or unwritable report output. |

A failed target carries its error in both reports. Other targets continue. If the baseline fails, localized targets still run their own checks and record `comparison: "unavailable"`. Invalid configuration and filesystem errors can prevent report creation.

Use the additive `scanStatus` field for coverage. Older schema-v1 readers can continue using `status` (`ok` means a usable inspection, `failed` means none). In historical reports without `scanStatus`, detailed coverage is unknown.

| scanStatus | Interpretation |
| --- | --- |
| completed | The scanner completed its supported main-document checks for this state. |
| partial | Measurements are usable. A stylesheet/font, baseline, DOM suffix or rule budget limited inspection. See `coverage.diagnostics` and element counts. Exit code 2. |
| inaccessible | Navigation, a captured redirect restriction, HTTP response or origin stop prevented inspection. Exit code 2. |
| failed | Browser launch, unstable layout, internal processing or replay setup failed. Exit code 2. |

`timings.json` records elapsed milliseconds per target, including creation and cleanup of its browser context. A job skipped before starting a browser has zero inspection time. A run stops scheduling new requests to an origin once it observes HTTP 429. Requests already in flight can finish.

## Running locally and handling scan data

LocaleGuard runs site JavaScript and fetches page resources using the network access of the local machine. Scan sites you are authorized to load. The fixture and local development servers can use loopback or private addresses. Use a disposable machine or VM with restricted network access for unfamiliar sites.

Each target uses a fresh browser context with Chromium sandboxing enabled, downloads disabled for the scan, service workers blocked and no granted browser permissions. The config rejects embedded URL credentials and non-HTTP(S) targets. A configuration can schedule up to 500 targets. Above 20,000 body descendants, the scanner measures the first 4,000 in DOM order and records partial coverage. The report escapes page text and blocks scripts. The review page permits its hash-pinned local export script.

Configured URLs, error messages and screenshots can contain private data. Review the run directory before sharing it. A public scanning service would need separate host isolation, network egress controls including redirect and DNS handling, and CPU, memory and storage quotas.

## Detection limits

- The scanner examines the main document's light DOM in a single loaded state. Authentication flows, interaction-triggered UI, iframe contents, shadow roots, canvas text and native form-control text need separate coverage.
- DOM ranges measure text boxes. Tight line heights, rotated elements, unusual fonts and intentional masks can produce clipping findings that need manual review. The masked-panel and scroll-container exclusions can also hide a defect inside a carousel.
- A document can scroll horizontally by design. Large illustrations and off-canvas controls can also legitimately cross an edge. Inspect the evidence before changing the layout.
- An unmatched control yields no cross-language warning. Responsive breakpoints are compared independently. A translated control may legitimately need several lines.
- Overlap checks exclude fixed, sticky and absolute layers, small labels, nested components and controls below the initial viewport. Paint checks use at most 24 local candidate pairs and crops up to 512 × 512 CSS px. Font fallback, mixed writing modes, antialiasing and crops containing a small part of a long line can affect the result. A paint measurement establishes contact at the sampled state. Intent still requires review.
- Fonts, asynchronously inserted content, animations, A/B variants and browser versions can affect measurements. Use a fixed browser build, fonts and fixture content for reproducibility.

## Development

```sh
npm run build
npm test
```

The test suite starts loopback servers on ephemeral ports. It checks rule evidence, intentional typography, deterministic reports, exit codes, screenshots, bounded scans, HTTP failures, origin stops and timeouts. GitHub Actions runs the source suite and the release tarball on Windows and Linux with Node 22, 24 and 26. [CI runs](https://github.com/dylantsouy/LocaleGuard/actions/workflows/ci.yml)

| Path | Responsibility |
| --- | --- |
| `src/cli.ts`, `src/config.ts` | Command-line interface and runtime validation of JSON input |
| `src/scan.ts` | Browser lifecycle, deadline, bounded workers and baseline scheduling |
| `src/browser/` | DOM measurements and annotated evidence capture |
| `src/rules/` | Pure detection rules over typed measurements |
| `src/report.ts`, `src/types.ts` | Offline report rendering and data contracts |
| `fixtures/`, `tests/` | Bilingual fixture site, unit tests and Chromium integration tests |

For a new rule, add a failing fixture and an intentional look-alike, implement the decision in `src/rules/`, then document its evidence and thresholds. Dedicated RTL layout checks, pseudo-localization and translation quality checks are future work. A reusable GitHub Action can later wrap the CLI and retain its report directory as a CI artifact.

Released under the [MIT License](LICENSE).
