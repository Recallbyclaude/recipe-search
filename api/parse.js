// Vercel serverless function — POST /api/parse
// Body:    { url?: string, text?: string, known?: { cuisine:[], mood:[], dietary:[] } }
// Returns: { recipe: { title, cuisine[], mood[], dietary[], time, servings, ingredients[], instructions[], photo }, note? }
//
// 1. Links: most recipe sites embed schema.org "Recipe" data — read that directly (no API key needed).
// 2. If ANTHROPIC_API_KEY is set in Vercel, Claude adds mood/dietary tags and handles pasted text
//    or pages without recipe data.

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST', aiConfigured: !!process.env.ANTHROPIC_API_KEY });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const known = cleanKnown(body.known);
  const hasKey = !!process.env.ANTHROPIC_API_KEY;

  try {
    if (body.url) {
      const url = String(body.url).trim();
      if (!isSafeUrl(url)) return res.status(400).json({ error: "That link doesn't look valid." });

      let html;
      try { html = await fetchPage(url); }
      catch (e) { return res.status(422).json({ error: "Couldn't open that page (the site may block it). Try Paste Text instead." }); }

      const ld = findRecipeJsonLd(html);
      if (ld) {
        const base = fromJsonLd(ld, url);
        if (!hasKey) return res.json({ recipe: base, note: 'Filled from the page — add mood and dietary tags yourself.' });
        try {
          const tagged = await askClaude('Structured recipe data from ' + url + ':\n' + JSON.stringify(base).slice(0, 12000), known);
          return res.json({ recipe: mergeTags(base, tagged) });
        } catch (e) {
          return res.json({ recipe: base, note: 'Filled from the page (AI tagging failed — add tags yourself).' });
        }
      }

      if (!hasKey) {
        return res.status(501).json({ error: "This page has no built-in recipe data, and AI reading isn't switched on yet. Try Paste Text, or type it in." });
      }
      const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
      const recipe = await askClaude('Page title: ' + title + '\nPage text:\n' + htmlToText(html).slice(0, 18000), known);
      const og = getMeta(html, 'og:image');
      if (og && !recipe.photo) recipe.photo = absolutize(og, url);
      return res.json({ recipe });
    }

    if (body.text) {
      if (!hasKey) return res.status(501).json({ error: "AI reading isn't switched on yet (ANTHROPIC_API_KEY missing in Vercel). You can still type the recipe in." });
      const recipe = await askClaude('Recipe text:\n' + String(body.text).slice(0, 18000), known);
      return res.json({ recipe });
    }

    return res.status(400).json({ error: 'Send a link or some text.' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
};

// ── Claude ────────────────────────────────────────────────────────────
async function askClaude(content, known) {
  const system =
`You extract recipes into JSON for a family recipe website. Reply with ONLY a JSON object (no prose, no code fences) with these keys:
title (string), cuisine (array of short strings like "Italian"), mood (array of 1-3 lowercase words like "comfort", "quick", "elegant"),
dietary (array of lowercase words like "vegan", "vegetarian", "seafood"; empty if none apply), time (string like "45 mins" or "2 hrs"),
servings (string), ingredients (array; one ingredient per item with its quantity; no commas inside an item), instructions (array of clear steps).
Prefer reusing these existing tags when they fit — cuisine: ${known.cuisine.join(', ') || 'none'}; mood: ${known.mood.join(', ') || 'none'}; dietary: ${known.dietary.join(', ') || 'none'}.
Use "" or [] when something is unknown. Never invent ingredients or steps that are not in the source.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, system, messages: [{ role: 'user', content }] })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('AI error: ' + ((data.error && data.error.message) || r.status));

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let out;
  try { out = JSON.parse(json); } catch (e) { throw new Error("Couldn't read that recipe — try pasting the text instead."); }
  return normalize(out);
}

function normalize(o) {
  o = o || {};
  const arr = v => (Array.isArray(v) ? v : v ? [v] : []).map(x => String(x).trim()).filter(Boolean);
  return {
    title: String(o.title || '').trim(),
    cuisine: arr(o.cuisine),
    mood: arr(o.mood).map(s => s.toLowerCase()),
    dietary: arr(o.dietary).map(s => s.toLowerCase()),
    time: String(o.time || '').trim(),
    servings: String(o.servings || '').trim(),
    ingredients: arr(o.ingredients).map(s => s.replace(/,/g, '')),
    instructions: arr(o.instructions),
    photo: typeof o.photo === 'string' ? o.photo : ''
  };
}

function mergeTags(base, ai) {
  const uniq = a => Array.from(new Set(a.filter(Boolean)));
  return Object.assign({}, base, {
    title: base.title || ai.title,
    cuisine: uniq(base.cuisine.length ? base.cuisine : ai.cuisine),
    mood: ai.mood,
    dietary: ai.dietary,
    time: base.time || ai.time,
    servings: base.servings || ai.servings,
    ingredients: base.ingredients.length ? base.ingredients : ai.ingredients,
    instructions: base.instructions.length ? base.instructions : ai.instructions
  });
}

function cleanKnown(k) {
  k = k || {};
  const list = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.length < 40).slice(0, 60);
  return { cuisine: list(k.cuisine), mood: list(k.mood), dietary: list(k.dietary) };
}

// ── Page fetching ─────────────────────────────────────────────────────
function isSafeUrl(u) {
  let url;
  try { url = new URL(u); } catch (e) { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  const h = url.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0' || h.includes(':')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  return true;
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en'
      }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.text()).slice(0, 3000000);
  } finally { clearTimeout(t); }
}

// ── schema.org Recipe (JSON-LD) ───────────────────────────────────────
function findRecipeJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const found = search(data);
    if (found) return found;
  }
  return null;

  function search(n) {
    if (!n || typeof n !== 'object') return null;
    if (Array.isArray(n)) { for (const x of n) { const f = search(x); if (f) return f; } return null; }
    const t = n['@type'];
    if (t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'))) return n;
    if (n['@graph']) return search(n['@graph']);
    if (n.mainEntity) return search(n.mainEntity);
    return null;
  }
}

function fromJsonLd(r, pageUrl) {
  const arr = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
  const clean = s => decode(String(s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();

  const steps = [];
  (function walk(x) {
    if (!x) return;
    if (typeof x === 'string') { x.split(/\n+/).forEach(s => { s = clean(s); if (s) steps.push(s); }); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x.itemListElement) { walk(x.itemListElement); return; }
    if (x.text) { walk(x.text); return; }
    if (x.name) walk(x.name);
  })(r.recipeInstructions);

  let img = r.image;
  if (Array.isArray(img)) img = img[0];
  if (img && typeof img === 'object') img = img.url || img.contentUrl;

  const yld = arr(r.recipeYield)[0];

  return {
    title: clean(r.name || ''),
    cuisine: arr(r.recipeCuisine).flatMap(c => String(c).split(',')).map(clean).filter(Boolean),
    mood: [],
    dietary: [],
    time: isoToText(r.totalTime) || isoToText(r.cookTime) || '',
    servings: yld != null ? clean(yld).replace(/\s*(servings?|serves)\s*$/i, '') : '',
    ingredients: arr(r.recipeIngredient).map(s => clean(s).replace(/,/g, '')).filter(Boolean),
    instructions: steps,
    photo: typeof img === 'string' ? absolutize(img, pageUrl) : ''
  };
}

function isoToText(d) {
  if (!d || typeof d !== 'string') return '';
  const m = d.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/i);
  if (!m) return '';
  const mins = (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0);
  if (!mins) return '';
  if (mins < 60) return mins + ' mins';
  const h = Math.floor(mins / 60), rest = mins % 60;
  return h + (h === 1 ? ' hr' : ' hrs') + (rest ? ' ' + rest + ' mins' : '');
}

// ── Small helpers ─────────────────────────────────────────────────────
function getMeta(html, prop) {
  const a = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)', 'i').exec(html);
  const b = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + prop + '["\']', 'i').exec(html);
  return decode((a && a[1]) || (b && b[1]) || '');
}

function absolutize(u, base) { try { return new URL(u, base).href; } catch (e) { return ''; } }

function htmlToText(html) {
  return decode(html
    .replace(/<(script|style|noscript|svg|iframe|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function decode(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
