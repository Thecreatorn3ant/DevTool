import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { OllamaClient } from './ollamaClient';

interface ChatMessage {
    role: 'user' | 'ai';
    value: string;
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
    const isSeparator = (l: string) => /^\s*={2,}\s*$/.test(l);
    const isCloseMarker = (l: string) => /^\s*>{2,}/.test(l);
    for (const line of lines) {
        if (state === 'idle') {
            if (isSearchMarker(line)) { state = 'search'; searchLines = []; replaceLines = []; }
        } else if (state === 'search') {
            if (isSeparator(line)) state = 'replace';
            else searchLines.push(line);
        } else if (state === 'replace') {
            if (isCloseMarker(line) || (isSeparator(line) && replaceLines.length > 0)) {
                patches.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
                state = 'idle';
            } else if (!isSeparator(line)) { replaceLines.push(line); }
        }
    }
    if (state === 'replace' && searchLines.length > 0) patches.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
    if (patches.length === 0) return { result: documentText, patchCount: 0, errors: [] };
    let workingText = docNorm;
    for (const patch of patches) {
        const { search, replace } = patch;
        if (workingText.includes(search)) { workingText = workingText.replace(search, replace); patchCount++; continue; }
        const trimEnd = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n');
        const searchTrimmed = trimEnd(search);
        const workingTrimmed = trimEnd(workingText);
        if (workingTrimmed.includes(searchTrimmed)) { workingText = workingTrimmed.replace(searchTrimmed, replace); patchCount++; continue; }
        const fuzzySearchLines = search.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const workingLines = workingText.split('\n');
        let fuzzyMatched = false;
        if (fuzzySearchLines.length > 0) {
            for (let i = 0; i < workingLines.length; i++) {
                let match = true; let searchIdx = 0; let docIdx = i;
                while (searchIdx < fuzzySearchLines.length && docIdx < workingLines.length) {
                    const docLine = workingLines[docIdx].trim();
                    if (docLine === '') { docIdx++; continue; }
                    if (docLine !== fuzzySearchLines[searchIdx]) { match = false; break; }
                    searchIdx++; docIdx++;
                }
                if (match && searchIdx === fuzzySearchLines.length) {
                    const textToReplace = workingLines.slice(i, docIdx).join('\n');
                    const occurrencesFuzzy = workingText.split(textToReplace).length - 1;
                    if (occurrencesFuzzy === 1) { workingText = workingText.replace(textToReplace, replace); patchCount++; fuzzyMatched = true; }
                    break;
                }
            }
        }
        if (!fuzzyMatched) errors.push(`Bloc SEARCH introuvable : ${search.substring(0, 50)}...`);
    }
    return { result: workingText, patchCount, errors };
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'local-ai.chatView';
    private _view?: vscode.WebviewView;
    private _history: ChatMessage[] = [];

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _ollamaClient: OllamaClient,
    ) {
        this._history = this._context.workspaceState.get<ChatMessage[]>('chatHistory', []);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._context.extensionUri] };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage': await this._handleSendMessage(data.value, data.model, data.url); break;
                case 'openCloudConnect': await this._handleCloudConnection(); break;
                case 'getModels': await this._updateModelsList(); break;
                case 'saveModel': await this._context.workspaceState.update('lastSelectedModel', data.model); break;
                case 'restoreHistory': webviewView.webview.postMessage({ type: 'restoreHistory', history: this._history }); break;
                case 'createFile': if (data.value && data.target) await this._handleFileCreation(data.target, data.value); break;
                case 'applyToActiveFile': if (data.value) await this._handleApplyEdit(data.value, data.targetFile); break;
                case 'requestFileAccess': if (data.target) await this._handleFileAccessRequest(data.target); break;
                case 'clearHistory': this._history = []; this._updateHistory(); break;
                case 'openFile': if (data.value) await this._handleOpenFile(data.value); break;
                case 'runCommand': if (data.value) await this._handleRunCommand(data.value); break;
            }
        });
    }

    public sendMessageFromEditor(message: string) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'injectMessage', value: message });
        }
    }

    private async _handleSendMessage(userMsg: string, model?: string, targetUrl?: string) {
        if (!userMsg || !this._view) return;
        this._history.push({ role: 'user', value: userMsg });
        this._updateHistory();
        this._view.webview.postMessage({ type: 'startResponse' });

        const workspaceFiles = await this._getWorkspaceFiles();
        let editor = vscode.window.activeTextEditor;
        if (!editor && vscode.window.visibleTextEditors.length > 0) editor = vscode.window.visibleTextEditors[0];

        let activeContext = '';
        if (editor && editor.document.uri.scheme === 'file') {
            const doc = editor.document;
            const fullText = doc.getText();
            const MAX_CHARS = 12000;
            activeContext = `Fichier actif: ${vscode.workspace.asRelativePath(doc.fileName)}\nContenu:\n${fullText.length > MAX_CHARS ? fullText.substring(0, MAX_CHARS) + "[...]" : fullText}`;
        }

        const fullContext = `[STRUCTURE]\n${workspaceFiles.join('\n')}\n\n[HISTORIQUE]\n${this._getFormattedHistory()}\n\n[CONTEXTE]\n${activeContext}`;

        let fullRes = '';
        try {
            const response = await this._ollamaClient.generateStreamingResponse(userMsg, fullContext, (chunk) => {
                fullRes += chunk;
                this._view?.webview.postMessage({ type: 'partialResponse', value: chunk });
            }, model, targetUrl);
            this._history.push({ role: 'ai', value: response });
            this._updateHistory();
            this._view.webview.postMessage({ type: 'endResponse', value: response });
        } catch (e: any) {
            vscode.window.showErrorMessage(e.message);
            this._view.webview.postMessage({ type: 'endResponse', value: "**Erreur**: " + e.message });
        }
    }

    private async _handleCloudConnection() {
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Comptes Cloud", cancellable: false }, async () => {
            const config = vscode.workspace.getConfiguration('local-ai');
            const apiKeys = config.get<any[]>('apiKeys') || [];
            const now = Date.now();
            const items = apiKeys.map(k => ({
                label: `${(k.rateLimitedUntil && k.rateLimitedUntil > now) ? 'â³' : 'ðŸŸ¢'} ${k.label}`,
                description: k.platform, key: k.key
            }));
            const choice = await vscode.window.showQuickPick([
                { label: 'ðŸ’» Local', description: 'localhost:11434' },
                { label: 'âž• Ajouter Ollama Cloud' },
                { label: 'âž• Ajouter Together/OpenRouter' },
                ...items,
                { label: 'ðŸ—‘ï¸ Supprimer' }
            ]);
            if (!choice) return;
            if (choice.label.includes('Local')) {
                await config.update('ollamaUrl', 'http://localhost:11434', true);
                await config.update('apiKey', '', true);
            } else if (choice.label.includes('Ollama Cloud')) {
                const key = await vscode.window.showInputBox({ prompt: "ClÃ© ollama_...", password: true });
                if (key) {
                    const label = await vscode.window.showInputBox({ prompt: "Nom" }) || 'Cloud';
                    await config.update('apiKeys', [...apiKeys, { key, label, platform: 'ollama.com' }], true);
                    await config.update('ollamaUrl', 'https://ollama.com', true);
                    await config.update('apiKey', key, true);
                }
            } else if ((choice as any).key) {
                const entry = apiKeys.find(k => k.key === (choice as any).key);
                if (entry) {
                    await config.update('ollamaUrl', entry.platform === 'ollama.com' ? 'https://ollama.com' : entry.platform, true);
                    await config.update('apiKey', entry.key, true);
                }
            } else if (choice.label.includes('Supprimer')) {
                const toDel = await vscode.window.showQuickPick(apiKeys.map(k => ({ label: k.label, key: k.key })));
                if (toDel) await config.update('apiKeys', apiKeys.filter(k => k.key !== toDel.key), true);
            }
            this._updateModelsList();
        });
    }

    private _updateHistory() { this._context.workspaceState.update('chatHistory', this._history); }

    private async _updateModelsList() {
        if (!this._view) return;
        try {
            const models = await this._ollamaClient.listAllModels();

            let formattedModels = models.map(m => {
                const uniqueValue = (m.isLocal ? 'local|' : 'cloud|') + m.name;
                if (m.isLocal) {
                    return { value: uniqueValue, name: m.name, url: m.url, label: `ðŸ’» ${m.name}`, isLocal: true };
                } else {
                    return { value: uniqueValue, name: m.name, url: m.url, label: `â˜ï¸ ${m.name}`, isLocal: false };
                }
            });

            const lastSelected = this._context.workspaceState.get<string>('lastSelectedModel');
            let selected = formattedModels.length > 0 ? formattedModels[0].value : '';
            if (lastSelected && formattedModels.find(m => m.value === lastSelected)) {
                selected = lastSelected;
            }

            this._view.webview.postMessage({ type: 'setModels', models: formattedModels, selected });
        } catch { this._view.webview.postMessage({ type: 'setModels', models: [] }); }
    }

    private _getFormattedHistory() { return this._history.slice(-10).map(m => `${m.role}: ${m.value.substring(0, 200)}`).join('\n'); }

    private async _handleFileCreation(fileName: string, content: string) {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
        const uri = vscode.Uri.file(path.join(folder, fileName));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
        await vscode.window.showTextDocument(uri);
    }

    private async _handleFileAccessRequest(target: string) {
        if (target === '.env') {
            const files = await vscode.workspace.findFiles('**/.env');
            if (files.length > 0) {
                const content = await vscode.workspace.fs.readFile(files[0]);
                this._view?.webview.postMessage({ type: 'fileContent', name: '.env', content: content.toString() });
            }
        } else {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true });
            if (uris?.[0]) {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                this._view?.webview.postMessage({ type: 'fileContent', name: path.basename(uris[0].fsPath), content: content.toString() });
            }
        }
    }

    private async _handleApplyEdit(code: string, targetFile?: string) {
        let uri: vscode.Uri | undefined;
        if (targetFile) {
            const files = await vscode.workspace.findFiles(`**/${targetFile.replace(/\[FILE:|\]/g, '').trim()}`, null, 1);
            if (files[0]) uri = files[0];
        }
        if (!uri) uri = vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;

        const doc = await vscode.workspace.openTextDocument(uri);
        const oldText = doc.getText();
        const hasMarkers = /SEARCH/.test(code);
        let preview = code;
        if (hasMarkers) {
            const res = applySearchReplace(oldText, code);
            preview = res.result;
            res.errors.forEach(e => vscode.window.showWarningMessage(e));
        }
        const choice = await vscode.window.showInformationMessage("Appliquer ?", "Oui", "Non");
        if (choice === "Oui") {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
            const validatedRange = doc.validateRange(fullRange).with(undefined, doc.lineAt(doc.lineCount - 1).range.end);
            edit.replace(doc.uri, validatedRange, preview);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            await vscode.window.showTextDocument(doc);
            this._highlightChangedLines(vscode.window.activeTextEditor!, oldText, preview);
        }
    }

    private async _handleOpenFile(fp: string) {
        const files = await vscode.workspace.findFiles(`**/${fp}`, null, 1);
        if (files[0]) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(files[0]));
    }

    private async _handleRunCommand(cmd: string) {
        if (await vscode.window.showInformationMessage(`Run: ${cmd}`, "Run", "No") === "Run") {
            const t = vscode.window.activeTerminal || vscode.window.createTerminal();
            t.show(); t.sendText(cmd);
        }
    }

    private async _getWorkspaceFiles() {
        const f = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**}', 100);
        return f.map(u => vscode.workspace.asRelativePath(u)).sort();
    }

    private _highlightChangedLines(editor: vscode.TextEditor, oldT: string, newT: string) {
        const oldL = oldT.split('\n'); const newL = newT.split('\n'); const ch = [];
        for (let i = 0; i < newL.length; i++) if (newL[i] !== oldL[i]) ch.push(i);
        const dec = vscode.window.createTextEditorDecorationType({ backgroundColor: 'rgba(0, 255, 120, 0.15)', isWholeLine: true });
        editor.setDecorations(dec, ch.map(n => n < editor.document.lineCount ? editor.document.lineAt(n).range : new vscode.Range(0, 0, 0, 0)));
        setTimeout(() => dec.dispose(), 4000);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const bgUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'background.png'));
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&family=Fira+Code&display=swap');
            * { box-sizing: border-box; }
            body { font-family: 'Inter', sans-serif; background: #000; color: #e0e0e0; margin:0; height:100vh; display:flex; flex-direction:column; overflow:hidden; font-size:13px; }
            .space-bg { position:fixed; top:0; left:0; width:100%; height:100%; background: url('${bgUri}') no-repeat center center; background-size:cover; filter:brightness(0.35); z-index:-1; }
            /* Header */
            .header { padding:8px 12px; background:rgba(5,5,15,0.92); display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(0,210,255,0.2); flex-shrink:0; }
            .header-brand { font-weight:900; letter-spacing:2px; font-size:14px; color:#fff; text-shadow: 0 0 10px rgba(0,210,255,0.5); }
            .header-controls { display:flex; gap:6px; align-items:center; }
            .btn-cloud { background:none; border:1px solid #00d2ff; color:#00d2ff; padding:4px 10px; font-size:11px; border-radius:20px; cursor:pointer; font-weight:700; transition:all 0.2s; }
            .btn-cloud:hover { background: rgba(0,210,255,0.15); }
            select#modelSelect { max-width:150px; padding:4px 6px; border-radius:20px; background:#0a0a1a; border:1px solid #444; outline:none; font-size:11px; color:#00d2ff; cursor:pointer; }
            /* Warn bar */
            #localWarn { display:none; background:rgba(177,156,217,0.12); color:#c9a9f5; padding:6px 12px; font-size:11px; text-align:center; border-bottom:1px solid rgba(177,156,217,0.25); flex-shrink:0; }
            /* Files context bar */
            #filesBar { display:none; background:rgba(0,122,204,0.1); padding:5px 12px; font-size:11px; color:#aaa; border-bottom:1px solid rgba(0,122,204,0.2); display:flex; gap:6px; align-items:center; overflow-x:auto; white-space:nowrap; flex-shrink:0; }
            #filesBar .file-tag { background:rgba(0,122,204,0.25); color:#6cb6ff; border:1px solid rgba(0,122,204,0.4); padding:2px 8px; border-radius:10px; cursor:pointer; font-size:11px; }
            #filesBar .file-tag:hover { background:rgba(0,122,204,0.4); }
            #filesBar .file-tag::after { content:"âœ•"; margin-left:6px; opacity:0.6; font-size:10px; }
            /* Chat */
            #chat { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:12px; }
            #chat::-webkit-scrollbar { width:4px; }
            #chat::-webkit-scrollbar-thumb { background:#333; border-radius:2px; }
            .msg { padding:10px 14px; border-radius:12px; max-width:95%; line-height:1.6; word-break:break-word; }
            .user { background:rgba(0,80,200,0.35); align-self:flex-end; border:1px solid rgba(0,120,255,0.3); border-bottom-right-radius:2px; }
            .ai { background:rgba(15,15,30,0.9); align-self:flex-start; width:100%; border:1px solid rgba(255,255,255,0.07); border-bottom-left-radius:2px; }
            .ai b { color:#fff; }
            .ai code { background:#1a1a2e; color:#00d2ff; padding:2px 5px; border-radius:4px; font-family:'Fira Code', monospace; font-size:11px; }
            /* Code blocks */
            .code-block { background:#0d0d1a; border:1px solid #2a2a3a; border-radius:8px; margin:10px 0; overflow:hidden; }
            .code-header { background:#141424; padding:8px 12px; display:flex; justify-content:space-between; align-items:center; font-size:11px; color:#888; border-bottom:1px solid #2a2a3a; }
            .code-header button { padding:4px 10px; font-size:11px; background:#007acc; border-radius:12px; margin-left:8px; cursor:pointer; border:none; color:#fff; font-weight:700; transition:background 0.2s; }
            .code-header button:hover { background:#0090e0; }
            .code-content { padding:12px; font-family:'Fira Code', monospace; font-size:12px; color:#cdd; white-space:pre-wrap; overflow-x:auto; max-height:400px; overflow-y:auto; }
            .code-block.patch { border-color:rgba(0,122,204,0.5); }
            .code-block.patch .code-header { background:rgba(0,60,120,0.4); color:#6cb6ff; border-color:rgba(0,122,204,0.3); }
            .code-block.patch .code-content .search-marker { color:#f97583; }
            .code-block.patch .code-content .replace-marker { color:#85e89d; }
            /* Input area */
            .input-area { padding:10px 12px; background:rgba(5,5,15,0.92); display:flex; flex-direction:column; gap:8px; border-top:1px solid rgba(0,210,255,0.15); flex-shrink:0; }
            .input-row { display:flex; gap:8px; align-items:flex-end; }
            #prompt { flex:1; background:rgba(20,20,40,0.8); color:#e0e0e0; border:1px solid #333; padding:10px 14px; border-radius:22px; outline:none; font-family:'Inter',sans-serif; font-size:13px; resize:none; min-height:40px; max-height:120px; line-height:1.4; transition:border-color 0.2s; }
            #prompt:focus { border-color: rgba(0,210,255,0.5); }
            #send { background:#007acc; color:#fff; border:none; padding:10px 18px; border-radius:22px; cursor:pointer; font-weight:700; font-size:13px; white-space:nowrap; transition:background 0.2s; }
            #send:hover { background:#0090e0; }
            .input-actions { display:flex; gap:6px; }
            .btn-action { background:rgba(255,255,255,0.06); color:#aaa; border:1px solid #333; padding:4px 10px; border-radius:12px; cursor:pointer; font-size:11px; transition:all 0.2s; }
            .btn-action:hover { background:rgba(255,255,255,0.12); color:#fff; }
            .thinking { display:flex; gap:4px; align-items:center; padding:6px 0; }
            .thinking span { width:6px; height:6px; background:#00d2ff; border-radius:50%; animation:bounce 1.2s infinite; }
            .thinking span:nth-child(2) { animation-delay:0.2s; }
            .thinking span:nth-child(3) { animation-delay:0.4s; }
            @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-8px)} }
            button { font-family:'Inter',sans-serif; }
        </style></head>
        <body><div class="space-bg"></div>
            <div class="header">
                <span class="header-brand">ANTIGRAVITY</span>
                <div class="header-controls">
                    <button class="btn-cloud" id="btnCloud">â˜ï¸ Cloud</button>
                    <select id="modelSelect"></select>
                </div>
            </div>
            <div id="localWarn">âš ï¸ <b>Mode Local</b> â€” DÃ©conseillÃ© pour les gros fichiers</div>
            <div id="filesBar"></div>
            <div id="chat"></div>
            <div class="input-area">
                <div class="input-actions">
                    <button class="btn-action" id="btnAddFile">ðŸ“Ž Contexte fichier</button>
                    <button class="btn-action" id="btnClearHistory">ðŸ—‘ï¸ Effacer</button>
                </div>
                <div class="input-row">
                    <textarea id="prompt" placeholder="Posez une question... (EntrÃ©e pour envoyer)" rows="1"></textarea>
                    <button id="send">SEND</button>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const chat = document.getElementById('chat');
                const prompt = document.getElementById('prompt');
                const send = document.getElementById('send');
                const modelSelect = document.getElementById('modelSelect');
                const filesBar = document.getElementById('filesBar');
                let contextFiles = []; // [{name, content}]

                // Auto-resize textarea
                prompt.addEventListener('input', () => {
                    prompt.style.height = 'auto';
                    prompt.style.height = Math.min(prompt.scrollHeight, 120) + 'px';
                });

                const addContextFile = (name, content) => {
                    if(contextFiles.find(f => f.name === name)) return;
                    contextFiles.push({name, content});
                    renderFilesBar();
                };
                const renderFilesBar = () => {
                    if(contextFiles.length === 0) { filesBar.style.display = 'none'; return; }
                    filesBar.style.display = 'flex';
                    filesBar.innerHTML = '<span style="color:#666;margin-right:4px;">Contexte :</span>' + 
                        contextFiles.map((f,i) => '<span class="file-tag" data-idx="'+i+'">'+f.name+'</span>').join('');
                    filesBar.querySelectorAll('.file-tag').forEach(el => {
                        el.onclick = () => {
                            const idx = parseInt(el.getAttribute('data-idx'));
                            contextFiles.splice(idx, 1);
                            renderFilesBar();
                        };
                    });
                };

                const add = (txt, cls, isHtml = false) => {
                    const d = document.createElement('div');
                    d.className = 'msg ' + cls;
                    if(isHtml) d.innerHTML = txt; else d.innerText = txt;
                    chat.appendChild(d);
                    chat.scrollTop = chat.scrollHeight;
                    return d;
                };

                const applyPatch = (encodedPatch) => {
                    try {
                        const raw = decodeURIComponent(encodedPatch);
                        vscode.postMessage({type: 'applyToActiveFile', value: raw});
                    } catch(e) { console.error('Patch error', e); }
                };
                window.applyPatch = applyPatch;

                const renderMarkdown = (text) => {
                    const blocks = [];
                    // Handle code blocks BEFORE HTML escaping (process raw text)
                    const processed = text.replace(/\`\`\`(\\w*)?\\n?([\\s\\S]*?)\`\`\`/g, (match, lang, inner) => {
                        lang = (lang || '').trim();
                        const isPatch = inner.includes('<<<<<<') || inner.includes('SEARCH');
                        let displayInner = inner
                            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                        
                        let blockHtml;
                        if (isPatch) {
                            const encoded = encodeURIComponent(match);
                            blockHtml = \`<div class="code-block patch">
                                <div class="code-header">
                                    <span>ðŸ› ï¸ Proposition de modification</span>
                                    <button onclick="applyPatch('\${encoded.replace(/'/g, "\\\\'")}')">Appliquer direct âœ…</button>
                                </div>
                                <div class="code-content">\${displayInner}</div>
                            </div>\`;
                        } else {
                            const encoded = encodeURIComponent(inner);
                            blockHtml = \`<div class="code-block">
                                <div class="code-header">
                                    <span>ðŸ“„ \${lang || 'Code'}</span>
                                    <button onclick="vscode.postMessage({type:'createFile',value:decodeURIComponent('\${encoded.replace(/'/g, "\\\\'")}'),target:'nouveau.\${lang||'txt'}' })">CrÃ©er fichier</button>
                                </div>
                                <div class="code-content">\${displayInner}</div>
                            </div>\`;
                        }
                        blocks.push(blockHtml);
                        return '%%%BLOCK_' + (blocks.length - 1) + '%%%';
                    });

                    // Escape remaining HTML
                    let t = processed.replace(/&(?!amp;|lt;|gt;|quot;|#)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    
                    // Format Markdown text
                    t = t.replace(/\\*\\*(.*?)\\*\\*/g, '<b>$1</b>');
                    t = t.replace(/\\*(.*?)\\*/g, '<i>$1</i>');
                    t = t.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
                    t = t.replace(/\\n/g, '<br>');

                    // Restore code blocks
                    t = t.replace(/%%%BLOCK_(\\d+)%%%/g, (_, idx) => blocks[parseInt(idx)] || '');
                    return t;
                };

                let currentAiMsg = null;
                let currentAiText = '';

                const doSend = () => {
                    const v = prompt.value.trim();
                    if(!v) return;
                    add(v, 'user');

                    const opt = modelSelect.options[modelSelect.selectedIndex];
                    const url = opt ? opt.getAttribute('data-url') : '';
                    const actualModel = opt ? opt.getAttribute('data-name') : '';

                    // Build extra context from added files
                    let extraCtx = '';
                    if(contextFiles.length > 0) {
                        extraCtx = contextFiles.map(f => \`\\n[FICHIER: \${f.name}]\\n\${f.content.substring(0, 8000)}\`).join('\\n');
                    }

                    vscode.postMessage({ type: 'sendMessage', value: v + extraCtx, model: actualModel, url });
                    prompt.value = '';
                    prompt.style.height = 'auto';
                };

                send.onclick = doSend;
                prompt.onkeydown = e => {
                    if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
                };

                document.getElementById('btnCloud').onclick = () => vscode.postMessage({ type: 'openCloudConnect' });
                document.getElementById('btnClearHistory').onclick = () => {
                    chat.innerHTML = '';
                    vscode.postMessage({ type: 'clearHistory' });
                };
                document.getElementById('btnAddFile').onclick = () => vscode.postMessage({ type: 'requestFileAccess', target: '__dialog__' });

                window.addEventListener('message', e => {
                    const m = e.data;

                    if(m.type === 'setModels') {
                        modelSelect.innerHTML = m.models.map(x => {
                            const color = x.isLocal ? '#b19cd9' : '#00d2ff';
                            const sel = x.value === m.selected ? 'selected' : '';
                            return \`<option value="\${x.value}" data-name="\${x.name}" data-url="\${x.url}" style="color:\${color}" \${sel}>\${x.label}</option>\`;
                        }).join('');
                        updateSelectColor();
                    }

                    if(m.type === 'startResponse') {
                        currentAiMsg = document.createElement('div');
                        currentAiMsg.className = 'msg ai';
                        currentAiMsg.innerHTML = '<div class="thinking"><span></span><span></span><span></span></div>';
                        chat.appendChild(currentAiMsg);
                        chat.scrollTop = chat.scrollHeight;
                        currentAiText = '';
                    }

                    if(m.type === 'partialResponse') {
                        if(!currentAiMsg) { currentAiMsg = add('', 'ai', true); }
                        currentAiText += m.value;
                        currentAiMsg.innerHTML = renderMarkdown(currentAiText);
                        chat.scrollTop = chat.scrollHeight;
                    }

                    if(m.type === 'endResponse') {
                        const finalText = m.value || currentAiText;
                        if(currentAiMsg) {
                            currentAiMsg.innerHTML = renderMarkdown(finalText);
                        } else {
                            add(renderMarkdown(finalText), 'ai', true);
                        }
                        currentAiMsg = null;
                        currentAiText = '';
                    }

                    if(m.type === 'fileContent') {
                        addContextFile(m.name, m.content);
                    }

                    if(m.type === 'injectMessage') { prompt.value = m.value; prompt.focus(); }

                    if(m.type === 'restoreHistory') {
                        if(m.history && m.history.length > 0) {
                            m.history.forEach(msg => {
                                add(msg.role === 'ai' ? renderMarkdown(msg.value) : msg.value, msg.role, msg.role === 'ai');
                            });
                        }
                    }
                });

                const updateSelectColor = () => {
                    const opt = modelSelect.options[modelSelect.selectedIndex];
                    if(opt) {
                        modelSelect.style.color = opt.style.color;
                        modelSelect.style.borderColor = opt.style.color;
                        const url = opt.getAttribute('data-url');
                        const isLocal = url && (url.includes('localhost') || url.includes('127.0.0.1'));
                        document.getElementById('localWarn').style.display = isLocal ? 'block' : 'none';
                    }
                };
                modelSelect.onchange = () => {
                    updateSelectColor();
                    vscode.postMessage({ type: 'saveModel', model: modelSelect.value });
                };

                vscode.postMessage({ type: 'getModels' });
                vscode.postMessage({ type: 'restoreHistory' });
            </script>
        </body></html>`;
    }
}