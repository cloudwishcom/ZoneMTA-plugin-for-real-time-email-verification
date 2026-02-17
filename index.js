'use strict';

/**
 * ZoneMTA Email Verification Plugin — MSG25
 *
 * Verifies recipient email addresses at RCPT TO stage via MSG25 Email Verification API.
 * Bad recipients (undeliverable, disposable) are rejected with 550 BEFORE the email
 * body is transferred — saving bandwidth and protecting sender reputation.
 *
 * Flow:
 *   RCPT TO → in-memory cache check → API call → reject (550) or allow
 *
 * Features:
 *   - Rejects at RCPT TO stage (before DATA) — same pattern as blacklist rejection
 *   - In-memory cache with per-result TTL (avoids redundant API calls)
 *   - Fail-open on API timeout (email goes through if API is down)
 *   - Configurable blocking: undeliverable, disposable, risky
 *   - Remotelog integration for timeline visibility
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

// In-memory cache: email → { action, result, reason, score, ts, ... }
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

    // Purge expired cache every 5 min
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
            if ((Date.now() - cached.ts) < ttl) {
                return Object.assign({}, cached, { _source: 'cache' });
            }
            cache.delete(key);
        }

        var params = new URLSearchParams({
            email: key,
            api_key: config.apiKey,
            block_undeliverable: config.blockUndeliverable ? 'true' : 'false',
            block_disposable: config.blockDisposable ? 'true' : 'false',
            block_risky: config.blockRisky ? 'true' : 'false',
        });

        var data = await apiGet(config.apiUrl + '?' + params.toString(), config.apiTimeout);
        if (!data || data.error) return null;

        var entry = {
            result: data.result || 'unknown',
            action: data.action || 'allow',
            reason: data.action_reason || data.reason || '',
            score: data.score || 0,
            disposable: data.disposable || false,
            free: data.free || false,
            catch_all: data.catch_all || false,
            role: data.role_based || data.role || false,
            smtp_code: data.smtp_code || null,
            reachable: data.reachable || 'unknown',
            duration_ms: data.duration_ms || 0,
            ts: Date.now()
        };
        cache.set(key, entry);
        return Object.assign({}, entry, { _source: 'api' });
    }

    // ── HOOK: smtp:rcpt_to — verify via API, reject or allow ──
    app.addHook('smtp:rcpt_to', async function(address, session) {
        if (!session.user) return;

        var email = address.address;
        if (!email) return;

        var user = session.user;

        try {
            var result = await verify(email);

            if (!result) {
                app.logger.info('Email Verifier', 'RCPT %s SKIP (API timeout) user=%s', email, user);
                try { app.remotelog('VRF' + Date.now().toString(36), false, 'VERIFY_UNKNOWN', {
                    to: email, user: user, reason: 'API unavailable',
                }); } catch(e) {}
                return;
            }

            var action = result.action;
            var status = result.result;
            var reason = result.reason;
            var src = result._source;
            var score = result.score;
            var ms = result.duration_ms;

            if (action === 'block') {
                app.logger.info('Email Verifier', 'RCPT_REJECT %s result=%s reason=%s score=%d src=%s user=%s %dms',
                    email, status, reason, score, src, user, ms);

                try { app.remotelog('VRF' + Date.now().toString(36), false, 'VERIFY_BLOCKED', {
                    to: email, user: user, result: status, reason: reason,
                    score: score, source: src, duration_ms: ms,
                    disposable: result.disposable, smtp_code: result.smtp_code,
                    reachable: result.reachable, free: result.free,
                }); } catch(e) {}

                var err = new Error('550 5.1.1 Rejected: ' + (reason || status));
                err.name = 'SMTPReject';
                err.responseCode = 550;
                throw err;
            }

            app.logger.info('Email Verifier', 'RCPT_ALLOW %s result=%s score=%d src=%s user=%s %dms',
                email, status, score, src, user, ms);

            try { app.remotelog('VRF' + Date.now().toString(36), false, 'VERIFY_' + status.toUpperCase(), {
                to: email, user: user, result: status, reason: reason,
                score: score, source: src, duration_ms: ms,
                disposable: result.disposable, role: result.role,
                catch_all: result.catch_all, smtp_code: result.smtp_code,
                reachable: result.reachable, free: result.free,
            }); } catch(e) {}

        } catch (err) {
            if (err.name === 'SMTPReject') throw err;
            app.logger.error('Email Verifier', 'RCPT error %s: %s', email, err.message);
        }
    });

    done();
};
