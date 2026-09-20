// Minimal chat client for browser use.
// - `kind: 'openai'`  -> OpenAI-compatible {baseUrl}/chat/completions (OpenAI,
//   OpenRouter, DeepSeek, Alibaba Qwen / DashScope, Ollama, LM Studio, ...).
// - `kind: 'anthropic'` -> Anthropic Messages API {baseUrl}/v1/messages (Claude).
// Supports SSE streaming responses (and falls back to a plain JSON response).

export const AI_PROVIDERS = {
    openai: {
        label: 'OpenAI',
        kind: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.6-terra',
        needsKey: true,
        hint: 'Uses your OpenAI API key (sk-...). Models: gpt-6-astra (flagship), gpt-5.6-sol, gpt-5.6-terra (balanced), gpt-5.6-luna (lowest cost). 1.05M context, 128K max output.'
    },
    openrouter: {
        label: 'OpenRouter',
        kind: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'deepseek/deepseek-v4-flash',
        needsKey: true,
        hint: 'One key for many models (Anthropic, OpenAI, DeepSeek, Google, Qwen, ...). Model ids use vendor/model, e.g. deepseek/deepseek-v4-flash.'
    },
    deepseek: {
        label: 'DeepSeek',
        kind: 'openai',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        needsKey: true,
        hint: 'OpenAI-compatible API. Key at platform.deepseek.com. Models: deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash-vision-exp (experimental, image input).'
    },
    claude: {
        label: 'Claude (Anthropic)',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-5',
        needsKey: true,
        hint: 'Uses the Anthropic Messages API (x-api-key). Models: claude-fable-5-1, claude-opus-5, claude-sonnet-5, claude-haiku-4-5. 1M context, 128K max output. The API key is sent only to Anthropic.'
    },
    qwen: {
        label: 'Qwen (Alibaba Cloud)',
        kind: 'openai',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max',
        needsKey: true,
        hint: 'Alibaba Cloud Model Studio (DashScope) OpenAI-compatible endpoint. Models: qwen3.8-max, qwen3.7-plus, qwen3.8-flash (also hosts deepseek-v4-*). For the international zone use https://dashscope-intl.aliyuncs.com/compatible-mode/v1.'
    },
    ollama: {
        label: 'Ollama (local)',
        kind: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3.8:27b-q8_0',
        needsKey: false,
        hint: 'Local server. No API key required. Start Ollama with OLLAMA_ORIGINS=* to allow browser requests. Use "Load models" to list installed tags.'
    },
    lmstudio: {
        label: 'LM Studio (local)',
        kind: 'openai',
        baseUrl: 'http://localhost:1234/v1',
        model: 'local-model',
        needsKey: false,
        hint: 'Local OpenAI-compatible server built into LM Studio.'
    },
    custom: {
        label: 'Custom (OpenAI-compatible)',
        kind: 'openai',
        baseUrl: 'http://localhost:8000/v1',
        model: 'model-name',
        needsKey: false,
        hint: 'Any OpenAI-compatible /v1/chat/completions endpoint.'
    }
};

export const DEFAULT_AI_SETTINGS = {
    provider: 'deepseek',
    kind: AI_PROVIDERS.deepseek.kind,
    baseUrl: AI_PROVIDERS.deepseek.baseUrl,
    model: AI_PROVIDERS.deepseek.model,
    apiKey: '',
    temperature: 0.3,
    maxTokens: 128000,
    includeLst: true,
    deepseekThinking: true,
    deepseekEffort: 'low'
};

export function aiSettingsFromProvider(providerId) {
    const p = AI_PROVIDERS[providerId] || AI_PROVIDERS.custom;
    return {
        ...DEFAULT_AI_SETTINGS,
        provider: providerId,
        kind: p.kind || 'openai',
        baseUrl: p.baseUrl,
        model: p.model
    };
}

function parseOpenAISSE(payload, onDelta, onReasoning) {
    // payload is one data: JSON chunk: {choices:[{delta:{content, reasoning_content}}]}
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
        json = JSON.parse(payload);
    } catch (e) {
        return; // ignore malformed keep-alive lines
    }
    const choice = json.choices && json.choices[0];
    const delta = choice && choice.delta;
    if (!delta) {
        if (choice && choice.text) onDelta(choice.text);
        return;
    }
    if (delta.content) {
        onDelta(delta.content);
    }
    // DeepSeek streams the chain of thought in `reasoning_content`; Ollama (and
    // some other OpenAI-compatible servers) use `reasoning`. Accept both, and
    // handle them independently of content since a chunk may carry either.
    const thinking = delta.reasoning_content || delta.reasoning;
    if (thinking && onReasoning) {
        onReasoning(thinking);
    }
}

