export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // API 端点配置
    const endpoints = {
      // Gemini Cloud Code API 端点
      gemini: 'https://cloudcode-pa.googleapis.com',
      // Google Cloud Platform API 端点 (with cloud-platform scope)
      gcp: 'https://www.googleapis.com',
      // Google OAuth2 token endpoint
      oauthToken: 'https://oauth2.googleapis.com'
    };

    // 路由配置
    const routes = {
      // Gemini Cloud Code 路由
      '/v1internal:generateContent': endpoints.gemini,
      '/v1internal:streamGenerateContent': endpoints.gemini,
      '/v1internal/': endpoints.gemini,
      '/v1/chat/completions': endpoints.gemini,

      // Google Cloud Platform 路由
      '/gcp/': endpoints.gcp,
      '/googleapis/': endpoints.gcp,
      '/oauth2/v4/': endpoints.gcp,
      '/auth/': endpoints.gcp,

      // Google OAuth2 token route
      '/token': endpoints.oauthToken
    };

    // 确定目标端点
    let targetBase;
    let targetPath;

    // 检查特定路由匹配
    for (const [route, base] of Object.entries(routes)) {
      if (url.pathname.startsWith(route)) {
        targetBase = base;
        // 移除路由前缀，保留实际路径
        if (route.startsWith('/') && route.endsWith('/')) {
          targetPath = url.pathname.replace(route, '/');
        } else if (route === '/v1/chat/completions') {
          targetPath = '/v1internal:generateContent';
        }
        else {
          targetPath = url.pathname;
        }
        break;
      }
    }

    // 默认路由到 Gemini API
    if (!targetBase) {
      targetBase = endpoints.gemini;
      targetPath = url.pathname;
    }

    const targetUrl = targetBase + targetPath + url.search;

    // 保留所有请求头，特别是认证头
    const headers = new Headers(request.headers);
    
    // 确保Content-Type正确
    if (request.method === 'POST' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    // 添加调试日志（可选）
    console.log(`=== Worker Proxy Debug ===`);
    console.log(`Original URL: ${request.url}`);
    console.log(`Path: ${url.pathname}`);
    console.log(`Target Base: ${targetBase}`);
    console.log(`Target Path: ${targetPath}`);
    console.log(`Final Target URL: ${targetUrl}`);
    console.log(`Method: ${request.method}`);
    console.log(`Authorization: ${headers.get('Authorization') ? 'Present' : 'Missing'}`);
    console.log(`========================`);

    // 构造新的请求
    const newRequest = new Request(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual'
    });

    try {
      // 发起请求并获取响应
      const response = await fetch(newRequest);

      // 直接返回响应（包括流式响应体）
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (error) {
      console.error('Proxy error:', error);
      return new Response(
        JSON.stringify({ 
          error: 'Proxy Error', 
          message: error.message,
          targetUrl: targetUrl 
        }), 
        { 
          status: 500, 
          headers: { 'Content-Type': 'application/json' } 
        }
      );
    }
  }
};
