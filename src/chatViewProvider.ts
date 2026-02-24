import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { OllamaClient, ContextFile, estimateTokens } from './ollamaClient';
import { FileContextManager } from './fileContextManager';

interface ChatMessage {
    role: 'user' | 'ai';
    value: string;
}

class AiPreviewProvider implements vscode.TextDocumentContentProvider {
    static readonly scheme = 'ai-preview';
    private _content = new Map<string, string>();
    private _emitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._emitter.event;

    set(uri: vscode.Uri, text: string) {
        this._content.set(uri.toString(), text);
        this._emitter.fire(uri);
    }
    delete(uri: vscode.Uri) { this._content.delete(uri.toString()); }
    provideTextDocumentContent(uri: vscode.Uri): string {
        const uriStr = uri.toString();
        if (this._content.has(uriStr)) return this._content.get(uriStr)!;
        const lowerUri = uriStr.toLowerCase();
        for (const [key, value] of this._content.entries()) {
            if (key.toLowerCase() === lowerUri) return value;
        }
        return '';
    }
}

function applySearchReplace(
    documentText: string,
    patchContent: string
): { result: string; patchCount: number; errors: string[] } {
    const errors: string[] = [];
    let patchCount = 0;
    const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const isCrLf = documentText.includes('\r\n');
    const docNorm = norm(documentText);
    const patchNorm = norm(patchContent);

    const lines = patchNorm.split('\n');
    const patches: Array<{ search: string; replace: string }> = [];
    let state: 'idle' | 'search' | 'replace' = 'idle';
    let searchLines: string[] = [];
    let replaceLines: string[] = [];

    const isSearchMarker = (l: string) => /^\s*<{2,}\s*SEARCH/i.test(l);
    const isSeparator = (l: string) => /^\s*={4,}\s*$/.test(l);
    const isCloseMarker = (l: string) => /^\s*>{2,}/.test(l);

    for (const line of lines) {
        if (state === 'idle') {
            if (isSearchMarker(line)) { state = 'search'; searchLines = []; replaceLines = []; }
        } else if (state === 'search') {
            if (isSeparator(line)) { state = 'replace'; }
            else { searchLines.push(line); }
        } else if (state === 'replace') {
            if (isCloseMarker(line)) {
                patches.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
                state = 'idle';
            } else { replaceLines.push(line); }
        }
    }
    if (state === 'replace' && searchLines.length > 0) {
        patches.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
    }

    if (patches.length === 0) return { result: documentText, patchCount: 0, errors: [] };

    let workingText = docNorm;

    for (const patch of patches) {
        const { search, replace } = patch;
        if (workingText.includes(search)) {
            workingText = workingText.replace(search, replace);
            patchCount++; continue;
        }

        const trimEnd = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n');
        const searchTrimmed = trimEnd(search);
        const workingTrimmed = trimEnd(workingText);
        if (workingTrimmed.includes(searchTrimmed)) {
            const tempDoc = workingText.split('\n').map(l => l.trimEnd()).join('\n');
            workingText = tempDoc.replace(searchTrimmed, replace);
            patchCount++; continue;
        }

        const fuzzyLines = search.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const workingLines = workingText.split('\n');
        let fuzzyMatched = false;

        if (fuzzyLines.length > 0) {
            for (let i = 0; i < workingLines.length; i++) {
                let si = 0, di = i;
                while (si < fuzzyLines.length && di < workingLines.length) {
                    const dl = workingLines[di].trim();
                    if (dl === '') { di++; continue; }
                    if (dl !== fuzzyLines[si]) break;
                    si++; di++;
                }
                if (si === fuzzyLines.length) {
                    const textToReplace = workingLines.slice(i, di).join('\n');
                    if (workingText.split(textToReplace).length - 1 === 1) {
                        workingText = workingText.replace(textToReplace, replace);
                        patchCount++; fuzzyMatched = true;
                    }
                    break;
                }
            }
        }
        if (!fuzzyMatched) errors.push(`Bloc SEARCH introuvable : "${search.substring(0, 60)}..."`);
    }

    let result = workingText;
    if (isCrLf) result = result.replace(/\n/g, '\r\n');
    return { result, patchCount, errors };
}

function parseAiResponse(response: string): {
    needFiles: string[];
    willModify: string[];
    plan: string | null;
    createFiles: Array<{ name: string; content: string }>;
    projectSummary: string | null;
} {
    const needFiles: string[] = [];
    const willModify: string[] = [];
    const createFiles: Array<{ name: string; content: string }> = [];
    let plan: string | null = null;
    let projectSummary: string | null = null;

    const needFileRegex = /\[NEED_FILE:\s*([^\]]+)\]/g;
    let m;
    while ((m = needFileRegex.exec(response)) !== null) {
        needFiles.push(m[1].trim());
    }

    const willModifyMatch = /\[WILL_MODIFY:\s*([^\]]+)\]/.exec(response);
    if (willModifyMatch) {
        willModify.push(...willModifyMatch[1].split(',').map(s => s.trim()).filter(Boolean));
    }

    const planMatch = /\[PLAN\]([\s\S]*?)\[\/PLAN\]/.exec(response);
    if (planMatch) plan = planMatch[1].trim();

    const createFileRegex = /\[CREATE_FILE:\s*([^\]]+)\]\s*```(?:\w+)?\n([\s\S]*?)```/g;
    while ((m = createFileRegex.exec(response)) !== null) {
        createFiles.push({ name: m[1].trim(), content: m[2] });
    }

    const summaryMatch = /\[PROJECT_SUMMARY\]([\s\S]*?)\[\/PROJECT_SUMMARY\]/.exec(response);
    if (summaryMatch) projectSummary = summaryMatch[1].trim();

    return { needFiles, willModify, plan, createFiles, projectSummary };
}

