#!/usr/bin/env node
/**
 * Download the fonts and the confetti library into web/vendor/.
 *
 * Run once locally, and again inside the Docker build. Vendoring these means
 * the running app never talks to a third party: the CSP can forbid every
 * external origin, the UI works without internet, and Google no longer learns
 * when the app is opened.
 *
 * Downloads are checked against scripts/vendor-lock.json. A file whose hash
 * changed is a failure, not a warning.
 *
 *   node scripts/fetch-assets.mjs           download, then check against the lock
 *   node scripts/fetch-assets.mjs --verify  check the local files, no network
 *   node scripts/fetch-assets.mjs --update  download and rewrite the lock
 */

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const vendorDir = join(root, 'web', 'vendor');
const fontsDir = join(vendorDir, 'fonts');
const filesDir = join(fontsDir, 'files');
const confettiDir = join(vendorDir, 'confetti');
const lockPath = join(here, 'vendor-lock.json');

const UPDATE = process.argv.includes('--update');
// Offline mode: hash what is already on disk and compare it to the lock file.
// This is what the Docker build runs, so a rebuild never depends on a CDN
// still serving the same bytes months later.
const VERIFY_ONLY = process.argv.includes('--verify');

// A desktop Chrome UA makes the Google Fonts API return woff2.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const GOOGLE_CSS = 'https://fonts.googleapis.com/css2?'
    + 'family=Exo+2:wght@400;500;600;700;800'
    + '&family=Orbitron:wght@400;500;600;700;800'
    + '&family=Audiowide'
    + '&family=Rajdhani:wght@400;500;600;700'
    + '&family=Inter:wght@400;500;600;700;800'
    + '&family=Share+Tech+Mono'
    + '&family=JetBrains+Mono:ital,wght@0,400;0,600;0,700;0,800'
    + '&family=Press+Start+2P'
    + '&family=VT323'
    + '&display=swap';

const SYMBOLS_CSS = 'https://fonts.googleapis.com/css2?'
    + 'family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0..1,0';

const NASALIZATION_CSS = 'https://fonts.cdnfonts.com/css/nasalization';

const CONFETTI_URL = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.2/dist/confetti.browser.min.js';

// German text needs latin; latin-ext covers the rest of the European glyphs.
// Every other subset is dropped, which is most of the download size.
const KEEP_SUBSETS = ['latin', 'latin-ext'];

// cdnfonts publishes Nasalization under its full name; the app's font picker
// refers to it as plain "Nasalization".
const FAMILY_ALIASES = { 'Nasalization Rg': 'Nasalization' };

// Matches the remote source in a @font-face block, with or without quotes,
// and skips any local() entry that precedes it.
const SRC_URL = /url\(\s*['"]?(https:\/\/[^)'"]+?)['"]?\s*\)/i;

const log = (...args) => console.log('[assets]', ...args);

function sha384(buffer) {
    return `sha384-${createHash('sha384').update(buffer).digest('base64')}`;
}

