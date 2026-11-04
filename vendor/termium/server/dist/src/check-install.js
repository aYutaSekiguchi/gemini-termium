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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const puppeteer_1 = __importDefault(require("puppeteer"));
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const browser_session_1 = require("./browser-session");
const bc_1 = require("../generated/bc");
const browser_controls_1 = require("./browser-controls");
// A disposable profile checks the actual packaged browser. No user browsing
// data, external website, or running Termium server participates in validation.
async function check() {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'termium-check-'));
    const abort = new AbortController();
    let browser;
    const timer = setTimeout(() => {
        abort.abort();
        browser?.process()?.kill('SIGKILL');
        console.error('Browser validation timed out');
        process.exitCode = 1;
    }, 30000);
    try {
        browser = await puppeteer_1.default.launch({ headless: true, pipe: true, enableExtensions: true, signal: abort.signal, dumpio: process.env.TERMIUM_CHECK_DEBUG === '1', args: ['--lang=en-US'],
            env: { ...process.env, XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_CACHE_HOME: path.join(temporary, 'cache') } });
        let page = await browser.newPage();
        page.setDefaultTimeout(5000);
        if (process.platform === 'linux') {
            await page.goto('chrome://sandbox');
            const status = await page.evaluate(() => document.body.innerText);
            if (!/adequately sandboxed/i.test(status) || !/Seccomp-BPF sandbox\s+Yes/.test(status)) {
                throw new Error(`Browser sandbox validation failed:\n${status}`);
            }
            console.log('✓ Browser sandbox active');
            await page.close();
            page = await browser.newPage();
            page.setDefaultTimeout(5000);
        }
        const controls = new browser_controls_1.BrowserControls(async () => page);
        await controls.attach(page);
        await controls.setViewport(320, 201);
        await page.setContent('<body style="background:lime"><input><button onclick="document.title=document.querySelector(\'input\').value">Check</button>');
        await page.type('input', 'Termium ✓');
        await page.click('button');
        if (await page.title() !== 'Termium ✓')
            throw new Error('Browser input check failed');
        const screenshot = await controls.capture('png');
        if (!Buffer.from(screenshot).subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
            throw new Error('Browser screenshot check failed');
        console.log('✓ Runtime, browser, input, and screenshots ready');
        const session = new browser_session_1.BrowserSession(async () => browser);
        await session.command(bc_1.NavigationRequest.fromPartial({ action: bc_1.NavigationAction.NEW_TAB }));
        const before = await session.state();
        await session.input(bc_1.InputEvent.fromPartial({ kind: bc_1.InputKind.TEXT_INPUT, text: 't', tabId: before.activeTabId, generation: before.generation }));
        const deadline = Date.now() + 5000;
        let after = await session.state();
        while (after.tabs.length !== before.tabs.length + 1 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
            after = await session.state();
        }
        if (after.tabs.length !== before.tabs.length + 1 || after.activeTabId === before.activeTabId)
            throw Error('Vimium tab navigation check failed');
        await session.capture('png');
        console.log('✓ Bundled Vimium and tab navigation ready');
    }
    finally {
        try {
            await browser?.close();
        }
        finally {
            clearTimeout(timer);
            await fs.rm(temporary, { recursive: true, force: true });
        }
    }
}
void check().catch(error => { console.error(error.message); process.exitCode = 1; });
