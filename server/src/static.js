import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Static file serving without a dependency.
 *
 * The directory is scanned once at startup into an explicit allow list of
 * URL path -> absolute file path. A request that is not an exact key in that
 * map is a 404, so there is no path to normalise, no traversal to defend
 * against, and no way to reach a file outside the web root.
 */

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.map': 'application/json; charset=utf-8',
};

function etagFor(urlPath, info) {
    return `"${createHash('sha256')
        .update(`${urlPath}:${info.size}:${info.mtimeMs}`)
        .digest('hex')
        .slice(0, 32)}"`;
}

async function walk(dir, files = []) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        // Never expose dotfiles, whatever ends up in the directory.
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop
            await walk(full, files);
        } else if (entry.isFile()) {
            files.push(full);
        }
    }
    return files;
}

export async function buildStaticIndex(root) {
    const files = await walk(root);
    const index = new Map();

    for (const file of files) {
        const urlPath = `/${relative(root, file).split(sep).join('/')}`;
        index.set(urlPath, {
            file,
            type: CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        });
    }

    return index;
}

function cacheControlFor(urlPath) {
    // Vendored assets are pinned by scripts/vendor-lock.json and replaced only
    // by a rebuild, so they are safe to cache indefinitely.
    if (urlPath.startsWith('/vendor/')) return 'public, max-age=31536000, immutable';

    // Everything else revalidates against its ETag. The filenames carry no
    // content hash, so a timed cache could otherwise pair a fresh index.html
    // with stale modules after a deploy. Revalidation costs one 304.
    return 'no-cache';
}

/**
 * Register the static handler. Must be added after the API routes so that
 * /api/* never falls through to a file.
 */
export function registerStatic(fastify, index) {
    const serve = async (request, reply, urlPath) => {
        const entry = index.get(urlPath);
        if (!entry) {
            return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
        }

        // The allow list is fixed at startup, but the validator is derived per
        // request. Reusing a start-up ETag would answer 304 with stale content
        // for anyone who edits or bind-mounts the web directory.
        let info;
        try {
            info = await stat(entry.file);
        } catch {
            return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
        }
        const etag = etagFor(urlPath, info);

        reply.header('Cache-Control', cacheControlFor(urlPath));
        reply.header('ETag', etag);
        reply.header('X-Content-Type-Options', 'nosniff');

        if (request.headers['if-none-match'] === etag) {
            return reply.code(304).send();
        }

        reply.type(entry.type);
        reply.header('Content-Length', String(info.size));
        return reply.send(createReadStream(entry.file));
    };

    fastify.get('/', (request, reply) => serve(request, reply, '/index.html'));

    // A single wildcard route: the parameter is only ever used as a map key.
    fastify.get('/*', (request, reply) => {
        const raw = request.params['*'] || '';
        if (raw.startsWith('api/')) {
            return reply.code(404).send({ error: 'not_found' });
        }
        return serve(request, reply, `/${raw}`);
    });
}
