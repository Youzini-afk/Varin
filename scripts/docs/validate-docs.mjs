import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

import { checkEngineeringDocs, engineeringDocPaths, engineeringDocErrors } from "./check-engineering-docs.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..", "..")
const docsRoot = path.join(repoRoot, "packages", "docs")
const contentRoot = path.join(docsRoot, "content", "docs")
const sidebarPath = path.join(docsRoot, "sidebar.config.json")

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(target)
      return [target]
    }),
  )
  return files.flat()
}

function toPosix(value) {
  return value.split(path.sep).join("/")
}

function routeFromFile(filePath) {
  const relative = toPosix(path.relative(contentRoot, filePath))
  const withoutExt = relative.replace(/\.mdx$/, "")

  if (withoutExt === "index") return "/"
  if (withoutExt.endsWith("/index")) {
    return `/${withoutExt.slice(0, -"/index".length)}/`
  }

  return `/${withoutExt}/`
}

function hasFrontmatterKey(content, key) {
  const hit = /^---\n([\s\S]*?)\n---\n/m.exec(content)
  if (!hit) return false
  return new RegExp(`^${key}:\\s*.+$`, "m").test(hit[1])
}

async function exists(absolutePath) {
  try {
    await stat(absolutePath)
    return true
  } catch {
    return false
  }
}

/**
 * Locale directories are the ones that carry their own landing page. `troubleshooting/` is nested
 * content that every locale repeats, not a locale, so it must not be mistaken for one.
 */
async function siteLocales() {
  const entries = await readdir(contentRoot, { withFileTypes: true })
  const locales = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (await exists(path.join(contentRoot, entry.name, "index.mdx"))) locales.push(entry.name)
  }
  return locales
}

/** Absolute route targets from inline Markdown links, which is how the site cross-references pages. */
function collectRouteLinks(body) {
  return [...body.matchAll(/\[[^\]]*\]\((\/[^)\s]*)\)/g)].map((match) => match[1])
}

async function run() {
  const filePaths = (await walk(contentRoot)).filter((p) => p.endsWith(".mdx"))
  const routeSet = new Set()
  const errors = []
  const locales = await siteLocales()
  const pages = []

  if (locales.includes("en")) {
    errors.push("English is the default docs locale and must live at content/docs/, not content/docs/en/")
  }
  if (!locales.includes("zh-cn")) {
    errors.push("Simplified Chinese must live at the translated locale path content/docs/zh-cn/")
  }

  for (const filePath of filePaths) {
    const body = await readFile(filePath, "utf8")
    const relative = toPosix(path.relative(repoRoot, filePath))
    const route = routeFromFile(filePath)
    routeSet.add(route)
    pages.push({ body, relative, route })

    if (!hasFrontmatterKey(body, "title")) {
      errors.push(`${relative}: missing frontmatter key 'title'`)
    }
    if (!hasFrontmatterKey(body, "description")) {
      errors.push(`${relative}: missing frontmatter key 'description'`)
    }
  }

  // A translated page that links to another locale silently drops the reader into a language they
  // did not choose. Every locale carries the same page set, so the correct target always exists and
  // a cross-locale link is always a mistake rather than a deliberate reference.
  for (const { body, relative, route } of pages) {
    const owner = locales.find((locale) => route.startsWith(`/${locale}/`)) ?? null
    for (const target of collectRouteLinks(body)) {
      if (!routeSet.has(target)) {
        errors.push(`${relative}: link target is not a page: ${target}`)
        continue
      }
      const linked = locales.find((locale) => target.startsWith(`/${locale}/`)) ?? null
      if (linked === owner) continue
      const expected = owner === null ? target.replace(`/${linked}/`, "/") : `/${owner}${target}`
      errors.push(
        `${relative}: links to the ${linked ?? "default"} locale: ${target}`
        + `${routeSet.has(expected) ? ` (use ${expected})` : ""}`,
      )
    }
  }

  const sidebarRaw = await readFile(sidebarPath, "utf8")
  const sidebar = JSON.parse(sidebarRaw)
  const validateSidebarLocales = (value, owner = "sidebar") => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => validateSidebarLocales(entry, `${owner}[${index}]`))
      return
    }
    if (value === null || typeof value !== "object") return
    if (typeof value.label === "string") {
      if (typeof value.translations?.["zh-CN"] !== "string") {
        errors.push(`${owner}: missing Simplified Chinese sidebar translation`)
      }
      if (Object.hasOwn(value.translations ?? {}, "en")) {
        errors.push(`${owner}: English is the default sidebar label and must not remain in translations.en`)
      }
    }
    for (const [key, child] of Object.entries(value)) validateSidebarLocales(child, `${owner}.${key}`)
  }
  validateSidebarLocales(sidebar)
  const links = (sidebar.sections ?? [])
    .flatMap((section) => section.items ?? [])
    .map((item) => item.link)

  for (const link of links) {
    if (!routeSet.has(link)) {
      errors.push(`sidebar link has no page: ${link}`)
    }
  }

  const engineering = checkEngineeringDocs({ root: repoRoot, paths: engineeringDocPaths(repoRoot) })
  errors.push(...engineeringDocErrors(engineering))

  if (errors.length > 0) {
    console.error("Docs validation failed:")
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exit(1)
  }

  console.log(
    `Docs validation passed: ${filePaths.length} pages, ${links.length} sidebar links, `
    + `${engineering.checkedDocuments} engineering docs, ${engineering.checkedLinks} local links.`,
  )
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
