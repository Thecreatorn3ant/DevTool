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
                label: `${(k.rateLimitedUntil && k.rateLimitedUntil > now) ? '⏳' : '🟢'} ${k.label}`,
                description: k.platform, key: k.key
            }));
            const choice = await vscode.window.showQuickPick([
                { label: '💻 Local', description: 'localhost:11434' },
                { label: '➕ Ajouter Ollama Cloud' },
                { label: '➕ Ajouter Together/OpenRouter' },
                ...items,
                { label: '🗑️ Supprimer' }
            ]);
            if (!choice) return;
            if (choice.label.includes('Local')) {
                await config.update('ollamaUrl', 'http://localhost:11434', true);
                await config.update('apiKey', '', true);
            } else if (choice.label.includes('Ollama Cloud')) {
                const key = await vscode.window.showInputBox({ prompt: "Clé ollama_...", password: true });
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
                if (m.isLocal) {
                    return { value: m.name, url: m.url, label: `💻 ${m.name} (⚠️ Déconseillé gros fichiers)`, isLocal: true };
                } else {
                    return { value: m.name, url: m.url, label: `☁️ ${m.name}`, isLocal: false };
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
        const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'icon.png'));
        const bgUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'background.png'));
        return `<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>
            body { font-family: 'Inter', sans-serif; background: #000; color: #fff; margin:0; height:100vh; display:flex; flex-direction:column; overflow:hidden; }
            .space-bg { position:fixed; top:0; left:0; width:100%; height:100%; background: url('${bgUri}') no-repeat center center; background-size:cover; filter:brightness(0.4); z-index:-1; }
            .header { padding:8px; background:rgba(0,0,0,0.8); display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #333; }
            #chat { flex:1; overflow-y:auto; padding:15px; display:flex; flex-direction:column; gap:10px; }
            .msg { padding:10px; border-radius:8px; border:1px solid #333; max-width:90%; line-height:1.5; }
            .user { background:rgba(0,100,255,0.3); align-self:flex-end; }
            .ai { background:rgba(30,30,40,0.9); align-self:flex-start; }
            .input-area { padding:12px; background:#111; display:flex; gap:8px; border-top:1px solid #333; }
            input { flex:1; background:#000; color:#fff; border:1px solid #444; padding:8px; border-radius:6px; outline:none; }
            button { background:#007acc; color:#fff; border:none; padding:8px 15px; border-radius:6px; cursor:pointer; font-weight:bold; }
            select { background:#111; color:#00d2ff; border:1px solid #333; font-size:11px; padding:3px; }
        </style></head>
        <body><div class="space-bg"></div>
            <div class="header">
                <span style="font-weight:900; letter-spacing:1px;">ANTIGRAVITY</span>
                <div><button id="btnCloud" style="background:none; border:1px solid #00d2ff; color:#00d2ff; padding:3px 8px; font-size:11px;">☁️ Cloud</button> <select id="modelSelect"></select></div>
            </div>
            <div id="chat"></div>
            <div class="input-area">
                <input id="prompt" placeholder="Posez une question...">
                <button id="send">SEND</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                const chat = document.getElementById('chat');
                const prompt = document.getElementById('prompt');
                const send = document.getElementById('send');
                const modelSelect = document.getElementById('modelSelect');

                const add = (txt, cls) => { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerText = txt; chat.appendChild(d); chat.scrollTop = chat.scrollHeight; return d; };

                send.onclick = () => { 
                    const v = prompt.value; 
                    if(!v) return; 
                    add(v, 'user'); 
                    
                    const opt = modelSelect.options[modelSelect.selectedIndex];
                    const url = opt ? opt.getAttribute('data-url') : '';
                    
                    vscode.postMessage({ type: 'sendMessage', value: v, model: modelSelect.value, url }); 
                    prompt.value=''; 
                };
                prompt.onkeydown = e => { if(e.key === 'Enter') send.onclick(); };
                document.getElementById('btnCloud').onclick = () => vscode.postMessage({ type: 'openCloudConnect' });

                window.addEventListener('message', e => {
                    const m = e.data;
                    if(m.type === 'setModels') {
                        modelSelect.innerHTML = m.models.map(x => {
                            const color = x.isLocal ? '#b19cd9' : '#00d2ff'; // Purple for local, Blue for cloud
                            const isSelected = x.value === m.selected ? 'selected' : '';
                            return '<option value="'+x.value+'" data-url="'+x.url+'" style="color: '+color+';" '+isSelected+'>'+x.label+'</option>';
                        }).join('');
                        
                        // Force update select color based on current selected option
                        const updateSelectColor = () => {
                            const selectedOption = modelSelect.options[modelSelect.selectedIndex];
                            if (selectedOption) {
                                modelSelect.style.color = selectedOption.style.color;
                                modelSelect.style.borderColor = selectedOption.style.color;
                            }
                        };
                        modelSelect.onchange = () => {
                            updateSelectColor();
                            vscode.postMessage({ type: 'saveModel', model: modelSelect.value });
                        };
                        updateSelectColor(); // Initial call
                    }
                    if(m.type === 'endResponse') add(m.value, 'ai');
                    if(m.type === 'injectMessage') { prompt.value = m.value; prompt.focus(); }
                });
                vscode.postMessage({ type: 'getModels' });
                vscode.postMessage({ type: 'restoreHistory' });
            </script>
        </body></html>`;
    }
}