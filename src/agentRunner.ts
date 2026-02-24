import * as vscode from 'vscode';
import * as path from 'path';
import { OllamaClient, ContextFile } from './ollamaClient';
import { FileContextManager } from './fileContextManager';
import { LspDiagnosticsManager } from './lspDiagnosticsManager';

export type AgentStepType =
    | 'read_file'
    | 'write_file'
    | 'run_command'
    | 'fix_diagnostics'
    | 'think'
    | 'done'
    | 'error';

export interface AgentStep {
    id: number;
    type: AgentStepType;
    description: string;
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    input?: string;
    output?: string;
    durationMs?: number;
}

export interface AgentSession {
    id: string;
    goal: string;
    steps: AgentStep[];
    status: 'running' | 'done' | 'failed' | 'stopped';
    startedAt: number;
    model: string;
    url: string;
}

type AgentEventType = 'step_start' | 'step_done' | 'step_failed' | 'session_done' | 'session_failed' | 'log';
interface AgentEvent {
    type: AgentEventType;
    session: AgentSession;
    step?: AgentStep;
    message?: string;
}

const MAX_STEPS = 20;

const AGENT_SYSTEM_PROMPT = `Tu es un agent autonome intégré dans VS Code. Tu dois accomplir un objectif en plusieurs étapes.

À chaque étape, réponds UNIQUEMENT avec un JSON valide dans ce format exact :
{
  "type": "read_file" | "write_file" | "run_command" | "fix_diagnostics" | "think" | "done" | "error",
  "description": "Ce que tu fais en une phrase",
  "input": "selon le type :",
  "content": "pour write_file : le nouveau contenu complet du fichier"
}

Types disponibles :
- read_file   → input = chemin relatif du fichier à lire
- write_file  → input = chemin relatif, content = contenu complet
- run_command → input = commande shell à exécuter (ex: "npm test", "tsc --noEmit")
- fix_diagnostics → input = "active" | "workspace" (lit les erreurs LSP actuelles)
- think       → input = ta réflexion interne (non exécuté, juste loggé)
- done        → input = résumé de ce qui a été accompli
- error       → input = raison pour laquelle tu ne peux pas continuer

RÈGLES ABSOLUES :
1. Une seule action par réponse.
2. Réponds UNIQUEMENT avec le JSON, aucun texte autour.
3. Commence TOUJOURS par un "think" pour planifier.
4. Vérifie avec "fix_diagnostics" après chaque write_file si c'est du code.
5. Termine TOUJOURS avec "done" ou "error".
6. Maximum ${MAX_STEPS} étapes au total.`;
const STEP_TIMEOUT_MS = 30_000;

export class AgentRunner {
    private _currentSession: AgentSession | null = null;
    private _stopped: boolean = false;
    private _onEvent?: (event: AgentEvent) => void;

    constructor(
        private readonly _ollamaClient: OllamaClient,
        private readonly _fileCtxManager: FileContextManager,
        private readonly _lspManager: LspDiagnosticsManager,
        private readonly _context: vscode.ExtensionContext,
    ) {}

    onEvent(handler: (event: AgentEvent) => void) {
        this._onEvent = handler;
    }

    stop() {
        this._stopped = true;
        if (this._currentSession) {
            this._currentSession.status = 'stopped';
        }
    }

    isRunning(): boolean {
        return this._currentSession?.status === 'running';
    }

    getCurrentSession(): AgentSession | null {
        return this._currentSession;
    }

