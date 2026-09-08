#!/usr/bin/env node
import config from './config.js';
import db, { credentialCount, pruneExpired } from './db.js';
import { issueEnrollmentToken, regenerateRecoveryCodes, recoveryCodeStatus, revokeAllEnrollmentTokens } from './auth/enrollment.js';
import { listCredentials, deleteCredential } from './auth/webauthn.js';
import { destroyAllSessions } from './auth/session.js';

/**
 * Console utility for everything that must not be reachable over the network:
 * handing out an enrollment token, inspecting state, and breaking a lockout.
 *
 * Run inside the container:
 *   docker compose exec app node src/cli.js <command>
 */

const out = (...args) => process.stdout.write(`${args.join(' ')}\n`);

const COMMANDS = {
    enroll: {
        describe: 'Issue a one-time token that authorises registering a new passkey',
        run(args) {
            const ttl = Number.parseInt(args[0], 10);
            const { token, expiresAt } = issueEnrollmentToken({
                label: 'cli',
                ttlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : config.enrollmentTokenTtlMinutes,
            });
            out('');
            out('Enrollment token (single use):');
            out('');
            out(`    ${token}`);
            out('');
            out(`Valid until ${expiresAt}`);
            out(`Open ${config.origin}, choose "Neues Gerät anmelden" and paste it there.`);
            out('');
        },
    },

    status: {
        describe: 'Show configuration and what is currently registered',
        run() {
            const codes = recoveryCodeStatus();
            const tasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
            const sessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE superseded_at IS NULL').get().n;
            const pending = db
                .prepare('SELECT COUNT(*) AS n FROM enrollment_tokens WHERE used_at IS NULL AND expires_at > ?')
                .get(new Date().toISOString()).n;

            out('');
            out(`  Origin              ${config.origin}`);
            out(`  Relying party ID    ${config.rpID}`);
            out(`  Secure cookies      ${config.cookie.secure}`);
            out(`  Session lifetime    ${config.session.ttlDays} days`);
            out(`  Data directory      ${config.dataDir}`);
            out('');
            out(`  Passkeys            ${credentialCount()}`);
            out(`  Recovery codes      ${codes.unused} unused of ${codes.total}`);
            out(`  Active sessions     ${sessions}`);
            out(`  Pending enrollments ${pending}`);
            out(`  Tasks               ${tasks}`);
            out('');
        },
    },

    credentials: {
        describe: 'List registered passkeys',
        run() {
            const credentials = listCredentials();
            if (credentials.length === 0) {
                out('No passkeys registered. Run "enroll" to get a setup token.');
                return;
            }
            out('');
            for (const credential of credentials) {
                out(`  ${credential.id.slice(0, 20)}…`);
                out(`      name        ${credential.name}`);
                out(`      created     ${credential.createdAt}`);
                out(`      last used   ${credential.lastUsedAt || 'never'}`);
                out(`      synced      ${credential.backedUp ? 'yes' : 'no'}`);
                out('');
            }
        },
    },

    'delete-credential': {
        describe: 'Remove one passkey by its id (or id prefix)',
        run(args) {
            const needle = args[0];
            if (!needle) {
                out('Usage: delete-credential <credential-id-prefix>');
                process.exitCode = 1;
                return;
            }
            const matches = listCredentials().filter((credential) => credential.id.startsWith(needle));
            if (matches.length === 0) {
                out('No passkey matches that id.');
                process.exitCode = 1;
                return;
            }
            if (matches.length > 1) {
                out(`Ambiguous: ${matches.length} passkeys start with that prefix.`);
                process.exitCode = 1;
                return;
            }
            deleteCredential(matches[0].id);
            out(`Removed passkey "${matches[0].name}".`);
        },
    },

    'recovery-codes': {
        describe: 'Generate a fresh set of recovery codes, invalidating the old ones',
        async run() {
            const codes = await regenerateRecoveryCodes();
            out('');
            out('New recovery codes. Each one works once. Store them offline:');
            out('');
            codes.forEach((code) => out(`    ${code}`));
            out('');
            out('The previous set is no longer valid.');
            out('');
        },
    },

    'revoke-sessions': {
        describe: 'Log out every device immediately',
        run() {
            const removed = destroyAllSessions();
            out(`Removed ${removed} session(s). Every device must sign in again.`);
        },
    },

    'revoke-enrollments': {
        describe: 'Invalidate all outstanding enrollment tokens',
        run() {
            const removed = revokeAllEnrollmentTokens();
            out(`Revoked ${removed} pending enrollment token(s).`);
        },
    },

    prune: {
        describe: 'Delete expired sessions, challenges and old log entries',
        run() {
            pruneExpired();
            out('Pruned.');
        },
    },
};

async function main() {
    const [command, ...args] = process.argv.slice(2);

    if (!command || command === 'help' || command === '--help') {
        out('');
        out('Usage: node src/cli.js <command> [args]');
        out('');
        for (const [name, entry] of Object.entries(COMMANDS)) {
            out(`  ${name.padEnd(20)} ${entry.describe}`);
        }
        out('');
        return;
    }

    const entry = COMMANDS[command];
    if (!entry) {
        out(`Unknown command "${command}". Run without arguments for the list.`);
        process.exitCode = 1;
        return;
    }

    await entry.run(args);
}

main()
    .then(() => db.close())
    .catch((error) => {
        process.stderr.write(`${error.stack}\n`);
        process.exit(1);
    });
