const axios = require('axios');
const cheerio = require('cheerio');
const { validateRequest } = require('./_auth');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Validar API Secret Key y Rate Limit
  const validation = validateRequest(req);

  if (!validation.valid) {
    if (validation.status === 401) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (validation.status === 429) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        rateLimitExceeded: true,
        details: {
          limit: validation.rateLimit.limit,
          resetInMinutes: validation.rateLimit.resetInMinutes
        }
      });
    }
  }

  res.setHeader('X-RateLimit-Limit', validation.rateLimit.limit.toString());
  res.setHeader('X-RateLimit-Remaining', validation.rateLimit.remaining.toString());
  res.setHeader('X-RateLimit-Reset', validation.rateLimit.resetInSeconds.toString());

  try {
    const { url } = req.method === 'GET' ? req.query : req.body;

    if (!url) {
      return res.status(400).json({ 
        error: 'URL parameter is required',
        usage: 'GET /api/debug?url=https://example.com'
      });
    }

    const targetUrl = new URL(url);
    const response = await axios.get(targetUrl.href, {
      headers,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: status => status < 400
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Recopilar información de debug
    const debug = {
      url: targetUrl.href,
      stylesheets: [],
      scripts: [],
      themeReferences: [],
      pluginReferences: [],
      metaTags: [],
      wpSignals: {
        wpContent: html.includes('/wp-content/'),
        wpIncludes: html.includes('/wp-includes/'),
        metaGenerator: $('meta[name="generator"]').attr('content')
      }
    };

    // Stylesheets
    $('link[rel="stylesheet"]').each((i, el) => {
      const href = $(el).attr('href');
      if (href) {
        debug.stylesheets.push(href);
        if (href.includes('/themes/')) {
          debug.themeReferences.push(href);
        }
        if (href.includes('/plugins/')) {
          debug.pluginReferences.push(href);
        }
      }
    });

    // Scripts
    $('script[src]').each((i, el) => {
      const src = $(el).attr('src');
      if (src) {
        debug.scripts.push(src);
        if (src.includes('/themes/')) {
          debug.themeReferences.push(src);
        }
        if (src.includes('/plugins/')) {
          debug.pluginReferences.push(src);
        }
      }
    });

    // Meta tags
    $('meta').each((i, el) => {
      const name = $(el).attr('name');
      const content = $(el).attr('content');
      if (name && content) {
        debug.metaTags.push({ name, content });
      }
    });

    // Buscar comentarios HTML
    const comments = html.match(/<!--[\s\S]*?-->/g) || [];
    debug.htmlComments = comments.slice(0, 10); // Primeros 10 comentarios

    // Extraer nombres de themes y plugins
    debug.themeNames = [...new Set(
      debug.themeReferences
        .map(ref => ref.match(/\/themes\/([^\/]+)\//))
        .filter(Boolean)
        .map(match => match[1])
    )];

    debug.pluginNames = [...new Set(
      debug.pluginReferences
        .map(ref => ref.match(/\/plugins\/([^\/]+)\//))
        .filter(Boolean)
        .map(match => match[1])
    )];

    // Intentar acceder a REST API
    try {
      const restUrl = new URL('/wp-json/', targetUrl.href).href;
      const restResponse = await axios.get(restUrl, { 
        headers, 
        timeout: 5000,
        validateStatus: status => status < 500 
      });
      debug.wpJson = {
        available: restResponse.status === 200,
        status: restResponse.status,
        data: restResponse.status === 200 ? restResponse.data : null
      };
    } catch (error) {
      debug.wpJson = { available: false, error: error.message };
    }

    return res.status(200).json(debug);

  } catch (error) {
    return res.status(500).json({
      error: 'Debug error',
      message: error.message
    });
  }
};
