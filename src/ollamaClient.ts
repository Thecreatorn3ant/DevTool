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

        try {
            const response = await fetch(`${url}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    prompt: fullPrompt,
                    system: systemPrompt,
                    stream: true
                }),
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
                    if (!line.trim()) { continue; }
                    try {
                        const data = JSON.parse(line);
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

            if (buffer.trim()) {
                try {
                    const data = JSON.parse(buffer);
                    if (data.response) {
                        fullResponse += data.response;
                        onUpdate(data.response);
                    }
                } catch { /* ignore */ }
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

    async listModels(): Promise<string[]> {
        try {
            const url = this._getBaseUrl();
            const response = await fetch(`${url}/api/tags`, {
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) { return []; }
            const data: any = await response.json();
            if (!Array.isArray(data?.models)) { return []; }
            return data.models.map((m: any) => m.name as string).filter(Boolean);
        } catch (error) {
            console.error('Failed to list models:', error);
            return [];
        }
    }

    async checkConnection(): Promise<boolean> {
        try {
            const url = this._getBaseUrl();
            const response = await fetch(`${url}/api/tags`, {
                signal: AbortSignal.timeout(3000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}