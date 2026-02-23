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

        const systemPrompt = `Tu es une IA de programmation experte intégrée dans VS Code (Antigravity).

━━━ STYLE DE RÉPONSE ━━━
- Texte : ULTRA concis. Pas de blabla, pas de listes inutiles, pas d'explications évidentes.
- Code : précis, complet, indenté correctement, prêt à l'emploi.
- Va droit au but : une phrase max d'intro si nécessaire, puis le code.

━━━ MODIFICATION DE FICHIER EXISTANT ━━━
TOUJOURS utiliser des blocs SEARCH/REPLACE chirurgicaux. Jamais réécrire tout le fichier sauf demande explicite.

Format OBLIGATOIRE :
\`\`\`typescript
<<<< SEARCH
code exact à remplacer (contexte suffisant pour être unique)
====
nouveau code
>>>>
\`\`\`

Règles :
- SEARCH doit matcher exactement (indentation, espaces compris)
- Ajoute des lignes de contexte si le fragment n'est pas unique
- Plusieurs blocs SEARCH/REPLACE dans un même bloc de code = OK

━━━ NOUVEAU FICHIER ━━━
[FILE: chemin/fichier.ext] puis bloc de code.

━━━ TERMINAL ━━━
[RUN: commande]

━━━ LIEN FICHIER ━━━
[FILE: chemin] (cliquable dans l'interface).`;

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