# zonemta-email-verifier

Real-time email verification plugin for [ZoneMTA](https://github.com/zone-eu/zone-mta). Rejects bad recipients at **RCPT TO** — before the email body is even transferred — via the [MSG25 Email Verification API](https://msg25.com). Blocks bounces, disposable emails, and undeliverable addresses automatically.

**Stop bounces before they happen.** This plugin verifies every recipient at the SMTP `RCPT TO` stage. Bad addresses get a `550` rejection before your MTA accepts the message body — saving bandwidth, protecting your sender reputation, and preventing bounces entirely.

## Why?

| Without verification | With this plugin |
|---|---|
| Emails bounce → IP reputation damaged | Bad addresses rejected at RCPT TO |
| Disposable signups waste resources | Disposable domains auto-rejected |
| Catch-all domains hide bad addresses | Catch-all detection flags risky sends |
| Hard bounces accumulate silently | Bounce history prevents repeat failures |
| You find out after the damage is done | Real-time 550 rejection on every email |
| Bad emails accepted, then bounce back | Rejected before DATA transfer = no bounce |

## Features

- **RCPT TO Rejection** — Blocks at SMTP envelope stage, before the email body is transferred (saves bandwidth)
- **SMTP Verification** — API connects to recipient's mail server and verifies the mailbox exists
- **Disposable Detection** — Blocks 130,000+ throwaway email domains (mailinator, guerrillamail, tempmail, etc.)
- **Role-Based Detection** — Flags admin@, info@, support@ and 880+ role-based prefixes
- **Catch-All Detection** — Identifies domains that accept mail for any address
- **Catch-All Intelligence** — Cross-references bounce history on catch-all domains for accurate classification
- **MX Record Check** — Verifies domain has valid mail server DNS records
- **Bounce History** — Learns from previous bounces across MSG25 network. Previously bounced = auto-blocked
- **Blacklist Check** — Cross-references against known bad addresses
- **SMTP Classification** — Categorizes SMTP responses with 15 enhanced status codes + 26 text patterns
- **Smart Caching** — In-memory cache with per-result TTL. Cached hits = 0ms delay
- **Configurable Blocking** — Choose what to block: undeliverable, disposable, risky
- **Fail-Open Safety** — API timeout or error = email goes through. Never blocks legitimate mail
- **Dashboard Integration** — Full verification timeline in your ZoneMTA dashboard via remotelog
- **Authenticated Only** — Only verifies outbound mail from authenticated SMTP sessions

## Architecture

The plugin uses a three-hook architecture for proper dashboard integration:

```
┌─────────────────────────────────────────────────────────────┐
│  HOOK 1: smtp:rcpt_to — Verify + Reject                    │
│                                                             │
│  For each RCPT TO command:                                  │
│    1. Check in-memory cache (0ms if hit)                    │
│    2. Call MSG25 Verification API                           │
│    3. action = "block" → throw 550 SMTPReject               │
│    4. action = "allow" → store result on session            │
│                                                             │
│  Rejected recipients never reach DATA stage.                │
│  The email body is never transferred for blocked addresses. │
├─────────────────────────────────────────────────────────────┤
│  HOOK 2: smtp:data — Bridge session → envelope              │
│                                                             │
│  Copies verification results from session to envelope.      │
│  (Session is not available in message:queue hook.)           │
├─────────────────────────────────────────────────────────────┤
│  HOOK 3: message:queue — Write remotelog                    │
│                                                             │
│  Writes VERIFY_DELIVERABLE / VERIFY_RISKY / VERIFY_UNKNOWN │
│  to remotelog with real envelope.id — shows in dashboard    │
│  message timeline alongside SPF, Spam Check, Queued, etc.  │
└─────────────────────────────────────────────────────────────┘
```

**Why three hooks?**
- `smtp:rcpt_to` has no message ID yet (the message doesn't exist)
- `smtp:data` bridges session data to the envelope (same pattern as ZoneMTA's auth plugin)
- `message:queue` has the real `envelope.id` that links to the dashboard's `mids` collection
- Rejected messages never reach `message:queue` — they get logged with `session.id` and show up via the blocked filter path

## Pricing

**Email verification is FREE with every MSG25 plan.** No extra charge. No per-verification fees. Verify unlimited emails as part of your SMTP plan.

| Plan | Price | Emails/month | Verifications |
|---|---|---|---|
| **Free** | $0 | 1,000 | **Unlimited** |
| **Pay-as-you-go** | $0.10/1K emails | Unlimited | **Unlimited** |
| **LTD Starter** | $39 one-time | 5,000/mo | **Unlimited** |
| **LTD Pro** | $99 one-time | 15,000/mo | **Unlimited** |
| **LTD Agency** | $199 one-time | 50,000/mo | **Unlimited** |

> **Free verification for every user.** Other providers charge $0.40-$0.80 per 1,000 verifications. MSG25 includes it free with every plan.

[Sign up free](https://app.msg25.com/register)

## Installation

```bash
cd /path/to/zone-mta/plugins
npm install zonemta-email-verifier
```

Or copy the plugin file directly:

```bash
cp node_modules/zonemta-email-verifier/email-verifier.js /path/to/zone-mta/plugins/email-verifier.js
```

## Configuration

Create `config/plugins/email-verifier.toml`:

```toml
["email-verifier"]
enabled = ["receiver"]

# Get your API key at https://app.msg25.com/tools/email-verification
apiUrl = "https://app.msg25.com/api/v1/verify"
apiKey = "msg25_your_api_key_here"
apiTimeout = 10000

# Blocking settings (sent to API, API returns action: "allow" or "block")
blockUndeliverable = true    # Block undeliverable (no mailbox, no MX, blacklisted)
blockDisposable = true       # Block disposable/throwaway domains
blockRisky = false           # Block risky (catch-all, full mailbox)
```

### Configuration Options

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | array | `["receiver"]` | ZoneMTA plugin scope |
| `apiUrl` | string | `https://app.msg25.com/api/v1/verify` | MSG25 verification API endpoint |
| `apiKey` | string | *(required)* | Your MSG25 API key |
| `apiTimeout` | number | `10000` | API timeout in milliseconds (fail-open on timeout) |
| `blockUndeliverable` | boolean | `true` | Reject undeliverable addresses (no mailbox, hard bounced) |
| `blockDisposable` | boolean | `true` | Reject disposable/throwaway email domains |
| `blockRisky` | boolean | `false` | Reject risky addresses (catch-all, full mailbox) |

## How It Works

```
Sender connects via SMTP (authenticated)
        │
        ▼
RCPT TO: user@example.com
        │
        ▼
┌─ Plugin: smtp:rcpt_to hook ─────────────┐
│                                          │
│  1. Check in-memory cache                │
│     Hit? → Use cached result             │
│     Miss? → Call MSG25 API               │
│                                          │
│  2. API returns result + action          │
│                                          │
│  3. action = "block"?                    │
│     → 550 5.1.1 Rejected: <reason>       │
│     → Email body never transferred       │
│     → VERIFY_BLOCKED written to log      │
│                                          │
│  4. action = "allow"?                    │
│     → RCPT TO accepted                   │
│     → Result stored for dashboard        │
│                                          │
│  5. API timeout/error?                   │
│     → Fail-open: RCPT TO accepted        │
│     → Logged as VERIFY_UNKNOWN           │
└──────────────────────────────────────────┘
        │
        ▼
DATA (email body transferred)
        │
        ▼
┌─ Plugin: smtp:data hook ────────────────┐
│  Bridge: copy results session→envelope  │
└──────────────────────────────────────────┘
        │
        ▼
Message queued for delivery
        │
        ▼
┌─ Plugin: message:queue hook ────────────┐
│  Write VERIFY_DELIVERABLE/RISKY/UNKNOWN │
│  to remotelog with real message ID       │
│  → Shows in dashboard message timeline  │
└──────────────────────────────────────────┘
```

## SMTP Rejection Example

When a bad recipient is detected, the plugin responds with a `550` at the `RCPT TO` stage:

```
S: 220 mail.example.com ESMTP
C: EHLO sender.com
S: 250-OK
C: AUTH LOGIN ...
S: 235 Authentication successful
C: MAIL FROM:<sender@example.com>
S: 250 OK
C: RCPT TO:<nonexistent@outlook.com>
S: 550 5.1.1 Rejected: Undeliverable - mailbox does not exist    ← BLOCKED HERE
C: RCPT TO:<valid@gmail.com>
S: 250 OK
C: DATA
S: 354 Go ahead
C: (email body sent only to valid@gmail.com)
```

The email body is **never transferred** for blocked recipients. This saves bandwidth and prevents bounce-backs.

## API Response

The plugin sends your blocking settings to the API and obeys the `action` field:

```json
{
  "email": "user@example.com",
  "result": "deliverable",
  "reason": "SMTP accepted",
  "action": "allow",
  "action_reason": null,
  "score": 95,
  "disposable": false,
  "role": false,
  "free": true,
  "catch_all": false,
  "mx_found": true,
  "reachable": "yes",
  "duration_ms": 1842,
  "smtp_check": {
    "smtp_result": "accepted",
    "smtp_code": 250,
    "smtp_response": "250 OK"
  },
  "bounce_history": {
    "bounced": false,
    "bounce_count": 0,
    "blacklisted": false
  },
  "settings": {
    "block_undeliverable": true,
    "block_disposable": true,
    "block_risky": false
  }
}
```

### Result Values

| Result | Default Action | Description |
|---|---|---|
| `deliverable` | allow | Mailbox exists, SMTP accepted |
| `undeliverable` | **block** | No mailbox, no MX, blacklisted, or hard-bounced |
| `risky` | allow | Catch-all, full mailbox, or temporary issue |
| `unknown` | allow | SMTP timeout, greylisting, or server error |

### Blocking Settings

| Parameter | Default | What gets blocked |
|---|---|---|
| `blockUndeliverable` | `true` | No mailbox, no MX records, blacklisted, hard-bounced history |
| `blockDisposable` | `true` | Disposable/throwaway domains (130,000+ domains) |
| `blockRisky` | `false` | Catch-all domains, full mailboxes, temporary issues |

## Performance

| Scenario | Latency | Impact on SMTP |
|---|---|---|
| Cached result (memory hit) | **<1ms** | Negligible |
| Fresh API verification | **1-3 seconds** | Added to RCPT TO response time |
| API timeout/error | **Fail-open** | Email accepted, no delay beyond timeout |

### Cache TTL by Result

| Result | TTL | Why |
|---|---|---|
| Deliverable | 30 minutes | Mailboxes can be deleted |
| Undeliverable | 24 hours | Dead addresses stay dead |
| Risky | 15 minutes | Temporary conditions change |
| Unknown | 5 minutes | Retry soon for better result |

## Dashboard Integration

The plugin writes verification events to ZoneMTA's remotelog, which appear in your dashboard's message timeline:

| Log Action | Meaning | Dashboard Label |
|---|---|---|
| `VERIFY_DELIVERABLE` | Recipient verified as deliverable | VERIFIED |
| `VERIFY_RISKY` | Recipient is risky (catch-all, full mailbox) | RISKY |
| `VERIFY_UNKNOWN` | Verification inconclusive or API unavailable | UNVERIFIED |
| `VERIFY_BLOCKED` | Recipient rejected at RCPT TO | VERIFY BLOCKED |
| `VERIFY_UNDELIVERABLE` | Logged for rejected undeliverable addresses | UNDELIVERABLE |

Each log entry includes: `result`, `reason`, `score`, `duration_ms`, `source` (api/cache), `disposable`, `role`, `catch_all`, `smtp_code`, `reachable`, `free`.

**Blocked recipients** (`VERIFY_BLOCKED`) are logged with `session.id` since the message was never created. They appear in the dashboard's blocked filter alongside `BLOCKED_SENDER` entries.

**Allowed recipients** get logged with the real `envelope.id` in the `message:queue` hook, so their verification status appears in the message detail timeline alongside SPF, Spam Check, Queued, and Accepted entries.

## vs Other Solutions

| Feature | MSG25 | ZeroBounce | Emailable | Kickbox |
|---|---|---|---|---|
| Verification cost | **FREE** | $0.80/1K | $0.40/1K | $0.50/1K |
| ZoneMTA plugin | **Yes** | No | No | No |
| RCPT TO rejection | **Yes** | N/A | N/A | N/A |
| Real-time SMTP check | **Yes** | Yes | Yes | Yes |
| Disposable detection | **130,000+ domains** | Yes | Yes | Yes |
| Bounce history learning | **Yes** | No | No | No |
| Catch-all intelligence | **Yes** | Basic | Basic | Basic |
| SMTP classification | **15 codes + 26 patterns** | Basic | Basic | Basic |
| Configurable blocking | **Per-request** | Account-level | Account-level | Account-level |
| Free tier | **Unlimited** | 100/mo | 100/mo | 100/mo |
| Dashboard integration | **Full timeline** | N/A | N/A | N/A |

## Get Your API Key

1. Sign up at [app.msg25.com/register](https://app.msg25.com/register) (free)
2. Go to [Tools > Email Verification](https://app.msg25.com/tools/email-verification)
3. Click "Generate API Key"
4. Copy the key to your `email-verifier.toml`

## Links

- [MSG25 - Cheapest SMTP & Email Marketing Platform](https://msg25.com)
- [Email Verification Tool](https://app.msg25.com/tools/email-verification)
- [API Documentation](https://msg25.com/verify)
- [Sign Up Free](https://app.msg25.com/register)
- [ZoneMTA](https://github.com/zone-eu/zone-mta)

## License

MIT - Free to use. Requires a [MSG25](https://msg25.com) API key.
