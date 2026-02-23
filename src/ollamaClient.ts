import * as vscode from 'vscode';

export class OllamaClient {

    private _getConfig() {
        return vscode.workspace.getConfiguration('local-ai');
    }

    private _getBaseUrl(): string {
        return this._getConfig().get<string>('ollamaUrl') || 'http://localhost:11434';
    }

    async generateStreamingResponse(
        prompt: string,
        context: string,
        onUpdate: (chunk: string) => void,
        modelOverride?: string
    ): Promise<string> {
        const config = this._getConfig();
        const url = this._getBaseUrl();
        const model = modelOverride || config.get<string>('defaultModel') || 'llama3';

        const systemPrompt = `Tu es une IA d'édition de code intégrée dans VS Code. Ton seul but est d'éditer le code de l'utilisateur.

━━━ COMPORTEMENT STRICT ABSOLU (SINON ÉCHEC) ━━━
- RÉPONDRE EXCLUSIVEMENT EN FRANÇAIS. Ne parle jamais une autre langue.
- NE DONNE JAMAIS D'EXEMPLES GÉNÉRIQUES OU DE TUTORIELS.
- Modifie UNIQUEMENT le vrai code fourni dans le contexte (la section [FICHIER ACTIF]). N'invente pas un faux code d'exemple (ex: "hello world").
- Style robotique : PAS de salutations, PAS d'explications ("voici comment faire", "tu devrais..."), PAS de conclusion.
- Fournis directement le correctif.

━━━ FORMAT OBLIGATOIRE POUR MODIFIER UN FICHIER ━━━
Toujours utiliser les blocs SEARCH/REPLACE. Le bloc SEARCH DOIT être un copié-collé exact (indentation stricte) du code actuel en contexte.

\`\`\`typescript
<<<< SEARCH
code_exact_existant_à_remplacer
====
nouveau_code
>>>>
\`\`\`

Règles absolues de parsage :
1. Le bloc SEARCH DOIT OBLIGATOIREMENT inclure au moins 2 lignes non-modifiées AVANT le changement et 2 lignes non-modifiées APRÈS.
2. Si tu ne mets pas ce contexte exact, notre système plantera.
3. Le bloc SEARCH doit être un copié-collé STRICT du code actuel. Ne résume jamais avec des "...".
4. Ne réécris pas tout le fichier, limite-toi au fragment exact.

━━━ EXEMPLE DE BONNE RÉPONSE (À IMITER ABSOLUMENT) ━━━
Utilisateur: ajoute un log d'erreur dans le catch

Réponse attendue (sans aucun autre texte) :
\`\`\`typescript
<<<< SEARCH
        try {
            await this.db.connect();
            this.isConnected = true;
        } catch (e) {
            this.isConnected = false;
        }
====
        try {
            await this.db.connect();
            this.isConnected = true;
        } catch (e) {
            console.error("Erreur :", e);
            this.isConnected = false;
        }
>>>>
\`\`\`

━━━ NOUVEAU FICHIER ━━━
[FILE: chemin/fichier.ext]
\`\`\`
code
\`\`\`

━━━ COMMANDES TERMINAL ━━━
[RUN: commande]`;

        const fullPrompt = context
            ? `Contexte du projet:\n${context}\n\n---\nQuestion: ${prompt}`
            : prompt;

        let apiKey = config.get<string>('apiKey') || '';

        if (apiKey.startsWith('http') && apiKey.includes('key=')) {
            try {
                const urlObj = new URL(apiKey);
                const extractedKey = urlObj.searchParams.get('key');
                if (extractedKey) {
                    apiKey = extractedKey;
                }
            } catch (e) {
            }
        }

        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            if (url.includes('openrouter')) {
                headers['HTTP-Referer'] = 'https://github.com/microsoft/vscode';
                headers['X-Title'] = 'VSCode Antigravity';
            }

            const isOpenAI = this._isOpenAI(url);
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

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error("Impossible de lire le flux de réponse.");
            }

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
                            } catch (e) { /* ignore parse error for incomplete chunks */ }
                        }
                    } else {
                        try {
                            const data = JSON.parse(cleanLine);
                            if (data.response) {
                                fullResponse += data.response;
                                onUpdate(data.response);
                            }
                            if (data.error) {
                                throw new Error(data.error);
                            }
                        } catch (e: any) {
                            if (e.message && !e.message.includes('JSON')) {
                                throw e;
                            }
                        }
                    }
                }
            }

            if (buffer.trim()) {
                if (isOpenAI) {
                    const cleanLine = buffer.trim();
                    if (cleanLine.startsWith('data: ') && cleanLine !== 'data: [DONE]') {
                        try {
                            const data = JSON.parse(cleanLine.slice(6));
                            const content = data.choices?.[0]?.delta?.content;
                            if (content) {
                                fullResponse += content;
                                onUpdate(content);
                            }
                        } catch (e) { /* ignore */ }
                    }
                } else {
                    try {
                        const data = JSON.parse(buffer.trim());
                        if (data.response) {
                            fullResponse += data.response;
                            onUpdate(data.response);
                        }
                    } catch { /* ignore */ }
                }
            }

            return fullResponse;

        } catch (error: any) {
            const msg = error.message || String(error);
            if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('NetworkError')) {
                vscode.window.showErrorMessage(`Ollama inaccessible. Vérifiez qu'Ollama est bien lancé sur ${url}`);
            } else {
                vscode.window.showErrorMessage(`Erreur Ollama: ${msg}`);
            }
            return '';
        }
    }

    async generateResponse(prompt: string, context: string = '', modelOverride?: string): Promise<string> {
        let full = '';
        return await this.generateStreamingResponse(prompt, context, (c) => { full += c; }, modelOverride);
    }

    private _isOpenAI(url: string): boolean {
        return url.includes('together') || url.includes('openrouter') || url.endsWith('/v1');
    }

    async listModels(): Promise<string[]> {
        try {
            const url = this._getBaseUrl();
            const config = this._getConfig();
            const apiKey = config.get<string>('apiKey') || '';
            const headers: Record<string, string> = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            const isOpenAI = this._isOpenAI(url);
            const endpoint = isOpenAI ? `${url}/models` : `${url}/api/tags`;

            const response = await fetch(endpoint, {
                headers,
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) { return []; }
            const data: any = await response.json();

            if (isOpenAI) {
                if (!Array.isArray(data?.data)) { return []; }
                return data.data.map((m: any) => m.id as string).filter(Boolean);
            } else {
                if (!Array.isArray(data?.models)) { return []; }
                return data.models.map((m: any) => m.name as string).filter(Boolean);
            }
        } catch (error) {
            console.error('Failed to list models:', error);
            return [];
        }
    }

    async checkConnection(): Promise<boolean> {
        try {
            const url = this._getBaseUrl();
            const isOpenAI = this._isOpenAI(url);
            const endpoint = isOpenAI ? `${url}/models` : `${url}/api/tags`;
            const config = this._getConfig();
            const apiKey = config.get<string>('apiKey') || '';
            const headers: Record<string, string> = {};
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

            const response = await fetch(endpoint, {
                headers,
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}