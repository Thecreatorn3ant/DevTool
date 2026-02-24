import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { OllamaClient } from './ollamaClient';

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
    delete(uri: vscode.Uri) {
        this._content.delete(uri.toString());
    }
    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._content.get(uri.toString()) ?? '';
    }
}

function applySearchReplace(
    documentText: string,
    patchContent: string
): { result: string; patchCount: number; errors: string[] } {
    const errors: string[] = [];
    let patchCount = 0;

    const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
            } else {
                replaceLines.push(line);
            }
        }
    }
    if (state === 'replace' && searchLines.length > 0) {
        patches.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
    }

    if (patches.length === 0) {
        return { result: documentText, patchCount: 0, errors: [] };
    }

    let workingText = docNorm;

    for (const patch of patches) {
        const { search, replace } = patch;

        if (workingText.includes(search)) {
            workingText = workingText.replace(search, replace);
            patchCount++;
            continue;
        }

        const trimEnd = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n');
        const searchTrimmed = trimEnd(search);
        const workingTrimmed = trimEnd(workingText);
        if (workingTrimmed.includes(searchTrimmed)) {
            workingText = workingTrimmed.replace(searchTrimmed, replace);
            patchCount++;
            continue;
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
                    if (dl !== fuzzyLines[si]) { break; }
                    si++; di++;
                }
                if (si === fuzzyLines.length) {
                    const textToReplace = workingLines.slice(i, di).join('\n');
                    const count = workingText.split(textToReplace).length - 1;
                    if (count === 1) {
                        workingText = workingText.replace(textToReplace, replace);
                        patchCount++;
                        fuzzyMatched = true;
                    }
                    break;
                }
            }
        }

        if (!fuzzyMatched) {
            errors.push(`Bloc SEARCH introuvable : "${search.substring(0, 60)}..."`);
        }
    }

    return { result: workingText, patchCount, errors };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'local-ai.chatView';
    private _view?: vscode.WebviewView;
    private _history: ChatMessage[] = [];
    private static readonly _previewProvider = new AiPreviewProvider();
    private static _providerRegistered = false;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _ollamaClient: OllamaClient,
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
                case 'sendMessage': await this._handleSendMessage(data.value, data.model, data.url); break;
                case 'openCloudConnect': await this._handleCloudConnection(); break;
                case 'getModels': await this._updateModelsList(); break;
                case 'saveModel': await this._context.workspaceState.update('lastSelectedModel', data.model); break;
                case 'restoreHistory': webviewView.webview.postMessage({ type: 'restoreHistory', history: this._history }); break;
                case 'createFile': if (data.value && data.target) { await this._handleFileCreation(data.target, data.value); } break;
                case 'applyToActiveFile': if (data.value) { await this._handleApplyEdit(data.value, data.targetFile); } break;
                case 'requestFileAccess': if (data.target) { await this._handleFileAccessRequest(data.target); } break;
                case 'clearHistory': this._history = []; this._updateHistory(); break;
                case 'openFile': if (data.value) { await this._handleOpenFile(data.value); } break;
                case 'runCommand': if (data.value) { await this._handleRunCommand(data.value); } break;
            }
        });
    }

    public sendMessageFromEditor(message: string) {
        this._view?.webview.postMessage({ type: 'injectMessage', value: message });
    }

    private async _handleSendMessage(userMsg: string, model?: string, targetUrl?: string) {
        if (!userMsg || !this._view) { return; }

        let resolvedModel = model || '';
        let resolvedUrl = targetUrl || '';
        if (resolvedModel.includes('||')) {
            const parts = resolvedModel.split('||');
            resolvedUrl = parts[0];
            resolvedModel = parts[1];
        }

        this._history.push({ role: 'user', value: userMsg });
        this._updateHistory();
        this._view.webview.postMessage({ type: 'startResponse' });

        const workspaceFiles = await this._getWorkspaceFiles();
        let editor = vscode.window.activeTextEditor;
        if (!editor && vscode.window.visibleTextEditors.length > 0) {
            editor = vscode.window.visibleTextEditors[0];
        }

        let activeContext = '';
        if (editor && editor.document.uri.scheme === 'file') {
            const doc = editor.document;
            const fullText = doc.getText();
            const MAX_CHARS = 12000;
            const truncated = fullText.length > MAX_CHARS
                ? fullText.substring(0, MAX_CHARS) + '\n[... fichier tronqué ...]'
                : fullText;
            activeContext = `Fichier actif: ${vscode.workspace.asRelativePath(doc.fileName)}\nContenu:\n${truncated}`;
        }

        const fullContext = [
            '[STRUCTURE]',
            workspaceFiles.join('\n'),
            '',
            '[HISTORIQUE]',
            this._getFormattedHistory(),
            '',
            '[CONTEXTE]',
            activeContext
        ].join('\n');

        try {
            let fullRes = '';
            const response = await this._ollamaClient.generateStreamingResponse(
                userMsg,
                fullContext,
                (chunk) => {
                    fullRes += chunk;
                    this._view?.webview.postMessage({ type: 'partialResponse', value: chunk });
                },
                resolvedModel,
                resolvedUrl
            );
            const finalResponse = response || fullRes;
            this._history.push({ role: 'ai', value: finalResponse });
            this._updateHistory();
            this._view.webview.postMessage({ type: 'endResponse', value: finalResponse });
        } catch (e: any) {
            const msg = e?.message ?? String(e);
            vscode.window.showErrorMessage(`Antigravity: ${msg}`);
            this._view.webview.postMessage({ type: 'endResponse', value: `**Erreur**: ${msg}` });
        }
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

        if (!picked) { return; }

        if (picked.keyEntry) {
            await this._updateModelsList(picked.keyEntry.url, picked.keyEntry.key);
        } else {
            const name = await vscode.window.showInputBox({ prompt: 'Nom du provider (ex: OpenAI, Mistral…)' });
            if (!name) { return; }
            const url = await vscode.window.showInputBox({
                prompt: "URL de base de l'API",
                value: 'https://api.openai.com/v1'
            });
            if (!url) { return; }
            const key = await vscode.window.showInputBox({ prompt: 'Clé API', password: true });
            if (!key) { return; }

            const updated = [...apiKeys, { name, url, key }];
            await config.update('apiKeys', updated, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`✅ Provider "${name}" ajouté.`);
            await this._updateModelsList(url, key);
        }
    }

    private async _updateModelsList(cloudUrl?: string, cloudKey?: string) {
        if (!this._view) { return; }

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
                } catch { /* provider unreachable — skip silently */ }
            }

            const lastSelected = this._context.workspaceState.get<string>('lastSelectedModel');
            let selected = formattedModels.length > 0 ? formattedModels[0].value : '';
            if (lastSelected && formattedModels.find(m => m.value === lastSelected)) {
                selected = lastSelected;
            }

            this._view.webview.postMessage({ type: 'setModels', models: formattedModels, selected });
        } catch {
            this._view.webview.postMessage({ type: 'setModels', models: [], selected: '' });
        }
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
        if (target === '.env') {
            const files = await vscode.workspace.findFiles('**/.env');
            if (files.length > 0) {
                const content = await vscode.workspace.fs.readFile(files[0]);
                this._view?.webview.postMessage({ type: 'fileContent', name: '.env', content: content.toString() });
            } else {
                vscode.window.showErrorMessage('.env introuvable.');
            }
        } else {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, openLabel: 'Ajouter au contexte' });
            if (uris?.[0]) {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                this._view?.webview.postMessage({
                    type: 'fileContent',
                    name: path.basename(uris[0].fsPath),
                    content: content.toString()
                });
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
        if (changedRanges.length === 0) { return; }

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

    private async _getWorkspaceFiles(): Promise<string[]> {
        const files = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**}',
            200
        );
        return files.map(u => vscode.workspace.asRelativePath(u)).sort();
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
            "let contextFiles = [];",
            "let currentAiMsg = null;",
            "let currentAiText = '';",
            "",
            "prompt.addEventListener('input', function() {",
            "    prompt.style.height = 'auto';",
            "    prompt.style.height = Math.min(prompt.scrollHeight, 120) + 'px';",
            "});",
            "",
            "function addContextFile(name, content) {",
            "    if (contextFiles.find(function(f) { return f.name === name; })) { return; }",
            "    contextFiles.push({ name: name, content: content });",
            "    renderFilesBar();",
            "}",
            "",
            "function renderFilesBar() {",
            "    if (contextFiles.length === 0) { filesBar.style.display = 'none'; return; }",
            "    filesBar.style.display = 'flex';",
            "    filesBar.innerHTML = '<span style=\"color:#666;margin-right:4px;\">Contexte :</span>' +",
            "        contextFiles.map(function(f, i) {",
            "            return '<span class=\"file-tag\" data-idx=\"' + i + '\">' + f.name + ' \u2715</span>';",
            "        }).join('');",
            "    filesBar.querySelectorAll('.file-tag').forEach(function(el) {",
            "        el.onclick = function() {",
            "            contextFiles.splice(parseInt(el.getAttribute('data-idx')), 1);",
            "            renderFilesBar();",
            "        };",
            "    });",
            "}",
            "",
            "function addMsg(txt, cls, isHtml) {",
            "    var d = document.createElement('div');",
            "    d.className = 'msg ' + cls;",
            "    if (isHtml) { d.innerHTML = txt; } else { d.innerText = txt; }",
            "    chat.appendChild(d);",
            "    chat.scrollTop = chat.scrollHeight;",
            "    return d;",
            "}",
            "",
            "function escapeHtml(t) {",
            "    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');",
            "}",
            "",
            "// Global code registry — avoids fragile inline onclick with special chars",
            "window._codeRegistry = [];",
            "function _registerCode(content) {",
            "    window._codeRegistry.push(content);",
            "    return window._codeRegistry.length - 1;",
            "}",
            "function _applyCode(idx) {",
            "    var content = window._codeRegistry[idx];",
            "    if (content !== undefined) { vscode.postMessage({ type: 'applyToActiveFile', value: content }); }",
            "}",
            "function _copyCode(btn, idx) {",
            "    var content = window._codeRegistry[idx];",
            "    if (content === undefined) { return; }",
            "    navigator.clipboard.writeText(content).then(function() {",
            "        btn.textContent = '\\u2713 Copi\\u00E9 !';",
            "        setTimeout(function() { btn.textContent = 'Copier'; }, 2000);",
            "    });",
            "}",
            "",
            "function renderMarkdown(text) {",
            "    var blocks = [];",
            "    var FENCE = String.fromCharCode(96,96,96);",
            "    var fenceRe = new RegExp(FENCE + '(\\\\w*)?\\\\n?([\\\\s\\\\S]*?)' + FENCE, 'g');",
            "    var processed = text.replace(fenceRe, function(match, lang, inner) {",
            "        lang = (lang || '').trim();",
            "        var isPatch = inner.indexOf('<<<<') !== -1 || inner.indexOf('SEARCH') !== -1;",
            "        var safeInner = escapeHtml(inner);",
            "        // Store in registry — safe against any special chars",
            "        var patchIdx = _registerCode(match);  // full block with fences for patch",
            "        var codeIdx  = _registerCode(inner);  // inner only for plain code",
            "        var blockHtml;",
            "        if (isPatch) {",
            "            blockHtml = '<div class=\"code-block patch\">' +",
            "                '<div class=\"code-header\"><span>\uD83D\uDCC4 ' + (lang || 'Patch') + '</span>' +",
            "                '<button onclick=\"_applyCode(' + patchIdx + ')\">\u26A1 Appliquer</button>' +",
            "                '</div><div class=\"code-content\">' + safeInner + '</div></div>';",
            "        } else {",
            "            blockHtml = '<div class=\"code-block\">' +",
            "                '<div class=\"code-header\"><span>' + (lang || 'code') + '</span>' +",
            "                '<button onclick=\"_copyCode(this,' + codeIdx + ')\">Copier</button>' +",
            "                '<button onclick=\"_applyCode(' + codeIdx + ')\">\u26A1 Appliquer</button>' +",
            "                '</div><div class=\"code-content\">' + safeInner + '</div></div>';",
            "        }",
            "        blocks.push(blockHtml);",
            "        return '%%%BLOCK_' + (blocks.length - 1) + '%%%';",
            "    });",
            "    var t = processed",
            "        .replace(/&(?!amp;|lt;|gt;|quot;|#)/g, '&amp;')",
            "        .replace(/</g, '&lt;').replace(/>/g, '&gt;');",
            "    t = t.replace(/\\*\\*(.*?)\\*\\*/g, '<b>$1</b>');",
            "    t = t.replace(/\\*(.*?)\\*/g, '<i>$1</i>');",
            "    var BT = String.fromCharCode(96);",
            "    t = t.replace(new RegExp(BT+'([^'+BT+'\\\\n]+)'+BT,'g'), '<code>$1</code>');",
            "    t = t.replace(/\\n/g, '<br>');",
            "    t = t.replace(/%%%BLOCK_(\\d+)%%%/g, function(_, idx) { return blocks[parseInt(idx)] || ''; });",
            "    return t;",
            "}",
            "",
            "function doSend() {",
            "    var v = prompt.value.trim();",
            "    if (!v) { return; }",
            "    var opt = modelSelect.options[modelSelect.selectedIndex];",
            "    var modelVal = opt ? opt.value : '';",
            "    if (!modelVal) {",
            "        modelSelect.style.borderColor = '#ff6b6b';",
            "        setTimeout(function() { updateSelectColor(); }, 2000);",
            "        return;",
            "    }",
            "    addMsg(v, 'user', false);",
            "    var url = opt.getAttribute('data-url') || '';",
            "    var actualModel = opt.getAttribute('data-name') || '';",
            "    var extraCtx = contextFiles.map(function(f) {",
            "        return '\\n[FICHIER: ' + f.name + ']\\n' + f.content.substring(0, 8000);",
            "    }).join('\\n');",
            "    vscode.postMessage({ type: 'sendMessage', value: v + extraCtx, model: actualModel, url: url });",
            "    prompt.value = '';",
            "    prompt.style.height = 'auto';",
            "}",
            "",
            "send.onclick = doSend;",
            "prompt.addEventListener('keydown', function(e) {",
            "    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }",
            "});",
            "document.getElementById('btnCloud').onclick = function() { vscode.postMessage({ type: 'openCloudConnect' }); };",
            "document.getElementById('btnClearHistory').onclick = function() {",
            "    chat.innerHTML = ''; vscode.postMessage({ type: 'clearHistory' });",
            "};",
            "document.getElementById('btnAddFile').onclick = function() {",
            "    vscode.postMessage({ type: 'requestFileAccess', target: '__dialog__' });",
            "};",
            "",
            "function updateSelectColor() {",
            "    var opt = modelSelect.options[modelSelect.selectedIndex];",
            "    var warn = document.getElementById('localWarn');",
            "    if (!opt || !opt.value) {",
            "        modelSelect.className = 'offline';",
            "        warn.className = 'offline';",
            "        warn.innerHTML = '&#x26A0;&#xFE0F; Ollama hors ligne &mdash; Lancez Ollama ou connectez un compte Cloud';",
            "        warn.style.display = 'block';",
            "        return;",
            "    }",
            "    modelSelect.className = '';",
            "    modelSelect.style.color = opt.style.color;",
            "    modelSelect.style.borderColor = opt.style.color;",
            "    var u = opt.getAttribute('data-url') || '';",
            "    var isLocal = u === '' || u.indexOf('localhost') !== -1 || u.indexOf('127.0.0.1') !== -1;",
            "    if (isLocal) {",
            "        warn.className = 'local';",
            "        warn.innerHTML = '&#x26A1; <b>Mode Local</b> &mdash; D&eacute;conseill&eacute; pour les gros fichiers';",
            "    } else {",
            "        warn.className = 'cloud';",
            "        warn.innerHTML = '&#x2601;&#xFE0F; <b>Mode Cloud</b> &mdash; ' + (opt.getAttribute('data-name') || '');",
            "    }",
            "    warn.style.display = 'block';",
            "}",
            "modelSelect.onchange = function() {",
            "    updateSelectColor();",
            "    // Save full value (includes url||name for cloud models)",
            "    vscode.postMessage({ type: 'saveModel', model: modelSelect.value });",
            "};",
            "",
            "window.addEventListener('message', function(e) {",
            "    var m = e.data;",
            "    if (m.type === 'setModels') {",
            "        modelSelect.innerHTML = m.models && m.models.length > 0",
            "            ? m.models.map(function(x) {",
            "                var color = x.isLocal ? '#b19cd9' : '#00d2ff';",
            "                var sel = x.value === m.selected ? 'selected' : '';",
            "                return '<option value=\"'+x.value+'\" data-name=\"'+x.name+'\" data-url=\"'+x.url+'\" style=\"color:'+color+'\" '+sel+'>'+x.label+'</option>';",
            "              }).join('')",
            "            : '<option value=\"\" data-name=\"\" data-url=\"\" style=\"color:#ff6b6b\">\u26A0\uFE0F Ollama hors ligne</option>';",
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
            "});",
            "",
            "vscode.postMessage({ type: 'getModels' });",
            "vscode.postMessage({ type: 'restoreHistory' });"
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
        select#modelSelect.offline { color: #ff6b6b !important; border-color: #ff6b6b !important; animation: blink-border 1.5s infinite; }
        @keyframes blink-border { 0%,100%{opacity:1} 50%{opacity:0.4} }
        #localWarn { display: none; padding: 4px 12px; font-size: 11px; text-align: center; border-bottom: 1px solid; flex-shrink: 0; }
        #localWarn.local { background: rgba(177,156,217,0.12); color: #c9a9f5; border-color: rgba(177,156,217,0.25); }
        #localWarn.cloud { background: rgba(0,210,255,0.08); color: #00d2ff; border-color: rgba(0,210,255,0.2); }
        #localWarn.offline { background: rgba(255,80,80,0.1); color: #ff6b6b; border-color: rgba(255,80,80,0.25); }
        #filesBar { display: none; background: rgba(0,122,204,0.1); padding: 5px 12px; font-size: 11px; color: #aaa; border-bottom: 1px solid rgba(0,122,204,0.2); flex-direction: row; gap: 6px; align-items: center; overflow-x: auto; white-space: nowrap; flex-shrink: 0; }
        #filesBar .file-tag { background: rgba(0,122,204,0.25); color: #6cb6ff; border: 1px solid rgba(0,122,204,0.4); padding: 2px 8px; border-radius: 10px; cursor: pointer; font-size: 11px; }
        #filesBar .file-tag:hover { background: rgba(0,122,204,0.4); }
        #chat { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
        #chat::-webkit-scrollbar { width: 4px; } #chat::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        .msg { padding: 10px 14px; border-radius: 12px; max-width: 95%; line-height: 1.6; word-break: break-word; }
        .user { background: rgba(0,80,200,0.35); align-self: flex-end; border: 1px solid rgba(0,120,255,0.3); border-bottom-right-radius: 2px; white-space: pre-wrap; }
        .ai { background: rgba(15,15,30,0.9); align-self: flex-start; width: 100%; border: 1px solid rgba(255,255,255,0.07); border-bottom-left-radius: 2px; }
        .ai b { color: #fff; }
        .ai code { background: #1a1a2e; color: #00d2ff; padding: 2px 5px; border-radius: 4px; font-family: 'Fira Code', monospace; font-size: 11px; }
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
        .input-actions { display: flex; gap: 6px; }
        .btn-action { background: rgba(255,255,255,0.06); color: #aaa; border: 1px solid #333; padding: 4px 10px; border-radius: 12px; cursor: pointer; font-size: 11px; transition: all 0.2s; }
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
            <button class="btn-cloud" id="btnCloud">&#x2601;&#xFE0F; Cloud</button>
            <select id="modelSelect"></select>
        </div>
    </div>
    <div id="localWarn"></div>
    <div id="filesBar"></div>
    <div id="chat"></div>
    <div class="input-area">
        <div class="input-actions">
            <button class="btn-action" id="btnAddFile">&#x1F4CE; Contexte fichier</button>
            <button class="btn-action" id="btnClearHistory">&#x1F5D1; Effacer</button>
        </div>
        <div class="input-row">
            <textarea id="prompt" placeholder="Posez une question\u2026 (Entr\u00E9e pour envoyer)" rows="1"></textarea>
            <button id="send">SEND</button>
        </div>
    </div>
    <script>${script}</script>
</body>
</html>`;
    }
}