function extractMultiFilePatches(response: string): Map<string, string> {
    const patches = new Map<string, string>();

    const fileBlockRegex = /\[FILE:\s*([^\]]+)\]([\s\S]*?)(?=\[FILE:|$)/g;
    let m;
    while ((m = fileBlockRegex.exec(response)) !== null) {
        const fileName = m[1].trim();
        const content = m[2].trim();
        if (content) patches.set(fileName, content);
    }

    return patches;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'local-ai.chatView';
    private _view?: vscode.WebviewView;
    private _history: ChatMessage[] = [];
    private _contextFiles: ContextFile[] = [];
    private _thinkMode: boolean = false;
    private _currentModel: string = 'llama3';
    private _currentUrl: string = '';
    private static readonly _previewProvider = new AiPreviewProvider();
    private static _providerRegistered = false;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _ollamaClient: OllamaClient,
        private readonly _fileCtxManager: FileContextManager,
    ) {
        this._history = this._context.workspaceState.get<ChatMessage[]>('chatHistory', []);
        if (!ChatViewProvider._providerRegistered) {
            this._context.subscriptions.push(
                vscode.workspace.registerTextDocumentContentProvider(
                    AiPreviewProvider.scheme,
                    ChatViewProvider._previewProvider
                )
            );
            ChatViewProvider._providerRegistered = true;
        }

        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && this._view) {
                const name = vscode.workspace.asRelativePath(editor.document.fileName);
                const history = this._fileCtxManager.getFileHistory(name);
                this._view.webview.postMessage({ type: 'fileHistoryChanged', fileName: name, history });
            }
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleSendMessage(data.value, data.model, data.url, data.contextFiles, data.thinkMode);
                    break;
                case 'openCloudConnect': await this._handleCloudConnection(); break;
                case 'getModels': await this._updateModelsList(); break;
                case 'saveModel':
                    await this._context.workspaceState.update('lastSelectedModel', data.model);
                    if (data.model?.includes('||')) {
                        const parts = data.model.split('||');
                        this._currentUrl = parts[0];
                        this._currentModel = parts[1];
                    } else {
                        this._currentModel = data.model || 'llama3';
                        this._currentUrl = '';
                    }
                    break;
                case 'restoreHistory':
                    webviewView.webview.postMessage({ type: 'restoreHistory', history: this._history });
                    break;
                case 'createFile':
                    if (data.value && data.target) await this._handleFileCreation(data.target, data.value);
                    break;
                case 'applyToActiveFile':
                    if (data.value) await this._handleApplyEdit(data.value, data.targetFile);
                    break;
                case 'applyMultiFile':
                    if (data.patches) await this._handleMultiFileApply(data.patches);
                    break;
                case 'requestFileAccess':
                    if (data.target) await this._handleFileAccessRequest(data.target);
                    break;
                case 'clearHistory':
                    this._history = [];
                    this._updateHistory();
                    break;
                case 'openFile':
                    if (data.value) await this._handleOpenFile(data.value);
                    break;
                case 'runCommand':
                    if (data.value) await this._handleRunCommand(data.value);
                    break;
                case 'addRelatedFiles':
                    await this._handleAddRelatedFiles();
                    break;
                case 'toggleThinkMode':
                    this._thinkMode = !this._thinkMode;
                    webviewView.webview.postMessage({ type: 'thinkModeChanged', active: this._thinkMode });
                    break;
                case 'analyzeError':
                    if (data.value) await this.analyzeError(data.value);
                    break;
                case 'generateCommitMessage':
                    await this._handleGenerateCommitMessage();
                    break;
                case 'reviewDiff':
                    await this._handleReviewDiff();
                    break;
                case 'generateTests':
                    await this._handleGenerateTests();
                    break;
                case 'updateProjectSummary':
                    await this._handleUpdateProjectSummary();
                    break;
                case 'removeContextFile':
                    this._contextFiles = this._contextFiles.filter(f => f.name !== data.name);
                    break;
                case 'getTokenBudget':
                    this._sendTokenBudget();
                    break;
            }
        });
    }

    public sendMessageFromEditor(message: string) {
        this._view?.webview.postMessage({ type: 'injectMessage', value: message });
    }

    public activateThinkMode() {
        this._thinkMode = true;
        this._view?.webview.postMessage({ type: 'thinkModeChanged', active: true });
    }

    public addFilesToContext(files: ContextFile[]) {
        for (const f of files) {
            if (!this._contextFiles.find(x => x.name === f.name)) {
                this._contextFiles.push(f);
            }
        }
        this._view?.webview.postMessage({
            type: 'updateContextFiles',
            files: this._contextFiles.map(f => ({ name: f.name, tokens: estimateTokens(f.content) }))
        });
        this._sendTokenBudget();
    }

    public async analyzeError(errorText: string) {
        if (!this._view) return;

        this._view.webview.postMessage({ type: 'statusMessage', value: '🔍 Analyse de l\'erreur en cours...' });

        const relatedFiles = await this._fileCtxManager.findFilesForError(errorText);

        if (relatedFiles.length > 0) {
            this.addFilesToContext(relatedFiles);
            this._view.webview.postMessage({
                type: 'statusMessage',
                value: `📁 ${relatedFiles.length} fichier(s) détecté(s) automatiquement : ${relatedFiles.map(f => f.name).join(', ')}`
            });
        }

        setTimeout(() => {
            this.sendMessageFromEditor(
                `Analyse cette erreur et propose un correctif :\n\`\`\`\n${errorText}\n\`\`\``
            );
        }, 500);
    }

    private async _handleSendMessage(
        userMsg: string,
        model?: string,
        targetUrl?: string,
        webviewContextFiles?: Array<{ name: string; content: string }>,
        thinkMode?: boolean
    ) {
        if (!userMsg || !this._view) return;

        let resolvedModel = model || this._currentModel || 'llama3';
        let resolvedUrl = targetUrl || this._currentUrl || '';
        if (resolvedModel.includes('||')) {
            const parts = resolvedModel.split('||');
            resolvedUrl = parts[0];
            resolvedModel = parts[1];
        }

        const isCloud = this._ollamaClient.isCloud(resolvedUrl || undefined);
        const budget = this._ollamaClient.getTokenBudget(resolvedModel, resolvedUrl || undefined);

        const allContextFiles: ContextFile[] = [...this._contextFiles];
        if (webviewContextFiles) {
            for (const f of webviewContextFiles) {
                if (!allContextFiles.find(x => x.name === f.name)) {
                    allContextFiles.push({ name: f.name, content: f.content, isActive: false });
                }
            }
        }

        const maxPerFile = isCloud ? 40000 : 8000;
        const activeFile = await this._fileCtxManager.getActiveFile(maxPerFile);
        if (activeFile && !allContextFiles.find(f => f.name === activeFile.name)) {
            allContextFiles.unshift(activeFile);
        }

        if (activeFile && (isCloud || allContextFiles.length < 3)) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const related = await this._fileCtxManager.getRelatedFiles(editor.document, maxPerFile);
                for (const r of related) {
                    if (!allContextFiles.find(f => f.name === r.name)) {
                        allContextFiles.push(r);
                    }
                }
            }
        }

        const maxFiles = isCloud ? 10 : 3;
        const limitedFiles = allContextFiles.slice(0, maxFiles);

        const formattedHistory = this._getFormattedHistory();
        const { context, budget: usedBudget } = this._ollamaClient.buildContext(
            limitedFiles,
            formattedHistory,
            resolvedModel,
            resolvedUrl || undefined
        );

        const projectSummary = this._fileCtxManager.getProjectSummary();
        const workspaceTree = await this._fileCtxManager.getWorkspaceTree();
        const treeStr = workspaceTree.slice(0, 100).join('\n');

        const thinkPrefix = (thinkMode || this._thinkMode)
            ? 'MODE RÉFLEXION ACTIVÉ : Commence par un bloc [PLAN] listant TOUTES les modifications que tu prévois de faire (fichiers, fonctions, raisons), puis [/PLAN]. Ensuite seulement, fournis le code.\n\n'
            : '';

        const fullContext = [
            projectSummary ? `[MÉMOIRE PROJET]\n${projectSummary}` : '',
            '[STRUCTURE]',
            treeStr,
            '',
            '[HISTORIQUE RÉCENT]',
            formattedHistory,
            '',
            '[FICHIERS EN CONTEXTE]',
            context
        ].filter(Boolean).join('\n');

        const finalPrompt = thinkPrefix + userMsg;

        this._history.push({ role: 'user', value: userMsg });
        this._updateHistory();
        this._view.webview.postMessage({ type: 'startResponse' });
        this._view.webview.postMessage({
            type: 'tokenBudget',
            used: estimateTokens(fullContext + finalPrompt),
            max: Math.floor(budget.max / 4),
            isCloud
        });

        try {
            let fullRes = '';
            await this._ollamaClient.generateStreamingResponse(
                finalPrompt,
                fullContext,
                (chunk) => {
                    fullRes += chunk;
                    this._view?.webview.postMessage({ type: 'partialResponse', value: chunk });
                },
                resolvedModel,
                resolvedUrl || undefined
            );

            this._history.push({ role: 'ai', value: fullRes });
            this._updateHistory();
            this._view.webview.postMessage({ type: 'endResponse', value: fullRes });

            if (activeFile) {
                const fileHist = this._fileCtxManager.getFileHistory(activeFile.name);
                fileHist.push({ role: 'user', value: userMsg });
                fileHist.push({ role: 'ai', value: fullRes });
                await this._fileCtxManager.saveFileHistory(activeFile.name, fileHist);
            }

            await this._processAiResponse(fullRes);

        } catch (e: any) {
            const msg = e?.message ?? String(e);
            vscode.window.showErrorMessage(`Antigravity: ${msg}`);
            this._view.webview.postMessage({ type: 'endResponse', value: `**Erreur**: ${msg}` });
        }
    }

    private async _processAiResponse(response: string) {
        const parsed = parseAiResponse(response);

        for (const filePath of parsed.needFiles) {
            const file = await this._fileCtxManager.handleAiFileRequest(filePath);
            if (file) {
                this.addFilesToContext([{ ...file, isActive: false }]);
                this._view?.webview.postMessage({
                    type: 'statusMessage',
                    value: `📁 Fichier "${file.name}" ajouté au contexte IA.`
                });
            }
        }

        for (const cf of parsed.createFiles) {
            const answer = await vscode.window.showInformationMessage(
                `L'IA veut créer : "${cf.name}". Confirmer ?`,
                '✅ Créer', '❌ Ignorer'
            );
            if (answer === '✅ Créer') {
                await this._handleFileCreation(cf.name, cf.content);
            }
        }

        if (parsed.projectSummary) {
            await this._fileCtxManager.saveProjectSummary(parsed.projectSummary);
            vscode.window.showInformationMessage('✅ Mémoire du projet mise à jour par l\'IA.');
        }

        if (parsed.plan) {
            this._view?.webview.postMessage({ type: 'showPlan', plan: parsed.plan });
        }
        const multiPatches = extractMultiFilePatches(response);
        if (multiPatches.size > 1) {
            const fileList = Array.from(multiPatches.keys()).join(', ');
            const answer = await vscode.window.showInformationMessage(
                `L'IA propose des modifications sur ${multiPatches.size} fichiers : ${fileList}`,
                '📋 Appliquer tout', '👁 Voir fichier par fichier', '❌ Ignorer'
            );

            if (answer === '📋 Appliquer tout') {
                await this._handleMultiFileApply(
                    Array.from(multiPatches.entries()).map(([name, patch]) => ({ name, patch }))
                );
            } else if (answer === '👁 Voir fichier par fichier') {
                for (const [fileName, patch] of multiPatches) {
                    await this._handleApplyEdit(patch, fileName);
                }
            }
        }
    }

    private async _handleMultiFileApply(patches: Array<{ name: string; patch: string }>) {
        let applied = 0;
        for (const { name, patch } of patches) {
            try {
                await this._handleApplyEdit(patch, name);
                applied++;
            } catch (e: any) {
                vscode.window.showErrorMessage(`Erreur sur ${name}: ${e.message}`);
            }
        }
        if (applied > 0) {
            vscode.window.showInformationMessage(`✅ ${applied} fichier(s) modifié(s) avec succès.`);
        }
    }

    private async _handleAddRelatedFiles() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Aucun fichier actif.');
            return;
        }
        const isCloud = this._ollamaClient.isCloud(this._currentUrl || undefined);
        const maxChars = isCloud ? 40000 : 8000;
        const related = await this._fileCtxManager.getRelatedFiles(editor.document, maxChars);

        if (related.length === 0) {
            vscode.window.showInformationMessage('Aucun import local détecté dans ce fichier.');
            return;
        }

        this.addFilesToContext(related);
        this._view?.webview.postMessage({
            type: 'statusMessage',
            value: `🔗 ${related.length} fichier(s) lié(s) ajouté(s) : ${related.map(f => f.name).join(', ')}`
        });
    }

    private async _handleCloudConnection() {
        const config = vscode.workspace.getConfiguration('local-ai');
        const apiKeys: Array<{ name: string; key: string; url: string; expiresAt?: number }> =
            config.get<any[]>('apiKeys') || [];

        interface QuickPickItemWithKey extends vscode.QuickPickItem {
            keyEntry?: { name: string; key: string; url: string; expiresAt?: number };
        }

        const now = Date.now();
        const items: QuickPickItemWithKey[] = [
            ...apiKeys.map(k => ({
                label: `☁️  ${k.name}`,
                description: k.url,
                detail: k.expiresAt
                    ? (k.expiresAt < now ? '⚠️ Clé expirée' : `Expire ${new Date(k.expiresAt).toLocaleDateString()}`)
                    : undefined,
                keyEntry: k
            })),
            { label: '$(add) Ajouter une clé API Cloud', description: 'Configurer un nouveau provider' }
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: 'Connexion Cloud',
            placeHolder: 'Sélectionner un compte ou en ajouter un'
        });
        if (!picked) return;

        if (picked.keyEntry) {
            await this._updateModelsList(picked.keyEntry.url, picked.keyEntry.key);
        } else {
            const name = await vscode.window.showInputBox({ prompt: 'Nom du provider (ex: OpenAI, Mistral…)' });
            if (!name) return;
            const url = await vscode.window.showInputBox({
                prompt: "URL de base de l'API",
                value: 'https://api.openai.com/v1'
            });
            if (!url) return;
            const key = await vscode.window.showInputBox({ prompt: 'Clé API', password: true });
            if (!key) return;

            const updated = [...apiKeys, { name, url, key }];
            await config.update('apiKeys', updated, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`✅ Provider "${name}" ajouté.`);
            await this._updateModelsList(url, key);
        }
    }

    private async _updateModelsList(cloudUrl?: string, cloudKey?: string) {
        if (!this._view) return;

        try {
            const allModels = await this._ollamaClient.listAllModels();
            const formattedModels: Array<{
                label: string; value: string; name: string; url: string; isLocal: boolean;
            }> = allModels.map(m => ({
                label: m.isLocal ? `⚡ ${m.name}` : `☁️  ${m.name}`,
                value: m.isLocal ? m.name : `${m.url}||${m.name}`,
                name: m.name,
                url: m.url,
                isLocal: m.isLocal
            }));

            const config = vscode.workspace.getConfiguration('local-ai');
            const savedKeys: Array<{ name: string; key: string; url: string }> =
                config.get<any[]>('apiKeys') || [];

            const providersToFetch = [...savedKeys];
            if (cloudUrl && cloudKey && !providersToFetch.find(k => k.url === cloudUrl)) {
                providersToFetch.push({ name: 'Cloud', url: cloudUrl, key: cloudKey });
            }

            for (const provider of providersToFetch) {
                try {
                    const isOpenAI = provider.url.includes('together') || provider.url.includes('openrouter') || provider.url.endsWith('/v1');
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
                        cloudList.forEach(m => {
                            const val = `${provider.url}||${m}`;
                            if (!formattedModels.find(x => x.value === val)) {
                                formattedModels.push({
                                    label: `☁️  ${m}`,
                                    value: val,
                                    name: m,
                                    url: provider.url,
                                    isLocal: false
                                });
                            }
                        });
                    }
                } catch { }
            }

            const lastSelected = this._context.workspaceState.get<string>('lastSelectedModel');
            let selected = formattedModels.length > 0 ? formattedModels[0].value : '';
            if (lastSelected && formattedModels.find(m => m.value === lastSelected)) selected = lastSelected;

            this._view.webview.postMessage({ type: 'setModels', models: formattedModels, selected });
        } catch {
            this._view.webview.postMessage({ type: 'setModels', models: [], selected: '' });
        }
    }

    private _sendTokenBudget() {
        if (!this._view) return;
        const isCloud = this._ollamaClient.isCloud(this._currentUrl || undefined);
        const budget = this._ollamaClient.getTokenBudget(this._currentModel || 'llama3', this._currentUrl || undefined);
        const usedChars = this._contextFiles.reduce((sum, f) => sum + f.content.length, 0);
        this._view.webview.postMessage({
            type: 'tokenBudget',
            used: estimateTokens(usedChars.toString()),
            max: Math.floor(budget.max / 4),
            isCloud
        });
    }

    private _updateHistory() {
        this._context.workspaceState.update('chatHistory', this._history);
    }

    private _getFormattedHistory(): string {
        return this._history
            .slice(-10)
            .map(m => `${m.role}: ${m.value.substring(0, 300)}`)
            .join('\n');
    }

    private async _handleFileCreation(fileName: string, content: string) {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = vscode.Uri.file(path.join(folder, fileName));
        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            await vscode.window.showTextDocument(uri);
            vscode.window.showInformationMessage(`✅ Fichier créé : ${fileName}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Erreur création : ${e.message}`);
        }
    }

    private async _handleFileAccessRequest(target: string) {
        if (target === 'env' || target === '.env') {
            const file = await this._fileCtxManager.handleAiFileRequest('.env');
            if (file) {
                this._view?.webview.postMessage({ type: 'fileContent', name: file.name, content: file.content });
            }
        } else {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, openLabel: 'Ajouter au contexte' });
            if (uris?.[0]) {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                const name = vscode.workspace.asRelativePath(uris[0]);
                const cf: ContextFile = { name, content: content.toString(), isActive: false };
                this._contextFiles.push(cf);
                this._view?.webview.postMessage({ type: 'fileContent', name, content: content.toString() });
                this._sendTokenBudget();
            }
        }
    }

    private async _handleApplyEdit(code: string, targetFile?: string) {
        let uri: vscode.Uri | undefined;
        if (targetFile) {
            const clean = targetFile.replace(/\[FILE:|\]/g, '').trim();
            const files = await vscode.workspace.findFiles(`**/${clean}`, '**/node_modules/**', 1);
            if (files[0]) { uri = files[0]; }
        }
        if (!uri) { uri = vscode.window.activeTextEditor?.document.uri; }
        if (!uri) {
            vscode.window.showWarningMessage('Aucun fichier actif pour appliquer le patch.');
            return;
        }

        const doc = await vscode.workspace.openTextDocument(uri);
        const oldText = doc.getText();
        const hasMarkers = /SEARCH/.test(code);
        let previewText = code;
        let patchCount = 0;

        if (hasMarkers) {
            const res = applySearchReplace(oldText, code);
            previewText = res.result;
            patchCount = res.patchCount;
            res.errors.forEach(e => vscode.window.showWarningMessage(e));
        }

        const previewUri = vscode.Uri.parse(
            `${AiPreviewProvider.scheme}://patch/${encodeURIComponent(path.basename(uri.fsPath))}`
        );
        ChatViewProvider._previewProvider.set(previewUri, previewText);

        const diffTitle = `Review: ${path.basename(uri.fsPath)} (${patchCount > 0 ? `${patchCount} modification(s)` : 'Proposition'})`;
        await vscode.commands.executeCommand('vscode.diff', uri, previewUri, diffTitle);

        const result = await vscode.window.showInformationMessage(
            patchCount > 0
                ? `Appliquer ${patchCount} modification(s) à "${path.basename(uri.fsPath)}" ?`
                : `Aucune modification SEARCH/REPLACE trouvée. Remplacer tout le fichier ?`,
            { modal: false },
            '✅ Accepter', '❌ Rejeter'
        );

        ChatViewProvider._previewProvider.delete(previewUri);

        if (result === '✅ Accepter') {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.lineAt(0).range.start,
                doc.lineAt(doc.lineCount - 1).range.end
            );
            edit.replace(doc.uri, fullRange, previewText);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            const editor = await vscode.window.showTextDocument(doc);
            this._highlightChangedLines(editor, oldText, previewText);
            vscode.window.showInformationMessage(
                `✅ ${patchCount > 0 ? `${patchCount} patch(s) appliqué(s)` : 'Fichier remplacé'} et sauvegardé !`
            );
        }
    }

    private _highlightChangedLines(editor: vscode.TextEditor, oldText: string, newText: string) {
        const oldLines = oldText.split('\n');
        const newLines = newText.split('\n');
        const changedRanges: vscode.Range[] = [];

        for (let i = 0; i < newLines.length; i++) {
            if (newLines[i] !== oldLines[i] && i < editor.document.lineCount) {
                changedRanges.push(editor.document.lineAt(i).range);
            }
        }
        if (changedRanges.length === 0) return;

        const dec = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 120, 0.12)',
            isWholeLine: true,
            borderWidth: '0 0 0 3px',
            borderStyle: 'solid',
            borderColor: 'rgba(0, 255, 120, 0.5)'
        });
        editor.setDecorations(dec, changedRanges);
        setTimeout(() => dec.dispose(), 4000);
    }

    private async _handleOpenFile(fp: string) {
        const files = await vscode.workspace.findFiles(`**/${fp}`, '**/node_modules/**', 1);
        if (files[0]) {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(files[0]));
        } else {
            vscode.window.showErrorMessage(`Fichier introuvable : ${fp}`);
        }
    }

    private async _handleRunCommand(cmd: string) {
        const answer = await vscode.window.showInformationMessage(
            `Exécuter : ${cmd}`, '🚀 Exécuter', 'Annuler'
        );
        if (answer === '🚀 Exécuter') {
            const t = vscode.window.activeTerminal ?? vscode.window.createTerminal('Antigravity AI');
            t.show();
            t.sendText(cmd);
        }
    }

    private async _handleGenerateCommitMessage() {
        const diff = await this._fileCtxManager.getStagedDiffForCommit();
        if (!diff) {
            vscode.window.showWarningMessage('Aucun fichier stagé. Faites d\'abord un `git add`.');
            return;
        }
        this.sendMessageFromEditor(
            `Génère un message de commit conventionnel (feat/fix/refactor/chore/docs/test) pour ce diff stagé. Réponds UNIQUEMENT avec le message de commit, sans explications :\n\`\`\`diff\n${diff.substring(0, 6000)}\n\`\`\``
        );
    }

    private async _handleReviewDiff() {
        const diff = await this._fileCtxManager.getGitDiff(false);
        if (!diff) {
            vscode.window.showWarningMessage('Aucune modification Git trouvée.');
            return;
        }
        this.sendMessageFromEditor(
            `Revois ce diff Git. Identifie : bugs potentiels, problèmes de sécurité, mauvaises pratiques, oublis.\n\`\`\`diff\n${diff.substring(0, 8000)}\n\`\`\``
        );
    }

    private async _handleGenerateTests() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Aucun fichier actif.'); return; }
        const fileName = path.basename(editor.document.fileName, path.extname(editor.document.fileName));
        const ext = path.extname(editor.document.fileName);
        this.sendMessageFromEditor(
            `Génère des tests unitaires complets pour le fichier actif. Crée le fichier [CREATE_FILE: ${fileName}.test${ext}] avec des cas de test couvrant les cas normaux, les cas limites, et les cas d'erreur. Utilise le framework de test approprié au projet.`
        );
    }

    private async _handleUpdateProjectSummary() {
        this.sendMessageFromEditor(
            `Génère un résumé technique de ce projet en 200-300 mots. Inclus : technos principales, architecture, rôle des dossiers clés, patterns utilisés. Encadre ta réponse avec [PROJECT_SUMMARY] et [/PROJECT_SUMMARY].`
        );
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const bgUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'background.png')
        );
        const cspSource = webview.cspSource;

        const script: string = [
            "const vscode = acquireVsCodeApi();",
            "const chat = document.getElementById('chat');",
            "const prompt = document.getElementById('prompt');",
            "const send = document.getElementById('send');",
            "const modelSelect = document.getElementById('modelSelect');",
            "const filesBar = document.getElementById('filesBar');",
            "const tokenBar = document.getElementById('tokenBar');",
            "let contextFiles = [];",
            "let currentAiMsg = null;",
            "let currentAiText = '';",
            "let thinkModeActive = false;",
            "",
            "// ─── Auto-resize textarea ───",
            "prompt.addEventListener('input', function() {",
            "    prompt.style.height = 'auto';",
            "    prompt.style.height = Math.min(prompt.scrollHeight, 120) + 'px';",
            "});",
            "",
            "// ─── Context file management ───",
            "function addContextFile(name, content) {",
            "    if (contextFiles.find(function(f) { return f.name === name; })) return;",
            "    contextFiles.push({ name: name, content: content });",
            "    renderFilesBar();",
            "    vscode.postMessage({ type: 'getTokenBudget' });",
            "}",
            "",
            "function renderFilesBar() {",
            "    if (contextFiles.length === 0) { filesBar.style.display = 'none'; return; }",
            "    filesBar.style.display = 'flex';",
            "    filesBar.innerHTML = '<span style=\"color:#666;margin-right:4px;\">📁</span>' +",
            "        contextFiles.map(function(f, i) {",
            "            var tokens = Math.ceil(f.content.length / 4);",
            "            return '<span class=\"file-tag\" data-idx=\"'+i+'\" title=\"'+tokens+' tokens\">'+f.name+' <span style=\"color:#888;font-size:10px\">('+tokens+'t)</span> ×</span>';",
            "        }).join('') +",
            "        '<button class=\"file-tag btn-clear-files\" onclick=\"clearAllFiles()\" style=\"color:#ff6b6b;border-color:#ff6b6b;\">Vider</button>';",
            "    filesBar.querySelectorAll('.file-tag[data-idx]').forEach(function(el) {",
            "        el.onclick = function() {",
            "            var idx = parseInt(el.getAttribute('data-idx'));",
            "            vscode.postMessage({ type: 'removeContextFile', name: contextFiles[idx].name });",
            "            contextFiles.splice(idx, 1);",
            "            renderFilesBar();",
            "        };",
            "    });",
            "}",
            "",
            "function clearAllFiles() {",
            "    contextFiles.forEach(function(f) { vscode.postMessage({ type: 'removeContextFile', name: f.name }); });",
            "    contextFiles = [];",
            "    renderFilesBar();",
            "}",
            "",
            "// ─── Token budget bar ───",
            "function updateTokenBar(used, max, isCloud) {",
            "    var pct = Math.min(100, Math.round(used / max * 100));",
            "    var color = pct > 85 ? '#ff6b6b' : pct > 60 ? '#ffaa00' : '#00d2ff';",
            "    var icon = isCloud ? '☁️' : '⚡';",
            "    tokenBar.innerHTML = '<span style=\"color:#666;font-size:10px\">' + icon + ' Tokens : ' +",
            "        '<span style=\"color:' + color + '\">' + used + '</span>/' + max +",
            "        ' <div style=\"display:inline-block;width:60px;height:4px;background:#222;border-radius:2px;vertical-align:middle;margin-left:4px;\">'+",
            "        '<div style=\"width:' + pct + '%;height:100%;background:' + color + ';border-radius:2px;\"></div></div>' +",
            "        (pct > 85 ? ' ⚠️ Contexte saturé' : '') + '</span>';",
            "    tokenBar.style.display = 'block';",
            "}",
            "",
            "// ─── Message helpers ───",
            "function addMsg(txt, cls, isHtml) {",
            "    var d = document.createElement('div');",
            "    d.className = 'msg ' + cls;",
            "    if (isHtml) { d.innerHTML = txt; } else { d.innerText = txt; }",
            "    chat.appendChild(d);",
            "    chat.scrollTop = chat.scrollHeight;",
            "    return d;",
            "}",
            "",
            "function addStatusMsg(txt) {",
            "    var d = document.createElement('div');",
            "    d.className = 'status-msg';",
            "    d.innerText = txt;",
            "    chat.appendChild(d);",
            "    chat.scrollTop = chat.scrollHeight;",
            "    setTimeout(function() { d.remove(); }, 5000);",
            "}",
            "",
            "function escapeHtml(t) {",
            "    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');",
            "}",
            "",
            "// ─── Code registry ───",
            "window._codeRegistry = [];",
            "function _registerCode(content) {",
            "    window._codeRegistry.push(content);",
            "    return window._codeRegistry.length - 1;",
            "}",
            "",
            "// ─── Markdown renderer ───",
            "function renderMarkdown(text) {",
            "    var html = '';",
            "    // Strip [PLAN]...[/PLAN] blocks — shown separately",
            "    text = text.replace(/\\[PLAN\\][\\s\\S]*?\\[\\/PLAN\\]/g, '');",
            "    text = text.replace(/\\[PROJECT_SUMMARY\\][\\s\\S]*?\\[\\/PROJECT_SUMMARY\\]/g, '');",
            "    // Strip [NEED_FILE:...] and [WILL_MODIFY:...] tags",
            "    text = text.replace(/\\[NEED_FILE:[^\\]]+\\]/g, '');",
            "    text = text.replace(/\\[WILL_MODIFY:[^\\]]+\\]/g, '');",
            "    // Code blocks with [FILE: name] support",
            "    text = text.replace(/\\[FILE:\\s*([^\\]]+)\\]\\s*```(\\w+)?\\n([\\s\\S]*?)```/g, function(_, fname, lang, code) {",
            "        var idx = _registerCode(code);",
            "        var fidx = _registerCode(fname);",
            "        return '<div class=\"code-block patch\"><div class=\"code-header\"><span>📄 '+escapeHtml(fname)+'</span>" +
            "            <button onclick=\"applyFilePatch('+idx+','+fidx+')\">✅ Appliquer</button></div>" +
            "            <div class=\"code-content\">'+escapeHtml(code)+'</div></div>';",
            "    });",
            "    // Regular code blocks",
            "    text = text.replace(/```(\\w+)?\\n([\\s\\S]*?)```/g, function(_, lang, code) {",
            "        var idx = _registerCode(code);",
            "        var isPatch = /SEARCH/.test(code);",
            "        var cls = isPatch ? 'patch' : '';",
            "        var btns = '<button onclick=\"applyCode('+idx+')\">✅ Appliquer</button>';",
            "        if (isPatch) btns += ' <button onclick=\"copyCode('+idx+')\">📋 Copier</button>';",
            "        else btns = '<button onclick=\"copyCode('+idx+')\">📋 Copier</button> ' + btns;",
            "        return '<div class=\"code-block '+cls+'\"><div class=\"code-header\"><span>'+(lang||'code')+'</span>'+btns+'</div><div class=\"code-content\">'+escapeHtml(code)+'</div></div>';",
            "    });",
            "    // Inline formatting",
            "    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');",
            "    text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');",
            "    text = text.replace(/\\*([^*]+)\\*/g, '<i>$1</i>');",
            "    // Paragraphs",
            "    var paras = text.split('\\n\\n');",
            "    html = paras.map(function(p) {",
            "        p = p.trim();",
            "        if (!p) return '';",
            "        if (p.startsWith('<div')) return p;",
            "        p = p.replace(/\\n/g, '<br>');",
            "        return '<p>' + p + '</p>';",
            "    }).join('');",
            "    return html;",
            "}",
            "",
            "function applyCode(idx) {",
            "    vscode.postMessage({ type: 'applyToActiveFile', value: window._codeRegistry[idx] });",
            "}",
            "function applyFilePatch(codeIdx, fileIdx) {",
            "    var code = window._codeRegistry[codeIdx];",
            "    var fname = window._codeRegistry[fileIdx];",
            "    vscode.postMessage({ type: 'applyToActiveFile', value: code, targetFile: fname });",
            "}",
            "function copyCode(idx) {",
            "    navigator.clipboard.writeText(window._codeRegistry[idx]);",
            "}",
            "",
            "// ─── Send message ───",
            "function sendMessage() {",
            "    var val = prompt.value.trim();",
            "    if (!val) return;",
            "    addMsg(val, 'user', false);",
            "    var selectedOpt = modelSelect.options[modelSelect.selectedIndex];",
            "    var modelVal = modelSelect.value;",
            "    var modelUrl = selectedOpt ? (selectedOpt.getAttribute('data-url') || '') : '';",
            "    vscode.postMessage({",
            "        type: 'sendMessage',",
            "        value: val,",
            "        model: modelVal,",
            "        url: modelUrl,",
            "        contextFiles: contextFiles,",
            "        thinkMode: thinkModeActive",
            "    });",
            "    prompt.value = '';",
            "    prompt.style.height = 'auto';",
            "}",
            "",
            "send.onclick = sendMessage;",
            "prompt.addEventListener('keydown', function(e) {",
            "    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }",
            "});",
            "",
            "// ─── Action buttons ───",
            "document.getElementById('btnAddFile').onclick = function() {",
            "    vscode.postMessage({ type: 'requestFileAccess', target: 'picker' });",
            "};",
            "document.getElementById('btnRelatedFiles').onclick = function() {",
            "    vscode.postMessage({ type: 'addRelatedFiles' });",
            "};",
            "document.getElementById('btnThink').onclick = function() {",
            "    vscode.postMessage({ type: 'toggleThinkMode' });",
            "};",
            "document.getElementById('btnCloud').onclick = function() {",
            "    vscode.postMessage({ type: 'openCloudConnect' });",
            "};",
            "document.getElementById('btnClearHistory').onclick = function() {",
            "    if (confirm('Effacer l\\'historique ?')) {",
            "        vscode.postMessage({ type: 'clearHistory' });",
            "        chat.innerHTML = '';",
            "    }",
            "};",
            "document.getElementById('btnGitReview').onclick = function() {",
            "    vscode.postMessage({ type: 'reviewDiff' });",
            "};",
            "document.getElementById('btnCommit').onclick = function() {",
            "    vscode.postMessage({ type: 'generateCommitMessage' });",
            "};",
            "document.getElementById('btnTests').onclick = function() {",
            "    vscode.postMessage({ type: 'generateTests' });",
            "};",
            "document.getElementById('btnError').onclick = function() {",
            "    var err = prompt.value.trim();",
            "    if (!err) {",
            "        var inp = window.prompt('Coller votre erreur / stack trace :');",
            "        if (!inp) return;",
            "        err = inp;",
            "    }",
            "    vscode.postMessage({ type: 'analyzeError', value: err });",
            "    prompt.value = '';",
            "};",
            "",
            "// ─── Model select ───",
            "function updateSelectColor() {",
            "    var opt = modelSelect.options[modelSelect.selectedIndex];",
            "    if (!opt) return;",
            "    var isLocal = !opt.getAttribute('data-url') || opt.getAttribute('data-url') === 'http://localhost:11434';",
            "    modelSelect.style.color = isLocal ? '#b19cd9' : '#00d2ff';",
            "    var warn = document.getElementById('localWarn');",
            "    if (!opt.value) {",
            "        warn.className = 'offline'; warn.innerHTML = '⚠️ Ollama hors ligne'; warn.style.display = 'block';",
            "    } else if (isLocal) {",
            "        warn.className = 'local'; warn.innerHTML = '⚡ <b>Mode Local</b> &mdash; ' + (opt.getAttribute('data-name') || '');",
            "        warn.style.display = 'block';",
            "    } else {",
            "        warn.className = 'cloud'; warn.innerHTML = '☁️ <b>Mode Cloud</b> &mdash; ' + (opt.getAttribute('data-name') || '');",
            "        warn.style.display = 'block';",
            "    }",
            "    vscode.postMessage({ type: 'getTokenBudget' });",
            "}",
            "modelSelect.onchange = function() {",
            "    updateSelectColor();",
            "    vscode.postMessage({ type: 'saveModel', model: modelSelect.value });",
            "};",
            "",
            "// ─── Message handler ───",
            "window.addEventListener('message', function(e) {",
            "    var m = e.data;",
            "    if (m.type === 'setModels') {",
            "        modelSelect.innerHTML = m.models && m.models.length > 0",
            "            ? m.models.map(function(x) {",
            "                var color = x.isLocal ? '#b19cd9' : '#00d2ff';",
            "                var sel = x.value === m.selected ? 'selected' : '';",
            "                return '<option value=\"'+x.value+'\" data-name=\"'+x.name+'\" data-url=\"'+x.url+'\" style=\"color:'+color+'\" '+sel+'>'+x.label+'</option>';",
            "              }).join('')",
            "            : '<option value=\"\" data-name=\"\" data-url=\"\" style=\"color:#ff6b6b\">⚠️ Ollama hors ligne</option>';",
            "        updateSelectColor();",
            "    }",
            "    if (m.type === 'startResponse') {",
            "        currentAiMsg = document.createElement('div');",
            "        currentAiMsg.className = 'msg ai';",
            "        currentAiMsg.innerHTML = '<div class=\"thinking\"><span></span><span></span><span></span></div>';",
            "        chat.appendChild(currentAiMsg);",
            "        chat.scrollTop = chat.scrollHeight;",
            "        currentAiText = '';",
            "    }",
            "    if (m.type === 'partialResponse') {",
            "        if (!currentAiMsg) { currentAiMsg = addMsg('', 'ai', true); }",
            "        currentAiText += m.value;",
            "        currentAiMsg.innerHTML = renderMarkdown(currentAiText);",
            "        chat.scrollTop = chat.scrollHeight;",
            "    }",
            "    if (m.type === 'endResponse') {",
            "        var finalText = m.value || currentAiText;",
            "        if (currentAiMsg) { currentAiMsg.innerHTML = renderMarkdown(finalText); }",
            "        else { addMsg(renderMarkdown(finalText), 'ai', true); }",
            "        currentAiMsg = null; currentAiText = '';",
            "    }",
            "    if (m.type === 'fileContent') { addContextFile(m.name, m.content); }",
            "    if (m.type === 'injectMessage') { prompt.value = m.value; prompt.focus(); }",
            "    if (m.type === 'restoreHistory' && m.history) {",
            "        m.history.forEach(function(msg) {",
            "            addMsg(msg.role === 'ai' ? renderMarkdown(msg.value) : msg.value, msg.role, msg.role === 'ai');",
            "        });",
            "    }",
            "    if (m.type === 'statusMessage') { addStatusMsg(m.value); }",
            "    if (m.type === 'thinkModeChanged') {",
            "        thinkModeActive = m.active;",
            "        var btn = document.getElementById('btnThink');",
            "        btn.style.background = m.active ? 'rgba(160,0,255,0.25)' : '';",
            "        btn.style.borderColor = m.active ? '#a000ff' : '';",
            "        btn.style.color = m.active ? '#cc88ff' : '';",
            "        btn.title = m.active ? 'Mode Réflexion ACTIF (cliquer pour désactiver)' : 'Activer le Mode Réflexion';",
            "    }",
            "    if (m.type === 'tokenBudget') { updateTokenBar(m.used, m.max, m.isCloud); }",
            "    if (m.type === 'showPlan') {",
            "        var planEl = document.createElement('div');",
            "        planEl.className = 'msg plan-msg';",
            "        planEl.innerHTML = '<b>🧠 Plan de l\\'IA :</b><br>' + escapeHtml(m.plan).replace(/\\n/g,'<br>');",
            "        chat.appendChild(planEl);",
            "        chat.scrollTop = chat.scrollHeight;",
            "    }",
            "    if (m.type === 'updateContextFiles') {",
            "        // Sync context files from backend (e.g. auto-detected related files)",
            "        m.files.forEach(function(f) {",
            "            if (!contextFiles.find(function(cf) { return cf.name === f.name; })) {",
            "                contextFiles.push({ name: f.name, content: '...', tokens: f.tokens });",
            "            }",
            "        });",
            "        renderFilesBar();",
            "    }",
            "});",
            "",
            "vscode.postMessage({ type: 'getModels' });",
            "vscode.postMessage({ type: 'restoreHistory' });",
            "vscode.postMessage({ type: 'getTokenBudget' });"
        ].join("\n");

        return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline';">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&family=Fira+Code&display=swap');
        * { box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: #000; color: #e0e0e0; margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; font-size: 13px; }
        .space-bg { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: url('${bgUri}') no-repeat center center; background-size: cover; filter: brightness(0.35); z-index: -1; }
        .header { padding: 8px 12px; background: rgba(5,5,15,0.92); display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0,210,255,0.2); flex-shrink: 0; }
        .header-brand { font-weight: 900; letter-spacing: 2px; font-size: 14px; color: #fff; text-shadow: 0 0 10px rgba(0,210,255,0.5); }
        .header-controls { display: flex; gap: 6px; align-items: center; }
        .btn-cloud { background: none; border: 1px solid #00d2ff; color: #00d2ff; padding: 4px 10px; font-size: 11px; border-radius: 20px; cursor: pointer; font-weight: 700; transition: all 0.2s; }
        .btn-cloud:hover { background: rgba(0,210,255,0.15); }
        select#modelSelect { max-width: 150px; padding: 4px 6px; border-radius: 20px; background: #0a0a1a; border: 1px solid #444; outline: none; font-size: 11px; color: #00d2ff; cursor: pointer; }
        #localWarn { display: none; padding: 4px 12px; font-size: 11px; text-align: center; border-bottom: 1px solid; flex-shrink: 0; }
        #localWarn.local { background: rgba(177,156,217,0.12); color: #c9a9f5; border-color: rgba(177,156,217,0.25); }
        #localWarn.cloud { background: rgba(0,210,255,0.08); color: #00d2ff; border-color: rgba(0,210,255,0.2); }
        #localWarn.offline { background: rgba(255,80,80,0.1); color: #ff6b6b; border-color: rgba(255,80,80,0.25); }
        #tokenBar { display: none; padding: 3px 12px; background: rgba(0,0,0,0.4); border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
        #filesBar { display: none; background: rgba(0,122,204,0.1); padding: 5px 12px; font-size: 11px; color: #aaa; border-bottom: 1px solid rgba(0,122,204,0.2); flex-direction: row; gap: 6px; align-items: center; overflow-x: auto; white-space: nowrap; flex-shrink: 0; }
        #filesBar .file-tag { background: rgba(0,122,204,0.25); color: #6cb6ff; border: 1px solid rgba(0,122,204,0.4); padding: 2px 8px; border-radius: 10px; cursor: pointer; font-size: 11px; transition: background 0.2s; }
        #filesBar .file-tag:hover { background: rgba(0,122,204,0.5); }
        #chat { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
        #chat::-webkit-scrollbar { width: 4px; } #chat::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        .msg { padding: 10px 14px; border-radius: 12px; max-width: 95%; line-height: 1.6; word-break: break-word; }
        .user { background: rgba(0,80,200,0.35); align-self: flex-end; border: 1px solid rgba(0,120,255,0.3); border-bottom-right-radius: 2px; white-space: pre-wrap; }
        .ai { background: rgba(15,15,30,0.9); align-self: flex-start; width: 100%; border: 1px solid rgba(255,255,255,0.07); border-bottom-left-radius: 2px; }
        .ai p { margin: 6px 0; }
        .ai b { color: #fff; }
        .ai code { background: #1a1a2e; color: #00d2ff; padding: 2px 5px; border-radius: 4px; font-family: 'Fira Code', monospace; font-size: 11px; }
        .plan-msg { background: rgba(120,0,255,0.12); border: 1px solid rgba(160,0,255,0.3); border-radius: 10px; padding: 10px 14px; align-self: flex-start; width: 100%; font-size: 12px; color: #cc88ff; }
        .status-msg { align-self: center; font-size: 11px; color: #888; padding: 4px 12px; background: rgba(255,255,255,0.05); border-radius: 20px; border: 1px solid #333; }
        .code-block { background: #0d0d1a; border: 1px solid #2a2a3a; border-radius: 8px; margin: 10px 0; overflow: hidden; }
        .code-header { background: #141424; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #888; border-bottom: 1px solid #2a2a3a; gap: 6px; }
        .code-header span { flex: 1; }
        .code-header button { padding: 4px 10px; font-size: 11px; background: #007acc; border-radius: 12px; cursor: pointer; border: none; color: #fff; font-weight: 700; transition: background 0.2s; white-space: nowrap; }
        .code-header button:hover { background: #0090e0; }
        .code-content { padding: 12px; font-family: 'Fira Code', monospace; font-size: 12px; color: #cdd; white-space: pre-wrap; overflow-x: auto; max-height: 400px; overflow-y: auto; }
        .code-block.patch { border-color: rgba(0,122,204,0.5); }
        .code-block.patch .code-header { background: rgba(0,60,120,0.4); color: #6cb6ff; border-color: rgba(0,122,204,0.3); }
        .input-area { padding: 10px 12px; background: rgba(5,5,15,0.92); display: flex; flex-direction: column; gap: 8px; border-top: 1px solid rgba(0,210,255,0.15); flex-shrink: 0; }
        .input-row { display: flex; gap: 8px; align-items: flex-end; }
        #prompt { flex: 1; background: rgba(20,20,40,0.8); color: #e0e0e0; border: 1px solid #333; padding: 10px 14px; border-radius: 22px; outline: none; font-family: 'Inter', sans-serif; font-size: 13px; resize: none; min-height: 40px; max-height: 120px; line-height: 1.4; transition: border-color 0.2s; }
        #prompt:focus { border-color: rgba(0,210,255,0.5); }
        #send { background: #007acc; color: #fff; border: none; padding: 10px 18px; border-radius: 22px; cursor: pointer; font-weight: 700; font-size: 13px; white-space: nowrap; transition: background 0.2s; }
        #send:hover { background: #0090e0; }
        .input-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .btn-action { background: rgba(255,255,255,0.06); color: #aaa; border: 1px solid #333; padding: 4px 10px; border-radius: 12px; cursor: pointer; font-size: 11px; transition: all 0.2s; white-space: nowrap; }
        .btn-action:hover { background: rgba(255,255,255,0.12); color: #fff; }
        .thinking { display: flex; gap: 4px; align-items: center; padding: 6px 0; }
        .thinking span { width: 6px; height: 6px; background: #00d2ff; border-radius: 50%; animation: bounce 1.2s infinite; }
        .thinking span:nth-child(2) { animation-delay: 0.2s; } .thinking span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-8px)} }
        button { font-family: 'Inter', sans-serif; }
    </style>
</head>
<body>
    <div class="space-bg"></div>
    <div class="header">
        <span class="header-brand">ANTIGRAVITY</span>
        <div class="header-controls">
            <button class="btn-cloud" id="btnCloud">☁️ Cloud</button>
            <select id="modelSelect"></select>
        </div>
    </div>
    <div id="localWarn"></div>
    <div id="tokenBar"></div>
    <div id="filesBar"></div>
    <div id="chat"></div>
    <div class="input-area">
        <div class="input-actions">
            <button class="btn-action" id="btnAddFile" title="Ajouter un fichier au contexte">📎 Fichier</button>
            <button class="btn-action" id="btnRelatedFiles" title="Ajouter les fichiers importés du fichier actif">🔗 Liés</button>
            <button class="btn-action" id="btnThink" title="Mode Réflexion : l'IA planifie avant d'agir">🧠 Réflexion</button>
            <button class="btn-action" id="btnError" title="Analyser une erreur avec détection auto de fichier">🐛 Erreur</button>
            <button class="btn-action" id="btnGitReview" title="Revue du diff Git actuel">📝 Diff</button>
            <button class="btn-action" id="btnCommit" title="Générer un message de commit">💾 Commit</button>
            <button class="btn-action" id="btnTests" title="Générer les tests du fichier actif">🧪 Tests</button>
            <button class="btn-action" id="btnClearHistory" title="Effacer l'historique">🗑 Vider</button>
        </div>
        <div class="input-row">
            <textarea id="prompt" placeholder="Posez une question… (Entrée pour envoyer, Shift+Entrée pour saut de ligne)" rows="1"></textarea>
            <button id="send">SEND</button>
        </div>
    </div>
    <script>${script}</script>
</body>
</html>`;
    }
}