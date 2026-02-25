import * as vscode from 'vscode';

export type TaskType = 'chat' | 'code' | 'vision' | 'commit' | 'agent';

export interface ProviderCapabilities {
    vision: boolean;
    streaming: boolean;
    maxContextK: number;
    freeDefault: boolean;
}

export interface ProviderHealth {
    url: string;
    name: string;
    provider: string;
    available: boolean;
    latencyMs: number;
    errorRate: number;
    rateLimitedUntil: number;
    lastChecked: number;
    totalRequests: number;
    totalErrors: number;
    totalTokens: number;
    capabilities: ProviderCapabilities;
}

export interface RouterStats {
    providers: ProviderHealth[];
    totalRequests: number;
    totalFailovers: number;
    queueLength: number;
    lastUpdated: number;
}

export interface QueuedRequest {
    id: string;
    task: TaskType;
    resolve: (providerUrl: string) => void;
    reject: (err: Error) => void;
    createdAt: number;
    timeoutMs: number;
}

const PROVIDER_CAPS: Record<string, ProviderCapabilities> = {
    'local': { vision: true, streaming: true, maxContextK: 32, freeDefault: true },
    'gemini': { vision: true, streaming: true, maxContextK: 128, freeDefault: true },
    'openai': { vision: true, streaming: true, maxContextK: 128, freeDefault: false },
    'openrouter': { vision: true, streaming: true, maxContextK: 128, freeDefault: true },
    'together': { vision: false, streaming: true, maxContextK: 32, freeDefault: false },
    'mistral': { vision: false, streaming: true, maxContextK: 32, freeDefault: false },
    'groq': { vision: false, streaming: true, maxContextK: 32, freeDefault: false },
    'anthropic': { vision: true, streaming: true, maxContextK: 200, freeDefault: false },
    'ollama-cloud': { vision: true, streaming: true, maxContextK: 32, freeDefault: false },
};

