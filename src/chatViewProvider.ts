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
            if (isSearchMarker(line)) {
                state = 'search';
                searchLines = [];
                replaceLines = [];
            }
        } else if (state === 'search') {
            if (isSeparator(line)) {
                state = 'replace';
            } else {
                searchLines.push(line);
            }
        } else if (state === 'replace') {
            if (isCloseMarker(line) || (isSeparator(line) && replaceLines.length > 0)) {
                patches.push({
                    search: searchLines.join('\n'),
                    replace: replaceLines.join('\n'),
                });
                state = 'idle';
            } else if (!isSeparator(line)) {
                replaceLines.push(line);
            }
        }
    }

    if (state === 'replace' && searchLines.length > 0) {
        patches.push({
            search: searchLines.join('\n'),
            replace: replaceLines.join('\n'),
        });
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

        const fuzzySearchLines = search.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const workingLines = workingText.split('\n');
        let fuzzyMatched = false;

        if (fuzzySearchLines.length > 0) {
            for (let i = 0; i < workingLines.length; i++) {
                let match = true;
                let searchIdx = 0;
                let docIdx = i;

                while (searchIdx < fuzzySearchLines.length && docIdx < workingLines.length) {
                    const docLine = workingLines[docIdx].trim();
                    if (docLine === '') {
                        docIdx++;
                        continue;
                    }
                    if (docLine !== fuzzySearchLines[searchIdx]) {
                        match = false;
                        break;
                    }
                    searchIdx++;
                    docIdx++;
                }

                if (match && searchIdx === fuzzySearchLines.length) {
                    const textToReplace = workingLines.slice(i, docIdx).join('\n');

                    const occurrencesFuzzy = workingText.split(textToReplace).length - 1;
                    if (occurrencesFuzzy === 1) {
                        workingText = workingText.replace(textToReplace, replace);
                        patchCount++;
                        fuzzyMatched = true;
                    } else if (occurrencesFuzzy > 1) {
                        errors.push(`Bloc SEARCH ambigu en fuzzy-match (${occurrencesFuzzy} occurrences) — ignoré.`);
                        fuzzyMatched = true;
                    }
                    break;
                }
            }
        }

        if (fuzzyMatched) {
            continue;
        }

        const occurrences = workingText.split(search).length - 1;
        if (occurrences > 1) {
            errors.push(`Bloc SEARCH ambigu (${occurrences} occurrences) — ignoré.`);
        } else {
            errors.push(`Bloc SEARCH introuvable :\n${search.substring(0, 120)}`);
        }
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

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {

                case 'sendMessage': {
                    if (!data.value) { break; }

                    const userMsg: string = data.value;
                    this._history.push({ role: 'user', value: userMsg });
                    this._updateHistory();

                    webviewView.webview.postMessage({ type: 'startResponse' });

                    const workspaceFiles = await this._getWorkspaceFiles();

                    let editor = vscode.window.activeTextEditor;
                    if (!editor && vscode.window.visibleTextEditors.length > 0) {
                        editor = vscode.window.visibleTextEditors[0];
                        const validEditors = vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'file');
                        if (validEditors.length > 0) {
                            editor = validEditors[0];
                        }
                    }

                    let activeContext = '';
                    if (editor && editor.document.uri.scheme === 'file') {
                        const doc = editor.document;
                        const relativeName = vscode.workspace.asRelativePath(doc.fileName);
                        const fullText = doc.getText();
                        const MAX_CHARS = 12000;
                        const truncated = fullText.length > MAX_CHARS;
                        const snippet = truncated
                            ? fullText.substring(0, MAX_CHARS) + `\n\n[... fichier tronqué à ${MAX_CHARS} caractères sur ${fullText.length} total ...]`
                            : fullText;
                        activeContext = `Fichier actif: ${relativeName}\nContenu:\n${snippet}`;
                    }

                    let fullContext = '';
                    if (workspaceFiles.length > 0) {
                        fullContext += `[STRUCTURE DU PROJET]\n${workspaceFiles.join('\n')}\n\n`;
                    }
                    const historyContext = this._getFormattedHistory();
                    if (historyContext) {
                        fullContext += `[HISTORIQUE DE CONVERSATION]\n${historyContext}\n\n`;
                    }
                    if (activeContext) {
                        fullContext += `[FICHIER ACTIF (À MODIFIER SI DEMANDÉ)]\n${activeContext}\n\n`;
                    }

                    let fullResponse = '';
                    const response = await this._ollamaClient.generateStreamingResponse(
                        userMsg,
                        fullContext.trim(),
                        (chunk) => {
                            fullResponse += chunk;
                            webviewView.webview.postMessage({ type: 'partialResponse', value: chunk });
                        },
                        data.model
                    );

                    if (response) {
                        this._history.push({ role: 'ai', value: response });
                        this._updateHistory();
                    }
                    webviewView.webview.postMessage({ type: 'endResponse', value: response || fullResponse });
                    break;
                }

                case 'getModels': {
                    try {
                        const models = await this._ollamaClient.listModels();
                        let selected = '';
                        if (models.length > 0) {
                            const priority = ['codellama', 'deepseek-coder', 'gemma', 'llama', 'mistral', 'qwen'];
                            for (const p of priority) {
                                const found = models.find(m => m.toLowerCase().includes(p));
                                if (found) { selected = found; break; }
                            }
                            if (!selected) { selected = models[0]; }
                        }
                        webviewView.webview.postMessage({ type: 'setModels', models, selected });
                    } catch {
                        webviewView.webview.postMessage({ type: 'setModels', models: [], selected: '' });
                    }
                    break;
                }

                case 'restoreHistory': {
                    webviewView.webview.postMessage({ type: 'restoreHistory', history: this._history });
                    break;
                }

                case 'createFile': {
                    if (data.value && data.target) {
                        await this._handleFileCreation(data.target, data.value);
                    }
                    break;
                }

                case 'applyToActiveFile': {
                    if (data.value) {
                        await this._handleApplyEdit(data.value, data.targetFile);
                    }
                    break;
                }

                case 'requestFileAccess': {
                    if (data.target) {
                        await this._handleFileAccessRequest(data.target);
                    }
                    break;
                }

                case 'clearHistory': {
                    this._history = [];
                    this._updateHistory();
                    break;
                }

                case 'openFile': {
                    if (data.value) {
                        await this._handleOpenFile(data.value);
                    }
                    break;
                }

                case 'runCommand': {
                    if (data.value) {
                        await this._handleRunCommand(data.value);
                    }
                    break;
                }
            }
        });
    }

    public sendMessageFromEditor(message: string) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'injectMessage', value: message });
        }
    }

    private _updateHistory() {
        this._context.workspaceState.update('chatHistory', this._history);
    }

    private _getFormattedHistory(): string {
        return this._history
            .slice(-16)
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.value.substring(0, 500)}`)
            .join('\n');
    }

    private async _handleFileCreation(fileName: string, content: string) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const folderPath = workspaceFolders && workspaceFolders.length > 0
            ? workspaceFolders[0].uri.fsPath
            : path.join(os.homedir(), 'Downloads');

        const filePath = path.join(folderPath, fileName);
        const uri = vscode.Uri.file(filePath);
        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            await vscode.window.showTextDocument(uri);
            vscode.window.showInformationMessage(`Fichier créé : ${path.basename(filePath)}`);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Erreur création fichier : ${error.message}`);
        }
    }

    private async _handleFileAccessRequest(target: string) {
        if (target === '.env') {
            const files = await vscode.workspace.findFiles('**/.env');
            if (files.length > 0) {
                const content = await vscode.workspace.fs.readFile(files[0]);
                this._view?.webview.postMessage({
                    type: 'fileContent',
                    name: '.env',
                    content: content.toString()
                });
            } else {
                vscode.window.showErrorMessage('.env non trouvé.');
            }
        } else {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                openLabel: 'Ajouter au contexte'
            });
            if (uris && uris[0]) {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                this._view?.webview.postMessage({
                    type: 'fileContent',
                    name: path.basename(uris[0].fsPath),
                    content: content.toString()
                });
            }
        }
    }

    private async _handleApplyEdit(codeContent: string, targetFile?: string) {
        let targetUri: vscode.Uri | undefined;
        if (targetFile) {
            const cleanTarget = targetFile.replace(/\[FILE:\s*|\]/g, '').trim();
            const files = await vscode.workspace.findFiles(`**/${cleanTarget}`, '**/node_modules/**', 1);
            if (files.length > 0) { targetUri = files[0]; }
        }
        if (!targetUri) {
            let editor = vscode.window.activeTextEditor;
            if (!editor && vscode.window.visibleTextEditors.length > 0) {
                editor = vscode.window.visibleTextEditors[0];
                const validEditors = vscode.window.visibleTextEditors.filter(e => e.document.uri.scheme === 'file');
                if (validEditors.length > 0) { editor = validEditors[0]; }
            }
            if (editor) { targetUri = editor.document.uri; }
        }
        if (!targetUri) {
            vscode.window.showErrorMessage("Aucun fichier cible trouvé. Ouvrez le fichier à modifier en éditeur principal.");
            return;
        }

        const document = await vscode.workspace.openTextDocument(targetUri);
        const documentText = document.getText();

        const hasMarkers = /^\s*<{2,}\s*SEARCH/im.test(codeContent.replace(/\r\n/g, '\n'));

        let previewText = codeContent;
        let patchCount = 0;
        let patchErrors: string[] = [];

        if (hasMarkers) {
            const patchResult = applySearchReplace(documentText, codeContent);
            previewText = patchResult.result;
            patchCount = patchResult.patchCount;
            patchErrors = patchResult.errors;

            for (const err of patchErrors) {
                vscode.window.showWarningMessage(err);
            }
        }

        let result: string | undefined;

        if (hasMarkers && patchCount === 0) {
            result = await vscode.window.showWarningMessage(
                `❌ Impossible d'appliquer le patch. Le code fourni par l'IA ne correspond pas EXACTEMENT au code du fichier (espaces, retours à la ligne, ou code fictif).\n\nVous pouvez l'insérer manuellement.`,
                "📋 Insérer au curseur", "❌ Annuler"
            );
        } else if (patchCount > 0) {
            const ext = path.extname(document.fileName) || '.txt';
            const tempUri = vscode.Uri.file(
                path.join(os.tmpdir(), `ai_patch_${Date.now()}${ext}`)
            );
            await vscode.workspace.fs.writeFile(tempUri, Buffer.from(previewText, 'utf8'));

            const diffTitle = `Review: ${path.basename(document.fileName)} (${patchCount} patch(s))`;
            await vscode.commands.executeCommand('vscode.diff', document.uri, tempUri, diffTitle);

            result = await vscode.window.showInformationMessage(
                `Appliquer ${patchCount} modification(s) SEARCH/REPLACE à "${path.basename(targetUri.fsPath)}" ?`,
                "✅ Accepter", "❌ Rejeter"
            );

            try { await vscode.workspace.fs.delete(tempUri); } catch { /* ignore */ }
        } else {
            const contentLines = codeContent.split('\n').length;
            const isSnippet = contentLines < document.lineCount / 2;
            const options: string[] = isSnippet
                ? ["📋 Insérer au curseur", "🔄 Remplacer tout", "❌ Rejeter"]
                : ["🔄 Remplacer tout", "❌ Rejeter"];

            result = await vscode.window.showWarningMessage(
                `Aucune balise SEARCH/REPLACE détectée. L'IA a fourni un ${isSnippet ? 'snippet' : 'fichier complet'}.`,
                ...options
            );
        }

        try {
            if (!result || result.includes("Rejeter") || result.includes("Annuler")) {
            } else if (result.includes("Insérer au curseur")) {
                let editor = vscode.window.activeTextEditor;
                if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
                    editor = await vscode.window.showTextDocument(document);
                }
                const insertPos = editor.selection.active;

                let codeToInsert = codeContent;
                if (hasMarkers && patchCount === 0) {
                    const match = codeContent.match(/====\s*([\s\S]*?)\s*>>>>/);
                    if (match && match[1]) { codeToInsert = match[1]; }
                }

                await editor.edit(eb => eb.insert(insertPos, codeToInsert));
                this._highlightLines(editor, insertPos.line, insertPos.line + codeToInsert.split('\n').length - 1);
                vscode.window.showInformationMessage("Snippet inséré !");
            } else if (result.includes("Accepter")) {
                const oldText = document.getText();
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                    document.lineAt(0).range.start,
                    document.lineAt(document.lineCount - 1).range.end
                );
                edit.replace(document.uri, fullRange, previewText);
                await vscode.workspace.applyEdit(edit);
                await document.save();
                const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
                if (editor) { this._highlightChangedLines(editor, oldText, previewText); }
                vscode.window.showInformationMessage(`✅ Patch appliqué (${patchCount} bloc(s)) et sauvegardé !`);
            } else {
                const oldText = document.getText();
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                    document.lineAt(0).range.start,
                    document.lineAt(document.lineCount - 1).range.end
                );
                edit.replace(document.uri, fullRange, codeContent);
                await vscode.workspace.applyEdit(edit);
                await document.save();
                const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === document.uri.toString());
                if (editor) { this._highlightChangedLines(editor, oldText, codeContent); }
                vscode.window.showInformationMessage("🔄 Fichier remplacé et sauvegardé !");
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(`Erreur lors de l'application: ${e.message}`);
        }
    }

    private async _handleOpenFile(filePath: string) {
        const files = await vscode.workspace.findFiles(`**/${filePath}`, '**/node_modules/**', 1);
        if (files.length > 0) {
            const document = await vscode.workspace.openTextDocument(files[0]);
            await vscode.window.showTextDocument(document);
        } else {
            vscode.window.showErrorMessage(`Fichier introuvable : ${filePath}`);
        }
    }

    private async _getWorkspaceFiles(): Promise<string[]> {
        const files = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**}',
            200
        );
        return files
            .map(uri => vscode.workspace.asRelativePath(uri))
            .sort();
    }

    private _highlightLines(editor: vscode.TextEditor, startLine: number, endLine: number) {
        const decType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 120, 0.18)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(0, 255, 120, 0.6)',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
        });
        const ranges: vscode.Range[] = [];
        for (let i = startLine; i <= Math.min(endLine, editor.document.lineCount - 1); i++) {
            ranges.push(editor.document.lineAt(i).range);
        }
        editor.setDecorations(decType, ranges);
        setTimeout(() => decType.dispose(), 4000);
    }

    private _highlightChangedLines(editor: vscode.TextEditor, oldText: string, newText: string) {
        const oldLines = oldText.replace(/\r\n/g, '\n').split('\n');
        const newLines = newText.replace(/\r\n/g, '\n').split('\n');
        const changedLineNums: number[] = [];
        const maxLen = newLines.length;
        for (let i = 0; i < maxLen; i++) {
            if (newLines[i] !== oldLines[i]) {
                changedLineNums.push(i);
            }
        }
        if (changedLineNums.length === 0) { return; }
        const decType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 120, 0.18)',
            isWholeLine: true,
            overviewRulerColor: 'rgba(0, 255, 120, 0.6)',
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            after: { contentText: ' ✎ modifié par IA', color: 'rgba(0, 255, 120, 0.5)', fontStyle: 'italic', margin: '0 0 0 12px' }
        });
        const ranges = changedLineNums
            .filter(n => n < editor.document.lineCount)
            .map(n => editor.document.lineAt(n).range);
        editor.setDecorations(decType, ranges);
        setTimeout(() => decType.dispose(), 5000);
    }

    private async _handleRunCommand(command: string) {
        const result = await vscode.window.showInformationMessage(
            `Exécuter : ${command}`,
            "🚀 Exécuter", "Annuler"
        );
        if (result === "🚀 Exécuter") {
            const terminal = vscode.window.activeTerminal || vscode.window.createTerminal("Antigravity AI");
            terminal.show();
            terminal.sendText(command);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const logoUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'icon.png')
        );
        const bgUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'background.png')
        );
        const cspSource = webview.cspSource;

        const webviewScript: string = [
            "(function() {",
            "    const vscode = acquireVsCodeApi();",
            "    const chat = document.getElementById('chat');",
            "    const prompt = document.getElementById('prompt');",
            "    const send = document.getElementById('send');",
            "    const modelSelect = document.getElementById('modelSelect');",
            "    const clearChat = document.getElementById('clearChat');",
            "    const thinkingDiv = document.getElementById('thinking');",
            "    const connStatus = document.getElementById('connectionStatus');",
            "    let currentAiDiv = null;",
            "    let currentAiText = '';",
            "    let isWaiting = false;",
            "",
            "    function escapeHtml(t) {",
            "        return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');",
            "    }",
            "",
            "    function parseInlineMarkdown(text) {",
            "        return text",
            "            .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')",
            "            .replace(/\\*(.*?)\\*/g, '<em>$1</em>')",
            "            .replace(/`([^`]+)`/g, '<code>$1</code>')",
            "            .replace(/\\[FILE:\\s*([^\\]]+)\\]/g, function(_, p) {",
            "                const f = p.trim();",
            "                return '<span class=\"file-link\" data-file=\"'+escapeHtml(f)+'\">\\uD83D\\uDCC4 '+escapeHtml(f)+'</span>';",
            "            })",
            "            .replace(/\\[RUN:\\s*([^\\]]+)\\]/g, function(_, cmd) {",
            "                const c = cmd.trim();",
            "                return '<button class=\"run-btn\" data-cmd=\"'+escapeHtml(c)+'\">\uD83D\uDE80 '+escapeHtml(c)+'</button>';",
            "            });",
            "    }",
            "",
            "    function parseMarkdownBlock(text) {",
            "        text = text.replace(/^### (.*$)/gm, '<h3>$1</h3>');",
            "        text = text.replace(/^## (.*$)/gm, '<h3>$1</h3>');",
            "        text = parseInlineMarkdown(text);",
            "        text = text.replace(/^[ \\t]*[-*] (.+)$/gm, '<li>$1</li>');",
            "        text = text.replace(/^[ \\t]*\\d+\\. (.+)$/gm, '<li>$1</li>');",
            "        text = text.replace(/(<li>.*<\\/li>\\n?)+/g, function(m) { return '<ul>'+m+'</ul>'; });",
            "        text = text.replace(/\\n{2,}/g, '</p><p>');",
            "        text = text.replace(/\\n/g, '<br>');",
            "        return '<p>' + text + '</p>';",
            "    }",
            "",
            "    function renderMsgContent(div, rawText, type) {",
            "        div.innerHTML = '';",
            "        if (type !== 'ai') { div.textContent = rawText; return; }",
            "        var FENCE = '```';",
            "        var parts = rawText.split(FENCE);",
            "        parts.forEach(function(part, i) {",
            "            if (i % 2 === 1) {",
            "                var firstNL = part.indexOf('\\n');",
            "                var lang = firstNL > -1 ? part.substring(0, firstNL).trim() : '';",
            "                var code = firstNL > -1 ? part.substring(firstNL + 1) : part;",
            "                var codeBlock = document.createElement('div');",
            "                codeBlock.className = 'code-block';",
            "                var header = document.createElement('div');",
            "                header.className = 'code-header';",
            "                header.innerHTML = '<span class=\"code-lang\">'+(lang||'code')+'</span><div class=\"btn-group\"><button class=\"btn-copy\">Copier</button><button class=\"btn-apply\">Appliquer</button></div>';",
            "                codeBlock.appendChild(header);",
            "                var pre = document.createElement('pre');",
            "                pre.className = 'code-content';",
            "                pre.textContent = code.replace(/\\n$/, '');",
            "                codeBlock.appendChild(pre);",
            "                var capturedCode = code;",
            "                header.querySelector('.btn-copy').onclick = function() {",
            "                    var btn = this;",
            "                    navigator.clipboard.writeText(capturedCode).then(function() {",
            "                        btn.textContent = '\\u2713 Copi\\u00E9 !';",
            "                        setTimeout(function() { btn.textContent = 'Copier'; }, 2000);",
            "                    });",
            "                };",
            "                header.querySelector('.btn-apply').onclick = function() {",
            "                    vscode.postMessage({ type: 'applyToActiveFile', value: capturedCode });",
            "                    this.classList.add('btn-applied');",
            "                    this.textContent = '\\u2713 Envoy\\u00E9';",
            "                };",
            "                div.appendChild(codeBlock);",
            "            } else {",
            "                var container = document.createElement('div');",
            "                container.innerHTML = parseMarkdownBlock(part);",
            "                container.querySelectorAll('.file-link').forEach(function(el) {",
            "                    el.addEventListener('click', function() {",
            "                        vscode.postMessage({ type: 'openFile', value: el.getAttribute('data-file') });",
            "                    });",
            "                });",
            "                container.querySelectorAll('.run-btn').forEach(function(el) {",
            "                    el.addEventListener('click', function() {",
            "                        vscode.postMessage({ type: 'runCommand', value: el.getAttribute('data-cmd') });",
            "                    });",
            "                });",
            "                div.appendChild(container);",
            "            }",
            "        });",
            "    }",
            "",
            "    function addMsg(text, type) {",
            "        var div = document.createElement('div');",
            "        div.className = 'msg ' + type;",
            "        chat.appendChild(div);",
            "        renderMsgContent(div, text, type);",
            "        requestAnimationFrame(function() { chat.scrollTop = chat.scrollHeight; });",
            "        return div;",
            "    }",
            "",
            "    function setWaiting(waiting) {",
            "        isWaiting = waiting;",
            "        send.disabled = waiting;",
            "        thinkingDiv.style.display = waiting ? 'block' : 'none';",
            "    }",
            "",
            "    prompt.addEventListener('input', function() {",
            "        this.style.height = 'auto';",
            "        this.style.height = Math.min(this.scrollHeight, 160) + 'px';",
            "    });",
            "",
            "    function sendMessage() {",
            "        var val = prompt.value.trim();",
            "        if (!val || isWaiting) { return; }",
            "        addMsg(val, 'user');",
            "        setWaiting(true);",
            "        vscode.postMessage({ type: 'sendMessage', value: val, model: modelSelect.value });",
            "        prompt.value = '';",
            "        prompt.style.height = 'auto';",
            "    }",
            "",
            "    send.onclick = sendMessage;",
            "    prompt.addEventListener('keydown', function(e) {",
            "        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }",
            "    });",
            "    clearChat.onclick = function() {",
            "        if (isWaiting) { return; }",
            "        chat.innerHTML = '';",
            "        vscode.postMessage({ type: 'clearHistory' });",
            "    };",
            "",
            "    window.addEventListener('message', function(event) {",
            "        var m = event.data;",
            "        switch (m.type) {",
            "            case 'startResponse':",
            "                setWaiting(false);",
            "                currentAiText = '';",
            "                currentAiDiv = addMsg('', 'ai');",
            "                break;",
            "            case 'partialResponse':",
            "                if (currentAiDiv) {",
            "                    currentAiText += m.value;",
            "                    if (!currentAiDiv._streamEl) {",
            "                        currentAiDiv.innerHTML = '';",
            "                        var streamPre = document.createElement('pre');",
            "                        streamPre.style.cssText = 'white-space:pre-wrap;word-break:break-word;margin:0;font-family:inherit;font-size:inherit;color:inherit;';",
            "                        currentAiDiv._streamEl = streamPre;",
            "                        currentAiDiv.appendChild(streamPre);",
            "                    }",
            "                    currentAiDiv._streamEl.textContent = currentAiText;",
            "                    chat.scrollTop = chat.scrollHeight;",
            "                }",
            "                break;",
            "            case 'endResponse':",
            "                if (currentAiDiv) { currentAiDiv._streamEl = null; if (m.value) { renderMsgContent(currentAiDiv, m.value, 'ai'); } }",
            "                currentAiDiv = null; currentAiText = ''; setWaiting(false);",
            "                break;",
            "            case 'setModels':",
            "                modelSelect.innerHTML = '';",
            "                if (m.models && m.models.length > 0) {",
            "                    m.models.forEach(function(mod) {",
            "                        var opt = document.createElement('option');",
            "                        opt.value = mod; opt.textContent = mod;",
            "                        if (mod === m.selected) { opt.selected = true; }",
            "                        modelSelect.appendChild(opt);",
            "                    });",
            "                    connStatus.textContent = '\\u25CF Connect\\u00E9';",
            "                    connStatus.className = 'status-ok';",
            "                } else {",
            "                    var opt = document.createElement('option');",
            "                    opt.textContent = 'Aucun mod\\u00E8le';",
            "                    modelSelect.appendChild(opt);",
            "                    connStatus.textContent = '\\u25CF Hors ligne';",
            "                    connStatus.className = 'status-err';",
            "                }",
            "                break;",
            "            case 'restoreHistory':",
            "                chat.innerHTML = '';",
            "                if (m.history && m.history.length > 0) {",
            "                    m.history.forEach(function(msg) { addMsg(msg.value, msg.role); });",
            "                }",
            "                break;",
            "            case 'injectMessage':",
            "                if (m.value) {",
            "                    prompt.value = m.value;",
            "                    prompt.dispatchEvent(new Event('input'));",
            "                    prompt.focus();",
            "                }",
            "                break;",
            "        }",
            "    });",
            "",
            "    vscode.postMessage({ type: 'getModels' });",
            "    vscode.postMessage({ type: 'restoreHistory' });",
            "})();"
        ].join("\n");

        return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
    <style>
        * { box-sizing: border-box; }
        body { font-family: 'Inter', system-ui, sans-serif; margin: 0; padding: 0; color: #e0e0e0; background: #000; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
        .space-bg { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: radial-gradient(circle at 50% 50%, rgba(26,26,46,0.4) 0%, #000 100%), url('${bgUri}'); background-size: cover; background-position: center; filter: brightness(0.5) contrast(1.1); z-index: -2; }
        .black-hole { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 450px; height: 450px; background: #000; border-radius: 50%; box-shadow: 0 0 100px 30px rgba(0,150,255,0.2), inset 0 0 80px rgba(255,0,150,0.15); z-index: -1; filter: blur(2px); animation: swirl 30s linear infinite; opacity: 0.8; }
        @keyframes swirl { 0%{transform:translate(-50%,-50%) rotate(0deg) scale(1);} 50%{transform:translate(-50%,-50%) rotate(180deg) scale(1.05);} 100%{transform:translate(-50%,-50%) rotate(360deg) scale(1);} }
        .container { display: flex; flex-direction: column; height: 100%; position: relative; z-index: 10; background: rgba(0,0,0,0.3); }
        .header { padding: 10px 14px; background: rgba(0,0,0,0.75); backdrop-filter: blur(15px); border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
        .logo-container { display: flex; align-items: center; gap: 8px; }
        .logo { width: 22px; height: 22px; border-radius: 4px; }
        .header-title { font-weight: 800; font-size: 14px; letter-spacing: 1px; color: #fff; }
        .header-controls { display: flex; gap: 6px; align-items: center; }
        #modelSelect { background: #111; color: #00d2ff; border: 1px solid rgba(0,210,255,0.25); border-radius: 6px; font-size: 10px; padding: 4px 8px; cursor: pointer; outline: none; max-width: 130px; }
        #clearChat { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: #aaa; cursor: pointer; font-size: 10px; padding: 4px 10px; border-radius: 6px; transition: 0.2s; }
        #clearChat:hover { background: rgba(255,80,80,0.15); color: #ff6b6b; border-color: rgba(255,80,80,0.3); }
        #connectionStatus { font-size: 9px; padding: 2px 6px; border-radius: 10px; font-weight: 600; }
        .status-ok { background: rgba(0,255,100,0.15); color: #00ff64; border: 1px solid rgba(0,255,100,0.3); }
        .status-err { background: rgba(255,80,80,0.15); color: #ff6b6b; border: 1px solid rgba(255,80,80,0.3); }
        #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
        .msg { max-width: 92%; padding: 12px 16px; border-radius: 12px; line-height: 1.65; font-size: 13px; border: 1px solid rgba(255,255,255,0.12); backdrop-filter: blur(12px); word-break: break-word; }
        .user { align-self: flex-end; background: rgba(0,110,200,0.4); border-color: rgba(0,150,255,0.3); box-shadow: 0 4px 15px rgba(0,0,0,0.4); white-space: pre-wrap; }
        .ai { align-self: flex-start; background: rgba(20,20,28,0.88); border-color: rgba(255,255,255,0.12); box-shadow: 0 4px 15px rgba(0,0,0,0.4); }
        .msg h3 { font-size: 1.05em; color: #00d2ff; margin: 10px 0 5px 0; border-bottom: 1px solid rgba(0,210,255,0.2); padding-bottom: 2px; }
        .msg p { margin: 6px 0; } .msg ul,.msg ol { padding-left: 18px; margin: 6px 0; } .msg li { margin: 3px 0; }
        .msg strong { color: #ff79c6; font-weight: 600; } .msg em { color: #8be9fd; }
        .msg code { background: rgba(255,255,255,0.1); padding: 1px 5px; border-radius: 3px; font-family: 'Fira Code',monospace; font-size: 11.5px; color: #f1fa8c; }
        .code-block { background: #0d0d12; border-radius: 8px; margin: 10px 0; border: 1px solid #2a2a3a; overflow: hidden; }
        .code-header { background: #16161e; padding: 6px 12px; border-bottom: 1px solid #2a2a3a; display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: #888; }
        .code-lang { font-weight: 600; color: #00d2ff; text-transform: uppercase; letter-spacing: 0.5px; }
        .code-content { padding: 12px; overflow-x: auto; font-family: 'Fira Code','Cascadia Code',monospace; font-size: 12px; color: #dcdcdc; margin: 0; white-space: pre; }
        .btn-group { display: flex; gap: 5px; }
        .btn-copy,.btn-apply { border: 1px solid #444; color: #ccc; cursor: pointer; padding: 2px 8px; border-radius: 4px; font-size: 10px; transition: 0.2s; }
        .btn-copy { background: rgba(255,255,255,0.05); } .btn-copy:hover { background: rgba(255,255,255,0.12); }
        .btn-apply { background: rgba(0,210,255,0.15); color: #00d2ff; border-color: rgba(0,210,255,0.3); } .btn-apply:hover { background: rgba(0,210,255,0.3); }
        .btn-applied { background: rgba(0,255,150,0.15) !important; color: #00ff96 !important; border-color: rgba(0,255,150,0.3) !important; }
        .file-link { color: #00d2ff; cursor: pointer; text-decoration: underline; font-weight: 600; background: rgba(0,210,255,0.1); padding: 0 4px; border-radius: 3px; font-size: 12px; }
        .file-link:hover { background: rgba(0,210,255,0.2); }
        .run-btn { background: rgba(233,30,99,0.3); color: #ff79c6; border: 1px solid rgba(233,30,99,0.4); padding: 2px 8px; border-radius: 5px; cursor: pointer; font-size: 10px; margin: 1px; font-weight: 700; transition: 0.2s; }
        .run-btn:hover { background: rgba(233,30,99,0.5); }
        .input-container { padding: 14px; background: rgba(8,8,14,0.96); border-top: 1px solid rgba(255,255,255,0.1); display: flex; gap: 10px; align-items: flex-end; backdrop-filter: blur(20px); flex-shrink: 0; }
        #prompt { flex: 1; background: #0e0e18; border: 1px solid #334; color: #e0e0e0; padding: 10px 13px; border-radius: 10px; outline: none; resize: none; font-size: 13px; min-height: 42px; max-height: 160px; transition: border-color 0.2s; font-family: inherit; line-height: 1.5; overflow-y: auto; }
        #prompt::placeholder { color: #556; } #prompt:focus { border-color: #0096ff; box-shadow: 0 0 10px rgba(0,150,255,0.15); }
        #send { background: linear-gradient(135deg,#0096ff,#0055e0); border: none; color: white; padding: 10px 18px; border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 12px; transition: 0.2s; flex-shrink: 0; height: 42px; }
        #send:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(0,150,255,0.45); } #send:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .thinking-container { display: flex; align-items: center; gap: 10px; color: #00d2ff; font-size: 11.5px; padding: 10px 16px; opacity: 0.85; font-weight: 600; flex-shrink: 0; }
        .pulsar { width: 8px; height: 8px; background: #00d2ff; border-radius: 50%; animation: pulse 1.2s infinite; box-shadow: 0 0 8px #00d2ff; flex-shrink: 0; }
        @keyframes pulse { 0%{opacity:0.4;transform:scale(0.9);} 50%{opacity:1;transform:scale(1.2);} 100%{opacity:0.4;transform:scale(0.9);} }
    </style>
</head>
<body>
    <div class="space-bg"></div>
    <div class="black-hole"></div>
    <div class="container">
        <div class="header">
            <div class="logo-container">
                <img src="${logoUri}" class="logo" onerror="this.style.display='none'">
                <span class="header-title">ANTIGRAVITY</span>
            </div>
            <div class="header-controls">
                <span id="connectionStatus">&#9679;</span>
                <select id="modelSelect"><option>Chargement...</option></select>
                <button id="clearChat">Effacer</button>
            </div>
        </div>
        <div id="chat"></div>
        <div id="thinking" style="display:none;">
            <div class="thinking-container"><div class="pulsar"></div><span>L'IA analyse...</span></div>
        </div>
        <div class="input-container">
            <textarea id="prompt" placeholder="D\u00E9cris une t\u00E2che, pose une question ou demande une modification..." rows="1"></textarea>
            <button id="send">ENVOYER</button>
        </div>
    </div>
    <script>${webviewScript}</script>
</body>
</html>`;
    }
}