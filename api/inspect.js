const axios = require('axios');
const cheerio = require('cheerio');

// Configuración de headers para evitar bloqueos
const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
};

// Función para detectar WordPress
async function detectWordPress(html, url) {
  const $ = cheerio.load(html);
  
  // Múltiples métodos de detección
  const wpSignals = {
    wpContent: html.includes('/wp-content/'),
    wpIncludes: html.includes('/wp-includes/'),
    metaGenerator: $('meta[name="generator"]').attr('content')?.includes('WordPress'),
    wpJson: false,
    xmlrpc: false,
    bodyClass: $('body').attr('class')?.includes('wp-') || false,
    adminAjax: html.includes('admin-ajax.php'),
    wpEmojiRelease: html.includes('wp-emoji-release.min.js'),
    customThemeStructure: false
  };

  // Detectar estructuras personalizadas de WordPress (como demos de themes)
  const customPatterns = [
    /\/themes\/[^\/]+\/style\.css/i,
    /\/assets\/css\/style\.css\?ver=/i, // BeTheme y otros
    /wp-json/i,
    /wordpress/i,
    /woocommerce/i,
    /wp-admin/i
  ];

  const htmlLower = html.toLowerCase();
  wpSignals.customThemeStructure = customPatterns.some(pattern => pattern.test(htmlLower));

  // Verificar REST API
  try {
    const restUrl = new URL('/wp-json/', url).href;
    const restResponse = await axios.get(restUrl, { 
      headers, 
      timeout: 5000,
      validateStatus: status => status < 500 
    });
    wpSignals.wpJson = restResponse.status === 200;
  } catch (error) {
    // No es crítico si falla
  }

  // Detectar por keywords en meta tags
  const keywords = $('meta[name="keywords"]').attr('content') || '';
  if (keywords.toLowerCase().includes('wordpress') || 
      keywords.toLowerCase().includes('woocommerce') ||
      keywords.toLowerCase().includes('betheme')) {
    wpSignals.metaGenerator = true;
  }

  // Detectar por scripts y estilos comunes de WordPress
  const scripts = $('script[src]').toArray().map(el => $(el).attr('src')).join(' ');
  const styles = $('link[href]').toArray().map(el => $(el).attr('href')).join(' ');
  const allAssets = scripts + ' ' + styles;

  if (allAssets.includes('jquery-migrate') || 
      allAssets.includes('wp-') ||
      allAssets.includes('plugins.js') ||
      allAssets.includes('scripts.js?ver=')) {
    wpSignals.customThemeStructure = true;
  }

  const isWordPress = Object.values(wpSignals).some(signal => signal === true);
  
  return { isWordPress, signals: wpSignals };
}

