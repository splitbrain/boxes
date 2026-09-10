import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The one Chromium the e2e suite shares, and the helpers every test uses to
 * open a page in a known colour scheme.
 */

let browser: Browser | null = null;

/** A Chromium named outright, which is the last word on the subject. */
const NAMED_CHROMIUM = process.env['CHROMIUM_PATH'];

/**
 * Where a Boxes session image keeps the browser it ships.
 *
 * A session's PLAYWRIGHT_BROWSERS_PATH holds links to the browsers the image
 * carries, so this suite's Playwright resolves a real browser there whenever
 * it pins the revision the image has. When it pins a different one, that path
 * is writable and the build can be downloaded — but this name is the one that
 * needs no download at all, which is why it is worth trying first.
 */
const IMAGE_CHROMIUM = '/usr/local/bin/chromium';

/**
 * Playwright's own `--disable-dev-shm-usage`, taken back off.
 *
 * The flag answers a 64 MB `/dev/shm`, which Chromium exhausts on any
 * substantial page and reports as a closed target, and it answers it by
 * moving that traffic to `TMPDIR`. In a session `TMPDIR` is the home volume,
 * so the flag puts a browser's shared memory on a disk; the orchestrator
 * gives the container a 512 MB `/dev/shm` instead, which is the better half
 * of that trade. CI and a developer's machine both have half of RAM there,
 * neither being a container, so it is the better half everywhere this runs.
 *
 * Suppressed rather than simply not passed: Playwright adds it to every
 * Chromium launch as one of its own defaults, so an `args` list without it
 * still produces a command line with it.
 *
 * Somewhere with a small `/dev/shm` and no way to raise it would want it back,
 * which means dropping this rather than adding anything.
 */
const IGNORED_DEFAULT_ARGS = ['--disable-dev-shm-usage'];

/**
 * Which Chromium to launch.
 *
 * CHROMIUM_PATH first, because somebody said so, and with no check that it
 * exists: an explicit path that is wrong should say which path, not be
 * quietly ignored. Then the build this suite's own Playwright pins, when it
 * has been installed — the exactly matching one, which is what CI installs
 * and what a session's browsers path already links or can download. Then the
 * session image's, which is a couple of Chrome majors off and used because it
 * is there and needs no download.
 *
 * `channel: 'chromium'` rather than the default, which is the
 * chromium-headless-shell build: that one has no permission UI and so reports
 * `Notification.permission` as a permanent `denied`, which the push toggle
 * reads as a browser that can never subscribe. The suite would then be
 * asserting one thing on a machine that provides its own Chromium and
 * another on CI, which is worse than either. Both `executablePath` branches
 * name a full browser for the same reason.
 */
function chromiumToLaunch(): LaunchOptions {
  if (NAMED_CHROMIUM) return { executablePath: NAMED_CHROMIUM };
  // Never throws; it answers where the browser would be, installed or not.
  if (existsSync(chromium.executablePath())) return { channel: 'chromium' };
  if (existsSync(IMAGE_CHROMIUM)) return { executablePath: IMAGE_CHROMIUM };
  // Nothing to launch. The channel gets Playwright's own error, which names
  // the install command, rather than an ENOENT on a path this file chose.
  return { channel: 'chromium' };
}

/** Launches Chromium once and reuses it for the whole run. */
export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
      ...chromiumToLaunch(),
    });
  }
  return browser;
}

/**
 * A Chromium with a profile directory of its own, thrown away afterwards.
 *
 * For the one question the shared browser cannot answer: whether Chrome would
 * offer to install the app. Every context from `newContext()` is incognito,
 * and Chrome refuses to install from one — it reports `in-incognito` as the
 * reason and stops looking, so a real bug in the manifest would be invisible
 * behind it. A persistent context is an ordinary profile.
 *
 * The context is returned rather than a page: what a browser carries before
 * its first navigation — a session cookie, most of the point here — has to be
 * put there first.
 */
export async function launchProfile(): Promise<{
  context: BrowserContext;
  close: () => Promise<void>;
}> {
  const profile = mkdtempSync(resolve(tmpdir(), 'boxes-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    viewport: VIEWPORTS.phone,
    colorScheme: 'dark',
    ...chromiumToLaunch(),
  });
  return {
    context,
    close: async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** Closes the shared Chromium, if one was launched. */
export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

/** Where screenshots land. Reviewed by eye, not compared pixel by pixel. */
const SHOT_DIR = resolve(import.meta.dirname, 'screenshots');

/**
 * The two viewports the dashboard is built for.
 *
 * Phone is the default because Boxes is driven from one; desktop exists for the
 * views that arrange themselves differently above the `md` breakpoint, which
 * the review is the first of.
 */
export const VIEWPORTS = {
  phone: { width: 430, height: 900 },
  desktop: { width: 1280, height: 900 },
} as const;

/** Opens a page in the given colour scheme, failing the test on a console error. */
export async function openPage(
  base: string,
  path: string,
  scheme: 'light' | 'dark' = 'dark',
  viewport: keyof typeof VIEWPORTS = 'phone',
): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await (
    await getBrowser()
  ).newContext({ colorScheme: scheme, viewport: VIEWPORTS[viewport] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (msg) => {
    // A request the app deliberately provokes and handles — a 404 for an
    // unknown file, a 409 for a session whose workspace cannot be read — logs
    // a console error in Chromium for the response itself. Handling those
    // correctly is what several tests are about, so the resource line is not a
    // page fault; a real one still arrives as a pageerror or as a message of
    // its own.
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource:')) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  return { page, errors, close: () => context.close() };
}

/**
 * Saves a screenshot under e2e/screenshots.
 *
 * Full page by default. `viewport` is for a shot of something anchored to the
 * viewport rather than to the document — a bottom sheet, a dialog — which a
 * full-page capture scrolls out from under.
 */
export async function shoot(
  page: Page,
  name: string,
  area: 'page' | 'viewport' = 'page',
): Promise<string> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const path = resolve(SHOT_DIR, `${name}.png`);
  // Animations finished rather than caught mid-flight: a sheet sliding in is
  // still translated off-screen when it first counts as visible, so a shot of
  // one would otherwise show an empty page.
  await page.screenshot({ path, fullPage: area === 'page', animations: 'disabled' });
  return path;
}
