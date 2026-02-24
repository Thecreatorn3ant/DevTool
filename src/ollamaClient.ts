import * as vscode from 'vscode';

export interface ApiKeyEntry {
    key: string;
    label: string;
    platform?: string;
    rateLimitedUntil?: number;
}

export interface ContextFile {
    name: string;
    content: string;
    isActive?: boolean;
}

export interface TokenBudget {
    used: number;
    max: number;
    isCloud: boolean;
}

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

const LOCAL_LIMITS: Record<string, number> = {
    'llama3': 8000,
    'llama3.1': 8000,
    'llama3.2': 8000,
    'codellama': 8000,
    'mistral': 8000,
    'mixtral': 16000,
    'deepseek-coder': 8000,
    'qwen2.5-coder': 8000,
    'phi3': 4000,
    'phi4': 8000,
    'gemma': 4000,
    'gemma2': 8000,
};

function getLocalMaxChars(model: string): number {
    const modelLower = model.toLowerCase();
    for (const [key, limit] of Object.entries(LOCAL_LIMITS)) {
        if (modelLower.includes(key)) return limit * 4;
    }
    return 8000 * 4;
}

export class OllamaClient {

    private _getConfig() {
        return vscode.workspace.getConfiguration('local-ai');
    }

    private _getBaseUrl(): string {
        return this._getConfig().get<string>('ollamaUrl') || 'http://localhost:11434';
    }

    private _getApiKeys(): ApiKeyEntry[] {
        return this._getConfig().get<ApiKeyEntry[]>('apiKeys') || [];
    }

    private async _saveApiKeys(keys: ApiKeyEntry[]) {
        await this._getConfig().update('apiKeys', keys, true);
    }

    private _getAvailableKey(platform: string): string {
        const config = this._getConfig();
        const mainKey = config.get<string>('apiKey') || '';
        const allKeys = this._getApiKeys();
        const now = Date.now();

        const best = allKeys.find(k =>
            k.key &&
            (!k.platform || platform.includes(k.platform)) &&
            (!k.rateLimitedUntil || k.rateLimitedUntil < now)
        );
        if (best) return best.key;
        return mainKey;
    }

    private async _markKeyAsRateLimited(key: string) {
        const allKeys = this._getApiKeys();
        const now = Date.now();
        let changed = false;
        const updated = allKeys.map(k => {
            if (k.key === key) { changed = true; return { ...k, rateLimitedUntil: now + 60000 }; }
            return k;
        });
        if (changed) await this._saveApiKeys(updated);
    }

    isCloud(url?: string): boolean {
        const u = url || this._getBaseUrl();
        return !u.includes('localhost') && !u.includes('127.0.0.1');
    }

    getTokenBudget(model: string, targetUrl?: string): TokenBudget {
        const cloud = this.isCloud(targetUrl);
        if (cloud) {
            return { used: 0, max: 100000 * 4, isCloud: true };
        }
        const maxChars = getLocalMaxChars(model);
        return { used: 0, max: maxChars, isCloud: false };
    }

    buildContext(
        files: ContextFile[],
        history: string,
        model: string,
        targetUrl?: string
    ): { context: string; budget: TokenBudget } {
        const budget = this.getTokenBudget(model, targetUrl);
        const historyChars = history.length;
        let remaining = budget.max - historyChars - 500;

        const parts: string[] = [];

        const activeFiles = files.filter(f => f.isActive);
        const otherFiles = files.filter(f => !f.isActive);

        for (const f of [...activeFiles, ...otherFiles]) {
            if (remaining <= 0) break;
            const header = `[FICHIER${f.isActive ? ' ACTIF' : ''}: ${f.name}]\n`;
            const available = remaining - header.length;
            if (available <= 100) break;

            const truncated = f.content.length > available
                ? f.content.substring(0, available) + '\n[... tronqué ...]'
                : f.content;

            parts.push(header + truncated);
            remaining -= (header.length + truncated.length);
        }

        budget.used = budget.max - remaining;
        const context = parts.join('\n\n');
        return { context, budget };
    }