// Función para extraer información del theme
async function extractThemeInfo(html, baseUrl) {
  const $ = cheerio.load(html);
  const themeInfo = {
    name: null,
    version: null,
    author: null,
    uri: null,
    description: null,
    stylesheetUrl: null,
    isChildTheme: false,
    parentTheme: null,
    detectedFrom: null
  };

  // MÉTODO 1: Detectar desde meta keywords (común en demos)
  const keywords = $('meta[name="keywords"]').attr('content') || '';
  const keywordsLower = keywords.toLowerCase();
  
  if (keywordsLower.includes('betheme') || keywordsLower.includes('be theme')) {
    themeInfo.name = 'BeTheme';
    themeInfo.detectedFrom = 'meta keywords';
  } else if (keywordsLower.includes('avada')) {
    themeInfo.name = 'Avada';
    themeInfo.detectedFrom = 'meta keywords';
  } else if (keywordsLower.includes('divi')) {
    themeInfo.name = 'Divi';
    themeInfo.detectedFrom = 'meta keywords';
  }

  // MÉTODO 2: Detectar desde el título o meta description
  const description = $('meta[name="description"]').attr('content') || '';
  if (!themeInfo.name) {
    const themePatterns = [
      { pattern: /be\s*theme/i, name: 'BeTheme' },
      { pattern: /betheme/i, name: 'BeTheme' },
      { pattern: /avada/i, name: 'Avada' },
      { pattern: /divi/i, name: 'Divi' },
      { pattern: /elementor/i, name: 'Elementor' },
    ];

    for (const { pattern, name } of themePatterns) {
      if (pattern.test(description) || pattern.test(keywords)) {
        themeInfo.name = name;
        themeInfo.detectedFrom = 'meta description';
        break;
      }
    }
  }

  // MÉTODO 3: Buscar en los stylesheets con versión
  const stylesheetLinks = $('link[rel="stylesheet"]').toArray();
  let themeStylesheetUrl = null;

  for (const link of stylesheetLinks) {
    const href = $(link).attr('href');
    if (!href) continue;

    // Detectar style.css con versión (común en WordPress)
    if (href.includes('style.css?ver=')) {
      const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
      themeStylesheetUrl = fullUrl;
      
      // Extraer versión del query string
      const versionMatch = href.match(/ver=([\d.]+)/);
      if (versionMatch) {
        themeInfo.version = versionMatch[1];
        themeInfo.detectedFrom = 'stylesheet version';
      }
      break;
    }

    // Buscar /themes/ en la URL
    if (href.includes('/themes/')) {
      const match = href.match(/\/themes\/([^\/]+)\//);
      if (match && !themeInfo.name) {
        themeInfo.name = match[1];
        themeInfo.detectedFrom = 'themes path';
        const fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
        const pathParts = fullUrl.split('/themes/')[0];
        themeStylesheetUrl = `${pathParts}/themes/${match[1]}/style.css`;
      }
    }
  }

  // MÉTODO 4: Buscar en scripts también
  if (!themeInfo.name || !themeStylesheetUrl) {
    const scripts = $('script[src]').toArray();
    for (const script of scripts) {
      const src = $(script).attr('src');
      if (!src) continue;

      // Detectar scripts.js con versión
      if (src.includes('scripts.js?ver=') && !themeInfo.version) {
        const versionMatch = src.match(/ver=([\d.]+)/);
        if (versionMatch) {
          themeInfo.version = versionMatch[1];
        }
      }

      if (src.includes('/themes/')) {
        const match = src.match(/\/themes\/([^\/]+)\//);
        if (match && !themeInfo.name) {
          themeInfo.name = match[1];
          themeInfo.detectedFrom = 'script path';
          const fullUrl = src.startsWith('http') ? src : new URL(src, baseUrl).href;
          const pathParts = fullUrl.split('/themes/')[0];
          themeStylesheetUrl = `${pathParts}/themes/${match[1]}/style.css`;
        }
      }
    }
  }

  // MÉTODO 5: Buscar en body class (WordPress añade theme slug)
  if (!themeInfo.name) {
    const bodyClass = $('body').attr('class') || '';
    const themeMatch = bodyClass.match(/theme-(\w+)/);
    if (themeMatch) {
      themeInfo.name = themeMatch[1];
      themeInfo.detectedFrom = 'body class';
    }
  }

  // MÉTODO 6: Buscar en comentarios HTML
  if (!themeInfo.name) {
    const htmlContent = html.toString();
    const themeCommentMatch = htmlContent.match(/<!--[^>]*themes?\/([^\/\s]+)/i);
    if (themeCommentMatch) {
      themeInfo.name = themeCommentMatch[1];
      themeInfo.detectedFrom = 'HTML comment';
      const themeUrl = new URL(baseUrl);
      themeStylesheetUrl = `${themeUrl.origin}/wp-content/themes/${themeInfo.name}/style.css`;
    }
  }

  // MÉTODO 7: Intentar con la REST API
  if (!themeInfo.name || !themeInfo.version) {
    try {
      const restUrl = new URL('/wp-json/wp/v2/themes', baseUrl).href;
      const restResponse = await axios.get(restUrl, { 
        headers, 
        timeout: 5000,
        validateStatus: status => status < 500 
      });
      
      if (restResponse.status === 200 && restResponse.data) {
        const activeTheme = Object.values(restResponse.data).find(theme => theme.status === 'active');
        if (activeTheme) {
          themeInfo.name = activeTheme.stylesheet || activeTheme.name;
          themeInfo.version = activeTheme.version;
          themeInfo.author = activeTheme.author?.name || activeTheme.author;
          themeInfo.description = activeTheme.description?.raw || activeTheme.description;
          themeInfo.uri = activeTheme.theme_uri;
          themeInfo.detectedFrom = 'REST API';
          
          if (activeTheme.template && activeTheme.template !== activeTheme.stylesheet) {
            themeInfo.isChildTheme = true;
            themeInfo.parentTheme = activeTheme.template;
          }
          
          const themeUrl = new URL(baseUrl);
          themeStylesheetUrl = `${themeUrl.origin}/wp-content/themes/${themeInfo.name}/style.css`;
        }
      }
    } catch (error) {
      // No pasa nada si falla
    }
  }

  // Normalizar el nombre del theme
  if (themeInfo.name) {
    themeInfo.name = themeInfo.name
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  }

  // Intentar obtener más info del meta description si tenemos el nombre
  if (themeInfo.name && !themeInfo.description) {
    themeInfo.description = description || null;
  }

  // Si encontramos el stylesheet URL, intentar leerlo
  if (themeStylesheetUrl && themeInfo.detectedFrom !== 'REST API') {
    try {
      const styleResponse = await axios.get(themeStylesheetUrl, { 
        headers, 
        timeout: 5000,
        validateStatus: status => status < 400
      });
      
      if (styleResponse.status === 200) {
        themeInfo.stylesheetUrl = themeStylesheetUrl;
        
        const styleContent = styleResponse.data;
        const headerMatch = styleContent.match(/\/\*\s*([\s\S]*?)\*\//);
        
        if (headerMatch) {
          const header = headerMatch[1];
          
          const nameMatch = header.match(/Theme Name:\s*(.+)/i);
          const versionMatch = header.match(/Version:\s*(.+)/i);
          const authorMatch = header.match(/Author:\s*(.+)/i);
          const uriMatch = header.match(/Theme URI:\s*(.+)/i);
          const descMatch = header.match(/Description:\s*(.+)/i);
          const templateMatch = header.match(/Template:\s*(.+)/i);

          if (nameMatch) themeInfo.name = nameMatch[1].trim();
          if (versionMatch) themeInfo.version = versionMatch[1].trim();
          if (authorMatch) themeInfo.author = authorMatch[1].trim();
          if (uriMatch) themeInfo.uri = uriMatch[1].trim();
          if (descMatch) themeInfo.description = descMatch[1].trim();
          
          if (templateMatch) {
            themeInfo.isChildTheme = true;
            themeInfo.parentTheme = templateMatch[1].trim();
          }

          themeInfo.detectedFrom = 'style.css header';
        }
      }
    } catch (error) {
      // Si falla, al menos tenemos el nombre del theme
    }
  }

  return themeInfo;
}

// Función para detectar plugins
async function detectPlugins(html, baseUrl) {
  const $ = cheerio.load(html);
  const plugins = new Map();

  // Buscar referencias a plugins en scripts y estilos
  const assets = [
    ...$('script[src]').toArray().map(el => $(el).attr('src')),
    ...$('link[rel="stylesheet"]').toArray().map(el => $(el).attr('href'))
  ];

  for (const asset of assets) {
    if (!asset || !asset.includes('/wp-content/plugins/')) continue;

    const match = asset.match(/\/wp-content\/plugins\/([^\/]+)\//);
    if (match) {
      const pluginSlug = match[1];
      
      if (!plugins.has(pluginSlug)) {
        plugins.set(pluginSlug, {
          slug: pluginSlug,
          name: pluginSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          detectedFiles: [],
          wpOrgUrl: `https://wordpress.org/plugins/${pluginSlug}/`,
          info: null
        });
      }
      
      plugins.get(pluginSlug).detectedFiles.push(asset);
    }
  }

  // Buscar también en comentarios HTML (algunos plugins dejan marcas)
  const htmlContent = html.toString();
  const pluginComments = htmlContent.match(/<!--[^>]*wp-content\/plugins\/([^\/\s]+)/gi) || [];
  
  for (const comment of pluginComments) {
    const match = comment.match(/plugins\/([^\/\s]+)/);
    if (match) {
      const pluginSlug = match[1];
      if (!plugins.has(pluginSlug)) {
        plugins.set(pluginSlug, {
          slug: pluginSlug,
          name: pluginSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          detectedFiles: ['HTML comment'],
          wpOrgUrl: `https://wordpress.org/plugins/${pluginSlug}/`,
          info: null
        });
      }
    }
  }

  // Buscar en meta tags y data attributes
  $('[class*="wp-"], [id*="wp-"], [data-plugin], [class*="plugin-"]').each((i, el) => {
    const classNames = $(el).attr('class') || '';
    const id = $(el).attr('id') || '';
    const combined = `${classNames} ${id}`;
    
    // Buscar patrones comunes de plugins
    const patterns = [
      /elementor/i,
      /wpforms/i,
      /contact-form-7/i,
      /yoast/i,
      /woocommerce/i,
      /jetpack/i
    ];
    
    for (const pattern of patterns) {
      if (pattern.test(combined)) {
        const pluginSlug = pattern.source.replace(/\//g, '').toLowerCase();
        if (!plugins.has(pluginSlug)) {
          plugins.set(pluginSlug, {
            slug: pluginSlug,
            name: pluginSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            detectedFiles: ['HTML attributes'],
            wpOrgUrl: `https://wordpress.org/plugins/${pluginSlug}/`,
            info: null
          });
        }
      }
    }
  });

  // Intentar obtener información adicional de wordpress.org
  const pluginsArray = Array.from(plugins.values());
  
  await Promise.allSettled(
    pluginsArray.map(async (plugin) => {
      try {
        const apiUrl = `https://api.wordpress.org/plugins/info/1.0/${plugin.slug}.json`;
        const response = await axios.get(apiUrl, { 
          timeout: 3000,
          validateStatus: status => status < 500
        });
        
        if (response.status === 200 && response.data && !response.data.error) {
          plugin.info = {
            name: response.data.name,
            version: response.data.version,
            author: response.data.author,
            description: response.data.short_description,
            rating: response.data.rating,
            activeInstalls: response.data.active_installs,
            lastUpdated: response.data.last_updated,
            requires: response.data.requires,
            testedUpTo: response.data.tested
          };
        }
      } catch (error) {
        // Si falla la API, mantenemos la info básica
      }
    })
  );

  return pluginsArray;
}

// Función para determinar si es custom o template
function analyzeCustomization(themeInfo, plugins) {
  const analysis = {
    isCustom: false,
    confidence: 0,
    indicators: []
  };

  // Indicadores de desarrollo custom
  if (themeInfo.name && !themeInfo.uri?.includes('wordpress.org')) {
    analysis.indicators.push('Theme no es del repositorio oficial');
    analysis.confidence += 30;
  }

  if (themeInfo.isChildTheme) {
    analysis.indicators.push('Es un child theme (probablemente personalizado)');
    analysis.confidence += 40;
  }

  // Themes comunes que indican template
  const commonThemes = [
    'astra', 'generatepress', 'oceanwp', 'neve', 'kadence',
    'hello-elementor', 'blocksy', 'twentytwenty', 'avada', 'divi'
  ];

  const themeName = themeInfo.name?.toLowerCase() || '';
  const isCommonTheme = commonThemes.some(common => themeName.includes(common));

  if (isCommonTheme) {
    analysis.indicators.push(`Theme popular/template: ${themeInfo.name}`);
    analysis.confidence -= 20;
  }

  // Page builders indican posible template
  const pageBuilders = ['elementor', 'wpbakery', 'beaver-builder', 'divi-builder'];
  const hasPageBuilder = plugins.some(p => 
    pageBuilders.some(pb => p.slug.includes(pb))
  );

  if (hasPageBuilder) {
    analysis.indicators.push('Usa page builder (común en templates)');
    analysis.confidence -= 15;
  }

  analysis.isCustom = analysis.confidence > 20;
  analysis.confidence = Math.max(0, Math.min(100, analysis.confidence + 50));

  return analysis;
}

// Handler principal de la API
module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const { url } = req.method === 'GET' ? req.query : req.body;

    if (!url) {
      return res.status(400).json({ 
        error: 'URL parameter is required',
        usage: 'GET /api/inspect?url=https://example.com or POST with { "url": "https://example.com" }'
      });
    }

    // Validar URL
    let targetUrl;
    try {
      targetUrl = new URL(url);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) {
        throw new Error('Invalid protocol');
      }
    } catch (error) {
      return res.status(400).json({ 
        error: 'Invalid URL format',
        message: 'Please provide a valid HTTP/HTTPS URL'
      });
    }

    // Fetch del sitio
    const response = await axios.get(targetUrl.href, {
      headers,
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: status => status < 400
    });

    const html = response.data;

    // Detectar WordPress
    const { isWordPress, signals } = await detectWordPress(html, targetUrl.href);

    if (!isWordPress) {
      return res.status(200).json({
        url: targetUrl.href,
        isWordPress: false,
        message: 'Este sitio no parece estar construido con WordPress',
        signals
      });
    }

    // Extraer información del theme
    const themeInfo = await extractThemeInfo(html, targetUrl.href);

    // Detectar plugins
    const plugins = await detectPlugins(html, targetUrl.href);

    // Análisis de customización
    const customAnalysis = analyzeCustomization(themeInfo, plugins);

    // Respuesta completa
    return res.status(200).json({
      url: targetUrl.href,
      isWordPress: true,
      scannedAt: new Date().toISOString(),
      theme: themeInfo,
      plugins: {
        count: plugins.length,
        list: plugins
      },
      customization: customAnalysis,
      detectionSignals: signals
    });

  } catch (error) {
    console.error('Error in inspection:', error);

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      return res.status(400).json({
        error: 'Unable to reach the website',
        message: 'The URL could not be accessed. Please verify it is correct and publicly accessible.'
      });
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