    async run(
        goal: string,
        model: string,
        url: string,
        initialContext: ContextFile[] = []
    ): Promise<AgentSession> {
        this._stopped = false;

        const session: AgentSession = {
            id: Date.now().toString(),
            goal,
            steps: [],
            status: 'running',
            startedAt: Date.now(),
            model,
            url,
        };
        this._currentSession = session;

        const contextParts: string[] = [
            `[OBJECTIF] ${goal}`,
            '',
        ];

        const tree = await this._fileCtxManager.getWorkspaceTree();
        contextParts.push('[STRUCTURE DU PROJET]');
        contextParts.push(tree.slice(0, 80).join('\n'));
        contextParts.push('');

        for (const f of initialContext.slice(0, 5)) {
            contextParts.push(`[FICHIER: ${f.name}]\n${f.content.substring(0, 3000)}`);
        }

        const diags = this._lspManager.getSnapshot('errors-only');
        if (diags.errorCount > 0) {
            contextParts.push('');
            contextParts.push(this._lspManager.formatForPrompt(diags));
        }

        const agentContext = contextParts.join('\n');

        const agentHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

        this._emit({ type: 'log', session, message: `🤖 Agent démarré — Objectif : ${goal}` });

        for (let stepIdx = 0; stepIdx < MAX_STEPS; stepIdx++) {
            if (this._stopped) {
                session.status = 'stopped';
                break;
            }

            const step: AgentStep = {
                id: stepIdx,
                type: 'think',
                description: '...',
                status: 'running',
            };
            session.steps.push(step);
            this._emit({ type: 'step_start', session, step });

            const historyStr = agentHistory
                .slice(-10)
                .map(m => `${m.role === 'user' ? 'SYSTÈME' : 'AGENT'}: ${m.content}`)
                .join('\n\n');

            const stepPrompt = agentHistory.length === 0
                ? `Contexte:\n${agentContext}\n\nCommence à accomplir l'objectif. Réponds avec le JSON de ta première action.`
                : `Continue. Historique des ${agentHistory.length} dernières actions:\n${historyStr}\n\nProchaine action JSON :`;

            let rawResponse = '';
            try {
                const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout')), STEP_TIMEOUT_MS)
                );
                const t0 = Date.now();
                rawResponse = await Promise.race([
                    this._ollamaClient.generateResponse(stepPrompt, AGENT_SYSTEM_PROMPT, model, url || undefined),
                    timeoutPromise,
                ]);
                step.durationMs = Date.now() - t0;
            } catch (e: any) {
                step.status = 'failed';
                step.output = e.message;
                this._emit({ type: 'step_failed', session, step, message: e.message });
                session.status = 'failed';
                break;
            }

            let action: any;
            try {
                const cleaned = rawResponse
                    .replace(/^```json\s*/i, '')
                    .replace(/^```\s*/i, '')
                    .replace(/```\s*$/i, '')
                    .trim();
                action = JSON.parse(cleaned);
            } catch {
                const match = rawResponse.match(/\{[\s\S]*\}/);
                if (match) {
                    try { action = JSON.parse(match[0]); } catch { /* noop */ }
                }
                if (!action) {
                    step.type = 'error';
                    step.status = 'failed';
                    step.output = `Réponse non-JSON : ${rawResponse.substring(0, 200)}`;
                    this._emit({ type: 'step_failed', session, step });
                    session.status = 'failed';
                    break;
                }
            }

            step.type = action.type as AgentStepType;
            step.description = action.description || action.type;
            step.input = action.input;

            const result = await this._executeAction(action, session, step);
            step.output = result.output;
            step.status = result.success ? 'done' : 'failed';

            agentHistory.push({ role: 'user', content: stepPrompt });
            agentHistory.push({ role: 'assistant', content: rawResponse });

            if (result.feedback) {
                agentHistory.push({ role: 'user', content: `[RÉSULTAT] ${result.feedback}` });
            }

            this._emit({ type: result.success ? 'step_done' : 'step_failed', session, step });

            if (action.type === 'done') {
                session.status = 'done';
                this._emit({ type: 'session_done', session, message: action.input });
                break;
            }

            if (action.type === 'error') {
                session.status = 'failed';
                this._emit({ type: 'session_failed', session, message: action.input });
                break;
            }

            if (!result.success) {
                agentHistory.push({ role: 'user', content: `[ERREUR] ${result.output} — Continue ou utilise "error" si bloqué.` });
            }
        }

        if (session.status === 'running') {
            session.status = 'done';
            this._emit({ type: 'session_done', session, message: 'Limite d\'étapes atteinte.' });
        }

        return session;
    }

    private async _executeAction(
        action: any,
        session: AgentSession,
        step: AgentStep
    ): Promise<{ success: boolean; output: string; feedback?: string }> {
        try {
            switch (action.type as AgentStepType) {
                case 'think':
                    return { success: true, output: action.input || '', feedback: 'Réflexion enregistrée.' };

                case 'read_file': {
                    const filePath = action.input?.trim();
                    if (!filePath) return { success: false, output: 'Chemin manquant.' };
                    const file = await this._fileCtxManager.readFile(filePath);
                    if (!file) return { success: false, output: `Fichier introuvable : ${filePath}` };
                    const preview = file.content.substring(0, 4000);
                    return {
                        success: true,
                        output: `Lu ${file.content.length} chars`,
                        feedback: `[CONTENU DE ${filePath}]\n${preview}${file.content.length > 4000 ? '\n[... tronqué ...]' : ''}`,
                    };
                }

                case 'write_file': {
                    const filePath = action.input?.trim();
                    const content = action.content;
                    if (!filePath || content === undefined) {
                        return { success: false, output: 'Chemin ou contenu manquant.' };
                    }
                    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
                    if (!folder) return { success: false, output: 'Aucun workspace ouvert.' };

                    const uri = vscode.Uri.joinPath(folder, filePath);
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
                    this._emit({ type: 'log', session, message: `✏️ Fichier écrit : ${filePath}` });
                    return {
                        success: true,
                        output: `${filePath} écrit (${content.length} chars)`,
                        feedback: `Fichier ${filePath} sauvegardé. Vérifie les diagnostics si c'est du code.`,
                    };
                }

                case 'run_command': {
                    const cmd = action.input?.trim();
                    if (!cmd) return { success: false, output: 'Commande manquante.' };

                    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Antigravity Agent');
                    terminal.show();
                    terminal.sendText(cmd);
                    this._emit({ type: 'log', session, message: `💻 CMD: ${cmd}` });
                    await new Promise(r => setTimeout(r, 1500));
                    return {
                        success: true,
                        output: `Commande envoyée : ${cmd}`,
                        feedback: `Commande "${cmd}" exécutée. Si elle génère des erreurs elles apparaîtront dans les diagnostics.`,
                    };
                }

                case 'fix_diagnostics': {
                    const scope = (action.input === 'workspace') ? 'workspace' : 'active';
                    const report = this._lspManager.getSnapshot(scope as any);
                    const formatted = this._lspManager.formatForPrompt(report);
                    return {
                        success: true,
                        output: report.summary,
                        feedback: formatted,
                    };
                }

                case 'done':
                case 'error':
                    return { success: true, output: action.input || '' };

                default:
                    return { success: false, output: `Type d'action inconnu : ${action.type}` };
            }
        } catch (e: any) {
            return { success: false, output: e.message || String(e) };
        }
    }

    private _emit(event: AgentEvent) {
        this._onEvent?.(event);
    }
}