function parseAnthropicSSE(payload, onDelta, onReasoning) {
    // payload is one data: JSON chunk; Anthropic events like
    // {"type":"content_block_delta","delta":{"type":"text_delta"|"thinking_delta",...}}
    if (!payload) return;
    let json;
    try {
        json = JSON.parse(payload);
    } catch (e) {
        return;
    }
    if (json.type === 'content_block_delta' && json.delta) {
        if (json.delta.type === 'text_delta' && json.delta.text) {
            onDelta(json.delta.text);
        } else if (json.delta.type === 'thinking_delta' && json.delta.thinking && onReasoning) {
            onReasoning(json.delta.thinking);
        }
    }
}

// Consume an SSE response, calling onDelta/onReasoning for each chunk as it
// arrives. Line-based parsing (not blank-line based) works with any SSE framing
// and lets reasoning deltas show up immediately.
async function readSSEStream(res, parser, onDelta, onReasoning) {
    let full = '';
    const handleEvent = (event) => {
        const captured = [];
        parser(event, (t) => { full += t; captured.push(t); onDelta(t); },
            (t) => { if (onReasoning) onReasoning(t); });
        return captured.join('');
    };

    if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const processLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) return; // skip event:/id:/comment lines
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            try {
                handleEvent(payload);
            } catch (e) { /* ignore a malformed chunk */ }
        };
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl).replace(/\r$/, '');
                buffer = buffer.slice(nl + 1);
                processLine(line);
            }
        }
        if (buffer.trim()) processLine(buffer);
        return full;
    }
    // Fallback: read the whole response and feed each data: line to the parser.
    const text = await res.text();
    for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!line.trim().startsWith('data:')) continue;
        const payload = line.trim().slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            handleEvent(payload);
        } catch (e) { /* ignore */ }
    }
    return full;
}

async function requestJson(url, headers, body, signal) {
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal
        });
    } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new Error(`Could not reach the AI endpoint (${url}). ${e.message}`);
    }
    if (!res.ok) {
        let detail = '';
        try {
            const err = await res.json();
            detail = (err.error && (err.error.message || err.error))
                || (err.message)
                || JSON.stringify(err);
        } catch (e) { /* ignore */ }
        throw new Error(`AI request failed (HTTP ${res.status}). ${detail || res.statusText}`);
    }
    return res;
}

function splitMessages(messages) {
    // Anthropic uses a top-level `system` field; OpenAI keeps system roles inline.
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const chat = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
    return { system, chat };
}

async function openaiChat(baseUrl, settings, messages, { onDelta, onReasoning, signal }) {
    const url = `${baseUrl}/chat/completions`;
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    const useStream = typeof onDelta === 'function';
    const body = {
        model: settings.model,
        messages,
        temperature: Number(settings.temperature || 0.3),
        max_tokens: Number(settings.maxTokens || 128000),
        stream: useStream
    };
    // DeepSeek V4: thinking mode is ON by default and may answer only after a
    // long reasoning phase; explicit control lets users get a fast answer.
    if (settings.provider === 'deepseek') {
        body.thinking = { type: settings.deepseekThinking === false ? 'disabled' : 'enabled' };
        if (settings.deepseekThinking !== false) body.reasoning_effort = settings.deepseekEffort || 'low';
    }
    const res = await requestJson(url, headers, body, signal);
    if (useStream) return readSSEStream(res, parseOpenAISSE, onDelta, onReasoning);
    const json = await res.json();
    const text = json.choices && json.choices[0]
        && (json.choices[0].message && json.choices[0].message.content)
        || '';
    return text || '';
}

