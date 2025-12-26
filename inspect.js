import axios from 'axios';
import * as cheerio from 'cheerio';

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
    xmlrpc: false
  };

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
    parentTheme: null
  };

  // Buscar referencias al theme en el HTML
  const stylesheetLinks = $('link[rel="stylesheet"]').toArray();
  let themeStylesheetUrl = null;

  for (const link of stylesheetLinks) {
    const href = $(link).attr('href');
    if (href && href.includes('/themes/') && href.includes('style.css')) {
      themeStylesheetUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
      break;
    }
  }

  // Si encontramos el stylesheet del theme, intentar leerlo
  if (themeStylesheetUrl) {
    try {
      const styleResponse = await axios.get(themeStylesheetUrl, { 
        headers, 
        timeout: 5000 
      });
      
      themeInfo.stylesheetUrl = themeStylesheetUrl;
      
      // Extraer el nombre del theme de la URL
      const themeMatch = themeStylesheetUrl.match(/\/themes\/([^\/]+)\//);
      if (themeMatch) {
        themeInfo.name = themeMatch[1];
      }

      // Parsear el header del CSS
      const styleContent = styleResponse.data;
      const headerMatch = styleContent.match(/\/\*\s*([\s\S]*?)\*\//);
      
      if (headerMatch) {
        const header = headerMatch[1];
        
        // Extraer campos del header
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
      }
    } catch (error) {
      console.error('Error fetching theme stylesheet:', error.message);
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
        
        if (response.status === 200 && response.data) {
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
export default async function handler(req, res) {
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
}
