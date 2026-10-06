/** Shared Markdown link extraction for documentation path and route checks. */

const stripCodeFences = (text) => {
  let fence = null
  return text.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null
      return ""
    }
    if (marker) { fence = marker; return "" }
    return line.replace(/(?<!`)(`+)(?!`)[^\n]*?\1(?!`)/g, " ")
  }).join("\n")
}

/**
 * Collect link targets from inline links and reference definitions.
 * Returns targets with queries/fragments removed and external URLs filtered out.
 */
export const collectLocalLinkTargets = (markdown) => {
  const body = stripCodeFences(markdown)
  const targets = []

  const push = (raw) => {
    if (typeof raw !== "string") return
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return
    if (trimmed.startsWith("//")) return
    const pathname = trimmed.split(/[?#]/)[0]
    if (pathname.length === 0) return
    targets.push(decodeURI(pathname))
  }

  for (const match of body.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)) push(match[1])
  for (const match of body.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)) push(match[1])

  return targets
}