async function anthropicChat(baseUrl, settings, messages, { onDelta, onReasoning, signal }) {
    const url = `${baseUrl}/v1/messages`;
    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (settings.apiKey) headers['x-api-key'] = settings.apiKey;
    const { system, chat } = splitMessages(messages);
    const useStream = typeof onDelta === 'function';
    const res = await requestJson(url, headers, {
        model: settings.model,
        max_tokens: Number(settings.maxTokens || 128000),
        temperature: Number(settings.temperature || 0.3),
        system: system || undefined,
        messages: chat,
        stream: useStream
    }, signal);
    if (useStream) return readSSEStream(res, parseAnthropicSSE, onDelta, onReasoning);
    const json = await res.json();
    const text = (json.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
    return text || '';
}

// Send a chat request. settings: {kind?, baseUrl, apiKey, model, temperature, maxTokens}.
// messages: [{role:'system'|'user'|'assistant', content}]. onDelta(text) per token,
// onReasoning(text) for thinking/reasoning streams. kind 'anthropic' uses the
// Messages API; everything else uses OpenAI-compatible chat/completions.
// Returns the full assistant text; throws Error with a readable message on failure.
export async function aiChat(settings, messages, { onDelta = null, onReasoning = null, signal = null } = {}) {
    const baseUrl = (settings.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('AI endpoint (base URL) is not configured. Open AI Settings.');
    if (!settings.model) throw new Error('AI model is not configured. Open AI Settings.');

    const opts = { onDelta, onReasoning, signal };
    if (settings.kind === 'anthropic') {
        return anthropicChat(baseUrl, settings, messages, opts);
    }
    return openaiChat(baseUrl, settings, messages, opts);
}

// List the models an endpoint currently serves. Works for any OpenAI-compatible
// server (Ollama, LM Studio, OpenAI, DeepSeek, ...) via GET {baseUrl}/models,
// and also accepts Ollama's native {models:[{name}]} shape as a fallback.
// Returns a sorted array of model id strings; throws Error with a readable
// message when the endpoint cannot be reached.
export async function listModels(settings, baseUrlOverride = null) {
    const baseUrl = (baseUrlOverride || settings.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('AI endpoint (base URL) is not configured. Open AI Settings.');

    const headers = {};
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

    let res;
    try {
        res = await fetch(`${baseUrl}/models`, { headers });
    } catch (e) {
        throw new Error(`Could not reach the model list at ${baseUrl}/models. ${e.message}`);
    }
    if (!res.ok) {
        throw new Error(`Could not list models (HTTP ${res.status}). ${res.statusText}`);
    }
    let json;
    try {
        json = await res.json();
    } catch (e) {
        throw new Error('Model list response was not valid JSON.');
    }
    const rows = Array.isArray(json.data) ? json.data
        : Array.isArray(json.models) ? json.models
        : [];
    return rows
        .map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)) || ''))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Agent mode: tool/function calling loop for OpenAI-compatible providers.
// ---------------------------------------------------------------------------

function toOpenAiTools(tools) {
    return (tools || []).map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description || '',
            parameters: t.parameters || { type: 'object', properties: {} }
        }
    }));
}

// Run an agent loop. history = messages so far (system/user). `tools` is a list
// of {name, description, parameters}; `execute(name, args)` performs each tool
// and returns a string/object result which is fed back to the model. Loops
// until the model produces a plain text answer (or maxSteps is reached).
// onStep({step, type:'assistant'|'tool'|'error', ...}) is called for progress.
export async function aiChatAgent(settings, history, tools, execute,
    { maxSteps = 14, signal = null, onStep = null } = {}) {
    if (settings.kind === 'anthropic') {
        throw new Error('Tool-calling is not supported for the Anthropic provider in this build. Use DeepSeek/OpenAI/Qwen/OpenRouter or a compatible endpoint.');
    }
    const baseUrl = (settings.baseUrl || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('AI endpoint (base URL) is not configured. Open AI Settings.');
    if (!settings.model) throw new Error('AI model is not configured. Open AI Settings.');

    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

    const messages = history.map(m => ({ ...m }));
    const toolDefs = toOpenAiTools(tools);
    let answer = '';

    const call = async () => {
        const body = {
            model: settings.model,
            messages,
            tools: toolDefs,
            tool_choice: 'auto',
            temperature: Number(settings.temperature || 0.3),
            max_tokens: Number(settings.maxTokens || 128000)
        };
        if (settings.provider === 'deepseek') {
            // Thinking mode + tools requires reasoning_content pass-back; simpler
            // and reliable to disable thinking for the tool loop.
            body.thinking = { type: 'disabled' };
        }
        const res = await requestJson(`${baseUrl}/chat/completions`, headers, body, signal);
        return res.json();
    };

    for (let step = 0; step < maxSteps; step++) {
        let json;
        try {
            json = await call();
        } catch (e) {
            if (onStep) onStep({ step, type: 'error', error: e.message });
            throw e;
        }
        const msg = json.choices && json.choices[0] && json.choices[0].message;
        if (!msg) {
            const detail = json.error ? (json.error.message || JSON.stringify(json.error)) : 'empty response';
            if (onStep) onStep({ step, type: 'error', error: detail });
            throw new Error(`Model returned an empty response. ${detail}`);
        }
        const content = msg.content || '';
        const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
            .filter(c => c && c.function && c.function.name);

        if (onStep) onStep({ step, type: 'assistant', content });

        if (!calls.length) {
            answer += content;
            break;
        }

        // Record the assistant turn with its tool calls, then run each tool.
        messages.push({ role: 'assistant', content: content || null, tool_calls: msg.tool_calls });
        for (const c of calls) {
            let name = c.function.name;
            let args = {};
            try { args = JSON.parse(c.function.arguments || '{}'); } catch (e) { /* keep {} */ }
            let result;
            try {
                result = await execute(name, args);
            } catch (e) {
                result = { error: e.message };
            }
            const text = typeof result === 'string' ? result : JSON.stringify(result);
            if (onStep) onStep({ step, type: 'tool', name, args, result: text });
            messages.push({ role: 'tool', tool_call_id: c.id, content: text });
        }
    }
    return answer;
}
