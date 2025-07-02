require("dotenv").config();
const express = require("express");
const httpProxy = require("http-proxy");

const app = express();
const PORT = process.env.PROXY_PORT || 8000;
const BASE_PATH = process.env.BASE_PATH; // e.g. http://localhost:9001/__output

const proxy = httpProxy.createProxy();

app.use((req, res) => {
  const hostname = req.hostname;
  const subdomain = hostname.split(".")[0];

  const projectId = "a165f816-285f-40cb-98ef-d372ca428a08";
  const resolvesTo = `${BASE_PATH}/${projectId}`; // like: http://localhost:9001/__output/b5e20e58-.../

  // Serve index.html if root is requested
  if (req.url === "/") {
    req.url = "/index.html";
  }

  return proxy.web(req, res, {
    target: resolvesTo,
    changeOrigin: true,
  });
});

proxy.on("error", (err, req, res) => {
  console.error("Proxy error:", err);
  res.writeHead(502, { "Content-Type": "text/plain" });
  res.end("Bad Gateway");
});

app.listen(PORT, () => {
  console.log(`✅ Reverse proxy running at http://localhost:${PORT}`);
});
