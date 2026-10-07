'use strict';
/* Builds the GitHub Pages copy of Firstcall into docs/. Run with: node build-pages.js
   - docs/index.html is the app screens (index.html) wrapped as a complete page.
   - docs/script.txt is the Google script the owner pastes into script.google.com: the email reader (mail.js)
     followed by the part that answers the app (google-script.src.js).
   The other files in docs/ are written by hand and are not touched. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DOCS = path.join(ROOT, 'docs');
fs.mkdirSync(DOCS, { recursive: true });

/* ---------- the Google script ---------- */
const reader = fs.readFileSync(path.join(ROOT, 'mail.js'), 'utf8')
  .replace(/^'use strict';\n/, '')
  .replace(/\nmodule\.exports = [^\n]*\n?$/, '\n');
const answers = fs.readFileSync(path.join(ROOT, 'google-script.src.js'), 'utf8');
const script = [
  '/**',
  ' * Firstcall: the Google side.',
  ' *',
  ' * This runs in your own Google account. It reads the form emails your website sends to this Gmail inbox',
  ' * (and no other emails), keeps your leads and their notes in this script\'s own storage, and passes a lead to',
  ' * ServiceM8 when you ask it to. It only answers requests that carry its key, which only your Firstcall has.',
  ' *',
  ' * To set it up: Deploy, New deployment, type "Web app", Execute as "Me", Who has access "Anyone", Deploy.',
  ' * Then paste the Web app URL into Firstcall.',
  ' * To cut off every connected device: choose "disconnectEverything" in the function list and press Run.',
  ' */',
  '',
  '/* ------------------------------------------------------------------------------------------------------------',
  '   The part below reads a website form email and picks out the name, phone, address and so on.',
  '   ------------------------------------------------------------------------------------------------------------ */',
  reader.replace(/^\/\*[\s\S]*?\*\/\n/, ''),
  answers,
].join('\n');
new Function(script); /* must at least be valid JavaScript */
fs.writeFileSync(path.join(DOCS, 'script.txt'), script);

/* ---------- the page ---------- */
const app = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const inline = /<script>([\s\S]*?)<\/script>/.exec(app);
const hash = crypto.createHash('sha256').update(inline[1]).digest('base64');
const csp = "default-src 'self'; script-src 'self' 'sha256-" + hash + "'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://script.google.com https://script.googleusercontent.com; " +
  "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'";
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
  '<meta name="referrer" content="no-referrer">' +
  '<meta name="theme-color" content="#141A40"><meta name="apple-mobile-web-app-capable" content="yes">' +
  '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">' +
  '<meta name="apple-mobile-web-app-title" content="Firstcall"><meta name="format-detection" content="telephone=no">' +
  '<link rel="manifest" href="manifest.webmanifest"><link rel="apple-touch-icon" href="apple-touch-icon.png">' +
  '<link rel="icon" href="icon.svg" type="image/svg+xml">' +
  '<style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}' +
  'html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}' +
  'img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style>' +
  '<link rel="stylesheet" href="setup.css"><script src="link.js"></script></head><body>\n' +
  app + '\n<script src="setup.js"></script></body></html>\n';
fs.writeFileSync(path.join(DOCS, 'index.html'), html);

for (const f of ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) fs.copyFileSync(path.join(ROOT, f), path.join(DOCS, f));
/* GitHub Pages would otherwise run the site through Jekyll, which is not needed here. */
fs.writeFileSync(path.join(DOCS, '.nojekyll'), '');

/* The saved-files version changes whenever any file of the site changes, so phones pick up an update. */
const swPath = path.join(DOCS, 'sw.js');
if (fs.existsSync(swPath)) {
  const h = crypto.createHash('sha256');
  for (const f of ['index.html', 'link.js', 'setup.js', 'setup.css', 'manifest.webmanifest']) if (fs.existsSync(path.join(DOCS, f))) h.update(fs.readFileSync(path.join(DOCS, f)));
  const sw = fs.readFileSync(swPath, 'utf8').replace(/const VERSION = '[^']*';/, "const VERSION = '" + h.digest('hex').slice(0, 12) + "';");
  fs.writeFileSync(swPath, sw);
}
console.log('Built docs/ (script ' + script.length + ' characters, page ' + html.length + ')');
