"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserSession = void 0;
const grpc = __importStar(require("@grpc/grpc-js"));
const bc_1 = require("../generated/bc");
const browser_controls_1 = require("./browser-controls");
const vimium_1 = require("./vimium");
const input_diagnostics_1 = require("./input-diagnostics");
const capture_diagnostics_1 = require("./capture-diagnostics");
function stale() {
    const metadata = new grpc.Metadata();
    metadata.set('termium-reason', 'stale-target');
    throw Object.assign(Error('Tab or page changed; input was cancelled'), { code: grpc.status.FAILED_PRECONDITION, metadata });
}
// The Chromium tab target is stable across page-target swaps (including BFCache).
// Puppeteer 25.10 exposes it internally as _tabId. Keep that dependency here,
// guard it against actual CDP metadata, and exercise it in native integration CI.
function tabId(page) {
    const id = page._tabId;
    if (!id)
        throw Error('Unsupported Puppeteer tab identity; use the packaged runtime');
    return id;
}
class BrowserSession {
    constructor(openBrowser, onPage = () => { }, homepage = () => 'about:termium') {
        this.openBrowser = openBrowser;
        this.onPage = onPage;
        this.homepage = homepage;
        this.records = new Map();
        this.selected = '';
        this.documentGeneration = -1;
        this.epoch = 0;
        this.tail = Promise.resolve();
        this.vimiumStatus = 'Vimium';
        this.viewport = { width: 800, height: 600 };
    }
    async init() {
        if (!this.initializing)
            this.initializing = (async () => {
                this.browser = await this.openBrowser();
                this.cdp = await this.browser.target().createCDPSession();
                this.vimium = new vimium_1.Vimium(this.browser, this.homepage());
                await this.vimium.install();
            })();
        await this.initializing;
    }
    async snapshot() {
        await this.init();
        // A caller arriving after a tab mutation must not reuse a read that
        // began before that mutation. Share only the next fresh snapshot.
        if (this.refreshing)
            await this.refreshing;
        if (!this.refreshing)
            this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
        return this.refreshing;
    }
    async refresh() {
        let pages = await this.browser.pages();
        const replacement = !pages.length;
        if (replacement) {
            const page = await this.browser.newPage();
            pages = [page];
        }
        const { targetInfos } = await this.cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
        const byId = new Map(pages.filter(p => !p.isClosed()).map(p => [tabId(p), p]));
        const infos = targetInfos.filter(info => byId.has(info.targetId));
        if (!infos.length)
            throw Error('Browser tab list is changing; retry');
        for (const info of infos) {
            if (typeof info.embedderData?.tabActive !== 'boolean' || !Number.isInteger(info.embedderData?.tabStripIndex)) {
                throw Error('This browser lacks tab metadata; use Termium’s packaged Chromium');
            }
            if (!this.records.has(info.targetId)) {
                const page = byId.get(info.targetId);
                const controls = new browser_controls_1.BrowserControls(async () => page);
                const { windowId } = await this.cdp.send('Browser.getWindowForTarget', { targetId: info.targetId });
                const tab = { id: info.targetId, page, controls, window: windowId };
                this.onPage(page, tab.id);
                await controls.attach(page);
                this.records.set(tab.id, tab);
                page.on('framenavigated', frame => this.vimium.forget(frame));
                page.on('close', () => {
                    this.records.delete(tab.id);
                    if (this.selected === tab.id) {
                        this.selected = '';
                        this.epoch++;
                    }
                });
            }
        }
        infos.sort((a, b) => this.records.get(a.targetId).window - this.records.get(b.targetId).window ||
            a.embedderData.tabStripIndex - b.embedderData.tabStripIndex);
        let candidates = infos.filter(info => info.embedderData.tabActive);
        if (candidates.length > 1) {
            const window = await this.vimium.evaluate(async () => (await globalThis.chrome.windows.getLastFocused()).id, undefined);
            candidates = candidates.filter(info => this.records.get(info.targetId).window === window);
        }
        if (candidates.length !== 1)
            throw Error('Browser is switching tabs; retry');
        const active = this.records.get(candidates[0].targetId);
        if (replacement)
            await this.openHome(active);
        if (this.selected !== active.id || this.documentGeneration !== active.controls.generation) {
            const old = this.records.get(this.selected);
            this.selected = active.id;
            this.documentGeneration = active.controls.generation;
            this.vimiumStatus = 'Vimium';
            this.epoch++;
            if (old && old !== active)
                await old.controls.resetInput().catch(() => { });
        }
        return { active, tabs: infos.map(info => this.records.get(info.targetId)), generation: this.epoch,
            titles: new Map(infos.map(info => [info.targetId, info.title])) };
    }
    async ensurePage() { return (await this.snapshot()).active.page; }
    async state() {
        for (let attempt = 0;; attempt++) {
            try {
                return await this.readState();
            }
            catch (error) {
                // Tab closure/activation can precede Puppeteer's target update.
                // Retry only the read, never the input or command that caused it.
                if (attempt >= 20 || !/Target closed|Session closed|No target with given id|Not attached to an active page|tab list is changing|switching tabs/.test(error.message))
                    throw error;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    }
    async readState() {
        const s = await this.snapshot();
        const state = await s.active.controls.state();
        const after = await this.snapshot();
        if (after.generation !== s.generation || after.active.id !== s.active.id)
            throw Error('Browser is switching tabs; retry');
        return { ...state, generation: s.generation, activeTabId: s.active.id, vimiumStatus: this.vimiumStatus,
            tabs: s.tabs.map(tab => ({ id: tab.id, title: s.titles.get(tab.id) || 'New tab', url: tab.page.url(),
                active: tab.id === s.active.id, loading: tab.controls.isLoading() })) };
    }
    enqueue(action) {
        const work = this.tail.then(action);
        this.tail = work.catch(() => { });
        return work;
    }
    command(request) {
        return this.enqueue(async () => {
            const s = await this.snapshot();
            const targeted = request.tabId ? s.tabs.find(t => t.id === request.tabId) : s.active;
            if (!targeted)
                stale();
            if (request.generation && request.generation !== s.generation)
                stale();
            switch (request.action) {
                case bc_1.NavigationAction.HOME:
                    if (targeted !== s.active)
                        stale();
                    await this.openHome(s.active);
                    break;
                case bc_1.NavigationAction.NEW_TAB: {
                    if (request.url) {
                        let url;
                        try {
                            url = new URL(request.url);
                        }
                        catch {
                            throw Object.assign(Error('Enter a valid HTTP or HTTPS address'), { code: grpc.status.INVALID_ARGUMENT });
                        }
                        if (!['http:', 'https:'].includes(url.protocol))
                            throw Object.assign(Error('Use an HTTP or HTTPS address'), { code: grpc.status.INVALID_ARGUMENT });
                    }
                    const p = await this.browser.newPage();
                    await p.bringToFront();
                    const created = await this.snapshot();
                    const ownTab = created.tabs.find(tab => tab.id === tabId(p));
                    if (!ownTab)
                        throw Error('New tab disappeared before navigation');
                    if (request.url)
                        await ownTab.controls.command({ ...request, action: bc_1.NavigationAction.NAVIGATE, generation: 0 });
                    else
                        await this.openHome(ownTab);
                    break;
                }
                case bc_1.NavigationAction.SELECT_TAB:
                    await targeted.page.bringToFront();
                    break;
                case bc_1.NavigationAction.CLOSE_TAB:
                    // Page.close with runBeforeUnload keeps cancellation usable.
                    await targeted.page.close({ runBeforeUnload: true });
                    break;
                case bc_1.NavigationAction.REOPEN_TAB:
                    await this.vimium.evaluate(async () => {
                        const chrome = globalThis.chrome;
                        const recent = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
                        if (recent.length)
                            await chrome.sessions.restore(recent[0].tab?.sessionId ?? recent[0].window?.sessionId);
                    }, undefined);
                    break;
                default:
                    if (targeted !== s.active)
                        stale();
                    await s.active.controls.command({ ...request, generation: 0 });
            }
            return this.state();
        });
    }
    async openHome(tab) {
        await tab.controls.resetInput();
        if (this.vimium.home === this.vimium.welcome) {
            await tab.page.goto(this.vimium.home, { waitUntil: 'domcontentloaded', timeout: 5000 });
        }
        else {
            await tab.controls.command({ action: bc_1.NavigationAction.NAVIGATE, url: this.vimium.home, tabId: tab.id, generation: 0 });
        }
    }
    input(event) {
        return (0, input_diagnostics_1.traceInput)(event, () => this.enqueue(async () => {
            (0, input_diagnostics_1.inputTrace)('dequeued');
            const s = await this.snapshot();
            (0, input_diagnostics_1.inputTrace)('selection', { tab: s.active.id, generation: s.generation });
            if ((event.tabId && event.tabId !== s.active.id) || (event.generation && event.generation !== s.generation)) {
                const old = this.records.get(event.tabId);
                if (old)
                    await old.controls.resetInput();
                stale();
            }
            if ([bc_1.InputKind.KEY_INPUT, bc_1.InputKind.TEXT_INPUT].includes(event.kind)) {
                (0, input_diagnostics_1.inputTrace)('vimium.begin');
                try {
                    this.vimiumStatus = await this.vimium.waitForPage(s.active.page);
                    (0, input_diagnostics_1.inputTrace)('vimium.ready');
                }
                catch (error) {
                    this.vimiumStatus = error.message;
                    throw error;
                }
            }
            try {
                await s.active.controls.input({ ...event, generation: 0 });
            }
            catch (error) {
                // x may close its own target before the key-up acknowledges.
                // Never retry that input on the replacement tab.
                if (!s.active.page.isClosed()) {
                    if (!/Target closed|Session closed/.test(error.message))
                        throw error;
                    // CDP can report closure before Puppeteer updates isClosed.
                    // Confirm the tab disappeared using a fresh read; never
                    // replay the event or mask an error on a surviving tab.
                    const after = await this.state();
                    if (after.tabs.some(tab => tab.id === s.active.id))
                        throw error;
                    return after;
                }
            }
            return this.state();
        }));
    }
    async setViewport(width, height) {
        const s = await this.snapshot();
        await s.active.controls.setViewport(width, height);
        this.viewport = { width, height };
    }
    captureSelection() {
        const active = this.records.get(this.selected);
        if (!active || active.page.isClosed())
            return undefined;
        // Navigation can precede the next state poll. Observe its local epoch
        // without querying Chromium, just as refresh() does for this document.
        if (this.documentGeneration !== active.controls.generation) {
            this.documentGeneration = active.controls.generation;
            this.vimiumStatus = 'Vimium';
            this.epoch++;
        }
        return { active, generation: this.epoch };
    }
    async capture(format) {
        // The client independently polls state, including while images are
        // unchanged or capture is paused. Only cold/closed selection needs a
        // discovery read here. Freeze provenance before any capture awaits.
        const selection = (0, capture_diagnostics_1.beginCapturePhase)('server.selection');
        const s = this.captureSelection() ?? await this.snapshot();
        (0, capture_diagnostics_1.endCapturePhase)(selection);
        const viewport = (0, capture_diagnostics_1.beginCapturePhase)('server.viewport');
        try {
            await s.active.controls.setViewport(this.viewport.width, this.viewport.height);
        }
        finally {
            (0, capture_diagnostics_1.endCapturePhase)(viewport);
        }
        let data;
        try {
            data = await s.active.controls.capture(format);
        }
        catch (error) {
            if (s.active.page.isClosed() || /Target closed|Session closed/.test(error.message))
                stale();
            throw error;
        }
        // A transitional frame is acceptable; never stamp it with a later
        // selection's epoch or replay toolbar metadata through screenshots.
        return { data, generation: s.generation, tabId: s.active.id };
    }
}
exports.BrowserSession = BrowserSession;
