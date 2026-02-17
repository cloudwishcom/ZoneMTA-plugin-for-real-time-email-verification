'use strict';

/**
 * ZoneMTA Email Verification Plugin — Pure API
 *
 * Calls MSG25 Email Verification API for every recipient.
 * Sends settings (block_undeliverable, block_disposable, block_risky) to API.
 * API returns action: "allow" or "block" — plugin just obeys the response.
 *
 * Config (email-verifier.toml):
 *   apiUrl, apiKey, apiTimeout, blockUndeliverable, blockDisposable, blockRisky
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

module.exports.title = 'Email Verifier';
module.exports.description = 'Verifies recipients via MSG25 API before delivery';

let appRef;
let config = {
    apiUrl: 'https://app.msg25.com/api/v1/verify',
    apiKey: '',
    apiTimeout: 10000,
    blockUndeliverable: true,
    blockDisposable: true,
    blockRisky: false,
};

// In-memory cache: email → { data, ts }
const cache = new Map();
const CACHE_TTL = {
    deliverable: 30 * 60 * 1000,
    undeliverable: 60 * 60 * 1000,
    risky: 15 * 60 * 1000,
    unknown: 5 * 60 * 1000,
};

// ── INIT ──

module.exports.init = async (app, done) => {
    appRef = app;
    config.apiKey = app.config.apiKey || '';
    config.apiUrl = app.config.apiUrl || config.apiUrl;
    config.apiTimeout = parseInt(app.config.apiTimeout) || config.apiTimeout;
    config.blockUndeliverable = app.config.blockUndeliverable !== false && app.config.blockUndeliverable !== 'false';
    config.blockDisposable = app.config.blockDisposable !== false && app.config.blockDisposable !== 'false';
    config.blockRisky = app.config.blockRisky === true || app.config.blockRisky === 'true';

    if (!config.apiKey) {
        app.logger.error('Email Verifier', 'No apiKey configured! Plugin disabled.');
        return done();
    }

    app.logger.info('Email Verifier',
        'Active — API: %s, Block: undeliverable=%s disposable=%s risky=%s',
        config.apiUrl,
        config.blockUndeliverable ? 'YES' : 'NO',
        config.blockDisposable ? 'YES' : 'NO',
        config.blockRisky ? 'YES' : 'NO'
    );

    // Purge expired cache every 2 min
    setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of cache) {
            const ttl = CACHE_TTL[entry.data?.result] || CACHE_TTL.unknown;
            if (now - entry.ts > ttl) cache.delete(key);
        }
    }, 120000);

    done();
};

// ── API CALL (sends settings to API) ──

function callApi(email) {
    return new Promise((resolve) => {
        if (!config.apiKey) return resolve(null);

        const params = new URLSearchParams({
            email,
            api_key: config.apiKey,
            block_undeliverable: config.blockUndeliverable ? 'true' : 'false',
            block_disposable: config.blockDisposable ? 'true' : 'false',
            block_risky: config.blockRisky ? 'true' : 'false',
        });

        const url = `${config.apiUrl}?${params.toString()}`;
        const client = url.startsWith('https') ? https : http;

        const timeout = setTimeout(() => {
            req.destroy();
            resolve(null);
        }, config.apiTimeout);

        const req = client.get(url, { timeout: config.apiTimeout }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                clearTimeout(timeout);
                try {
                    const data = JSON.parse(body);
                    if (data.error) return resolve(null);
                    resolve(data);
                } catch (err) {
                    resolve(null);
                }
            });
        });

        req.on('error', () => {
            clearTimeout(timeout);
            resolve(null);
        });
    });
}

// ── VERIFY (cache → API) ──

async function verify(email) {
    const key = email.toLowerCase().trim();

    // Check cache
    const cached = cache.get(key);
    if (cached) {
        const ttl = CACHE_TTL[cached.data?.result] || CACHE_TTL.unknown;
        if ((Date.now() - cached.ts) < ttl) {
            return { ...cached.data, _source: 'cache' };
        }
        cache.delete(key);
    }

    // Call API
    const data = await callApi(key);
    if (data) {
        cache.set(key, { data, ts: Date.now() });
        return { ...data, _source: 'api' };
    }

    return null; // fail-open
}

// ── HOOK ──

module.exports['smtp:data_ready'] = async (envelope, callback) => {
    if (!config.apiKey) return callback();

    const smtpUser = envelope.user;
    if (!smtpUser) return callback();

    try {
        const recipients = envelope.to || [];
        if (recipients.length === 0) return callback();

        const blocked = [];
        const headerParts = [];

        for (const recipient of recipients) {
            const email = typeof recipient === 'string' ? recipient : recipient.address || recipient;
            const result = await verify(email);

            if (!result) {
                // API failed/timeout — fail-open
                headerParts.push(`${email}=unknown`);
                remotelog(envelope, email, smtpUser, 'VERIFY_UNKNOWN', {
                    result: 'unknown', reason: 'API unavailable', duration_ms: 0, source: 'timeout',
                });
                continue;
            }

            const status = result.result || 'unknown';
            const reason = result.reason || '';
            const ms = result.duration_ms || 0;
            const src = result._source || 'api';
            const action = result.action || 'allow';  // API decides!
            const actionReason = result.action_reason || reason;

            if (action === 'block') {
                blocked.push({ email, reason: actionReason || status });
                headerParts.push(`${email}=blocked`);
                remotelog(envelope, email, smtpUser, 'VERIFY_BLOCKED', {
                    result: status, reason: actionReason, duration_ms: ms, source: src,
                    disposable: result.disposable || false,
                    smtp_code: result.smtp_check?.smtp_code || null,
                });
            } else {
                headerParts.push(`${email}=${status}`);
                remotelog(envelope, email, smtpUser, 'VERIFY_' + status.toUpperCase(), {
                    result: status, reason, duration_ms: ms, source: src,
                    disposable: result.disposable || false,
                    role_based: result.role_based || result.role || false,
                    catch_all: result.catch_all || false,
                });
            }
        }

        // Add verification header
        if (envelope.headers && headerParts.length > 0) {
            try {
                envelope.headers.add('X-MSG25-Verification', headerParts.join('; '), 0);
            } catch (e) {}
        }

        // ALL recipients blocked → reject
        if (blocked.length > 0 && blocked.length === recipients.length) {
            const reasons = blocked.map(b => `${b.email}: ${b.reason}`).join(', ');
            return callback(null, {
                code: 550,
                message: `All recipients undeliverable: ${reasons}`,
            });
        }

        // SOME blocked → remove from envelope
        if (blocked.length > 0) {
            const blockedSet = new Set(blocked.map(b => b.email.toLowerCase()));
            envelope.to = recipients.filter(r => {
                const addr = typeof r === 'string' ? r : r.address || r;
                return !blockedSet.has(addr.toLowerCase());
            });
        }

        return callback();

    } catch (err) {
        // Fail-open on any error
        return callback();
    }
};

// ── REMOTELOG HELPER ──

function remotelog(envelope, email, smtpUser, action, data) {
    if (!appRef || !appRef.remotelog) return;
    try {
        const id = envelope.id || ('VRF' + crypto.randomBytes(8).toString('hex'));
        appRef.remotelog(id, false, action, {
            from: envelope.from || '',
            to: email,
            user: smtpUser,
            result: data.result || '',
            reason: data.reason || '',
            duration_ms: data.duration_ms || 0,
            source: data.source || '',
            disposable: data.disposable || false,
            role_based: data.role_based || false,
            catch_all: data.catch_all || false,
            smtp_code: data.smtp_code || null,
        });
    } catch (e) {}
}
