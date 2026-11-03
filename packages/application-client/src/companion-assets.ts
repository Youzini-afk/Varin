/** Native windows pin one installed artwork generation for their entire lifetime. */
export function companionAssetBase(href?: string, review = false): string {
  if (review) return '/companion-review-director/';
  if (href) {
    const params = new URL(href).searchParams;
    const id = params.get('companionPack'), version = params.get('companionVersion');
    if (id && /^[a-z0-9][a-z0-9_-]*$/u.test(id) && version && /^[a-f0-9]{64}$/u.test(version)) {
      const origin = params.get('companionAssetOrigin');
      // Native-generated, fixed local protocol only. Never accept a renderer URL
      // that could transmit installed artwork or identifiers to a remote host.
      if (origin === 'varin-companion://localhost' || origin === 'http://varin-companion.localhost') return `${origin}/${id}/${version}/`;
      return `varin-ui://app/companion-assets/${id}/${version}/`;
    }
  }
  return '/companion-assets/';
}
