// Patches Node's http/https Agent classes to tunnel every outbound
// connection through the environment proxy. Needed because the AWS SDK v3 /
// CDK toolkit construct their own http(s).Agent instances directly and
// don't read HTTP_PROXY/HTTPS_PROXY themselves.
const http = require('http');
const https = require('https');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;

if (proxyUrl) {
  class PatchedHttpAgent extends HttpProxyAgent {
    constructor(options) {
      super(proxyUrl, options);
      // HttpProxyAgent defines `proxy` as a read-only getter, but some
      // callers (npm's fetch stack, possibly AWS SDK internals) assign to
      // it directly. Shadow it with a writable own property so that
      // doesn't throw.
      Object.defineProperty(this, 'proxy', { value: proxyUrl, writable: true, configurable: true });
    }
  }
  class PatchedHttpsAgent extends HttpsProxyAgent {
    constructor(options) {
      super(proxyUrl, options);
      Object.defineProperty(this, 'proxy', { value: proxyUrl, writable: true, configurable: true });
    }
  }

  http.Agent = PatchedHttpAgent;
  https.Agent = PatchedHttpsAgent;

  console.error(`[force-proxy] routing all http/https Agent traffic through ${proxyUrl}`);
}
