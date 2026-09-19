// Routes outbound connections through the environment proxy for AWS SDK v3
// clients that don't check HTTP_PROXY/HTTPS_PROXY themselves (many of
// Amplify's CLI commands construct bare `new XClient()` instances with no
// proxy config, which otherwise hang forever behind an authenticated proxy).
//
// This patches http(s).request()/get() to inject a proxy agent ONLY when the
// caller didn't already pass their own `agent` option (mirrors global-agent's
// non-forcing mode). That matters because the CDK toolkit (used internally
// by `cdk` and `ampx`) constructs and passes its own proxy-aware agent
// explicitly for some calls — leaving those alone avoids double-wrapping a
// connection that's already tunneled through the proxy, which corrupts the
// response.
//
// Uses the `https-proxy-agent`/`http-proxy-agent` packages (not
// global-agent's own Agent classes) because they correctly set the TLS
// `servername` for the tunneled connection; global-agent's bundled classes
// were observed defaulting it to "localhost", failing certificate
// hostname validation against the real target (e.g. ssm.ap-south-1.amazonaws.com).
const http = require('http');
const https = require('https');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;

if (proxyUrl) {
  const httpProxyAgent = new HttpProxyAgent(proxyUrl);
  const httpsProxyAgent = new HttpsProxyAgent(proxyUrl);

  const wrap = (originalMethod, defaultAgent, globalAgentRef) => {
    return (...args) => {
      let options;
      let rest;
      if (typeof args[0] === 'string' || args[0] instanceof URL) {
        options = typeof args[1] === 'object' && args[1] !== null ? { ...args[1] } : {};
        rest = typeof args[1] === 'object' && args[1] !== null ? args.slice(2) : args.slice(1);
        if (!options.agent || options.agent === globalAgentRef()) {
          options.agent = defaultAgent;
        }
        return originalMethod(args[0], options, ...rest);
      }
      options = { ...args[0] };
      rest = args.slice(1);
      if (!options.agent || options.agent === globalAgentRef()) {
        options.agent = defaultAgent;
      }
      return originalMethod(options, ...rest);
    };
  };

  const originalHttpRequest = http.request.bind(http);
  const originalHttpGet = http.get.bind(http);
  const originalHttpsRequest = https.request.bind(https);
  const originalHttpsGet = https.get.bind(https);

  http.request = wrap(originalHttpRequest, httpProxyAgent, () => http.globalAgent);
  http.get = wrap(originalHttpGet, httpProxyAgent, () => http.globalAgent);
  https.request = wrap(originalHttpsRequest, httpsProxyAgent, () => https.globalAgent);
  https.get = wrap(originalHttpsGet, httpsProxyAgent, () => https.globalAgent);

  console.error(`[force-proxy] patched http(s).request/get to default unconfigured requests through ${proxyUrl}`);
}