    async generateStreamingResponse(
        prompt: string,
        context: string,
        onUpdate: (chunk: string) => void,
        modelOverride?: string,
        targetUrl?: string
    ): Promise<string> {
        const url = targetUrl || this._getBaseUrl();
        const config = this._getConfig();
        const model = modelOverride || config.get<string>('defaultModel') || 'llama3';

        const fullPrompt = context
            ? `Contexte du projet:\n${context}\n\n---\nQuestion: ${prompt}`
            : prompt;

        return await this._doRequestWithRetry(url, model, fullPrompt, onUpdate);
    }

    private async _doRequestWithRetry(
        url: string,
        model: string,
        fullPrompt: string,
        onUpdate: (chunk: string) => void,
        attempt: number = 0
    ): Promise<string> {
        const apiKey = this._getAvailableKey(url);
        const isOpenAI = this._isOpenAI(url);
        const systemPrompt = this._getSystemPrompt();

        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            if (url.includes('openrouter')) {
                headers['HTTP-Referer'] = 'https://github.com/microsoft/vscode';
                headers['X-Title'] = 'VSCode Antigravity';
            }

            const endpoint = isOpenAI ? `${url}/chat/completions` : `${url}/api/generate`;

            const reqBody = isOpenAI ? {
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: fullPrompt }
                ],
                stream: true
            } : {
                model,
                prompt: fullPrompt,
                system: systemPrompt,
                stream: true
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(reqBody),
            });

            if (response.status === 429 && attempt < 3) {
                if (apiKey) {
                    await this._markKeyAsRateLimited(apiKey);
                    vscode.window.showWarningMessage("⏳ Rate Limit atteint. Basculement sur un autre compte...");
                    return this._doRequestWithRetry(url, model, fullPrompt, onUpdate, attempt + 1);
                }
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error("Impossible de lire le flux de réponse.");

            const decoder = new TextDecoder();
            let fullResponse = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    const cleanLine = line.trim();
                    if (!cleanLine) continue;

                    if (isOpenAI) {
                        if (cleanLine === 'data: [DONE]') continue;
                        if (cleanLine.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(cleanLine.slice(6));
                                const content = data.choices?.[0]?.delta?.content;
                                if (content) { fullResponse += content; onUpdate(content); }
                            } catch { }
                        }
                    } else {
                        try {
                            const data = JSON.parse(cleanLine);
                            if (data.response) { fullResponse += data.response; onUpdate(data.response); }
                            if (data.error) throw new Error(data.error);
                        } catch (e: any) {
                            if (e.message && !e.message.includes('JSON')) throw e;
                        }
                    }
                }
            }

            if (buffer.trim()) {
                if (isOpenAI) {
                    if (buffer.startsWith('data: ') && buffer !== 'data: [DONE]') {
                        try {
                            const data = JSON.parse(buffer.slice(6));
                            const content = data.choices?.[0]?.delta?.content;
                            if (content) { fullResponse += content; onUpdate(content); }
                        } catch { }
                    }
                } else {
                    try {
                        const data = JSON.parse(buffer);
                        if (data.response) { fullResponse += data.response; onUpdate(data.response); }
                    } catch { }
                }
            }

            return fullResponse;

        } catch (error: any) {
            const msg = error.message || String(error);
            if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('NetworkError')) {
                vscode.window.showErrorMessage(`Serveur inaccessible sur ${url}`);
            } else {
                vscode.window.showErrorMessage(`Erreur IA: ${msg}`);
            }
            return '';
        }
    }

    private _getSystemPrompt(): string {
        return `Tu es une IA d'édition de code intégrée dans VS Code. Ton seul but est d'éditer le code de l'utilisateur.

━━━ COMPORTEMENT STRICT ABSOLU (SINON ÉCHEC) ━━━
- RÉPONDRE EXCLUSIVEMENT EN FRANÇAIS.
- Modifie UNIQUEMENT le vrai code fourni dans le contexte.
- Style robotique : PAS de salutations, PAS d'explications inutiles. Fournis directement le correctif.
- Si tu as besoin d'accéder à un fichier qui n'est PAS dans ton contexte, indique-le EXPLICITEMENT avec la balise : [NEED_FILE: chemin/du/fichier]
- Si tu identifies plusieurs fichiers à modifier, liste-les TOUS avant de commencer avec : [WILL_MODIFY: fichier1, fichier2, ...]
- Pour le mode "Réflexion", commence par un bloc [PLAN] qui liste toutes les modifications envisagées avant tout code.

━━━ FORMAT OBLIGATOIRE POUR MODIFIER UN FICHIER ━━━
Toujours utiliser les blocs SEARCH/REPLACE avec le fichier cible.

\`\`\`typescript
[FILE: nom_du_fichier.ts]
<<<< SEARCH
code_exact_existant
====
nouveau_code
>>>>
\`\`\`

Règles :
1. SEARCH doit être un copié-collé STRICT.
2. Inclure 2 lignes de contexte avant et après.
3. Si tu crées un nouveau fichier : [CREATE_FILE: chemin] suivi du contenu complet.`;
    }

    async generateResponse(prompt: string, context: string = '', modelOverride?: string, targetUrl?: string): Promise<string> {
        let full = '';
        return await this.generateStreamingResponse(prompt, context, (c) => { full += c; }, modelOverride, targetUrl);
    }

    private _isOpenAI(url: string): boolean {
        return url.includes('together') || url.includes('openrouter') || url.endsWith('/v1');
    }

    async listModels(): Promise<string[]> {
        const url = this._getBaseUrl();
        const apiKey = this._getAvailableKey(url);
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

        try {
            const isOpenAI = this._isOpenAI(url);
            const endpoint = isOpenAI ? `${url}/models` : `${url}/api/tags`;
            const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(5000) });
            if (!response.ok) return [];
            const data: any = await response.json();
            if (isOpenAI) {
                return (data?.data || []).map((m: any) => m.id).filter(Boolean);
            } else {
                return (data?.models || []).map((m: any) => m.name).filter(Boolean);
            }
        } catch { return []; }
    }

    async listAllModels(): Promise<{ name: string; isLocal: boolean; url: string }[]> {
        const activeUrl = this._getBaseUrl();
        const config = this._getConfig();
        const result: { name: string; isLocal: boolean; url: string }[] = [];

        let localModels: string[] = [];
        try {
            const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(2000) });
            if (res.ok) {
                const data: any = await res.json();
                localModels = (data?.models || []).map((m: any) => m.name).filter(Boolean);
            }
        } catch { }

        const savedKeys: Array<{ name: string; key: string; url: string }> =
            config.get<any[]>('apiKeys') || [];

        for (const provider of savedKeys) {
            try {
                const isOpenAI = this._isOpenAI(provider.url);
                const endpoint = isOpenAI ? `${provider.url}/models` : `${provider.url}/api/tags`;
                const res = await fetch(endpoint, {
                    headers: { 'Authorization': `Bearer ${provider.key}` },
                    signal: AbortSignal.timeout(4000)
                });
                if (res.ok) {
                    const data: any = await res.json();
                    const cloudList: string[] = isOpenAI
                        ? (data?.data || []).map((m: any) => m.id as string).filter(Boolean)
                        : (data?.models || []).map((m: any) => (m.name ?? m.id) as string).filter(Boolean);
                    cloudList.forEach(m => result.push({ name: m, isLocal: false, url: provider.url }));
                }
            } catch { }
        }

        for (const m of localModels) result.push({ name: m, isLocal: true, url: 'http://localhost:11434' });
        return result;
    }

    async checkConnection(): Promise<boolean> {
        const url = this._getBaseUrl();
        const apiKey = this._getAvailableKey(url);
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        try {
            const isOpenAI = this._isOpenAI(url);
            const endpoint = isOpenAI ? `${url}/models` : `${url}/api/tags`;
            const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(3000) });
            return response.ok;
        } catch { return false; }
    }
}