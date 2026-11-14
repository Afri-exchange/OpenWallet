# Security policy

This project handles card details, wallet keys and money movement. Please report security problems privately.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository
(https://github.com/spendkit/spendkit/security/advisories/new).

Do not open a public issue, pull request or discussion for a suspected vulnerability.

Please include what you found, how to reproduce it, and what an attacker could do with it. We aim to acknowledge
a report within 3 working days and to tell you what we plan to do within 10.

Never include real secrets, card numbers, mnemonics or personal data in a report. Sandbox values are enough.

## Scope and status

Spendkit is **sandbox only and not production-ready**. It refuses to start against non-sandbox Miden or Circle
hosts. The known gaps are listed in [docs/production-gaps.md](docs/production-gaps.md); those are not
vulnerabilities to report, but fixes are welcome.

If you run it anywhere other than your own machine, be aware that:

- it binds to `127.0.0.1` by default and has no rate limiting; the signup endpoints are open;
- owner tokens do not expire and email is not verified;
- the deposit and payout keys come from one mnemonic in a local file (testnet only);
- with `CARD_VAULT_KEY` set it stores full card details (encrypted), which puts a real deployment in PCI DSS scope.

## Supported versions

Only the `main` branch is supported.