async function download(url, { text = false } = {}) {
    // Some CDNs serve paths containing spaces; encode before requesting.
    const response = await fetch(encodeURI(url), { headers: { 'User-Agent': UA } });
    if (!response.ok) {
        throw new Error(`GET ${url} -> HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return text ? buffer.toString('utf8') : buffer;
}

/**
 * Split a Google Fonts stylesheet into @font-face blocks, keeping only the
 * subsets we want and noting which file each block needs.
 */
function parseFontFaces(css) {
    const blocks = [];
    const pattern = /\/\*\s*([a-z0-9-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/gi;
    let match = pattern.exec(css);

    if (!match) {
        // Some stylesheets (cdnfonts) carry no subset comments at all.
        const bare = /@font-face\s*\{[^}]*\}/gi;
        let block = bare.exec(css);
        while (block) {
            blocks.push({ subset: null, css: block[0] });
            block = bare.exec(css);
        }
        return blocks;
    }

    while (match) {
        blocks.push({ subset: match[1], css: match[2] });
        match = pattern.exec(css);
    }
    return blocks;
}

function familyOf(block) {
    return (/font-family:\s*['"]([^'"]+)['"]/i.exec(block) || [])[1] || 'font';
}

function weightOf(block) {
    const raw = (/font-weight:\s*([^;]+);/i.exec(block) || [])[1] || '400';
    return raw.trim().replace(/\s+/g, '-');
}

function styleOf(block) {
    return (/font-style:\s*([^;]+);/i.exec(block) || [])[1]?.trim() || 'normal';
}

function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function collectStylesheet(url, { label, keepSubsets = true }) {
    log(`fetching ${label} stylesheet`);
    const css = await download(url, { text: true });
    const blocks = parseFontFaces(css);
    const results = [];

    for (const { subset, css: block } of blocks) {
        if (keepSubsets && subset && !KEEP_SUBSETS.includes(subset)) continue;

        const urlMatch = SRC_URL.exec(block);
        if (!urlMatch) continue;

        const rawFamily = familyOf(block);
        const family = FAMILY_ALIASES[rawFamily] || rawFamily;
        const fileUrl = urlMatch[1];
        const extension = fileUrl.split('?')[0].split('.').pop().toLowerCase();
        const name = [slug(family), slug(weightOf(block)), styleOf(block) === 'italic' ? 'italic' : null, subset || null]
            .filter(Boolean)
            .join('-');
        const fileName = `${name}.${['woff2', 'woff', 'ttf', 'otf'].includes(extension) ? extension : 'woff2'}`;

        // Drop the local() reference: a font of that name on the visitor's
        // machine must not silently replace the one we vendored.
        const normalised = block
            .replace(/src:\s*[^;]*;/i, `src: url(${fileUrl}) format('${extension === 'woff' ? 'woff' : 'woff2'}');`)
            .replace(/font-family:\s*['"][^'"]+['"]/i, `font-family: '${family}'`);

        results.push({ family, block: normalised, fileUrl, fileName });
    }

    if (results.length === 0) {
        throw new Error(`no usable @font-face blocks found for ${label}`);
    }
    return results;
}

/** Hash every file named in the lock and report any that do not match. */
async function verifyLocal(lock) {
    const entries = Object.entries(lock.files || {});
    if (entries.length === 0) {
        throw new Error('vendor-lock.json is empty; run with --update first');
    }

    const missing = [];
    const mismatched = [];

    for (const [relative, expected] of entries) {
        const target = join(vendorDir, relative.startsWith('confetti/') ? relative : `fonts/${relative}`);
        if (!existsSync(target)) {
            missing.push(relative);
            continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const actual = sha384(await readFile(target));
        if (actual !== expected) mismatched.push(relative);
    }

    if (missing.length > 0 || mismatched.length > 0) {
        const details = [
            ...missing.map((f) => `  missing:    ${f}`),
            ...mismatched.map((f) => `  changed:    ${f}`),
        ].join('\n');
        throw new Error(`vendored assets do not match the lock file\n${details}`);
    }

    log(`verified ${entries.length} vendored files against the lock`);
}

async function main() {
    const lock = existsSync(lockPath)
        ? JSON.parse(await readFile(lockPath, 'utf8'))
        : { files: {} };
    if (VERIFY_ONLY) {
        await verifyLocal(lock);
        return;
    }

    const nextLock = { files: {} };
    const problems = [];

    await rm(filesDir, { recursive: true, force: true });
    await mkdir(filesDir, { recursive: true });
    await mkdir(confettiDir, { recursive: true });

    // ── Fonts ─────────────────────────────────────────────────────────────
    const faces = [];
    faces.push(...await collectStylesheet(GOOGLE_CSS, { label: 'Google Fonts' }));
    // The symbols sheet labels its single block "fallback", not a subset name.
    faces.push(...await collectStylesheet(SYMBOLS_CSS, { label: 'Material Symbols', keepSubsets: false }));

    try {
        faces.push(...await collectStylesheet(NASALIZATION_CSS, { label: 'Nasalization', keepSubsets: false }));
    } catch (error) {
        // Optional: one of ten selectable fonts. The CSS falls back to a
        // generic sans-serif if it is missing.
        problems.push(`Nasalization konnte nicht geladen werden (${error.message})`);
    }

    const cssParts = [
        '/* Vendored web fonts. Generated by scripts/fetch-assets.mjs - do not edit. */',
        '',
    ];
    const seen = new Set();

    for (const face of faces) {
        if (seen.has(face.fileName)) continue;
        seen.add(face.fileName);

        const bytes = await download(face.fileUrl);
        const hash = sha384(bytes);
        const relative = `files/${face.fileName}`;

        if (!UPDATE && lock.files[relative] && lock.files[relative] !== hash) {
            throw new Error(
                `integrity mismatch for ${relative}\n  expected ${lock.files[relative]}\n  got      ${hash}`,
            );
        }
        nextLock.files[relative] = hash;

        await writeFile(join(filesDir, face.fileName), bytes);
        cssParts.push(face.block.replace(SRC_URL, `url('./${relative}')`));
        cssParts.push('');
    }

    // The Google Symbols stylesheet ships this helper class; recreate it here
    // so the icon spans keep working without the remote sheet.
    cssParts.push(`.material-symbols-outlined {
    font-family: 'Material Symbols Outlined', sans-serif;
    font-weight: normal;
    font-style: normal;
    font-size: 24px;
    line-height: 1;
    letter-spacing: normal;
    text-transform: none;
    display: inline-block;
    white-space: nowrap;
    word-wrap: normal;
    direction: ltr;
    -webkit-font-feature-settings: 'liga';
    -webkit-font-smoothing: antialiased;
}
`);

    await writeFile(join(fontsDir, 'fonts.css'), cssParts.join('\n'), 'utf8');
    log(`wrote ${seen.size} font files`);

    // ── canvas-confetti ───────────────────────────────────────────────────
    log('fetching canvas-confetti');
    const confetti = await download(CONFETTI_URL);
    const confettiHash = sha384(confetti);
    const confettiKey = 'confetti/confetti.browser.min.js';

    if (!UPDATE && lock.files[confettiKey] && lock.files[confettiKey] !== confettiHash) {
        throw new Error(
            `integrity mismatch for ${confettiKey}\n  expected ${lock.files[confettiKey]}\n  got      ${confettiHash}`,
        );
    }
    nextLock.files[confettiKey] = confettiHash;
    await writeFile(join(confettiDir, 'confetti.browser.min.js'), confetti);

    if (UPDATE || !existsSync(lockPath)) {
        await writeFile(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`, 'utf8');
        log(`lock file written with ${Object.keys(nextLock.files).length} entries`);
    } else {
        const missing = Object.keys(nextLock.files).filter((key) => !lock.files[key]);
        if (missing.length > 0) {
            log(`note: ${missing.length} new file(s) not in the lock file, run with --update`);
        }
    }

    problems.forEach((problem) => log(`WARN ${problem}`));
    log('done');
}

main().catch((error) => {
    console.error('[assets] FAILED:', error.message);
    process.exit(1);
});
