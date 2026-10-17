// =============================================================================
// Tiny local test server — ONLY for running the app on your own computer.
// It is NOT used on Vercel (Vercel serves the static files and api/generate.js itself).
//
// It does two things:
//   1. Serves index.html, style.css and script.js
//   2. Sends POST /api/generate to the same handler Vercel uses
//
// Run with:  npm run dev   (which loads your .env file via Node's --env-file flag)
// =============================================================================

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import handler from "./api/generate.js";

const PORT = process.env.PORT || 3000; // e.g. PORT=3001 npm run dev if 3000 is taken
const ROOT = import.meta.dirname;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
const STATIC_FILES = ["/index.html", "/style.css", "/script.js"];

const server = http.createServer(async (req, res) => {
  // Add the two helpers Vercel gives us: res.status() and res.json()
  res.status = (code) => ((res.statusCode = code), res);
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };

  // ---- API route ----
  if (req.url === "/api/generate") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      req.body = raw ? JSON.parse(raw) : {};
    } catch {
      return res.status(400).json({ error: "Invalid JSON." });
    }
    return handler(req, res);
  }

  // ---- Static files (only our three files, nothing else on disk) ----
  const path = req.url === "/" ? "/index.html" : req.url;
  if (!STATIC_FILES.includes(path)) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  const file = await readFile(join(ROOT, path));
  res.setHeader("Content-Type", TYPES[extname(path)]);
  res.end(file);
});

server.listen(PORT, () => {
  console.log(`Running at http://localhost:${PORT}`);
  if (!process.env.GROQ_API_KEY) console.warn("Warning: GROQ_API_KEY is not set. Check your .env file.");
});
