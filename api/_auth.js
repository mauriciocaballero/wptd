// Middleware simple: validar API_SECRET_KEY y rate limiting por IP
// Solo usuarios con la key correcta pueden usar el servicio

// Configuración de rate limiting
const RATE_LIMIT = {
  maxRequests: 10,
  windowMs: 60 * 60 * 1000, // 1 hora
};

// Store en memoria para rate limiting
const requestCounts = new Map();

function cleanOldEntries() {
  const now = Date.now();
  for (const [key, data] of requestCounts.entries()) {
    if (now - data.resetTime > 60 * 60 * 1000) {
      requestCounts.delete(key);
    }
  }
}

function checkRateLimit(ip) {
  cleanOldEntries();
  
  const now = Date.now();
  const data = requestCounts.get(ip) || {
    count: 0,
    resetTime: now
  };

  if (now - data.resetTime > RATE_LIMIT.windowMs) {
    // Reset window
    data.count = 1;
    data.resetTime = now;
  } else {
    data.count++;
  }

  requestCounts.set(ip, data);

  const resetInSeconds = Math.ceil((data.resetTime + RATE_LIMIT.windowMs - now) / 1000);
  const resetInMinutes = Math.ceil(resetInSeconds / 60);

  return {
    allowed: data.count <= RATE_LIMIT.maxRequests,
    remaining: Math.max(0, RATE_LIMIT.maxRequests - data.count),
    resetInSeconds,
    resetInMinutes,
    current: data.count,
    limit: RATE_LIMIT.maxRequests
  };
}

function validateRequest(req) {
  // Validar API Secret Key
  const apiKey = req.headers['x-api-key'];
  const secretKey = process.env.API_SECRET_KEY;

  if (!secretKey || apiKey !== secretKey) {
    return {
      valid: false,
      error: 'Unauthorized',
      status: 401
    };
  }

  // Obtener IP del cliente
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                   req.headers['x-real-ip'] || 
                   'unknown';

  // Detectar si viene del frontend HTML (referer) o de Make.com/API directa
  const referer = req.headers['referer'] || req.headers['origin'] || '';
  const isFromFrontend = referer.includes('vercel.app') || referer.includes('localhost');
  
  // Solo aplicar rate limiting si viene del frontend HTML
  // Make.com y otras integraciones NO tienen rate limit
  if (isFromFrontend) {
    const rateLimit = checkRateLimit(clientIp);

    if (!rateLimit.allowed) {
      return {
        valid: false,
        error: 'Rate limit exceeded',
        status: 429,
        rateLimit
      };
    }

    return {
      valid: true,
      rateLimit,
      ip: clientIp,
      source: 'frontend'
    };
  }

  // Request desde Make.com u otra API - sin rate limit
  return {
    valid: true,
    rateLimit: {
      allowed: true,
      remaining: 999999,
      resetInSeconds: 0,
      resetInMinutes: 0,
      current: 0,
      limit: 999999
    },
    ip: clientIp,
    source: 'api'
  };
}

module.exports = { validateRequest };
