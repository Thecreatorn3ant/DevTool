import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';
import { ChatViewProvider } from './chatViewProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('[Antigravity] Extension activée');

    const ollamaClient = new OllamaClient();
    const chatProvider = new ChatViewProvider(context, ollamaClient);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.openChat', () => {
            vscode.commands.executeCommand('local-ai.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.sendSelectionToChat', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Aucun éditeur actif.');
                return;
            }
            const selection = editor.selection;
            const selectedText = editor.document.getText(selection);
            if (!selectedText) {
                vscode.window.showWarningMessage('Aucun texte sélectionné.');
                return;
            }
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.sendMessageFromEditor(`Explique ce code :\n\`\`\`\n${selectedText}\n\`\`\``);
            }, 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.explainFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('Aucun fichier actif.');
                return;
            }
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.sendMessageFromEditor('Explique le fichier actif et son rôle dans le projet.');
            }, 300);
        })
    );

    ollamaClient.checkConnection().then(connected => {
        if (!connected) {
            vscode.window.showWarningMessage(
                'Antigravity: Ollama semble inaccessible. Assurez-vous qu\'Ollama est lancé.',
                'OK'
            );
        }
    });
}

export function deactivate() {
    console.log('[Antigravity] Extension désactivée');
}