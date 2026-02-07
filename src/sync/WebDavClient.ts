export interface WebDavConfig {
  url: string;
  username: string;
  password: string;
}

export interface WebDavFileInfo {
  path: string;
  size: number;
  lastModified: Date;
  etag?: string;
  isDirectory: boolean;
}

export class WebDavClient {
  private baseUrl: string;
  private authHeader: string;
  private lastRequestTime = 0;
  private minInterval = 1500; // ms between requests (坚果云 free tier is very strict)
  private knownDirs: Set<string> = new Set();

  constructor(config: WebDavConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.authHeader = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise(r => setTimeout(r, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private fullUrl(remotePath: string): string {
    const clean = remotePath.startsWith('/') ? remotePath : '/' + remotePath;
    return this.baseUrl + encodeURI(clean);
  }

  private async request(method: string, remotePath: string, options?: {
    body?: Buffer | string;
    headers?: Record<string, string>;
    retries?: number;
  }): Promise<Response> {
    const maxRetries = options?.retries ?? 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.throttle();

      const url = this.fullUrl(remotePath);
      const headers: Record<string, string> = {
        'Authorization': this.authHeader,
        ...options?.headers,
      };

      const resp = await fetch(url, {
        method,
        headers,
        body: options?.body,
      });

      // Retry on 503 (rate limit) with exponential backoff
      if (resp.status === 503 && attempt < maxRetries) {
        // Slow down all future requests too
        this.minInterval = Math.min(this.minInterval * 2, 10000);
        const delay = Math.min(3000 * Math.pow(2, attempt), 30000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return resp;
    }

    // Should not reach here, but fallback
    throw new Error(`Request failed after ${maxRetries} retries: ${method} ${remotePath}`);
  }

  async testConnection(): Promise<boolean> {
    try {
      const resp = await this.request('PROPFIND', '/', {
        headers: { 'Depth': '0' },
      });
      return resp.status === 207 || resp.status === 200;
    } catch {
      return false;
    }
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      const resp = await this.request('PROPFIND', remotePath, {
        headers: { 'Depth': '0' },
      });
      return resp.status === 207 || resp.status === 200;
    } catch {
      return false;
    }
  }

  async mkdir(remotePath: string): Promise<void> {
    const resp = await this.request('MKCOL', remotePath);
    if (resp.status !== 201 && resp.status !== 405) {
      // 405 = already exists, which is fine
      if (resp.status >= 400) {
        throw new Error(`mkdir failed: ${resp.status} ${resp.statusText}`);
      }
    }
  }

  async delete(remotePath: string): Promise<void> {
    const resp = await this.request('DELETE', remotePath);
    if (resp.status >= 400 && resp.status !== 404) {
      throw new Error(`delete failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async mkdirp(remotePath: string): Promise<void> {
    const parts = remotePath.split('/').filter(p => p);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      if (this.knownDirs.has(current)) { continue; }
      // Try mkdir directly (MKCOL), skip exists check to save a request
      // 405 = already exists, which is fine
      await this.mkdir(current);
      this.knownDirs.add(current);
    }
  }

  async upload(remotePath: string, content: Buffer | string): Promise<void> {
    const body = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const resp = await this.request('PUT', remotePath, {
      body,
      headers: { 'Content-Type': 'application/octet-stream' },
    });

    if (resp.status >= 400) {
      throw new Error(`upload failed: ${resp.status} ${resp.statusText}`);
    }
  }

  async download(remotePath: string): Promise<Buffer> {
    const resp = await this.request('GET', remotePath);

    if (resp.status === 404) {
      throw new Error(`File not found: ${remotePath}`);
    }
    if (resp.status >= 400) {
      throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async list(remotePath: string): Promise<WebDavFileInfo[]> {
    const path = remotePath.endsWith('/') ? remotePath : remotePath + '/';
    const resp = await this.request('PROPFIND', path, {
      headers: { 'Depth': '1' },
    });

    if (resp.status === 404) {
      return [];
    }
    if (resp.status !== 207) {
      throw new Error(`list failed: ${resp.status} ${resp.statusText}`);
    }

    const xml = await resp.text();
    return this.parsePropfind(xml, path);
  }

  async listRecursive(remotePath: string): Promise<WebDavFileInfo[]> {
    const results: WebDavFileInfo[] = [];
    const items = await this.list(remotePath);

    for (const item of items) {
      if (item.isDirectory) {
        const subPath = remotePath.replace(/\/+$/, '') + '/' + item.path;
        const subItems = await this.listRecursive(subPath);
        for (const sub of subItems) {
          sub.path = item.path + sub.path;
          results.push(sub);
        }
      } else {
        results.push(item);
      }
    }

    return results;
  }

  async getFileInfo(remotePath: string): Promise<WebDavFileInfo | null> {
    try {
      const resp = await this.request('PROPFIND', remotePath, {
        headers: { 'Depth': '0' },
      });

      if (resp.status === 404) { return null; }
      if (resp.status !== 207) { return null; }

      const xml = await resp.text();
      const items = this.parsePropfind(xml, remotePath);
      return items.length > 0 ? items[0] : null;
    } catch {
      return null;
    }
  }

  private parsePropfind(xml: string, basePath: string): WebDavFileInfo[] {
    const results: WebDavFileInfo[] = [];

    // Normalize base path for comparison
    const normalizedBase = decodeURIComponent(this.baseUrl.replace(/^https?:\/\/[^/]+/, '') + basePath).replace(/\/+$/, '');

    // Split by response elements
    const responses = xml.split(/<(?:D|d):response>/g).slice(1);

    for (const resp of responses) {
      const href = this.extractTag(resp, 'href');
      if (!href) { continue; }

      const decodedHref = decodeURIComponent(href).replace(/\/+$/, '');

      // Skip the directory itself
      if (decodedHref === normalizedBase || decodedHref + '/' === normalizedBase + '/') {
        continue;
      }

      const contentLength = this.extractTag(resp, 'getcontentlength');
      const lastModified = this.extractTag(resp, 'getlastmodified');
      const etag = this.extractTag(resp, 'getetag');
      const isCollection = resp.includes('<D:collection') || resp.includes('<d:collection');

      // Extract relative path: the last segment of the href
      const segments = decodedHref.split('/').filter(s => s);
      const name = segments[segments.length - 1];

      if (name) {
        results.push({
          path: isCollection ? name + '/' : name,
          size: contentLength ? parseInt(contentLength, 10) : 0,
          lastModified: lastModified ? new Date(lastModified) : new Date(0),
          etag: etag?.replace(/"/g, '') || undefined,
          isDirectory: isCollection,
        });
      }
    }

    return results;
  }

  private extractTag(xml: string, tagName: string): string | null {
    const regex = new RegExp(`<(?:[Dd]:)?${tagName}[^>]*>([^<]*)<`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : null;
  }
}
