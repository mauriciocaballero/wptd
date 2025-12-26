const axios = require('axios');
const cheerio = require('cheerio');
const { validateRequest } = require('./_auth');

// Configuración de headers para evitar bloqueos
const headers = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
};

// Función para extraer nombre limpio del sitio
function extractSiteName(url) {
  try {
    const urlObj = new URL(url);
    let hostname = urlObj.hostname;
    
    // Remover www.
    hostname = hostname.replace(/^www\./, '');
    
    // Remover extensiones comunes
    const extensions = [
      '.com.mx', '.co.uk', '.com.br', '.com.ar', // Multi-parte primero
      '.com', '.net', '.org', '.edu', '.gov', '.mx', '.es', '.io',
      '.co', '.uk', '.us', '.ca', '.de', '.fr', '.it', '.jp',
      '.br', '.ar', '.cl', '.pe', '.ve', '.uy'
    ];
    
    for (const ext of extensions) {
      if (hostname.endsWith(ext)) {
        hostname = hostname.slice(0, -ext.length);
        break; // Solo remover una extensión
      }
    }
    
    // Capitalizar primera letra
    return hostname.charAt(0).toUpperCase() + hostname.slice(1);
  } catch (error) {
    return 'Sitio';
  }
}

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

  // Detectar child themes por patrones en el nombre (cuando no tienen Template: header)
  if (!themeInfo.isChildTheme && themeInfo.name) {
    const childPatterns = [
      /child/i,
      /alt$/i,        // "Something Alt"
      /-alt$/i,       // "Something-alt"
      /custom/i,
      /modified/i,
      /personalized/i
    ];
    
    const isLikelyChild = childPatterns.some(pattern => pattern.test(themeInfo.name));
    
    if (isLikelyChild) {
      themeInfo.isChildTheme = true;
      // Intentar inferir el parent theme del nombre
      const baseName = themeInfo.name
        .replace(/\s*(child|alt|custom|modified|personalized)\s*$/i, '')
        .trim();
      if (baseName && baseName !== themeInfo.name) {
        themeInfo.parentTheme = baseName;
      }
    }
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

  // MÉTODO 1: Buscar referencias a plugins en scripts y estilos
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

  // MÉTODO 2: Buscar en comentarios HTML
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

  // MÉTODO 3: Detectar por clases CSS y atributos conocidos
  const knownPlugins = [
    { pattern: /elementor/i, slug: 'elementor' },
    { pattern: /wpforms/i, slug: 'wpforms-lite' },
    { pattern: /contact-form-7/i, slug: 'contact-form-7' },
    { pattern: /yoast/i, slug: 'wordpress-seo' },
    { pattern: /woocommerce/i, slug: 'woocommerce' },
    { pattern: /jetpack/i, slug: 'jetpack' },
    { pattern: /wp-rocket/i, slug: 'wp-rocket' },
    { pattern: /wpbakery/i, slug: 'js_composer' },
    { pattern: /visual-composer/i, slug: 'js_composer' },
    { pattern: /rank-math/i, slug: 'seo-by-rank-math' },
    { pattern: /all-in-one-seo/i, slug: 'all-in-one-seo-pack' },
    { pattern: /wordfence/i, slug: 'wordfence' },
    { pattern: /smush/i, slug: 'wp-smushit' },
    { pattern: /akismet/i, slug: 'akismet' },
    { pattern: /updraft/i, slug: 'updraftplus' },
    { pattern: /gravityforms/i, slug: 'gravityforms' },
    { pattern: /wpml/i, slug: 'sitepress-multilingual-cms' },
    { pattern: /polylang/i, slug: 'polylang' }
  ];

  $('[class*="wp-"], [id*="wp-"], [data-plugin], [class*="plugin-"]').each((i, el) => {
    const classNames = $(el).attr('class') || '';
    const id = $(el).attr('id') || '';
    const combined = `${classNames} ${id}`;
    
    for (const { pattern, slug } of knownPlugins) {
      if (pattern.test(combined) && !plugins.has(slug)) {
        plugins.set(slug, {
          slug: slug,
          name: slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          detectedFiles: ['HTML attributes'],
          wpOrgUrl: `https://wordpress.org/plugins/${slug}/`,
          info: null
        });
      }
    }
  });

  // MÉTODO 4: Intentar obtener plugins desde la REST API
  try {
    const restUrl = new URL('/wp-json/wp/v2/plugins', baseUrl).href;
    const restResponse = await axios.get(restUrl, { 
      headers, 
      timeout: 5000,
      validateStatus: status => status < 500 
    });
    
    if (restResponse.status === 200 && Array.isArray(restResponse.data)) {
      for (const plugin of restResponse.data) {
        const pluginSlug = plugin.plugin?.split('/')[0] || plugin.slug;
        
        if (pluginSlug && !plugins.has(pluginSlug)) {
          plugins.set(pluginSlug, {
            slug: pluginSlug,
            name: plugin.name || pluginSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            detectedFiles: ['REST API'],
            wpOrgUrl: `https://wordpress.org/plugins/${pluginSlug}/`,
            info: null
          });
        }
      }
    }
  } catch (error) {
    // REST API no disponible o requiere autenticación
  }

  // MÉTODO 5: Detectar por meta tags y data-* attributes
  $('meta[name*="generator"], meta[name*="plugin"]').each((i, el) => {
    const content = $(el).attr('content') || '';
    
    for (const { pattern, slug } of knownPlugins) {
      if (pattern.test(content) && !plugins.has(slug)) {
        plugins.set(slug, {
          slug: slug,
          name: slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          detectedFiles: ['Meta tag'],
          wpOrgUrl: `https://wordpress.org/plugins/${slug}/`,
          info: null
        });
      }
    }
  });

  // MÉTODO 6: Analizar inline scripts que a veces declaran variables de plugins
  $('script:not([src])').each((i, el) => {
    const scriptContent = $(el).html() || '';
    
    for (const { pattern, slug } of knownPlugins) {
      if (pattern.test(scriptContent) && !plugins.has(slug)) {
        plugins.set(slug, {
          slug: slug,
          name: slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
          detectedFiles: ['Inline script'],
          wpOrgUrl: `https://wordpress.org/plugins/${slug}/`,
          info: null
        });
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
            testedUpTo: response.data.tested,
            icons: response.data.icons || {
              // Fallback: construir URLs de iconos basados en el slug
              '2x': `https://ps.w.org/${plugin.slug}/assets/icon-256x256.png`,
              '1x': `https://ps.w.org/${plugin.slug}/assets/icon-128x128.png`,
              'svg': `https://ps.w.org/${plugin.slug}/assets/icon.svg`,
              'default': `https://s.w.org/plugins/geopattern-icon/${plugin.slug}.svg`
            }
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
    indicators: [],
    category: 'unknown',
    scoring: {
      breakdown: [],
      total: 0,
      max: 0
    }
  };

  let score = 0; // Score negativo = template, positivo = custom
  const breakdown = [];

  // ============================================
  // INDICADORES FUERTES CONTRA CUSTOM (-30 a -50 puntos)
  // ============================================

  // Theme de WordPress.org (muy probable template gratuito)
  if (themeInfo.uri?.includes('wordpress.org/themes')) {
    score -= 50;
    breakdown.push({ indicator: 'Theme oficial de WordPress.org', points: -50, weight: 'muy fuerte' });
    analysis.indicators.push('📦 Theme del repositorio oficial de WordPress');
    analysis.category = 'official-free';
  }

  // Marketplaces premium conocidos (ThemeForest, etc.)
  const premiumMarketplaces = [
    { domain: 'themeforest.net', name: 'ThemeForest' },
    { domain: 'elegantthemes.com', name: 'Elegant Themes' },
    { domain: 'studiopress.com', name: 'StudioPress' },
    { domain: 'mojo-themes.com', name: 'MOJO Themes' }
  ];
  
  const marketplace = premiumMarketplaces.find(m => themeInfo.uri?.includes(m.domain));
  if (marketplace) {
    score -= 45;
    breakdown.push({ indicator: `Theme de ${marketplace.name}`, points: -45, weight: 'muy fuerte' });
    analysis.indicators.push(`💎 Theme premium de ${marketplace.name}`);
    analysis.category = 'premium-template';
  }

  // Marketplaces de themes gratuitos
  const freeMarketplaces = [
    { domain: 'voilathemes.com', name: 'VoilaThemes' },
    { domain: 'themegrill.com', name: 'ThemeGrill' },
    { domain: 'acmethemes.com', name: 'Acme Themes' },
    { domain: 'themeinwp.com', name: 'ThemeinWP' }
  ];
  
  const freeMarket = freeMarketplaces.find(m => themeInfo.uri?.includes(m.domain));
  if (freeMarket) {
    score -= 40;
    breakdown.push({ indicator: `Theme gratuito de ${freeMarket.name}`, points: -40, weight: 'muy fuerte' });
    analysis.indicators.push(`🆓 Theme gratuito de ${freeMarket.name}`);
    analysis.category = 'free-marketplace';
  }

  // ============================================
  // INDICADORES FUERTES PRO CUSTOM (+30 a +50 puntos)
  // ============================================

  // Child theme (indica personalización)
  if (themeInfo.isChildTheme) {
    const parentName = themeInfo.parentTheme || 'theme base';
    
    // Si ya detectamos que es un marketplace (gratuito o premium), es solo personalización menor
    if (analysis.category === 'free-marketplace' || 
        analysis.category === 'premium-template' || 
        analysis.category === 'official-free') {
      score += 5; // Pequeño boost, pero sigue siendo template
      breakdown.push({ indicator: `Child theme de "${parentName}"`, points: 5, weight: 'leve' });
      analysis.indicators.push(`🎨 Child theme de "${parentName}" (personalización menor)`);
      analysis.category = 'customized-template';
    } else {
      // Si no sabemos qué es el parent, asumimos desarrollo personalizado
      score += 40;
      breakdown.push({ indicator: `Child theme de "${parentName}"`, points: 40, weight: 'muy fuerte' });
      analysis.indicators.push(`🔧 Child theme de "${parentName}" (desarrollo personalizado)`);
      analysis.category = 'customized';
    }
  }

  // Theme sin URI pública (muy probable custom)
  if (themeInfo.name && !themeInfo.uri) {
    score += 35;
    breakdown.push({ indicator: 'Sin URI pública', points: 35, weight: 'muy fuerte' });
    analysis.indicators.push('🔒 Theme sin URI pública (probable desarrollo interno)');
  }

  // ============================================
  // INDICADORES MODERADOS (-15 a -25 puntos)
  // ============================================

  // Themes populares conocidos
  const popularThemes = [
    'astra', 'generatepress', 'oceanwp', 'neve', 'kadence',
    'hello elementor', 'blocksy', 'twentytwenty', 'twentytwentyone',
    'avada', 'divi', 'enfold', 'bridge', 'betheme', 'the7',
    'flatsome', 'salient', 'x theme', 'jupiter', 'uncode',
    'web development', 'business', 'corporate', 'agency'
  ];

  const themeName = themeInfo.name?.toLowerCase() || '';
  const matchedPopular = popularThemes.find(popular => themeName.includes(popular));
  
  if (matchedPopular && !themeInfo.isChildTheme) {
    score -= 25;
    breakdown.push({ indicator: `Theme popular: ${themeInfo.name}`, points: -25, weight: 'fuerte' });
    analysis.indicators.push(`🎨 Theme popular/comercial: ${themeInfo.name}`);
    if (!analysis.category || analysis.category === 'unknown') {
      analysis.category = 'popular-template';
    }
  }

  // Page builders (solo si NO es child theme)
  const pageBuilders = [
    { slug: 'elementor', name: 'Elementor', points: -15 },
    { slug: 'wpbakery', name: 'WPBakery', points: -20 },
    { slug: 'beaver-builder', name: 'Beaver Builder', points: -15 },
    { slug: 'divi-builder', name: 'Divi Builder', points: -20 },
    { slug: 'oxygen', name: 'Oxygen', points: -12 },
    { slug: 'siteorigin', name: 'SiteOrigin', points: -10 }
  ];

  if (!themeInfo.isChildTheme) {
    for (const builder of pageBuilders) {
      const hasBuilder = plugins.some(p => p.slug.includes(builder.slug));
      if (hasBuilder) {
        score += builder.points;
        breakdown.push({ indicator: `Usa ${builder.name}`, points: builder.points, weight: 'moderado' });
        analysis.indicators.push(`🔌 Usa ${builder.name} (común en templates)`);
      }
    }
  }

  // ============================================
  // INDICADORES LEVES (+5 a +15 puntos)
  // ============================================

  // URI personalizada (no marketplace, no wordpress.org)
  const knownDomains = [
    ...premiumMarketplaces.map(m => m.domain),
    ...freeMarketplaces.map(m => m.domain),
    'wordpress.org'
  ];
  
  const hasCustomUri = themeInfo.uri && 
                       !knownDomains.some(domain => themeInfo.uri.includes(domain)) &&
                       !themeInfo.isChildTheme;
  
  if (hasCustomUri) {
    score += 15;
    breakdown.push({ indicator: 'URI personalizada', points: 15, weight: 'leve' });
    analysis.indicators.push('🌐 URI personalizada del theme');
  }

  // Plugins del theme (indica bundle comercial)
  const themeSlug = themeName.replace(/\s+/g, '-');
  const authorSlug = themeInfo.author?.toLowerCase().replace(/\s+/g, '-') || '';
  const themePlugins = plugins.filter(p => 
    p.slug.includes(themeSlug) || (authorSlug && p.slug.includes(authorSlug))
  );

  if (themePlugins.length > 0 && !themeInfo.isChildTheme) {
    score -= 12;
    breakdown.push({ indicator: `${themePlugins.length} plugin(s) del theme`, points: -12, weight: 'leve' });
    analysis.indicators.push(`📦 ${themePlugins.length} plugin(s) exclusivo(s) del theme`);
  }

  // Alto número de plugins (puede indicar customización compleja)
  if (plugins.length > 12) {
    score += 8;
    breakdown.push({ indicator: `${plugins.length} plugins instalados`, points: 8, weight: 'leve' });
    analysis.indicators.push(`🔧 ${plugins.length} plugins (posible customización extensa)`);
  }

  // Versión antigua sin actualizaciones (puede ser custom abandonado o template viejo)
  if (themeInfo.version) {
    const versionNum = parseFloat(themeInfo.version);
    if (versionNum < 2.0 && !themeInfo.uri?.includes('wordpress.org')) {
      score += 5;
      breakdown.push({ indicator: `Versión ${themeInfo.version} (antigua)`, points: 5, weight: 'muy leve' });
    }
  }

  // ============================================
  // CALCULAR CONFIANZA Y CATEGORÍA FINAL
  // ============================================

  analysis.scoring.breakdown = breakdown;
  analysis.scoring.total = score;

  // Convertir score a porcentaje de confianza (0-100%)
  // Score va de -100 (template definitivo) a +100 (custom definitivo)
  // Mapeamos a 0-100% donde:
  // -100 score = 0% custom (100% template)
  // 0 score = 50% (dudoso)
  // +100 score = 100% custom
  
  const rawConfidence = ((score + 100) / 200) * 100;
  analysis.confidence = Math.max(0, Math.min(100, Math.round(rawConfidence)));

  // Determinar si es custom (>60% confianza)
  analysis.isCustom = analysis.confidence >= 60;

  // Determinar categoría final si aún no está definida
  if (analysis.category === 'unknown') {
    if (score >= 30) {
      analysis.category = 'custom-development';
    } else if (score >= 10) {
      analysis.category = 'likely-custom';
    } else if (score >= -10) {
      analysis.category = 'uncertain';
    } else if (score >= -30) {
      analysis.category = 'likely-template';
    } else {
      analysis.category = 'commercial-template';
    }
  }

  // Labels finales
  const categoryLabels = {
    'official-free': '📦 Template Gratuito (WordPress.org)',
    'free-marketplace': '🆓 Template Gratuito',
    'premium-template': '💎 Template Premium',
    'popular-template': '🎨 Template Popular',
    'customized': '🔧 Desarrollo Personalizado',
    'customized-template': '🎨 Template con Personalización',
    'custom-development': '🛠️ Desarrollo Custom',
    'likely-custom': '🛠️ Probablemente Custom',
    'commercial-template': '📦 Template Comercial',
    'likely-template': '📦 Probablemente Template',
    'uncertain': '❓ Indeterminado',
    'unknown': '❓ No Determinado'
  };

  analysis.categoryLabel = categoryLabels[analysis.category];

  return analysis;
}

// Handler principal de la API
module.exports = async function handler(req, res) {
  // CORS headers
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
    // Si es error de autenticación
    if (validation.status === 401) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'API key inválida o faltante'
      });
    }

    // Si es error de rate limit
    if (validation.status === 429) {
      res.setHeader('X-RateLimit-Limit', validation.rateLimit.limit.toString());
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', validation.rateLimit.resetInSeconds.toString());

      return res.status(429).json({
        error: 'Rate limit exceeded',
        rateLimitExceeded: true,
        message: `Has excedido el límite de ${validation.rateLimit.limit} requests por hora.`,
        details: {
          limit: validation.rateLimit.limit,
          current: validation.rateLimit.current,
          remaining: 0,
          resetInMinutes: validation.rateLimit.resetInMinutes,
          resetInSeconds: validation.rateLimit.resetInSeconds
        }
      });
    }
  }

  // Headers de rate limiting para requests exitosos
  res.setHeader('X-RateLimit-Limit', validation.rateLimit.limit.toString());
  res.setHeader('X-RateLimit-Remaining', validation.rateLimit.remaining.toString());
  res.setHeader('X-RateLimit-Reset', validation.rateLimit.resetInSeconds.toString());

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
      siteName: extractSiteName(targetUrl.href),
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
