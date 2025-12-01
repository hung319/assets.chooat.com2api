/**
 * =================================================================================
 * Project: nanobanana-2api (Bun Edition)
 * Version: 1.0.0
 * Refactored by: CezDev
 * * [Changelog]
 * - Migrated to Bun runtime
 * - Removed Web UI/Frontend
 * - Added native .env support
 * - Optimized stream handling
 * =================================================================================
 */

// --- [Configuration] ---
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_URL: process.env.UPSTREAM_URL || "https://assets.chooat.com/api/openrouter-notlogin",
  
  // Headers ngụy trang (Giữ nguyên để bypass WAF)
  HEADERS: {
    "Host": "assets.chooat.com",
    "Origin": "https://nanobananaprompt.org",
    "Referer": "https://nanobananaprompt.org/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "priority": "u=1, i"
  },

  MODELS: [
    "openai/gpt-oss-20b:free",
    "gpt-4o-mini",
    "gpt-3.5-turbo"
  ]
};

// --- [Server Entry] ---
console.log(`🍌 NanoBanana API is running on http://localhost:${CONFIG.PORT}`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // 1. CORS Preflight
    if (req.method === 'OPTIONS') return handleCorsPreflight();

    // 2. Auth Check (Middleware style)
    if (url.pathname.startsWith('/v1/')) {
      if (!verifyAuth(req)) {
        return createErrorResponse('Unauthorized: Invalid Bearer Token', 401, 'unauthorized');
      }
    }

    // 3. Routing
    if (url.pathname === '/v1/models') {
      return handleModelsRequest();
    } 
    
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const requestId = `req-${crypto.randomUUID()}`;
      return handleChatCompletions(req, requestId);
    }

    // 4. 404 Handler
    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  },
});

// --- [Logic Handlers] ---

function verifyAuth(req: Request): boolean {
  // Nếu key là "1", cho phép truy cập public (debug mode)
  if (CONFIG.API_MASTER_KEY === "1") return true;

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return false;
  return authHeader.trim() === `Bearer ${CONFIG.API_MASTER_KEY}`;
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'nanobanana',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

async function handleChatCompletions(req: Request, requestId: string) {
  try {
    const body = await req.json() as any;
    const isStream = body.stream !== false; // Default true if not specified

    // Payload chuẩn hóa cho Upstream
    const upstreamPayload = {
      model: "openai/gpt-oss-20b:free", // Hardcode theo yêu cầu upstream
      messages: body.messages || [],
      domain: "nanobananaprompt.org",
      cost: 0
    };

    // Gọi Upstream (Blocking)
    const upstreamRes = await fetch(CONFIG.UPSTREAM_URL, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(upstreamPayload)
    });

    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text();
      return createErrorResponse(`Upstream Error (${upstreamRes.status}): ${errorText}`, upstreamRes.status, 'upstream_error');
    }

    const data = await upstreamRes.json() as any;

    // Xử lý nội dung & Reasoning
    let content = "";
    let reasoning = "";

    if (data.choices && data.choices.length > 0) {
      content = data.choices[0].message.content || "";
      reasoning = data.choices[0].message.reasoning || "";
    }

    // Format Thinking Process (Chain of Thought)
    if (reasoning) {
      content = `> **Thinking Process:**\n> ${reasoning.replace(/\n/g, "\n> ")}\n\n---\n\n${content}`;
    }

    // --- CASE 1: STREAMING (Pseudo-Stream) ---
    if (isStream) {
      const encoder = new TextEncoder();
      
      const stream = new ReadableStream({
        async start(controller) {
          try {
            // Giả lập hiệu ứng gõ máy (5 chars / 10ms)
            const chunkSize = 5;
            for (let i = 0; i < content.length; i += chunkSize) {
              const chunkText = content.slice(i, i + chunkSize);
              const chunk = createChatCompletionChunk(requestId, body.model, chunkText);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              
              // Delay nhỏ để tạo cảm giác stream
              await new Promise(resolve => setTimeout(resolve, 10));
            }

            // Gửi tín hiệu kết thúc
            const endChunk = createChatCompletionChunk(requestId, body.model, "", "stop");
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch (e: any) {
             const errChunk = createChatCompletionChunk(requestId, body.model, `\n\n[Stream Error: ${e.message}]`, "stop");
             controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
             controller.close();
          }
        }
      });

      return new Response(stream, {
        headers: corsHeaders({ 
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
      });
    }

    // --- CASE 2: NON-STREAMING (Standard JSON) ---
    return new Response(JSON.stringify({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: content },
        finish_reason: "stop"
      }],
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }), { 
      headers: corsHeaders({ 'Content-Type': 'application/json' }) 
    });

  } catch (e: any) {
    console.error(`[Error] ${e.message}`);
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- [Helpers] ---

function createChatCompletionChunk(id: string, model: string, content: string, finishReason: string | null = null) {
  return {
    id: id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ 
      index: 0, 
      delta: content ? { content: content } : {}, 
      finish_reason: finishReason 
    }]
  };
}

function createErrorResponse(message: string, status: number, code: string) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers: Record<string, string> = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
