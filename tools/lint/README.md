# Linter

ESLint with bug-finding rules only. There are no style rules. It lives here, apart from the apps, so it never ships in them.

## Run it

Needs Node 22.13 or newer. The type-aware checks read the directory app's dependencies, so set those up too:

```bash
npm run setup --prefix reference-implementations/dacs-directory
npm ci --prefix tools/lint --ignore-scripts
npm run lint --prefix tools/lint
```

## Existing issues

`eslint-suppressions.json` lists the issues that were already in the code when the linter was added, as a count per file and rule. They don't fail the run. A new issue fails it, unless a listed issue of the same rule in the same file was removed in the same change, because the list holds counts rather than exact lines.

After fixing listed issues, shrink the list, or the run fails:

```bash
npm run lint:prune --prefix tools/lint
```

Don't add entries to it to get a pass. Fix the new issue, or use an `eslint-disable-next-line` comment that says why it's safe.

## What's left out

- Type-aware checks cover TypeScript in the directory app, except `app/.well-known/`, which TypeScript's project settings skip. JavaScript files have no types to read, so a missed `await` isn't caught there.
