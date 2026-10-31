English | [简体中文](DEPLOYMENT.zh-CN.md)

# Documentation validation and publishing

This package is the source of the public user guides. They are published at
[varin.dev/docs](https://varin.dev/docs/) by the website repository,
[Varin-web](https://github.com/Youzini-afk/Varin-web), which renders them with Starlight. Edit the guides
here only; the website copies them at build time and never keeps its own version.

Content is in `content/docs/`; navigation is in `sidebar.config.json`. English is the root
locale. Locale directories and sidebar translation keys are listed in
[CONTRIBUTING.md](CONTRIBUTING.md).

Run the same validation used by CI from the repository root:

```bash
bun run docs:validate
```

`.github/workflows/ci.yml` and `.github/workflows/desktop-release.yml` invoke this check.
It validates frontmatter and local links, not a rendered site.

## How a change reaches the site

The website's build copies this directory from `main`: English pages are served under `/docs/` and each
translation under `/<locale>/docs/`. Root-relative links such as `/install/` and `/zh-cn/install/` are
rewritten to `/docs/install/` and `/zh-cn/docs/install/`, and a first `# Heading` that repeats the
frontmatter title is dropped, because the site shows the title itself. Keep writing links and headings as
the existing pages do.

After a push to `main` that changes `packages/docs`, `.github/workflows/docs-site.yml` calls the website's
Cloudflare Pages deploy hook, stored as the repository secret `DOCS_SITE_DEPLOY_HOOK`. Without that secret
the workflow only reports that no rebuild was requested; rebuild the latest deployment from the Cloudflare
dashboard instead. To preview locally, keep both repositories side by side and run `bun run dev` in Varin-web;
it reads `../Varin/packages/docs` directly.