export const FREE_MODELS: Record<string, string[]> = {
    'gemini': ['gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-2.0-flash'],
    'openrouter': [],
    'groq': ['llama-3.1-8b-instant', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
    'local': [],
};

export class ProviderRouter {
    private _health = new Map<string, ProviderHealth>();
    private _queue: QueuedRequest[] = [];
    private _queueTimer?: NodeJS.Timeout;
    private _stats: RouterStats = {
        providers: [],
        totalRequests: 0,
        totalFailovers: 0,
        queueLength: 0,
        lastUpdated: Date.now(),
    };
    private _onStatsChanged?: (stats: RouterStats) => void;

    registerProvider(url: string, name: string, provider: string, apiKey?: string) {
        const key = this._urlKey(url);
        if (!this._health.has(key)) {
            this._health.set(key, {
                url,
                name,
                provider,
                available: true,
                latencyMs: 0,
                errorRate: 0,
                rateLimitedUntil: 0,
                lastChecked: 0,
                totalRequests: 0,
                totalErrors: 0,
                totalTokens: 0,
                capabilities: PROVIDER_CAPS[provider] ?? PROVIDER_CAPS['ollama-cloud'],
            });
        }
        this._syncStats();
    }

    unregisterProvider(url: string) {
        this._health.delete(this._urlKey(url));
        this._syncStats();
    }

    async selectProvider(
        task: TaskType,
        preferredUrl?: string,
        requireVision: boolean = false
    ): Promise<string> {
        this._stats.totalRequests++;

        const now = Date.now();
        const candidates = Array.from(this._health.values())
            .filter(h => {
                if (h.rateLimitedUntil > now) return false;
                if (!h.available) return false;
                if (requireVision && !h.capabilities.vision) return false;
                return true;
            });

        if (candidates.length === 0) {
            return this._enqueueRequest(task, requireVision);
        }

        if (preferredUrl) {
            const preferred = candidates.find(c => this._urlKey(c.url) === this._urlKey(preferredUrl));
            if (preferred) return preferred.url;
        }

        const scored = candidates.map(h => ({
            h,
            score: this._score(h, task),
        })).sort((a, b) => b.score - a.score);

        return scored[0].h.url;
    }

    private _score(h: ProviderHealth, task: TaskType): number {
        let score = 100;
        score -= Math.min(30, h.latencyMs / 100);
        score -= h.errorRate * 40;
        if (h.provider === 'local') score += 20;
        if (task === 'agent' && h.capabilities.maxContextK >= 100) score += 15;
        if (task === 'vision' && h.capabilities.vision) score += 25;
        if (h.capabilities.freeDefault) score += 10;
        return score;
    }

    reportSuccess(url: string, latencyMs: number, tokensUsed: number = 0) {
        const h = this._health.get(this._urlKey(url));
        if (!h) return;
        h.latencyMs = Math.round((h.latencyMs * 0.8) + (latencyMs * 0.2));
        h.totalRequests++;
        h.totalTokens += tokensUsed;
        h.available = true;
        h.lastChecked = Date.now();
        h.errorRate = Math.max(0, h.errorRate - 0.05);
        this._syncStats();
        this._drainQueue();
    }

    reportError(url: string, isRateLimit: boolean = false, cooldownMs: number = 60_000) {
        const h = this._health.get(this._urlKey(url));
        if (!h) return;
        h.totalRequests++;
        h.totalErrors++;
        h.errorRate = Math.min(1, h.errorRate + 0.2);
        h.lastChecked = Date.now();
        if (isRateLimit) {
            h.rateLimitedUntil = Date.now() + cooldownMs;
            h.available = true;
        } else if (h.errorRate > 0.6) {
            h.available = false;
        }
        this._stats.totalFailovers++;
        this._syncStats();
    }

    reportRateLimit(url: string, retryAfterMs?: number) {
        this.reportError(url, true, retryAfterMs ?? 60_000);
    }

    setAvailable(url: string, available: boolean) {
        const h = this._health.get(this._urlKey(url));
        if (h) { h.available = available; this._syncStats(); }
    }

    getBestFreeModel(providerKey: string): string | null {
        const models = FREE_MODELS[providerKey];
        if (!models || models.length === 0) return null;
        return models[0];
    }

    getCapabilities(url: string): ProviderCapabilities | null {
        const h = this._health.get(this._urlKey(url));
        return h?.capabilities ?? null;
    }

    supportsVision(url: string): boolean {
        return this.getCapabilities(url)?.vision ?? false;
    }

    private _enqueueRequest(task: TaskType, requireVision: boolean): Promise<string> {
        return new Promise((resolve, reject) => {
            const id = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const entry: QueuedRequest = {
                id, task, resolve, reject,
                createdAt: Date.now(),
                timeoutMs: 120_000,
            };
            this._queue.push(entry);
            this._stats.queueLength = this._queue.length;
            this._syncStats();

            setTimeout(() => {
                const idx = this._queue.findIndex(q => q.id === id);
                if (idx >= 0) {
                    this._queue.splice(idx, 1);
                    this._stats.queueLength = this._queue.length;
                    this._syncStats();
                    reject(new Error('Tous les providers sont indisponibles. Réessayez dans quelques instants.'));
                }
            }, entry.timeoutMs);

            if (!this._queueTimer) {
                this._queueTimer = setInterval(() => this._drainQueue(), 5_000);
            }
        });
    }

    private _drainQueue() {
        if (this._queue.length === 0) {
            if (this._queueTimer) { clearInterval(this._queueTimer); this._queueTimer = undefined; }
            return;
        }
        const now = Date.now();
        const available = Array.from(this._health.values())
            .filter(h => h.available && h.rateLimitedUntil <= now);

        if (available.length === 0) return;

        const best = available.sort((a, b) => this._score(b, 'chat') - this._score(a, 'chat'))[0];
        const next = this._queue.shift();
        if (next) {
            this._stats.queueLength = this._queue.length;
            this._syncStats();
            next.resolve(best.url);
        }
    }

    onStatsChanged(cb: (stats: RouterStats) => void) {
        this._onStatsChanged = cb;
    }

    getStats(): RouterStats {
        return { ...this._stats };
    }

    getProviderHealth(url: string): ProviderHealth | undefined {
        return this._health.get(this._urlKey(url));
    }

    getAllHealth(): ProviderHealth[] {
        return Array.from(this._health.values());
    }

    getCooldownSummary(): string {
        const now = Date.now();
        const cooled = Array.from(this._health.values())
            .filter(h => h.rateLimitedUntil > now)
            .map(h => `${h.name}: ${Math.ceil((h.rateLimitedUntil - now) / 1000)}s`);
        return cooled.length > 0 ? cooled.join(', ') : 'Aucun cooldown actif';
    }

    private _syncStats() {
        this._stats.providers = Array.from(this._health.values());
        this._stats.queueLength = this._queue.length;
        this._stats.lastUpdated = Date.now();
        this._onStatsChanged?.(this.getStats());
    }

    private _urlKey(url: string): string {
        return (url || '').replace(/\/+$/, '').toLowerCase();
    }

    async pingProvider(url: string, apiKey?: string): Promise<{ ok: boolean; latencyMs: number }> {
        const t0 = Date.now();
        const isOpenAI = url.includes('together') || url.includes('openrouter') || url.endsWith('/v1');
        const isGemini = url.includes('generativelanguage.googleapis.com');
        let endpoint = isOpenAI ? `${url}/models` : `${url}/api/tags`;
        if (isGemini && apiKey) endpoint = `${url}/models?key=${apiKey}`;
        try {
            const headers: Record<string, string> = {};
            if (apiKey && !isGemini) headers['Authorization'] = `Bearer ${apiKey}`;
            const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(4000) });
            const latencyMs = Date.now() - t0;
            const h = this._health.get(this._urlKey(url));
            if (h) {
                h.latencyMs = latencyMs;
                h.available = res.ok;
                h.lastChecked = Date.now();
                this._syncStats();
            }
            return { ok: res.ok, latencyMs };
        } catch {
            const h = this._health.get(this._urlKey(url));
            if (h) { h.available = false; h.lastChecked = Date.now(); this._syncStats(); }
            return { ok: false, latencyMs: Date.now() - t0 };
        }
    }

    dispose() {
        if (this._queueTimer) clearInterval(this._queueTimer);
        this._queue.forEach(q => q.reject(new Error('Router disposed')));
        this._queue = [];
    }
}
