'use strict';

/**
 * ZoneMTA Email Verification Plugin — MSG25
 *
 * Verifies recipient email addresses via MSG25 Email Verification API.
 * Bad recipients (undeliverable, disposable) are rejected with 550 BEFORE the email
 * body is transferred — saving bandwidth and protecting sender reputation.
 *
 * Three-hook architecture for proper dashboard integration:
 *   smtp:rcpt_to  → verify via API → reject bad recipients (before DATA transfer)
 *   smtp:data     → copy verification results from session to envelope (bridge)
 *   message:queue → write remotelog with real envelope.id (shows in dashboard timeline)
 *
 * Why three hooks:
 *   - smtp:rcpt_to has no message ID yet (message doesn't exist)
 *   - smtp:data bridges session → envelope (same pattern as authplugin.js)
 *   - message:queue has envelope.id that links to the mids collection
 *   - Dashboard queries mids → messages, so remotelog needs the real message ID
 *   - Rejected messages never reach message:queue — they get logged with session.id
 *     and show up via the blocked filter path (same as BLOCKED_SENDER)
 *
 * Features:
 *   - Rejects at RCPT TO stage (before DATA) — same pattern as blacklist rejection
 *   - In-memory cache with per-result TTL (avoids redundant API calls)
 *   - Fail-open on API timeout (email goes through if API is down)
 *   - Configurable blocking: undeliverable, disposable, risky
 *   - Remotelog with real message ID for dashboard timeline visibility
 *   - Only checks authenticated sessions (outbound mail)
 *
 * Config (config/plugins/email-verifier.toml):
 *
 *   ["email-verifier"]
 *   enabled = ["receiver"]
 *   apiUrl = "https://app.msg25.com/api/v1/verify"
 *   apiKey = "your-api-key"
 *   apiTimeout = 10000
 *   blockUndeliverable = true
 *   blockDisposable = true
 *   blockRisky = false
 *
 * API Response (action field determines reject/allow):
 *   action: "block"  → 550 rejection at RCPT TO
 *   action: "allow"  → recipient accepted
 *
 * @see https://msg25.com/verify
 */

const https = require('https');
const http = require('http');

module.exports.title = 'Email Verifier';
module.exports.description = 'Verifies recipients at RCPT TO via MSG25 API';

var cache = new Map();
var CACHE_TTL = {
    deliverable: 30 * 60 * 1000,        // 30 min
    undeliverable: 24 * 60 * 60 * 1000, // 24 hours
    risky: 15 * 60 * 1000,              // 15 min
    unknown: 5 * 60 * 1000,             // 5 min
};

function apiGet(url, timeout) {
    return new Promise(function(resolve) {
        var client = url.startsWith('https') ? https : http;
        var timer = setTimeout(function() { req.destroy(); resolve(null); }, timeout);
        var req = client.get(url, { timeout: timeout }, function(res) {
            var body = '';
            res.on('data', function(chunk) { body += chunk; });
            res.on('end', function() {
                clearTimeout(timer);
                try { resolve(JSON.parse(body)); } catch(e) { resolve(null); }
            });
        });
        req.on('error', function() { clearTimeout(timer); resolve(null); });
    });
}

