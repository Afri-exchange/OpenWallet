# spendkit.ai landing page

A static page: `index.html`, `styles.css`, `main.js`, `theme.js`. No build step, no dependencies, no fonts or
images to fetch. It is separate from the dashboard the service serves (`src/presentation/web/`).

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

- The limits playground in `main.js` mirrors `evaluate()` in `src/lib/services/spendPolicy.ts`. If the rules
  or their messages change there, change them here too.
- The feed in the hero is example data, labelled as such on the page.
- The page says what is and is not real today. Keep that section in step with `docs/production-gaps.md`.
