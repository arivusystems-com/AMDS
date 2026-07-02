/** 1×1 transparent PNG */
export const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const LINK_RE = /<a\s+[^>]*href=["']([^"']+)["']/gi;

export function extractLinkUrls(html: string): string[] {
  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(html)) !== null) {
    const url = match[1];
    if (
      url.startsWith('mailto:') ||
      url.startsWith('#') ||
      url.startsWith('tel:') ||
      url.includes('/c/')
    ) {
      continue;
    }
    urls.add(url);
  }
  return [...urls];
}

export function injectTrackingHtml(
  html: string,
  baseUrl: string,
  openToken: string | null,
  clickTokens: Record<string, string>
): string {
  const root = baseUrl.replace(/\/$/, '');
  let result = html;

  for (const [url, token] of Object.entries(clickTokens)) {
    const wrapped = `${root}/c/${token}`;
    result = result.split(`href="${url}"`).join(`href="${wrapped}"`);
    result = result.split(`href='${url}'`).join(`href='${wrapped}'`);
  }

  if (openToken) {
    const pixel = `<img src="${root}/t/${openToken}.png" width="1" height="1" alt="" style="display:none" />`;
    if (/<\/body>/i.test(result)) {
      result = result.replace(/<\/body>/i, `${pixel}</body>`);
    } else {
      result += pixel;
    }
  }

  return result;
}
