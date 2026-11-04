export interface WebSource {
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly publishedAt: string | null;
}

export interface WebPage {
  readonly title: string;
  readonly url: string;
  readonly content: string;
}

// The model integration depends on this interface, not on a particular search vendor.
export interface WebProvider {
  search(query: string, signal: AbortSignal): Promise<readonly WebSource[]>;
  fetchPage(url: string, signal: AbortSignal): Promise<WebPage>;
}

export class WebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebError';
  }
}

export function publicWebUrl(value: string): string {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw new WebError('Use a public HTTP(S) page URL.');
  let url: URL;
  try { url = new URL(value); } catch { throw new WebError('Use a public HTTP(S) page URL.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Fetching is delegated to the web service. Do not request local hosts, IP literals, or credentials.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.') ||
    /^[\d.]+$/.test(host) || host.includes(':') ||
    ['.localhost', '.local', '.internal', '.lan', '.home', '.invalid', '.test'].some(suffix => host.endsWith(suffix)) ||
    (url.port && !['80', '443'].includes(url.port))) {
    throw new WebError('Only public HTTP(S) pages without credentials are supported.');
  }
  return url.href;
}
