# zonemta-email-verifier

Real-time email verification plugin for [ZoneMTA](https://github.com/zone-eu/zone-mta). Validates every recipient **before delivery** via the [MSG25 Email Verification API](https://msg25.com) — blocks bounces, disposable emails, and undeliverable addresses automatically.

**Stop bounces before they happen.** This plugin checks every outgoing email recipient against MSG25's verification API and blocks bad addresses before your MTA even attempts delivery. Protect your sender reputation, reduce bounce rates, and save money on wasted sends.

## Why?

| Without verification | With this plugin |
|---|---|
| Emails bounce → IP reputation damaged | Bad addresses blocked before send |
| Disposable signups waste resources | Disposable domains auto-rejected |
| Catch-all domains hide bad addresses | Catch-all detection flags risky sends |
| Hard bounces accumulate silently | Bounce history prevents repeat failures |
| You find out after the damage is done | Real-time protection on every email |

## Features

- **SMTP Verification** — Connects to recipient's mail server and verifies the mailbox exists
- **Disposable Detection** — Blocks 5,000+ throwaway email domains (mailinator, guerrillamail, etc.)
- **Role-Based Detection** — Flags admin@, info@, support@ and 40+ role-based prefixes
- **Catch-All Detection** — Identifies domains that accept mail for any address
- **MX Record Check** — Verifies domain has valid mail server DNS records
- **Bounce History** — Learns from previous bounces across MSG25 network. Previously bounced = auto-blocked
- **Blacklist Check** — Cross-references against known bad addresses
- **SMTP Classification** — Categorizes responses (recipient, capacity, policy, block, greylist, rate)
- **Smart Caching** — In-memory cache with TTL per result type. Cached hits = 0ms delay
- **Configurable Blocking** — Choose what to block via API settings (undeliverable, disposable, risky)
- **Fail-Open Safety** — API timeout or error = email goes through. Never blocks legitimate mail
- **ZoneMTA remotelog** — Full verification details in your ZoneMTA logs

## Pricing

| Plan | Price | Verifications |
|---|---|---|
| **Free** | $0 | 1,000/month |
| **Starter** | $9/mo | 90,000/month |
| **Pro** | $19/mo | 190,000/month |
| **Business** | $39/mo | 390,000/month |
| **Pay-as-you-go** | $0.10/1,000 | Unlimited |

> **$0.10 per 1,000 verifications.** That's 10x cheaper than ZeroBounce ($0.80/1K), Emailable ($0.40/1K), and Kickbox ($0.50/1K).

[Sign up free →](https://app.msg25.com/register)

## Installation

```bash
cd /path/to/zone-mta/plugins
npm install zonemta-email-verifier
```

Or copy the plugin file directly:

```bash
cp node_modules/zonemta-email-verifier/index.js /path/to/zone-mta/plugins/email-verifier.js
```

## Configuration

Create `config/plugins/email-verifier.toml`:

```toml
["email-verifier"]
enabled = true

# Get your API key at https://app.msg25.com/tools/email-verification
apiUrl = "https://app.msg25.com/api/v1/verify"
apiKey = "msg25_your_api_key_here"
apiTimeout = 10000

# Blocking settings (sent to API, API returns action: "allow" or "block")
blockUndeliverable = true    # Block undeliverable (no mailbox, no MX, blacklisted)
blockDisposable = true       # Block disposable/throwaway domains
blockRisky = false           # Block risky (catch-all, full mailbox)
```

## How It Works

```
Email submitted to ZoneMTA
        ↓
Plugin intercepts (smtp:data_ready hook)
        ↓
For each recipient:
  ┌─ Check in-memory cache (0ms)
  │   Hit? → Use cached result
  │   Miss? ↓
  └─ Call MSG25 API with settings
        ↓
  API returns: result + action
        ↓
  action = "block"? → Remove recipient
  action = "allow"? → Let through
        ↓
All recipients blocked? → Reject with 550
Some blocked? → Remove bad, deliver to good
None blocked? → Deliver normally
```

## API Response

The plugin sends your settings to the API and obeys the `action` field:

```json
{
  "email": "user@example.com",
  "result": "deliverable",
  "reason": "SMTP accepted",
  "action": "allow",
  "action_reason": null,
  "disposable": false,
  "role": false,
  "catch_all": false,
  "mx_found": true,
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

| Result | Action (default) | Description |
|---|---|---|
| `deliverable` | allow | Mailbox exists, SMTP accepted |
| `undeliverable` | **block** | No mailbox, no MX, blacklisted, or hard-bounced |
| `risky` | allow | Catch-all, full mailbox, or temporary issue |
| `unknown` | allow | SMTP timeout, greylisting, or server error |

### Settings Parameters

| Parameter | Default | Description |
|---|---|---|
| `block_undeliverable` | `true` | Block emails with no mailbox, no MX, blacklisted, hard-bounced |
| `block_disposable` | `true` | Block disposable/throwaway email domains |
| `block_risky` | `false` | Block catch-all domains, full mailboxes, temporary issues |

## Performance

| Scenario | Latency |
|---|---|
| Cached result (memory) | **0ms** |
| Fresh SMTP verification | **1-3 seconds** |
| API timeout/error | **Fail-open** (email delivered) |

Cache TTL by result:
- Deliverable: 30 minutes
- Undeliverable: 60 minutes
- Risky: 15 minutes
- Unknown: 5 minutes

## ZoneMTA Log Actions

The plugin writes to ZoneMTA's remotelog:

| Action | When |
|---|---|
| `VERIFY_DELIVERABLE` | Recipient verified as deliverable |
| `VERIFY_RISKY` | Recipient is risky (catch-all, full mailbox) |
| `VERIFY_BLOCKED` | Recipient blocked (undeliverable or disposable) |
| `VERIFY_UNKNOWN` | Verification inconclusive or API unavailable |

Each log entry includes: `result`, `reason`, `duration_ms`, `source`, `disposable`, `role_based`, `catch_all`, `smtp_code`.

## vs Other Solutions

| Feature | MSG25 | ZeroBounce | Emailable | Kickbox |
|---|---|---|---|---|
| Price per 1K | **$0.10** | $0.80 | $0.40 | $0.50 |
| ZoneMTA plugin | **Yes** | No | No | No |
| Real-time SMTP check | **Yes** | Yes | Yes | Yes |
| Disposable detection | **5,000+ domains** | Yes | Yes | Yes |
| Bounce history learning | **Yes** | No | No | No |
| Catch-all intelligence | **Yes** | Basic | Basic | Basic |
| Configurable blocking | **Per-request** | Account-level | Account-level | Account-level |
| Free tier | **1,000/mo** | 100/mo | 100/mo | 100/mo |

## Get Your API Key

1. Sign up at [app.msg25.com/register](https://app.msg25.com/register) (free)
2. Go to [Tools → Email Verification](https://app.msg25.com/tools/email-verification)
3. Click "Generate API Key"
4. Copy the key to your `email-verifier.toml`

## Links

- [MSG25 — Cheapest SMTP & Email Marketing Platform](https://msg25.com)
- [Email Verification API Docs](https://app.msg25.com/tools/email-verification)
- [Sign Up Free](https://app.msg25.com/register)
- [ZoneMTA](https://github.com/zone-eu/zone-mta)

## License

MIT — Free to use. Requires a [MSG25](https://msg25.com) API key.
