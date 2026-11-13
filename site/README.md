# spendkit.ai landing page

One idea: the page is a till receipt. The left column is the till (press a purchase, change the limits); the
right column is the receipt it prints, which also carries the rest of the page (how it works, how to connect,
what is real today).

Static files, no build step, no dependencies, no third-party requests: `index.html`, `styles.css`, `main.js`
and self-hosted fonts in `fonts/` (see `fonts/README.md` for licences). It is separate from the dashboard the
service serves (`src/presentation/web/`).

## Preview

```
python3 -m http.server 8781 --directory site
```

Open http://localhost:8781. Paths are root-relative, so open it through a server, not as a file.

## Deploy to Cloudflare Pages

From the dashboard: create a Pages project from this repository with no build command and `site` as the
output directory, then add `spendkit.ai` as a custom domain.

From the command line:

```
npx wrangler pages deploy site --project-name spendkit-site
```

`_headers` sets the security headers (a strict Content-Security-Policy with no inline scripts or styles), so
keep scripts and styles in their own files.

## Editing

- The till in `main.js` mirrors `evaluate()` in `src/lib/services/spendPolicy.ts`: the same three checks, in
  the same order, with the same messages. If they change there, change them here too.
- The receipt says what is and is not real today. Keep that section in step with `docs/production-gaps.md`.