module.exports.init = function(app, done) {
    var config = {
        apiUrl: app.config.apiUrl || 'https://app.msg25.com/api/v1/verify',
        apiKey: app.config.apiKey || '',
        apiTimeout: parseInt(app.config.apiTimeout) || 10000,
        blockUndeliverable: app.config.blockUndeliverable !== false && app.config.blockUndeliverable !== 'false',
        blockDisposable: app.config.blockDisposable !== false && app.config.blockDisposable !== 'false',
        blockRisky: app.config.blockRisky === true || app.config.blockRisky === 'true',
    };

    if (!config.apiKey) {
        app.logger.error('Email Verifier', 'No apiKey! Plugin disabled.');
        return done();
    }

    app.logger.info('Email Verifier',
        'RCPT TO rejection via API: %s | block: undeliverable=%s disposable=%s risky=%s',
        config.apiUrl,
        config.blockUndeliverable ? 'YES' : 'NO',
        config.blockDisposable ? 'YES' : 'NO',
        config.blockRisky ? 'YES' : 'NO'
    );

    // Cache cleanup every 5 min
    setInterval(function() {
        var now = Date.now();
        for (var entry of cache) {
            var ttl = CACHE_TTL[entry[1].result] || CACHE_TTL.unknown;
            if (now - entry[1].ts > ttl) cache.delete(entry[0]);
        }
    }, 300000);

    // ── Verify: memory cache → API ──
    async function verify(email) {
        var key = email.toLowerCase().trim();
        var cached = cache.get(key);
        if (cached) {
            var ttl = CACHE_TTL[cached.result] || CACHE_TTL.unknown;
            if ((Date.now() - cached.ts) < ttl) return Object.assign({}, cached, { _source: 'cache' });
            cache.delete(key);
        }
        var params = new URLSearchParams({
            email: key, api_key: config.apiKey,
            block_undeliverable: config.blockUndeliverable ? 'true' : 'false',
            block_disposable: config.blockDisposable ? 'true' : 'false',
            block_risky: config.blockRisky ? 'true' : 'false',
        });
        var data = await apiGet(config.apiUrl + '?' + params.toString(), config.apiTimeout);
        if (!data || data.error) return null;
        var entry = {
            result: data.result || 'unknown', action: data.action || 'allow',
            reason: data.action_reason || data.reason || '', score: data.score || 0,
            disposable: data.disposable || false, free: data.free || false,
            catch_all: data.catch_all || false, role: data.role_based || data.role || false,
            smtp_code: data.smtp_code || null, reachable: data.reachable || 'unknown',
            duration_ms: data.duration_ms || 0, ts: Date.now()
        };
        cache.set(key, entry);
        return Object.assign({}, entry, { _source: 'api' });
    }

    // ═══ HOOK 1: smtp:rcpt_to — Verify + reject before DATA ═══
    app.addHook('smtp:rcpt_to', async function(address, session) {
        if (!session.user) return;
        var email = address.address;
        if (!email) return;
        var user = session.user;

        try {
            var result = await verify(email);
            if (!session._verifyResults) session._verifyResults = {};

            if (!result) {
                app.logger.info('Email Verifier', 'RCPT %s SKIP (API timeout) user=%s', email, user);
                session._verifyResults[email.toLowerCase()] = { status: 'unknown', reason: 'API unavailable' };
                return;
            }

            if (result.action === 'block') {
                app.logger.info('Email Verifier', 'RCPT_REJECT %s result=%s reason=%s score=%d user=%s',
                    email, result.result, result.reason, result.score, user);

                // Rejected = no message:queue will fire, log with session.id
                try { app.remotelog(session.id, false, 'VERIFY_BLOCKED', {
                    from: '', to: email, user: user, result: result.result,
                    reason: result.reason, score: result.score,
                }); } catch(e) {}

                var err = new Error('550 5.1.1 Rejected: ' + (result.reason || result.result));
                err.name = 'SMTPReject';
                err.responseCode = 550;
                throw err;
            }

            // Store for smtp:data → message:queue bridge
            session._verifyResults[email.toLowerCase()] = {
                status: result.result, reason: result.reason, score: result.score,
                src: result._source, ms: result.duration_ms,
                disposable: result.disposable, role: result.role,
                catch_all: result.catch_all, smtp_code: result.smtp_code,
                reachable: result.reachable, free: result.free,
            };

            app.logger.info('Email Verifier', 'RCPT_ALLOW %s result=%s score=%d user=%s',
                email, result.result, result.score, user);
        } catch (err) {
            if (err.name === 'SMTPReject') throw err;
            app.logger.error('Email Verifier', 'RCPT error %s: %s', email, err.message);
        }
    });

    // ═══ HOOK 2: smtp:data — Bridge session → envelope ═══
    app.addHook('smtp:data', async function(envelope, session) {
        if (session._verifyResults) {
            envelope._verifyResults = session._verifyResults;
        }
    });

    // ═══ HOOK 3: message:queue — Remotelog with real envelope.id ═══
    app.addHook('message:queue', function(envelope, messageInfo, next) {
        if (!envelope.user || !envelope._verifyResults) return next();

        var recipients = envelope.to || [];
        for (var i = 0; i < recipients.length; i++) {
            var recipient = recipients[i];
            var email = typeof recipient === 'string' ? recipient : (recipient.address || String(recipient));
            var vr = envelope._verifyResults[email.toLowerCase()];
            if (!vr) continue;

            var actionName = 'VERIFY_' + (vr.status || 'unknown').toUpperCase();
            try {
                app.remotelog(envelope.id, false, actionName, {
                    from: envelope.from || '', to: email, user: envelope.user,
                    result: vr.status, reason: vr.reason, score: vr.score || 0,
                    source: vr.src || 'api', duration_ms: vr.ms || 0,
                    disposable: vr.disposable || false, role: vr.role || false,
                    catch_all: vr.catch_all || false, smtp_code: vr.smtp_code || null,
                    reachable: vr.reachable || 'unknown', free: vr.free || false,
                });
            } catch(e) {}
        }

        return next();
    });

    done();
};
