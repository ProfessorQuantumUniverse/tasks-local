#!/usr/bin/env node
/**
 * Test runner.
 *
 * Starts the server against a throwaway database on a free port, picks the
 * first-run enrollment token out of its log, runs the end-to-end suite, and
 * shuts everything down again.
 *
 *   npm --prefix server test
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, '..', 'src', 'server.js');
const suite = join(here, 'e2e.mjs');

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function main() {
    const port = await freePort();
    const origin = `http://localhost:${port}`;
    const dataDir = await mkdtemp(join(tmpdir(), 'tasks-test-'));

    const server = spawn(process.execPath, [serverEntry], {
        env: {
            ...process.env,
            APP_ORIGIN: origin,
            PORT: String(port),
            HOST: '127.0.0.1',
            DATA_DIR: dataDir,
            LOG_LEVEL: 'warn',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let token = null;
    let ready = false;

    const waitForToken = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('server did not start in time')), 30_000);

        const inspect = (chunk) => {
            output += chunk.toString();
            // The startup banner carries the one-time enrollment token.
            const match = output.match(/enrollment token:[\s\S]{0,200}?([A-Za-z0-9_-]{40,})/);
            if (match && !ready) {
                ready = true;
                token = match[1];
                clearTimeout(timer);
                resolve();
            }
        };

        server.stdout.on('data', inspect);
        server.stderr.on('data', inspect);
        server.on('exit', (code) => {
            if (!ready) {
                clearTimeout(timer);
                reject(new Error(`server exited with code ${code}\n${output}`));
            }
        });
    });

    const stop = async () => {
        server.kill('SIGTERM');
        await new Promise((resolve) => {
            server.on('exit', resolve);
            setTimeout(() => {
                server.kill('SIGKILL');
                resolve();
            }, 5000);
        });
        await rm(dataDir, { recursive: true, force: true });
    };

    try {
        await waitForToken;
    } catch (error) {
        await stop();
        console.error(error.message);
        process.exit(1);
    }

    const tests = spawn(process.execPath, [suite], {
        env: { ...process.env, BASE: origin, ENROLL_TOKEN: token },
        stdio: 'inherit',
    });

    const code = await new Promise((resolve) => tests.on('exit', resolve));
    await stop();
    process.exit(code ?? 1);
}

main().catch(async (error) => {
    console.error(error);
    process.exit(1);
});
