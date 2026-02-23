import * as vscode from 'vscode';

export interface ApiKeyEntry {
    key: string;
    label: string;
    platform?: string;
    rateLimitedUntil?: number;
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

        const best = allKeys.find(k => k.key && (!k.platform || platform.includes(k.platform)) && (!k.rateLimitedUntil || k.rateLimitedUntil < now));
        if (best) return best.key;

        return mainKey;
    }

    private async _markKeyAsRateLimited(key: string) {
        const allKeys = this._getApiKeys();
        const now = Date.now();
        let changed = false;
        const updated = allKeys.map(k => {
            if (k.key === key) {
                changed = true;
                return { ...k, rateLimitedUntil: now + 60000 };
            }
            return k;
        });
        if (changed) {
            await this._saveApiKeys(updated);
        }
    }

    async generateStreamingResponse(
        prompt: string,
        context: string,
        onUpdate: (chunk: string) => void,
        modelOverride?: string
    ): Promise<string> {
        const url = this._getBaseUrl();
        const config = this._getConfig();
        const model = modelOverride || config.get<string>('defaultModel') || 'llama3';

        const fullPrompt = context
            ? `Contexte du projet:\n${context}\n\n---\nQuestion: ${prompt}`
            : prompt;

        return await this._doRequestWithRetry(url, model, fullPrompt, onUpdate);
    }

    private async _doRequestWithRetry(url: string, model: string, fullPrompt: string, onUpdate: (chunk: string) => void, attempt: number = 0): Promise<string> {
        const apiKey = this._getAvailableKey(url);
        const isOpenAI = this._isOpenAI(url);
        const systemPrompt = this._getSystemPrompt();

        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
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
                    vscode.window.showWarningMessage("⏳ Rate Limit atteint sur ce compte. Basculement sur un autre disponible...");
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
                                if (content) {
                                    fullResponse += content;
                                    onUpdate(content);
                                }
                            } catch (e) { /* ignore parse error */ }
                        }
                    } else {
                        try {
                            const data = JSON.parse(cleanLine);
                            if (data.response) {
                                fullResponse += data.response;
                                onUpdate(data.response);
                            }
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
- Modifie UNIQUEMENT le vrai code fourni dans le contexte (la section [FICHIER ACTIF]).
- Style robotique : PAS de salutations, PAS d'explications. Fournis directement le correctif.

━━━ FORMAT OBLIGATOIRE POUR MODIFIER UN FICHIER ━━━
Toujours utiliser les blocs SEARCH/REPLACE. 

\`\`\`typescript
<<<< SEARCH
code_exact_existant
====
nouveau_code
>>>>
\`\`\`

Règles :
1. SEARCH doit être un copié-collé STRICT.
2. Inclure 2 lignes de contexte avant et après.`;
    }

    async generateResponse(prompt: string, context: string = '', modelOverride?: string): Promise<string> {
        let full = '';
        return await this.generateStreamingResponse(prompt, context, (c) => { full += c; }, modelOverride);
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