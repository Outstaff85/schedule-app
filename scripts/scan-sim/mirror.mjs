// The weak-phone simulator's local copy of a deployed scanner lab (docs/tests.md → The weak-phone simulator): a small
// HTTP server on localhost (a secure context, so the camera and WebGPU work) that fetches each file once from the
// preview as the browser would get it (Brotli, its ETag and Cache-Control) and keeps it on disk, so 40 runs do not
// download the models 40 times. Two more things only a server can do for every thread: the device stand-in (shim.js)
// put in front of the background thread's bundle, and a slow network, shared by all the requests of a run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';

const KEPT = ['content-type', 'etag', 'cache-control', 'content-encoding'];

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'accept-encoding': 'br', 'user-agent': 'scan-sim' } }, res => {
      const parts = [];
      res.on('data', d => parts.push(d));
      res.on('end', () => {
        const headers = {};
        for (const k of KEPT) if (res.headers[k]) headers[k] = res.headers[k];
        resolve({ status: res.statusCode, headers, body: Buffer.concat(parts) });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

export class Mirror {
  /** preview: the deployed origin; dir: where its files are kept; shimFor(): the stand-in for the run's profile. */
  constructor(preview, dir, shimFor) {
    this.preview = preview.replace(/\/+$/, '');
    this.dir = dir;
    this.shimFor = shimFor;
    /** The run's network: { kbps, rttMs }, or null for none. */
    this.net = null;
    /** Bytes sent and requests seen in this run (the runs' figures). */
    this.sent = 0;
    this.requests = [];
    this.nextFree = 0;
    this.loading = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }

  async file(url) {
    const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 20), bin = path.join(this.dir, key + '.bin'), meta = path.join(this.dir, key + '.json');
    if (fs.existsSync(meta)) return { ...JSON.parse(fs.readFileSync(meta, 'utf8')), body: fs.readFileSync(bin) };
    if (!this.loading.has(url)) {
      this.loading.set(url, fetchRaw(this.preview + url).then(r => {
        fs.writeFileSync(bin, r.body);
        fs.writeFileSync(meta, JSON.stringify({ url, status: r.status, headers: r.headers }));
        this.loading.delete(url);
        return r;
      }));
    }
    return this.loading.get(url);
  }

  /** The body paced by the run's network: all the requests of a run share its bandwidth. */
  async send(res, body) {
    const net = this.net;
    if (!net) { res.end(body); return; }
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await sleep(net.rttMs);
    const bytesPerMs = net.kbps * 1000 / 8 / 1000, CHUNK = 16384;
    for (let i = 0; i < body.length; i += CHUNK) {
      const n = Math.min(CHUNK, body.length - i), now = Date.now();
      this.nextFree = Math.max(this.nextFree, now) + n / bytesPerMs;
      if (this.nextFree - now > 1) await sleep(this.nextFree - now);
      if (res.destroyed) return;
      res.write(body.subarray(i, i + n));
    }
    res.end();
  }

  async handle(req, res) {
    const url = req.url;
    if (url.startsWith('/__sim/blank')) { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>bench</title>'); return; }
    const f = await this.file(url);
    let body = f.body;
    const headers = { ...f.headers };
    // the background thread's bundle: the device stand-in in front of it (its own ETag, a profile's stand-in is its own)
    if (f.status === 200 && /^\/assets\/worker-[^/]+\.js/.test(url)) {
      const plain = headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(body) : body;
      body = Buffer.concat([Buffer.from(this.shimFor() + '\n'), plain]);
      delete headers['content-encoding'];
      headers['cache-control'] = 'no-store';
      delete headers.etag;
    }
    const seen = { url, bytes: body.length, at: Date.now(), end: null };
    this.requests.push(seen);
    const same = headers.etag && req.headers['if-none-match'] === headers.etag;
    if (same) { seen.end = Date.now(); seen.notModified = true; res.writeHead(304, headers); res.end(); return; }
    res.writeHead(f.status, { ...headers, 'content-length': body.length });
    this.sent += body.length;
    if (req.method === 'HEAD') { res.end(); return; }
    await this.send(res, body);
    seen.end = Date.now();
  }

  listen() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch(e => { res.statusCode = 502; res.end(String(e)); }));
    return new Promise(r => this.server.listen(0, '127.0.0.1', () => r(this.server.address().port)));
  }
  close() { this.server.closeAllConnections(); this.server.close(); }
}
