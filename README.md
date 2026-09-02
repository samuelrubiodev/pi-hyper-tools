# pi-hyper-tools

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An enhanced [Pi] extension for Charm's [Hyper] inference provider, based on the official [charmbracelet/pi-hyper-provider](https://github.com/charmbracelet/pi-hyper-provider).

This fork extends the official Hyper provider with an interactive `/hyper` terminal dashboard, dynamic server rate-limit detection from HTTP response headers, live Hypercredit balance tracking, dual cost accounting, detailed token & cache statistics, and interactive slash command autocomplete.

[Pi]: https://pi.dev
[Hyper]: https://hyper.charm.land

```sh
# Install in Pi
pi install git:github.com/samuelrubiodev/pi-hyper-tools

# Install in Pi from npm
pi install npm:pi-hyper-tools

# Or install from local directory during development
pi install /path/to/omp-hyper-tools
```

---

## What This Fork Adds

This extension is 100% compatible with the official provider while adding:

- **Interactive `/hyper` Dashboard**: A polished ASCII terminal overview displaying live credit balance, dynamic rate limits, active model pricing, cache hit rate, and session usage.
- **Dynamic Server Rate Limits**: Inspects HTTP response headers (`x-ratelimit-*`) on live inference requests to automatically detect hourly and daily rate limits and remaining requests without hardcoding account tiers.
- **Dual Cost Accounting**: Captures server-reported actual request costs when returned by Hyper alongside pricing formula calculations based on input, output, cache-read, and cache-write rates.
- **Subcommand Autocomplete**: Interactive autocomplete suggestions when typing `/hyper ` or `/hyper status ` in the Pi editor.
- **Detailed Usage Analytics**: `/hyper stats` breaks down uncached input tokens, cached tokens, reasoning tokens, and cache hit rates.
- **Explicit Request Accounting**: `/hyper requests` clearly distinguishes authoritative server-reported limits from local session/machine request counts.
- **Configurable Status Line**: Live footer status showing credit balance and team name via `/hyper status`.

---

## Authentication

### OAuth (Recommended)

1. Open `pi`.
2. Run `/login`.
3. Choose **Subscription** and select **Charm Hyper**.
4. Complete the device authorization flow in your browser.

### API Key

Set the `HYPER_API_KEY` environment variable in your shell:

```sh
export HYPER_API_KEY="your-hyper-api-key"
```

Then launch `pi`.

---

## Selecting Models

List and select available Hyper models using Pi's model selector:

```text
/model hyper
```

Examples:
- `hyper/deepseek-v4-flash`
- `hyper/qwen3.8-flash`
- `hyper/qwen3.8-max`
- `hyper/kimi-k3`

The dashboard and pricing display automatically adapt whenever you switch models.

---

## Commands

All `/hyper` commands include full argument autocompletion. Simply type `/hyper ` in the Pi editor to see interactive suggestions for all available subcommands (`credits`, `requests`, `stats`, `refresh`, `status`, `help`).

### `/hyper`

Displays the compact, complete Hyper dashboard:

```text
╭─ Hyper ───────────────────────────╮
│                                    │
│ Hypercredits                       │
│   183.42 HC   ($9.17)              │
│                                    │
│ Rate Limits                        │
│   Hour: 180 / 200 remaining        │
│   Day:  385 / 1000 remaining       │
│                                    │
│ Model                              │
│   DeepSeek V4 Flash                │
│                                    │
│ Pricing                            │
│   Input:       $0.20 / 1M          │
│   Cache read:  $0.04 / 1M          │
│   Output:      $0.40 / 1M          │
│                                    │
│ Cache                              │
│   Session hit rate: 95.4%          │
│                                    │
│ Usage                              │
│   Session:  0.02 HC  ($0.0008)     │
│                                    │
╰────────────────────────────────────╯
```

### `/hyper credits`

Shows your authoritative Hypercredit balance, USD value, and last refresh timestamp:

```text
Hypercredits (authoritative server-side balance)

  Balance:         183.42 HC
  USD Equivalent:  $9.17
  Last Refreshed:  just now
```

### `/hyper requests`

Displays authoritative server rate limits and local session request counts:

```text
Requests

Server reported limits
  Hour: 180 remaining / 200
  Day:  385 remaining / 1000
  Last server update: just now

Local activity
  Hour: 14 requests
  Day:  24 requests

Note: Server limits are authoritative from Hyper response headers. Local activity counts inference requests made from this Pi session/machine.
```

### `/hyper stats`

Displays token usage, reasoning tokens, cache hit rate, and estimated vs server-reported costs for both the current session and today's aggregate usage:

```text
Hyper Usage Statistics

Session Usage
  Inference Requests:    12
  Uncached Input Tokens: 8,509
  Cached Input Tokens:   174,912
  Total Input Tokens:    183,421
  Cache Hit Rate:        95.4% (cached / (uncached + cached))
  Output Tokens:         4,200
  Reasoning Tokens:      1,800
  Total Tokens:          187,621
  Estimated Cost:        $0.14 (2.8400 HC)
  Server Reported Cost:  $0.14 (2.8300 HC)

Today's Aggregate Usage
  Inference Requests:    45
  Uncached Input Tokens: 30,000
  Cached Input Tokens:   500,000
  Total Input Tokens:    530,000
  Cache Hit Rate:        94.3% (cached / (uncached + cached))
  Output Tokens:         15,000
  Reasoning Tokens:      6,000
  Total Tokens:          545,000
  Estimated Cost:        $0.45 (9.0000 HC)
  Server Reported Cost:  $0.45 (8.9800 HC)
```

### `/hyper refresh`

Bypasses local caches to fetch fresh balance data from `/v1/credits` and model pricing catalogs from `/v1/provider`.

### `/hyper status`

Interactive or CLI configuration for the Pi footer status line:

```sh
/hyper status teamName true
/hyper status hypercredits false
/hyper status reset
```

*(Legacy alias `/hyper-status` is also supported).*

---

## Data Accounting & Sources of Truth

The extension separates sources of truth across three categories:

| Category | Metric | Source | Nature |
| :--- | :--- | :--- | :--- |
| **Balance** | Hypercredits | `GET /v1/credits` | **Authoritative**: Real server-side balance from Hyper account. |
| **Rate Limits** | Hourly & Daily Limits / Remaining | Inference HTTP Headers (`x-ratelimit-*`) | **Authoritative**: Real server rate limits currently applied to the account. |
| **Model Pricing** | Rates per 1M tokens | `GET /v1/provider` | **Authoritative**: Real rates for input, output, cache-read, and cache-write. |
| **Activity** | Local Request Counters | Local Tracker | **Local Activity**: Counts model inference calls originating from this Pi installation. |
| **Cost** | Actual vs Estimated Cost | Completion chunk / Model rates | **Dual**: Server-reported cost when provided by Hyper, alongside local rate formula estimates. |

---

## Privacy & Local Storage

- Local persistence is stored in `~/.pi/agent/hyper-provider/` (`settings.json` and `usage.json`).
- Stored records contain **only metadata**: timestamp, model ID, token counts, rate limits, and cost calculations.
- **Zero prompt text, zero model responses, zero tool arguments, and zero conversation content** are ever persisted or sent outside inference calls.
- Historical usage records older than 30 days are automatically pruned to keep file sizes negligible (< 50 KB).

---

## Development & Testing

Run the test suite:

```sh
npm test
```

Run TypeScript type checking:

```sh
npm run typecheck
```

Run formatting and linting:

```sh
npm run check:biome
```

Run live API verification (requires `HYPER_API_KEY`):

```sh
npx tsx test/integration.live.ts
```

---

## Acknowledgements & License

This project is a fork of the official [charmbracelet/pi-hyper-provider](https://github.com/charmbracelet/pi-hyper-provider) by [Charm](https://charm.land).

Licensed under the [MIT License](LICENSE).
