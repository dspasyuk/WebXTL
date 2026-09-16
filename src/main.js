import ace from 'ace-builds/src-noconflict/ace';
import 'ace-builds/src-noconflict/theme-monokai';
import 'ace-builds/src-noconflict/theme-chrome';
import 'ace-builds/src-noconflict/mode-text';
import 'ace-builds/src-noconflict/ext-searchbox';
import './css/style.css';

// Import Bootstrap
import 'bootstrap/dist/css/bootstrap.min.css';
import * as bootstrap from 'bootstrap';

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import Split from 'split-grid';

import { ShelxParser } from './js/parser/ShelxParser.js';
import { CifParser } from './js/parser/CifParser.js';
import { PdbParser } from './js/parser/PdbParser.js';
import { MoleculeRenderer } from './js/viewer/MoleculeRenderer.js';
import { FcfParser } from './js/parser/FcfParser.js';
import { MapCalculator } from './js/compute/MapCalculator.js';
import { DensityRenderer } from './js/viewer/DensityRenderer.js';
import { Symmetry } from './js/utils/Symmetry.js';
import { RealSpaceRefiner } from './js/compute/RealSpaceRefiner.js';
import { MoleculeCluster } from './js/compute/MoleculeCluster.js';
import { FRAGMENTS } from './js/compute/FragmentLibrary.js';
import { SphericalAbsorption } from './js/compute/SphericalAbsorption.js';
import { AI_PROVIDERS, DEFAULT_AI_SETTINGS, aiSettingsFromProvider, aiChat, aiChatAgent } from './js/ai/client.js';
import { AI_PROMPTS } from './js/ai/prompts.js';
import './js/ace/mode-cif.js';
import './js/ace/mode-shelx.js';

class WMOLApp {
    constructor() {
        this.state = {
            editors: {
                res: null,
                cif: null,
                lst: null
            },
            scene: null,
            camera: null,
            cameras: {
                perspective: null,
                orthographic: null
            },
            renderer: null,
            controls: null,
            moleculeRenderer: null,
            parsers: {
                shelx: new ShelxParser(),
                cif: new CifParser(),
                pdb: new PdbParser(),
                fcf: new FcfParser()
            },
            mapCalculator: new MapCalculator(),
            realSpaceRefiner: new RealSpaceRefiner(),
            densityRenderer: null,
            renderTimeout: null,
            rsr: { active: false, from: null, to: null },
            fragment: { active: false, selectedId: null, placedAtoms: null },
            preview: {
                active: false,
                cartAtoms: null,
                centroid: null,
                placementPos: null,
                rotation: { x: 0, y: 0, z: 0 },
                translation: { x: 0, y: 0, z: 0 },
                meshes: [],
                labels: [],
                baseCartAtoms: null,
                fragmentDef: null,
                sfacElements: null,
                sfacLineIndex: -1,
                allLines: null,
                usesExistingAtom: false,
                existingAtomLabel: null
            },
            loadedContent: null,
            loadedFilename: null,
            loadedType: 'res',
            fileId: 0, // Track file version to sync editor
            currentProject: null,
            fileTabs: {}, // keyed by filename -> { filename, type, editor, project, dirty }
            availablePrograms: [], // external programs detected on the server
            xrdspaceIns: null, // { filename, content } generated SHELX .ins for SHELXT
            hklContent: null,
            hklName: null,
            hklServerProject: null, // project name when the HKL lives server-side (no content in browser)
            fcfRawContent: null,
            splitView: false,
            splitInstance: null,
            showEditor: true,
            viewSettings: {
                showUnitCell: false, // Default to OFF
                showSymmetry: false,
                orthographic: true, // Default to Orthographic
                showLabels: true, // Default to ON
                showADPs: false // Default to OFF
            },
            preferences: {
                general: {
                    uiFontSize: 14,
                    serverUrl: 'http://localhost:3000/refine',
                    refineTimeout: 180000,
                    restoreSession: true,
                    autoSave: true
                },
                editor: {
                    theme: 'ace/theme/chrome',
                    fontSize: 18,
                    fontFamily: 'Monaco, Menlo, "Ubuntu Mono", "Consolas", "source-code-pro", monospace',
                    tabSize: 4,
                    wrapLines: false,
                    showLineNumbers: true,
                    highlightActiveLine: true
                },
                viewer: {
                    backgroundColor: '#ffffff',
                    bondColor: '#888888',
                    unitCellColor: '#000000',
                    bondThresholds: {
                        metal: 2.5,
                        nonMetal: 1.9,
                        hBond: 0.0
                    },
                    labels: {
                        fontSize: 24,
                        color: '#000000',
                        offsetX: 0.3,
                        offsetY: 0.3,
                        offsetZ: 0.3
                    },
                    atoms: {
                        scale: 0.3,
                        resolution: 'medium',
                        // Safety ceiling: stop parsing atoms above this count so a
                        // pathological file cannot exhaust the browser heap.
                        maxAtoms: 4000000
                    },
                    bonds: {
                        radius: 0.05,
                        resolution: 'medium'
                    }
                },
                map: {
                    type: '2Fo-Fc',
                    sigma: 1.0,
                    radius: 10.0,
                    resolution: 0.5,
                    color: '#0000ff',
                    autoShow: false,
                    style: 'wireframe',
                    opacity: 0.4
                }
            },
            selectionOrder: [], // Track order of selected rows
            lastStructureTabKey: null, // Most recently shown structure file tab (.ins/.res/.cif)
            aiSettings: { ...DEFAULT_AI_SETTINGS },
            aiRunning: false,
            aiAbortController: null,
            aiLog: null,            // { id, startedAt, meta, lines: [] } current session log
            aiLogs: []              // persisted past session logs
        };

        // Bind methods
        this.onWindowResize = this.onWindowResize.bind(this);

        // Raycasting
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        this.loadPreferences();
    }

    loadPreferences() {
        try {
            const raw = localStorage.getItem('webxtl_preferences');
            if (!raw) return;
            const saved = JSON.parse(raw);
            const merge = (base, patch) => {
                if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
                const out = { ...base };
                for (const k of Object.keys(patch)) {
                    if (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
                        out[k] = merge(base[k], patch[k]);
                    } else {
                        out[k] = patch[k];
                    }
                }
                return out;
            };
            this.state.preferences = merge(this.state.preferences, saved);
        } catch (e) {
            console.warn('Failed to load preferences:', e.message);
        }
    }

    savePreferences() {
        try {
            localStorage.setItem('webxtl_preferences', JSON.stringify(this.state.preferences));
        } catch (e) {
            console.warn('Failed to save preferences:', e.message);
        }
    }

    loadAISettings() {
        try {
            const raw = localStorage.getItem('webxtl_ai_settings');
            if (raw) this.state.aiSettings = { ...DEFAULT_AI_SETTINGS, ...JSON.parse(raw) };
        } catch (e) {
            console.warn('Failed to load AI settings:', e.message);
        }
    }

    saveAISettings(settings) {
        this.state.aiSettings = { ...DEFAULT_AI_SETTINGS, ...(settings || this.state.aiSettings) };
        try {
            localStorage.setItem('webxtl_ai_settings', JSON.stringify(this.state.aiSettings));
        } catch (e) {
            console.warn('Failed to save AI settings:', e.message);
        }
    }

    // -----------------------------------------------------------------------
    // AI Data Analysis
    // -----------------------------------------------------------------------

    setupAI() {
        // Menu wiring
        const menuAnalyze = document.getElementById('menu-ai-analyze');
        if (menuAnalyze) {
            menuAnalyze.addEventListener('click', (e) => {
                e.preventDefault();
                this.openAIAnalysis();
            });
        }
        const menuSettings = document.getElementById('menu-ai-settings');
        if (menuSettings) {
            menuSettings.addEventListener('click', (e) => {
                e.preventDefault();
                this.openAISettings();
            });
        }

        // Populate provider + prompt-type selects once.
        const providerSel = document.getElementById('ai-provider');
        if (providerSel) {
            providerSel.innerHTML = Object.entries(AI_PROVIDERS)
                .map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
            providerSel.addEventListener('change', () => {
                const s = aiSettingsFromProvider(providerSel.value);
                const baseEl = document.getElementById('ai-base-url');
                const modelEl = document.getElementById('ai-model');
                const hint = document.getElementById('ai-provider-hint');
                if (baseEl) baseEl.value = s.baseUrl;
                if (modelEl) modelEl.value = s.model;
                if (hint) {
                    hint.textContent = AI_PROVIDERS[providerSel.value]
                        ? AI_PROVIDERS[providerSel.value].hint : '';
                }
            });
        }
        const promptSel = document.getElementById('ai-prompt-type');
        if (promptSel) {
            promptSel.innerHTML = Object.entries(AI_PROMPTS)
                .map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
            promptSel.addEventListener('change', () => {
                const q = document.getElementById('ai-question');
                if (q) q.value = (AI_PROMPTS[promptSel.value] || AI_PROMPTS.freeform).user;
            });
        }

        // Settings modal save
        const btnSaveSettings = document.getElementById('btn-save-ai-settings');
        if (btnSaveSettings) {
            btnSaveSettings.addEventListener('click', () => {
                const provider = (document.getElementById('ai-provider') || {}).value || 'custom';
                const provDef = AI_PROVIDERS[provider];
                const settings = {
                    provider: provider,
                    kind: provDef ? (provDef.kind || 'openai') : 'openai',
                    baseUrl: (document.getElementById('ai-base-url') || {}).value || '',
                    model: (document.getElementById('ai-model') || {}).value || '',
                    apiKey: (document.getElementById('ai-apikey') || {}).value || '',
                    temperature: parseFloat((document.getElementById('ai-temperature') || {}).value) || 0.3,
                    maxTokens: parseInt((document.getElementById('ai-max-tokens') || {}).value, 10) || 128000,
                    includeLst: !!document.getElementById('ai-include-lst')?.checked,
                    deepseekThinking: !!document.getElementById('ai-ds-thinking')?.checked,
                    deepseekEffort: (document.getElementById('ai-ds-effort') || {}).value || 'low'
                };
                this.saveAISettings(settings);
                const modalEl = document.getElementById('aiSettingsModal');
                const modal = bootstrap.Modal.getInstance(modalEl);
                if (modal) modal.hide();
            });
        }

        // Show/hide the DeepSeek-only options whenever the provider changes.
        const providerSel2 = document.getElementById('ai-provider');
        const updateDeepseekOptions = () => {
            const wrap = document.getElementById('ai-deepseek-options');
            if (wrap) wrap.classList.toggle('d-none', providerSel2 ? providerSel2.value !== 'deepseek' : true);
        };
        if (providerSel2) providerSel2.addEventListener('change', updateDeepseekOptions);
        this._updateDeepseekOptions = updateDeepseekOptions;

        // Analysis actions
        const btnGo = document.getElementById('btn-ai-go');
        if (btnGo) btnGo.addEventListener('click', () => this.runAIAnalysis());
        const btnStop = document.getElementById('btn-ai-stop');
        if (btnStop) btnStop.addEventListener('click', () => this.stopAIAnalysis());
        const btnCopy = document.getElementById('btn-ai-copy');
        if (btnCopy) btnCopy.addEventListener('click', () => {
            const out = document.getElementById('ai-output');
            if (out && out.textContent && navigator.clipboard) {
                navigator.clipboard.writeText(out.textContent);
            }
        });

        // Session log buttons
        const btnSaveLog = document.getElementById('btn-ai-save-log');
        if (btnSaveLog) btnSaveLog.addEventListener('click', () => this.saveCurrentAILog());
        const btnLoadLog = document.getElementById('btn-ai-load-log');
        if (btnLoadLog) btnLoadLog.addEventListener('click', () => this.loadSelectedAILog());
        const btnClearLog = document.getElementById('btn-ai-clear-log');
        if (btnClearLog) btnClearLog.addEventListener('click', () => this.clearSelectedAILog());

        // Load persisted settings + past logs
        this.loadAISettings();
        this.loadAILogs();
    }

    openAISettings() {
        const modalEl = document.getElementById('aiSettingsModal');
        if (!modalEl) return;
        const s = this.state.aiSettings || DEFAULT_AI_SETTINGS;
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        setVal('ai-provider', s.provider);
        setVal('ai-base-url', s.baseUrl);
        setVal('ai-model', s.model);
        setVal('ai-apikey', s.apiKey || '');
        setVal('ai-temperature', s.temperature);
        setVal('ai-max-tokens', s.maxTokens);
        setVal('ai-ds-effort', s.deepseekEffort || 'low');
        const lst = document.getElementById('ai-include-lst');
        if (lst) lst.checked = !!s.includeLst;
        const dsThinking = document.getElementById('ai-ds-thinking');
        if (dsThinking) dsThinking.checked = s.deepseekThinking !== false;
        const hint = document.getElementById('ai-provider-hint');
        if (hint) hint.textContent = AI_PROVIDERS[s.provider] ? AI_PROVIDERS[s.provider].hint : '';
        if (typeof this._updateDeepseekOptions === 'function') this._updateDeepseekOptions();
        const modal = new bootstrap.Modal(modalEl);
        modal.show();
    }

    // Build the text/metadata context sent to the model.
    buildAIContext() {
        const info = { filename: null, type: null, structure: '', lstSnippet: '', atoms: 0, elements: {} };

        const activeTab = this.state.lastStructureTabKey && this.state.fileTabs[this.state.lastStructureTabKey];
        let structure = this.getStructureContent();
        if (!structure) structure = this.state.loadedContent || '';
        if (!structure && this.state.editors.res) structure = this.state.editors.res.getValue();
        info.structure = structure;

        if (activeTab) {
            info.filename = activeTab.filename;
            info.type = activeTab.type;
        } else if (this.state.loadedFilename) {
            info.filename = this.state.loadedFilename;
            info.type = this.state.loadedType;
        }

        // Parsed atom / element summary
        let parsed = this.state.parsedData;
        if ((!parsed || !parsed.atoms) && structure && structure.trim()) {
            try {
                const type = (info.type === 'cif' || info.type === 'pdb') ? info.type : 'res';
                parsed = this.state.parsers[type === 'pdb' ? 'pdb' : (type === 'cif' ? 'cif' : 'shelx')].parse(structure);
            } catch (e) { /* ignore parse errors here */ }
        }
        if (parsed && parsed.atoms && parsed.atoms.length) {
            info.atoms = parsed.atoms.length;
            const counts = {};
            parsed.atoms.forEach(a => { const k = (a.element || '?').toUpperCase(); counts[k] = (counts[k] || 0) + 1; });
            info.elements = counts;
        }

        // Refinement .lst content (last SHELXL run) if requested and present.
        const useLst = this.state.aiSettings ? this.state.aiSettings.includeLst !== false : true;
        if (useLst && this.state.editors.lst) {
            const lst = this.state.editors.lst.getValue() || '';
            if (lst && lst.trim()) {
                // Keep the most informative tail of the log (~last 30 KB) plus a header line.
                const tail = lst.length > 30000 ? lst.slice(-30000) : lst;
                info.lstSnippet = tail;
            }
        }

        // HKL header (first ~30 lines) so "structure solution" analysis can see
        // the raw data / cell before a model exists.
        info.hklSnippet = '';
        if (this.state.hklContent) {
            const hklLines = this.state.hklContent.split(/\r?\n/);
            info.hklName = this.state.hklName || 'data.hkl';
            info.hklSnippet = hklLines.slice(0, 30).join('\n');
            if (hklLines.length > 30) info.hklSnippet += `\n... (${hklLines.length} HKL lines total)`;
        }

        // Space-group analysis .ins generated by xrdspace (template for SHELXT).
        info.xrdspaceIns = '';
        if (this.state.xrdspaceIns && this.state.xrdspaceIns.content) {
            info.xrdspaceIns = this.state.xrdspaceIns.content;
        }

        // Cell from the current parsed data (or generated .ins) as text.
        info.cellSummary = '';
        if (parsed && parsed.cell) {
            const c = parsed.cell;
            info.cellSummary = `a=${c.a} b=${c.b} c=${c.c} Å, α=${c.alpha} β=${c.beta} γ=${c.gamma}°`;
        } else {
            const m = (info.xrdspaceIns || info.structure || '').match(/CELL\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
            if (m) {
                info.cellSummary = `a=${m[2]} b=${m[3]} c=${m[4]} Å, α=${m[5]} β=${m[6]} γ=${m[7]}° (λ=${m[1]})`;
            }
        }
        return info;
    }

    openAIAnalysis() {
        const modalEl = document.getElementById('aiAnalysisModal');
        if (!modalEl) return;
        const promptSel = document.getElementById('ai-prompt-type');
        if (promptSel && promptSel.options.length) promptSel.value = 'review';
        const q = document.getElementById('ai-question');
        if (q) q.value = AI_PROMPTS.review.user;
        const out = document.getElementById('ai-output');
        if (out) out.textContent = 'Analysis output will appear here.';
        this.updateAIContextSummary();

        const modal = new bootstrap.Modal(modalEl);
        modal.show();
    }

    // -----------------------------------------------------------------------
    // AI session logging (save / reload past sessions to debug runs)
    // -----------------------------------------------------------------------

    loadAILogs() {
        try {
            const raw = localStorage.getItem('webxtl_ai_logs');
            if (raw) this.state.aiLogs = JSON.parse(raw);
        } catch (e) {
            this.state.aiLogs = [];
        }
        if (!Array.isArray(this.state.aiLogs)) this.state.aiLogs = [];
        this.refreshAILogList();
    }

    persistAILogs() {
        try {
            localStorage.setItem('webxtl_ai_logs', JSON.stringify(this.state.aiLogs.slice(-40)));
        } catch (e) { /* storage full - ignore */ }
    }

    // Start a fresh log for a new analysis run.
    beginAILog(meta = {}) {
        this.state.aiLog = {
            id: Date.now(),
            startedAt: new Date().toISOString(),
            meta: { ...meta },
            lines: []
        };
    }

    aiLogLine(type, text) {
        if (!this.state.aiLog) return;
        const t = new Date().toISOString();
        this.state.aiLog.lines.push({ t, type, text });
    }

    endAILog(status) {
        if (!this.state.aiLog) return;
        this.state.aiLog.endedAt = new Date().toISOString();
        this.state.aiLog.status = status || 'ended';
        this.state.aiLog.meta = this.state.aiLog.meta || {};
        this.state.aiLog.meta.editorModel = this.state.loadedFilename || null;
        this.state.aiLog.meta.lastRun = this.state.aiLastRun ? { ...this.state.aiLastRun } : null;
        this.state.aiLog.meta.lstStats = this.lstStats();
        // Keep the top-level answer text too so reloading restores the view.
        const out = document.getElementById('ai-output');
        if (out) this.state.aiLog.output = out.textContent;
        const reasoning = document.getElementById('ai-reasoning');
        if (reasoning) this.state.aiLog.reasoning = reasoning.textContent;

        this.state.aiLogs.push(this.state.aiLog);
        this.state.aiLog = null;
        this.persistAILogs();
        this.refreshAILogList();
    }

    refreshAILogList() {
        const sel = document.getElementById('ai-log-sessions');
        if (!sel) return;
        const logs = this.state.aiLogs || [];
        const current = sel.value;
        sel.innerHTML = '<option value="">(select a past session to view)</option>';
        // Newest first
        const ordered = [...logs].reverse();
        for (const log of ordered) {
            const label = (log.meta && (log.meta.promptId || log.meta.label))
                || 'analysis';
            const when = log.startedAt ? new Date(log.startedAt).toLocaleString() : '';
            const err = log.status === 'error' ? ' [ERROR]' : '';
            const opt = document.createElement('option');
            opt.value = String(log.id);
            opt.textContent = `${when} — ${label} — ${(log.lines || []).length} events${err}`;
            sel.appendChild(opt);
        }
        if (current && [...logs].some(l => String(l.id) === current)) sel.value = current;
    }

    // Human-readable dump of a log object.
    renderAILog(log) {
        const L = [];
        const m = log.meta || {};
        L.push('=== WebXTL AI SESSION LOG ===');
        L.push(`Started : ${log.startedAt || ''}`);
        if (log.endedAt) L.push(`Ended   : ${log.endedAt}`);
        if (log.status) L.push(`Status  : ${log.status}`);
        if (m.promptId) L.push(`Prompt  : ${m.promptId}`);
        if (m.question) L.push(`Question: ${m.question}`);
        if (m.settings) {
            L.push(`Provider: ${m.settings.provider || '?'}  model: ${m.settings.model || '?'}  base: ${m.settings.baseUrl || '?'}`);
        }
        L.push('');
        for (const ln of log.lines || []) {
            L.push(`[${ln.t || ''}] ${ln.type.toUpperCase()}:`);
            L.push(ln.text);
            L.push('');
        }
        if (log.output != null) {
            L.push('--- FINAL OUTPUT ---');
            L.push(log.output);
            L.push('');
        }
        if (m.lastRun) {
            L.push('--- LAST SERVER RUN ---');
            L.push(JSON.stringify(m.lastRun, null, 2));
            L.push('');
        }
        if (m.lstStats) {
            L.push(`--- REFINEMENT STATS --- ${m.lstStats}`);
        }
        return L.join('\n');
    }

    saveCurrentAILog() {
        // Save the currently visible session (either live `state.aiLog` or the
        // last persisted one / last completed run).
        let log = this.state.aiLog;
        if (!log && this.state.aiLogs.length) log = this.state.aiLogs[this.state.aiLogs.length - 1];
        if (!log) {
            alert('Nothing to save yet — run an analysis first.');
            return;
        }
        const text = this.renderAILog(log);
        const stamp = (log.startedAt || Date.now()).toString().replace(/[:.]/g, '-');
        const name = (log.meta && (log.meta.promptId || 'ai')) || 'ai';
        this.downloadText(text, `ai-log_${name}_${stamp}.txt`);
    }

    loadSelectedAILog() {
        const sel = document.getElementById('ai-log-sessions');
        const logs = this.state.aiLogs || [];
        const log = logs.find(l => String(l.id) === sel.value);
        if (!log) return;
        const out = document.getElementById('ai-output');
        const reasoning = document.getElementById('ai-reasoning');
        if (out) out.textContent = log.output != null ? log.output : '(no output captured)';
        if (reasoning) {
            reasoning.textContent = (log.reasoning && log.reasoning.trim())
                ? log.reasoning : this.renderAILog(log);
            reasoning.scrollTop = reasoning.scrollHeight;
        }
        const status = document.getElementById('ai-stream-status');
        if (status) status.textContent = `Loaded session ${new Date(log.startedAt).toLocaleString()} — status: ${log.status || 'ended'}`;
        const count = document.getElementById('ai-reasoning-count');
        if (count) count.classList.remove('d-none');
    }

    clearSelectedAILog() {
        const sel = document.getElementById('ai-log-sessions');
        if (!sel.value) return;
        const id = sel.value;
        this.state.aiLogs = (this.state.aiLogs || []).filter(l => String(l.id) !== id);
        this.persistAILogs();
        this.refreshAILogList();
        const status = document.getElementById('ai-stream-status');
        if (status) status.textContent = 'Session log cleared.';
    }

    updateAIContextSummary() {
        const el = document.getElementById('ai-context-summary');
        if (!el) return;
        const info = this.buildAIContext();
        const parts = [];
        if (info.filename) parts.push(`<b>${info.filename}</b>`);
        if (info.type) parts.push(`<code>${info.type}</code>`);
        if (info.atoms) parts.push(`${info.atoms} atoms`);
        if (Object.keys(info.elements).length) {
            const comp = Object.entries(info.elements)
                .map(([el, n]) => `${el}${n}`).join(' ');
            parts.push(`<span title="${comp}">composition ${comp}</span>`);
        }
        if (info.cellSummary) parts.push(`<span title="${info.cellSummary}">cell ${info.cellSummary.length > 40 ? info.cellSummary.slice(0, 40) + '…' : info.cellSummary}</span>`);
        if (info.structure) parts.push(`${(info.structure.length / 1024).toFixed(1)} KB structure`);
        if (info.hklSnippet) parts.push(`${info.hklName || 'HKL'}`);
        if (info.xrdspaceIns) parts.push('xrdspace .ins');
        if (info.lstSnippet) parts.push(`${(info.lstSnippet.length / 1024).toFixed(1)} KB .lst`);
        el.innerHTML = parts.length
            ? `<span class="text-muted">Context:</span> ` + parts.join(' &nbsp;·&nbsp; ')
            : 'No structure loaded. Load a .res/.ins/.cif first.';
        el.setAttribute('title', '');
    }

    setAIButtons(running) {
        const go = document.getElementById('btn-ai-go');
        const stop = document.getElementById('btn-ai-stop');
        if (go) go.disabled = running;
        if (stop) stop.classList.toggle('d-none', !running);
        this.state.aiRunning = running;
    }

    resetAIStreamUI() {
        const out = document.getElementById('ai-output');
        if (out) out.textContent = '';
        const reasoning = document.getElementById('ai-reasoning');
        if (reasoning) reasoning.textContent = '';
        const count = document.getElementById('ai-reasoning-count');
        if (count) count.classList.add('d-none');
        const status = document.getElementById('ai-stream-status');
        if (status) status.textContent = '';
    }

    updateAIStreamUI(deltaCount, reasoningCount) {
        const status = document.getElementById('ai-stream-status');
        if (!status) return;
        const kb = ((deltaCount + reasoningCount) / 1024).toFixed(0);
        status.textContent = deltaCount
            ? `streaming… ${kb} KB`
            : (reasoningCount ? 'thinking…' : '');
        const count = document.getElementById('ai-reasoning-count');
        if (count) count.classList.toggle('d-none', reasoningCount === 0);
    }

    async runAIAnalysis() {
        if (this.state.aiRunning) return;

        const settings = this.state.aiSettings || DEFAULT_AI_SETTINGS;
        const promptSel = document.getElementById('ai-prompt-type');
        const promptId = promptSel ? promptSel.value : 'freeform';
        const promptDef = AI_PROMPTS[promptId] || AI_PROMPTS.freeform;

        if (!settings.baseUrl || !settings.model) {
            alert('AI is not configured yet. Open AI > AI Settings and pick a provider/model.');
            return;
        }

        const info = this.buildAIContext();
        const out = document.getElementById('ai-output');
        if (!out) return;
        const isSolveType = promptId === 'solve';
        if (!info.structure && !info.lstSnippet && !(isSolveType && info.hklSnippet)) {
            out.textContent = isSolveType
                ? 'Full structure solution needs data to work from. Load an .hkl file (optionally run Calculate > Space Group) and/or a .res/.ins template.'
                : 'No structure or refinement data to analyze. Load a .res/.ins/.cif file (and optionally refine it) first.';
            return;
        }
        this.resetAIStreamUI();

        // Begin session log (user-visible via the session-log row in the modal).
        this.beginAILog({
            promptId,
            label: promptDef.label,
            question: (document.getElementById('ai-question') || {}).value || '',
            settings: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl },
            filename: info.filename || null
        });

        // Assemble user message with the actual data.
        const userParts = [];
        userParts.push(`Analysis requested: ${promptDef.label}`);
        if (info.filename) userParts.push(`Structure file: ${info.filename}`);
        if (info.cellSummary) userParts.push(`Cell: ${info.cellSummary}`);
        if (info.structure) {
            userParts.push(`\n===== SHELX STRUCTURE (${(info.structure.length / 1024).toFixed(1)} KB) =====\n${info.structure}`);
        }
        if (info.hklSnippet) {
            userParts.push(`\n===== HKL DATA (${info.hklName}, header) =====\n${info.hklSnippet}`);
        }
        if (info.xrdspaceIns) {
            userParts.push(`\n===== XRDSPACE-GENERATED .ins (template for SHELXT) =====\n${info.xrdspaceIns}`);
        }
        if (info.lstSnippet) {
            userParts.push(`\n===== LAST SHELXL REFINEMENT LOG (.lst tail) =====\n${info.lstSnippet}`);
        }
        const question = document.getElementById('ai-question');
        if (question && question.value && question.value.trim()) {
            userParts.push(`\n===== USER INSTRUCTIONS =====\n${question.value.trim()}`);
        }

        const reasoningEl = document.getElementById('ai-reasoning');
        const reasoningCountEl = document.getElementById('ai-reasoning-count');
        const MAX_REASONING = 200000;
        let reasoningCount = 0;
        const toolLog = [];   // structured history of tool calls for the final report

        const controller = new AbortController();
        this.state.aiAbortController = controller;
        this.setAIButtons(true);

        const onStep = (ev) => {
            if (ev.type === 'assistant' && ev.content) {
                out.textContent += ev.content;
                out.scrollTop = out.scrollHeight;
                this.updateAIStreamUI(out.textContent.length, reasoningCount);
                this.aiLogLine('assistant', ev.content);
            } else if (ev.type === 'tool') {
                // Show each executed tool compactly in the reasoning panel so the
                // user can see the agent is actually acting.
                reasoningCount += 1;
                const summary = this.aiToolSummary(ev.result);
                toolLog.push({ name: ev.name, summary });
                if (reasoningEl) {
                    if (reasoningEl.textContent === '(none)') reasoningEl.textContent = '';
                    reasoningEl.textContent += `\n\n>>> TOOL: ${ev.name}\n${String(ev.result || '').slice(0, 500)}${String(ev.result || '').length > 500 ? '\n…' : ''}`;
                    reasoningEl.scrollTop = reasoningEl.scrollHeight;
                }
                if (reasoningCountEl) reasoningCountEl.classList.remove('d-none');
                this.updateAIStreamUI(out.textContent.length, reasoningCount);
                // Full result recorded in the log (not truncated) for debugging.
                this.aiLogLine('tool', `>>> TOOL: ${ev.name}\nArgs: ${JSON.stringify(ev.args || null)}\nResult:\n${String(ev.result || '')}`);
            } else if (ev.type === 'error') {
                this.aiLogLine('error', ev.error || String(ev));
            }
        };

        const systemMsg = promptDef.system;
        const userMsg = userParts.join('\n\n');
        this.aiLogLine('system', `[SYSTEM PROMPT (${promptDef.label})]\n${systemMsg}`);
        this.aiLogLine('user', `[USER REQUEST]\n${userMsg}`);

        try {
            if (isSolveType && settings.kind !== 'anthropic') {
                // Agentic mode: the model can call tools to actually run the
                // solution/refinement/validation rather than only advise.
                const finalText = await this.runAIAgent(settings, systemMsg, userMsg, onStep);
                if (finalText && !out.textContent.endsWith(finalText)) {
                    out.textContent += finalText;
                    out.scrollTop = out.scrollHeight;
                    this.aiLogLine('assistant', finalText);
                }
                out.textContent += this.buildAgentSessionReport(toolLog);
                out.scrollTop = out.scrollHeight;
            } else if (isSolveType && settings.kind === 'anthropic') {
                out.textContent = 'Anthropic does not support tool-calling in this build. Use DeepSeek/OpenAI/Qwen/OpenRouter for "Full structure solution", or ask a free-form question.';
                // Still answer with advice so the user is not stuck.
                out.textContent += '\n\n' + await aiChat(settings, [
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: userMsg }
                ], { signal: controller.signal });
            } else {
                await aiChat(settings, [
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: userMsg }
                ], {
                    onDelta: (t) => {
                        out.textContent += t;
                        out.scrollTop = out.scrollHeight;
                        this.updateAIStreamUI(out.textContent.length, reasoningCount);
                        this.aiLogLine('assistant', t);
                    },
                    onReasoning: (t) => {
                        reasoningCount += t.length;
                        if (reasoningEl) {
                            if (reasoningEl.textContent === '(none)') reasoningEl.textContent = '';
                            if (reasoningCount <= MAX_REASONING) reasoningEl.textContent += t;
                            reasoningEl.scrollTop = reasoningEl.scrollHeight;
                        }
                        if (reasoningCountEl) {
                            reasoningCountEl.classList.remove('d-none');
                        }
                        this.updateAIStreamUI(out.textContent.length, reasoningCount);
                        this.aiLogLine('reasoning', t);
                    },
                    signal: controller.signal
                });
            }
        } catch (e) {
            if (e && e.name === 'AbortError') {
                out.textContent += '\n\n[stopped]';
                this.aiLogLine('error', '[stopped by user]');
            } else {
                out.textContent = `Error: ${e.message}`;
                this.aiLogLine('error', e.stack || e.message);
            }
        } finally {
            this.state.aiAbortController = null;
            this.setAIButtons(false);
            const status = document.getElementById('ai-stream-status');
            if (status) {
                status.textContent = out.textContent && out.textContent.startsWith('Error')
                    ? ''
                    : (reasoningCount ? `done (${(out.textContent.length / 1024).toFixed(1)} KB answer, ${(reasoningCount / 1024).toFixed(1)} KB tool logs)` : 'done');
            }
            this.endAILog(out.textContent && out.textContent.startsWith('Error') ? 'error' : 'ended');
        }
    }

    stopAIAnalysis() {
        if (this.state.aiAbortController) this.state.aiAbortController.abort();
    }

    // -----------------------------------------------------------------------
    // AI agent tools (function calling) — let the model actually act.
    // -----------------------------------------------------------------------

    get AITools() {
        return [
            {
                name: 'webxtl_get_workspace',
                description: 'Return the current WebXTL workspace state: the loaded SHELX structure text (.ins/.res), its filename, whether HKL data is loaded (plus its header), any xrdspace-generated .ins template, and the last SHELXL .lst statistics. Use this first to see what you are working with.',
                parameters: { type: 'object', properties: {}, additionalProperties: false }
            },
            {
                name: 'webxtl_apply_structure',
                description: 'Write a SHELX .ins/.res text into the structure editor (replaces current model). Use it to set a corrected or generated structure before running programs. Provide the FULL file content.',
                parameters: {
                    type: 'object',
                    properties: {
                        content: { type: 'string', description: 'Complete SHELX .ins/.res text (TITL ... END).' }
                    },
                    required: ['content'],
                    additionalProperties: false
                }
            },
            {
                name: 'webxtl_run_program',
                description: 'Run a crystallography program on the server using the current structure (editor content) and loaded HKL: SHELXT/SHELXS/SHELXD (structure solution) or SHELXL (refinement). Returns stdout plus the produced .res/.lst/.fcf files (refined model etc).',
                parameters: {
                    type: 'object',
                    properties: {
                        program: { type: 'string', enum: ['shelxt', 'shelxs', 'shelxd', 'shelxl'], description: 'Program to run.' },
                        structure: { type: 'string', description: 'Optional .ins/.res text to use instead of the current editor content.' }
                    },
                    required: ['program'],
                    additionalProperties: false
                }
            },
            {
                name: 'webxtl_refine_structure',
                description: 'Run SHELXL refinement with WGHT optimisation to convergence on the current structure (in the editor) + loaded HKL. Returns the refined .res (loaded back into the editor) plus the final R1/wR2/GooF from the .lst. Use this to actually finish a refinement (not just advise), and call it again / validate afterwards.',
                parameters: {
                    type: 'object',
                    properties: {
                        cycles: { type: 'number', description: 'Number of SHELXL cycles (default 3; larger = more complete WGHT optimisation).' }
                    },
                    additionalProperties: false
                }
            },
            {
                name: 'webxtl_solve_structure',
                description: 'Run the full automated pipeline: structure solution (SHELXT, or SHELXS if no model), SHELXL refinement and a disorder/twinning + CheckCIF-style validation report. Inputs are the current editor structure (or empty template) + the loaded HKL. Returns the validation report, the refinement log and the final refined .res/.lst.',
                parameters: {
                    type: 'object',
                    properties: {
                        program: { type: 'string', enum: ['auto', 'shelxt', 'shelxs'], description: 'Solution program (default auto = SHELXT then SHELXS).' },
                        cycles: { type: 'number', description: 'SHELXL WGHT optimisation cycles (default 3).' }
                    },
                    additionalProperties: false
                }
            },
            {
                name: 'webxtl_space_group',
                description: 'Run xrdspace space-group determination on the loaded HKL data. Returns the crystal system, Laue class, candidate space groups with scores, and a SHELX .ins template for the chosen group. Use before writing the solution .ins if the space group is unknown.',
                parameters: {
                    type: 'object',
                    properties: {
                        force: { type: 'string', description: 'Optional space group to force (number or Hermann-Mauguin, e.g. "14" or "P 21/c").' }
                    },
                    additionalProperties: false
                }
            },
            {
                name: 'webxtl_validate',
                description: 'Run a CheckCIF-style validation (disorder, twinning, R-factors, geometry) on the current structure (and last .lst if available). Returns the alert report.',
                parameters: { type: 'object', properties: {}, additionalProperties: false }
            }
        ];
    }

    // Executor called by the AI agent loop for each tool request.
    async aiRunTool(name, args) {
        if (name === 'webxtl_get_workspace') return this.aiToolWorkspace();
        if (name === 'webxtl_apply_structure') return this.aiToolApplyStructure(args);
        if (name === 'webxtl_run_program') return this.aiToolRunProgram(args);
        if (name === 'webxtl_refine_structure') return this.aiToolRefine(args);
        if (name === 'webxtl_solve_structure') return this.aiToolSolve(args);
        if (name === 'webxtl_space_group') return this.aiToolSpaceGroup(args);
        if (name === 'webxtl_validate') return this.aiToolValidate();
        return { error: `Unknown tool ${name}` };
    }

    truncateForAI(text, max = 80000) {
        if (!text) return '';
        return text.length > max ? text.slice(0, max) + `\n... [truncated ${text.length} chars]` : text;
    }

    // Compact one-line summary of a tool result (JSON or text) for the report.
    aiToolSummary(result) {
        if (result == null) return '';
        if (typeof result === 'string') return this.truncateForAI(result, 400);
        let s;
        try { s = JSON.stringify(result); } catch (e) { s = String(result); }
        return this.truncateForAI(s, 400);
    }

    // Appended after the agent loop stops (model answer, step limit, or error)
    // so the user always knows where refinement stopped and that the current
    // model is loaded in the editor.
    buildAgentSessionReport(toolLog) {
        const L = ['\n\n------ AI SOLUTION SESSION END ------'];
        const last = this.state.aiLastRun || null;
        const stats = this.lstStats();
        L.push('Tools executed in this session:');
        if (toolLog && toolLog.length) {
            L.push(...toolLog.map(t => `  • ${t.name}  →  ${t.summary}`));
        } else {
            L.push('  (none)');
        }

        const editorModel = this.getStructureContent();
        const atoms = (this.state.parsedData && this.state.parsedData.atoms) ? this.state.parsedData.atoms.length : null;

        if (last) {
            L.push('');
            L.push(`Last server job: ${last.program} — ${last.ok ? 'OK' : 'FAILED'}${last.message ? ' (' + last.message + ')' : ''}`);
            if (last.promotedModel) L.push(`Model file promoted to editor: ${last.promotedModel}`);
            if (last.lstStats) L.push(`Refinement stopped at: ${last.lstStats}`);
        }
        if (stats) {
            L.push('');
            L.push(`Current model in editor reports: ${stats}`);
        }
        if (editorModel) {
            L.push('');
            L.push(`A structure is loaded in the editor (${atoms != null ? atoms + ' atoms' : 'see RES tab'}). ` +
                'Open the RES/3D view to inspect the solution. ' +
                'You can continue by asking the AI again (e.g. "refine further / fix disorder / add hydrogens"), ' +
                'or run Programs > SHELXL / Calculate > Refine manually.');
            L.push(`Editor content length: ${editorModel.length} chars.`);
        } else {
            L.push('');
            L.push('No model reached the editor. Check the tool log above — the agent may have stopped before a successful run.');
        }
        if (!stats && !editorModel && last && last.ok) {
            L.push('Note: the job succeeded but no refinement statistics were parsed from the .lst.');
        }
        return L.join('\n');
    }

    // Choose which .res file produced by a run to promote into the editor.
    // For solutions (SHELXT etc) several candidates (name_a.res ...) can exist;
    // pick the one with the lowest R1 quoted in its header.
    pickResFile(files, base, preferBase = false) {
        const keys = Object.keys(files || {}).filter(f => /\.res$/i.test(f));
        if (!keys.length) return null;
        if (preferBase) {
            const exact = keys.find(f => f.toLowerCase() === `${base}.res`);
            if (exact) return exact;
        }
        const r1Of = (text) => {
            const m = (text || '').match(/R1\s*[= ]\s*([\d.]+)/i);
            return m ? parseFloat(m[1]) : 99;
        };
        keys.sort((a, b) => r1Of(files[a]) - r1Of(files[b]));
        return keys[0];
    }

    // Load a structure .res/.ins into the RES editor (kept in sync for the
    // next program run and visible to the user in the 3D/RES view).
    loadStructureIntoEditor(content, filename) {
        const editor = this.state.editors.res;
        if (!editor || !content || !content.trim()) return false;
        editor.setValue(content, -1);
        this.state.loadedContent = content;
        this.state.loadedType = 'res';
        this.state.loadedFilename = filename || this.state.loadedFilename || 'structure.res';
        this.state.lastStructureTabKey = null;
        this.renderContent(content, 'res');
        return true;
    }

    async aiToolWorkspace() {
        const structure = this.getStructureContent();
        const filename = this.state.loadedFilename
            || (this.state.lastStructureTabKey && this.state.fileTabs[this.state.lastStructureTabKey]?.filename) || null;
        const info = {
            filename,
            hasStructure: !!structure,
            structurePreview: this.truncateForAI(structure, 20000),
            hasHkl: this.hasHkl(),
            hklName: this.state.hklName || (this.hasHkl() ? this.hklBaseName() + '.hkl' : null),
            hklServerSide: !!this.state.hklServerProject,
            hklHeader: this.state.hklContent ? this.truncateForAI(this.state.hklContent.split(/\r?\n/).slice(0, 25).join('\n'), 3000) : '',
            xrdspaceIns: this.state.xrdspaceIns ? this.truncateForAI(this.state.xrdspaceIns.content, 30000) : null,
            lastLstStats: this.lstStats()
        };
        // Keep the last agent-run state visible to the model.
        if (this.state.aiLastRun) Object.assign(info, { lastRun: this.state.aiLastRun });
        return info;
    }

    lstStats() {
        const lst = this.state.editors.lst ? this.state.editors.lst.getValue() : '';
        if (!lst) return null;
        const r1 = lst.match(/R1\s*=\s*([\d.]+)\s+for\s+\d+\s+Fo\s*>\s*\d+sig\(Fo\)/);
        const wr = lst.match(/wR2\s*=\s*([\d.]+),\s*GooF\s*=\s*S\s*=\s*([\d.]+)/);
        const flack = lst.match(/Flack\s*x\s*=\s*([\d.\-()]+)/);
        const out = {};
        if (r1) out.r1 = r1[1];
        if (wr) { out.wr2 = wr[1]; out.goof = wr[2]; }
        if (flack) out.flack = flack[1];
        return Object.keys(out).length ? out : null;
    }

    async aiToolApplyStructure(args) {
        const content = (args && args.content) || '';
        if (!content.trim()) return { error: 'apply_structure requires non-empty content.' };
        const editor = this.state.editors.res;
        if (!editor) return { error: 'No structure editor available.' };
        editor.setValue(content, -1);
        this.state.loadedContent = content;
        this.state.loadedType = 'res';
        this.state.loadedFilename = this.state.loadedFilename || 'structure.res';
        this.renderContent(content, 'res');
        return {
            ok: true,
            message: 'Structure written to the editor.',
            atoms: (this.state.parsedData && this.state.parsedData.atoms) ? this.state.parsedData.atoms.length : '?'
        };
    }

    async aiToolRunProgram(args) {
        const programId = args && args.program;
        if (!['shelxt', 'shelxs', 'shelxd', 'shelxl'].includes(programId)) {
            return { error: `program must be shelxt|shelxs|shelxd|shelxl (got ${programId})` };
        }
        // structure to run: explicit arg or current editor content
        let structure = (args && args.structure) || this.getStructureContent();
        if (!structure) return { error: 'No structure text available. Load a .ins/.res or call webxtl_apply_structure first.' };
        if (!(await this.ensureHklForRun())) {
            return { error: 'No HKL file available. Load the .hkl file (File > Load HKL) or open a project that contains one before running a program.' };
        }

        const base = this.hklBaseName().replace(/[^a-zA-Z0-9_-]/g, '_');
        const form = new FormData();
        const needsHkl = ['shelxt', 'shelxs', 'shelxd', 'shelxl'].includes(programId);
        form.append('ins', new Blob([structure], { type: 'text/plain' }), base + '.ins');
        if (needsHkl) this.appendHklPart(form, base);

        const controller = new AbortController();
        this.state.aiAbortController = controller;
        let data;
        try {
            const res = await fetch(this.getApiUrl(`/run/${programId}`), {
                method: 'POST', body: form,
                signal: this.makeAbortSignal(controller)
            });
            if (!res.ok) throw new Error(`Server error: ${res.statusText}`);
            data = await res.json();
        } catch (e) {
            return { error: `Failed to run ${programId}: ${e.message}` };
        } finally {
            this.state.aiAbortController = null;
        }

        const out = { program: programId, success: data.success, message: data.message || null };
        if (data.stdout) out.stdout = this.truncateForAI(data.stdout, 12000);
        if (data.stderr) out.stderr = this.truncateForAI(data.stderr, 4000);

        const files = data.files || {};
        const resKeys = Object.keys(files).filter(f => /\.res$/i.test(f));
        const lstKeys = Object.keys(files).filter(f => /\.lst$/i.test(f));

        // Always promote the best produced model into the editor so the user can
        // inspect it (3D + RES tab) and so the next run/refine uses it.
        let promoted = null;
        if (data.success && resKeys.length) {
            const best = this.pickResFile(files, base, programId === 'shelxl' || programId === 'shelxs');
            if (best && this.loadStructureIntoEditor(files[best], best)) {
                promoted = best;
            }
        }

        // Summary of each .res candidate for the model (kept short - full model
        // is in the editor, not echoed into the conversation).
        if (resKeys.length) {
            out.models = resKeys.map(k => {
                const head = files[k].split(/\r?\n/).slice(0, 8).join(' | ');
                const r1 = files[k].match(/R1\s*[= ]\s*([\d.]+)/i);
                return { file: k, header: head.slice(0, 300), r1: r1 ? r1[1] : null };
            });
            out.promotedModel = promoted;
            out.editorUpdated = promoted ? `${promoted} loaded into the editor - use it as the current model` : null;
        }
        if (lstKeys.length) {
            const k = lstKeys[0];
            out.lstStats = this.summarizeLstPlain(files[k]);
            out.lstTail = this.truncateForAI(files[k], 8000);
            // Keep the .lst in the LST editor too so the user can inspect where
            // refinement stopped (R1/wR2/GooF, shifts, peak/hole).
            const lstEditor = this.state.editors.lst;
            if (lstEditor) lstEditor.setValue(files[k], -1);
        }

        // Record where we are for the final report / "where did it stop".
        this.state.aiLastRun = {
            program: programId,
            ok: !!data.success,
            message: data.message || null,
            promotedModel: promoted,
            lstStats: out.lstStats || null,
            timestamp: new Date().toISOString()
        };
        return out;
    }

    summarizeLstPlain(lst) {
        const r1 = lst.match(/R1\s*=\s*([\d.]+)\s+for\s+\d+\s+Fo\s*>\s*\d+sig\(Fo\)/);
        const wr = lst.match(/wR2\s*=\s*([\d.]+),\s*GooF\s*=\s*S\s*=\s*([\d.]+)/);
        const flack = lst.match(/Flack\s*x\s*=\s*([\d.\-()]+)/);
        const peak = lst.match(/Highest\s+peak\s*([\d.\-]+)/);
        const hole = lst.match(/Deepest\s+hole\s*([\d.\-]+)/);
        const parts = [];
        if (r1) parts.push(`R1=${r1[1]}`);
        if (wr) parts.push(`wR2=${wr[1]} GooF=${wr[2]}`);
        if (flack) parts.push(`Flack=${flack[1]}`);
        if (peak) parts.push(`peak=${peak[1]}`);
        if (hole) parts.push(`hole=${hole[1]}`);
        return parts.length ? parts.join('  ') : 'no recognizable statistics';
    }

    // Refine the current structure on the server (SHELXL weight optimisation).
    async aiToolRefine(args) {
        const structure = this.getStructureContent();
        if (!structure) return { error: 'No structure loaded to refine. Solve first or load a .res/.ins.' };
        if (!(await this.ensureHklForRun())) return { error: 'No HKL file available. Load an .hkl file or open a project that contains one.' };

        const cycles = Math.max(1, Math.min(20, parseInt((args && args.cycles) || 3, 10) || 3));
        const base = this.hklBaseName().replace(/[^a-zA-Z0-9_-]/g, '_');
        const form = new FormData();
        form.append('ins', new Blob([structure], { type: 'text/plain' }), base + '.ins');
        this.appendHklPart(form, base);
        form.append('cycles', String(cycles));
        form.append('mode', 'weight'); // apply recommended WGHT each cycle

        const controller = new AbortController();
        this.state.aiAbortController = controller;
        let data;
        try {
            const res = await fetch(this.getApiUrl('/refine'), {
                method: 'POST', body: form,
                signal: typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([AbortSignal.timeout(600000), controller.signal]) : controller.signal
            });
            if (!res.ok) {
                const e = await res.json().catch(() => ({}));
                throw new Error(e.error || e.details || `HTTP ${res.status}`);
            }
            data = await res.json();
        } catch (e) {
            return { error: `Refinement failed: ${e.message}` };
        } finally {
            this.state.aiAbortController = null;
        }

        const out = { program: 'shelxl', mode: 'weight', cycles, success: !!data.success, message: data.message || null };
        if (data.stdout) out.stdout = this.truncateForAI(data.stdout, 8000);
        if (data.stderr) out.stderr = this.truncateForAI(data.stderr, 4000);

        const files = data.files || {};
        const resKeys = Object.keys(files).filter(f => /\.res$/i.test(f));
        const lstKeys = Object.keys(files).filter(f => /\.lst$/i.test(f));

        let promoted = null;
        if (data.success && resKeys.length) {
            const best = this.pickResFile(files, base, true) || resKeys[0];
            if (best && this.loadStructureIntoEditor(files[best], best)) promoted = best;
        }
        out.promotedModel = promoted;
        out.editorUpdated = promoted ? `${promoted} loaded into the editor (refined model)` : null;

        if (lstKeys.length) {
            const k = lstKeys[0];
            out.lstStats = this.summarizeLstPlain(files[k]);
            out.lstTail = this.truncateForAI(files[k], 10000);
            const lstEditor = this.state.editors.lst;
            if (lstEditor) lstEditor.setValue(files[k], -1);
        }

        this.state.aiLastRun = {
            program: 'shelxl (WGHT)',
            ok: !!data.success,
            message: data.message || null,
            promotedModel: promoted,
            lstStats: out.lstStats || null,
            timestamp: new Date().toISOString()
        };
        return out;
    }

    async aiToolSolve(args) {
        const insText = this.getStructureContent();
        if (!insText) return { error: 'No structure template in the editor.' };
        if (!(await this.ensureHklForRun())) return { error: 'No HKL file available. Load an .hkl file or open a project that contains one.' };

        const base = this.hklBaseName().replace(/[^a-zA-Z0-9_-]/g, '_');
        const form = new FormData();
        form.append('ins', new Blob([insText], { type: 'text/plain' }), base + '.ins');
        this.appendHklPart(form, base);
        form.append('program', (args && args.program) || 'auto');
        form.append('cycles', String((args && args.cycles) || 3));
        form.append('refine', '1');
        form.append('platon', '0');

        const controller = new AbortController();
        this.state.aiAbortController = controller;
        let data;
        try {
            const res = await fetch(this.getApiUrl('/solve-structure'), {
                method: 'POST', body: form,
                signal: typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([AbortSignal.timeout(600000), controller.signal]) : controller.signal
            });
            if (!res.ok) {
                const e = await res.json().catch(() => ({}));
                throw new Error(e.error || e.details || `HTTP ${res.status}`);
            }
            data = await res.json();
        } catch (e) {
            return { error: `Solve pipeline failed: ${e.message}` };
        } finally {
            this.state.aiAbortController = null;
        }

        const out = {
            success: data.success,
            steps: (data.steps || []).map(s => `[${s.status}] ${s.label}${s.message ? ' — ' + s.message : ''}`),
            reportText: data.reportText || '',
            message: data.message || null
        };
        if (data.files && data.files.res) {
            // Promote the final refined model into the editor.
            const resText = data.files.res;
            this.loadStructureIntoEditor(resText, (data.project || 'structure') + '.res');
            out.finalResPreview = this.truncateForAI(resText, 6000);
        }
        if (data.files && data.files.lst) {
            out.lstStats = this.summarizeLstPlain(data.files.lst);
            out.finalLstTail = this.truncateForAI(data.files.lst, 12000);
            const lstEditor = this.state.editors.lst;
            if (lstEditor) lstEditor.setValue(data.files.lst, -1);
        }
        this.state.aiLastRun = {
            program: 'solve-structure',
            ok: !!data.success,
            message: data.message || null,
            promotedModel: data.project ? data.project + '.res' : 'structure.res',
            lstStats: out.lstStats || null,
            reportVerdict: data.report ? data.report.verdict : null,
            timestamp: new Date().toISOString()
        };
        return out;
    }

    async aiToolSpaceGroup(args) {
        if (!(await this.ensureHklForRun())) return { error: 'No HKL file available. Load an .hkl file or open a project that contains one.' };
        const force = (args && args.force && String(args.force).trim()) || null;
        let result;
        try {
            result = await this.apiXrdspaceAnalyze(
                this.state.hklContent,
                null,
                force,
                null,
                this.state.hklContent ? null : this.state.hklServerProject || this.state.currentProject
            );
        } catch (e) {
            return { error: `xrdspace failed: ${e.message}` };
        }
        const out = {
            ok: result.ok,
            spaceGroup: result.spaceGroup || result.best || null,
            laue: result.laue || null,
            crystalSystem: result.system || result.crystalSystem || null,
            summary: this.truncateForAI(typeof result.summary === 'string' ? result.summary : JSON.stringify(result).slice(0, 4000), 6000)
        };
        // If xrdspace returned an .ins template, remember it so SHELXT can use it.
        if (result.ins && result.ins.content) {
            this.state.xrdspaceIns = { filename: result.ins.filename || 'xrdspace.ins', content: result.ins.content };
        } else if (result.shelxIns) {
            this.state.xrdspaceIns = { filename: 'xrdspace.ins', content: result.shelxIns };
        } else if (result.merge && result.merge.shelxIns) {
            this.state.xrdspaceIns = { filename: 'xrdspace_merged.ins', content: result.merge.shelxIns };
        }
        if (this.state.xrdspaceIns) {
            out.generatedIns = this.truncateForAI(this.state.xrdspaceIns.content, 30000);
            out.note = 'You may call webxtl_apply_structure with generatedIns (after fixing SFAC/UNIT for the real composition), then webxtl_run_program shelxt to solve.';
        }
        return out;
    }

    async aiToolValidate() {
        const structure = this.getStructureContent();
        if (!structure) return { error: 'No structure loaded to validate.' };
        const lst = this.state.editors.lst ? this.state.editors.lst.getValue() : '';
        const base = (this.state.loadedFilename || 'structure').replace(/\.[^.]+$/, '');
        const form = new FormData();
        form.append('res', new Blob([structure], { type: 'text/plain' }), base + '.res');
        if (lst && lst.trim()) form.append('lst', new Blob([lst], { type: 'text/plain' }), base + '.lst');
        try {
            const res = await fetch(this.getApiUrl('/validate-structure'), { method: 'POST', body: form });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return { success: data.success, report: data.reportText || '' };
        } catch (e) {
            return { error: `Validation failed: ${e.message}` };
        }
    }

    // Run an agentic analysis where the model may call tools to actually solve
    // the structure. Returns the final assistant text.
    async runAIAgent(settings, system, userContent, onStep) {
        const controller = new AbortController();
        this.state.aiAbortController = controller;
        try {
            return await aiChatAgent(settings,
                [
                    { role: 'system', content: system },
                    { role: 'user', content: userContent }
                ],
                this.AITools,
                (name, args) => this.aiRunTool(name, args),
                {
                    maxSteps: 20,
                    signal: controller.signal,
                    onStep
                });
        } catch (e) {
            if (e && e.name === 'AbortError') throw e;
            // Anthropic providers do not support this tool loop yet.
            throw new Error(`Agent unavailable: ${e.message}`);
        }
    }

    // localStorage helpers -----------------------------------------------------
    // localStorage has a ~5 MB per-origin quota. Session content (HKL/FCF) is
    // intentionally never persisted; only small metadata is stored. These
    // wrappers drop oversized/legacy keys on quota errors instead of failing.
    lsRemove(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
    lsSet(k, v) {
        try {
            localStorage.setItem(k, v);
            return;
        } catch (e) {
            const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
            if (!quota) { console.warn('localStorage save error:', e.message); return; }
        }
        // Quota exceeded: free the big legacy/session keys, then retry once.
        ['webxtl_res_content', 'webxtl_file_tabs', 'webxtl_hkl_name', 'webxtl_hkl_project',
         'webxtl_hkl_content', 'webxtl_fcf_content', 'webxtl_current_project',
         'webxtl_loaded_type', 'webxtl_loaded_filename'].forEach(k => this.lsRemove(k));
        try { localStorage.setItem(k, v); }
        catch (e2) { /* still over quota - skip */ }
    }

    saveStateToLocalStorage() {
        if (this.state.preferences && this.state.preferences.general.autoSave === false) return;
        // Never keep reflection data client-side: HKL lives in the server
        // project, FCF is re-fetched from the project only to draw the map.
        this.lsRemove('webxtl_hkl_content');
        this.lsRemove('webxtl_fcf_content');

        if (this.state.loadedContent && this.state.loadedContent.length < 512 * 1024) {
            this.lsSet('webxtl_res_content', this.state.loadedContent);
            this.lsSet('webxtl_loaded_type', this.state.loadedType);
            this.lsSet('webxtl_loaded_filename', this.state.loadedFilename || '');
        }
        if (this.state.currentProject) {
            this.lsSet('webxtl_current_project', this.state.currentProject);
        }
        // Persist open file tabs (content + metadata) so they survive a
        // refresh, but only small text tabs - never HKL/FCF data.
        const tabs = [];
        for (const [name, t] of Object.entries(this.state.fileTabs || {})) {
            if (t.type === 'hkl' || t.type === 'fcf') continue;
            const content = t.editor ? t.editor.getValue() : '';
            if (content.length < 128 * 1024) {
                tabs.push({ filename: t.filename, type: t.type, project: t.project, content });
            }
        }
        this.lsSet('webxtl_file_tabs', JSON.stringify(tabs));
        // Persist only the HKL reference (name + project) - never the content.
        this.lsSet('webxtl_hkl_name', this.state.hklName || '');
        this.lsSet('webxtl_hkl_project', this.state.hklServerProject || '');
    }

    async restoreStateFromLocalStorage() {
        if (this.state.preferences && this.state.preferences.general.restoreSession === false) return;
        // Purge any large reflection data left by earlier versions of the app so
        // a full localStorage never breaks the quota again.
        this.lsRemove('webxtl_hkl_content');
        this.lsRemove('webxtl_fcf_content');
        const currentProject = localStorage.getItem('webxtl_current_project');

        // If the last session was a server project, reload the *latest* project
        // from the server. This re-attaches the HKL reference, auto-loads the
        // .fcf (density map) and .cif exactly like a manual project load, and
        // avoids restoring stale editor text saved in localStorage.
        if (currentProject) {
            const ok = await this.loadProjectFromServer(currentProject, { silent: true });
            if (ok) {
                this.restoreAuxFileTabs();
                return;
            }
            // Server unreachable / project missing - fall through to the saved text.
        }

        this.restoreSavedTextSession();
    }

    // Restore only auxiliary file tabs (pdb, lst, log, ...) from localStorage.
    // HKL/FCF tabs are never persisted.
    restoreAuxFileTabs() {
        try {
            const rawTabs = localStorage.getItem('webxtl_file_tabs');
            if (rawTabs) {
                const tabs = JSON.parse(rawTabs);
                for (const t of tabs) {
                    if (t && t.filename && t.type !== 'hkl' && t.type !== 'fcf') {
                        this.openFileTab(t.filename, t.content, t.type, t.project || null, false);
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to restore file tabs:', e.message);
        }
    }

    // Fallback used when no server project is known: restore the raw .res/.ins
    // text plus HKL reference that were persisted before the restart.
    restoreSavedTextSession() {
        const resContent = localStorage.getItem('webxtl_res_content');
        const loadedType = localStorage.getItem('webxtl_loaded_type');
        const filename = localStorage.getItem('webxtl_loaded_filename');
        const hklName = localStorage.getItem('webxtl_hkl_name');
        const hklProject = localStorage.getItem('webxtl_hkl_project');
        const fcfContent = localStorage.getItem('webxtl_fcf_content');
        const currentProject = localStorage.getItem('webxtl_current_project');

        if (!resContent || !loadedType) return;

        console.log('Restoring last session from localStorage...');
        this.state.loadedContent = resContent;
        this.state.loadedType = loadedType;
        this.state.loadedFilename = filename || null;
        if (currentProject) this.state.currentProject = currentProject;

        const editor = this.state.editors[loadedType] || this.state.editors.res;
        if (editor) {
            editor.setValue(this.truncateContent(resContent), -1);
        }

        this.renderContent(resContent, loadedType);
        this.resetView();

        // The HKL content is not persisted (only its name/project), so a
        // restored session references the server-side file instead of holding
        // the data in the browser.
        if (hklName) {
            this.state.hklName = hklName || null;
            this.state.hklContent = null;
            if (hklProject || this.state.currentProject) {
                this.state.hklServerProject = hklProject || this.state.currentProject;
            }
            this.refreshHklStatus();
        }

        if (fcfContent) {
            setTimeout(() => this.renderMap(fcfContent), 200);
        }

        this.restoreAuxFileTabs();

        // After a session restore the HKL lives only on the server; register the
        // reference (without loading content) so the status badge shows it and
        // refine/solve can run immediately.
        if (!this.state.hklContent && !this.state.hklServerProject) {
            setTimeout(() => { this.ensureHklForRun(); }, 150);
        }
    }

    init() {
        this.enableSplitView();
        this.setupEditors();
        this.setup3D();
        this.setupMapControls();
        this.setupFileHandling();
        this.setupEditorCommands();
        this.setupUIEvents();
        this.setupFragmentControls();
        this.setupPreferences();
        this.setupAI();
        this.restoreStateFromLocalStorage();
    }

    setupPreferences() {
        // Open Modal
        const toolSettings = document.getElementById('tool-settings');
        if (toolSettings) {
            toolSettings.addEventListener('click', () => {
                const modal = new bootstrap.Modal(document.getElementById('preferencesModal'));
                modal.show();
            });
        }

        // Dot-path helpers over this.state.preferences
        const getPref = (path, fallback) => {
            const parts = path.split('.');
            let cur = this.state.preferences;
            for (const p of parts) {
                if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
                cur = cur[p];
            }
            return cur === undefined ? fallback : cur;
        };
        const setPref = (path, val) => {
            const parts = path.split('.');
            let cur = this.state.preferences;
            for (let i = 0; i < parts.length - 1; i++) {
                if (cur[parts[i]] === undefined) cur[parts[i]] = {};
                cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = val;
        };

        // id -> preference path (+ input type)
        const BINDINGS = [
            // General
            { id: 'pref-ui-fontsize', path: 'general.uiFontSize', type: 'number' },
            { id: 'pref-server-url', path: 'general.serverUrl' },
            { id: 'pref-refine-timeout', path: 'general.refineTimeout', type: 'number' },
            { id: 'pref-restore-session', path: 'general.restoreSession', type: 'checkbox' },
            { id: 'pref-autosave', path: 'general.autoSave', type: 'checkbox' },
            // Editor
            { id: 'pref-editor-fontsize', path: 'editor.fontSize', type: 'number' },
            { id: 'pref-editor-theme', path: 'editor.theme' },
            { id: 'pref-editor-fontfamily', path: 'editor.fontFamily' },
            { id: 'pref-editor-tabsize', path: 'editor.tabSize', type: 'number' },
            { id: 'pref-editor-wrap', path: 'editor.wrapLines', type: 'checkbox' },
            { id: 'pref-editor-gutter', path: 'editor.showLineNumbers', type: 'checkbox' },
            { id: 'pref-editor-highlight', path: 'editor.highlightActiveLine', type: 'checkbox' },
            // Viewer
            { id: 'pref-bg-color', path: 'viewer.backgroundColor', type: 'color' },
            { id: 'pref-bond-color', path: 'viewer.bondColor', type: 'color' },
            { id: 'pref-cell-color', path: 'viewer.unitCellColor', type: 'color' },
            { id: 'pref-label-color', path: 'viewer.labels.color', type: 'color' },
            { id: 'pref-bond-metal', path: 'viewer.bondThresholds.metal', type: 'number' },
            { id: 'pref-bond-nonmetal', path: 'viewer.bondThresholds.nonMetal', type: 'number' },
            { id: 'pref-bond-hbond', path: 'viewer.bondThresholds.hBond', type: 'number' },
            { id: 'pref-bond-radius', path: 'viewer.bonds.radius', type: 'number' },
            { id: 'pref-atom-scale', path: 'viewer.atoms.scale', type: 'number' },
            { id: 'pref-quality', path: 'viewer.atoms.resolution' },
            { id: 'pref-max-atoms', path: 'viewer.atoms.maxAtoms', type: 'number' },
            { id: 'pref-label-size', path: 'viewer.labels.fontSize', type: 'number' },
            { id: 'pref-label-offx', path: 'viewer.labels.offsetX', type: 'number' },
            { id: 'pref-label-offy', path: 'viewer.labels.offsetY', type: 'number' },
            { id: 'pref-label-offz', path: 'viewer.labels.offsetZ', type: 'number' },
            // Map
            { id: 'pref-map-type', path: 'map.type' },
            { id: 'pref-map-sigma', path: 'map.sigma', type: 'number' },
            { id: 'pref-map-radius', path: 'map.radius', type: 'number' },
            { id: 'pref-map-resolution', path: 'map.resolution', type: 'number' },
            { id: 'pref-map-color', path: 'map.color', type: 'color' },
            { id: 'pref-map-style', path: 'map.style' },
            { id: 'pref-map-opacity', path: 'map.opacity', type: 'number' },
            { id: 'pref-map-autoshow', path: 'map.autoShow', type: 'checkbox' }
        ];

        BINDINGS.forEach(({ id, path, type = 'text' }) => {
            const el = document.getElementById(id);
            if (!el) return;

            // Set initial value from preferences
            const val = getPref(path);
            if (val !== undefined) {
                if (type === 'checkbox') el.checked = !!val;
                else el.value = val;
            }

            el.addEventListener('input', () => {
                let v = el.value;
                if (type === 'checkbox') v = el.checked;
                else if (type === 'number') v = parseFloat(v);
                else if (type === 'color') v = el.value;
                setPref(path, v);
                this.savePreferences();
                this.applyPreferences();
            });
        });

        // Sync toolbar map controls from preferences and apply initial prefs
        this.applyMapControlsFromPrefs();
        this.applyPreferences();
    }

    applyMapControlsFromPrefs() {
        const typeSel = document.getElementById('map-type');
        const styleSel = document.getElementById('map-style');
        const levelIn = document.getElementById('map-level');
        const radiusIn = document.getElementById('map-radius');
        const opacityIn = document.getElementById('map-opacity');
        const map = this.state.preferences.map;
        if (typeSel && map.type) typeSel.value = map.type;
        if (styleSel && map.style) styleSel.value = map.style;
        if (levelIn && map.sigma) levelIn.value = map.sigma;
        if (radiusIn && map.radius) radiusIn.value = map.radius;
        if (opacityIn && map.opacity != null) opacityIn.value = map.opacity;
    }

    applyPreferences() {
        // General
        const uiSize = this.state.preferences.general.uiFontSize;
        document.documentElement.style.setProperty('--ui-font-size', uiSize + 'px');
        // Apply to specific elements if CSS var isn't enough (Bootstrap overrides)
        const navLinks = document.querySelectorAll('.navbar-nav .nav-link, .dropdown-item');
        navLinks.forEach(el => el.style.fontSize = uiSize + 'px');

        // Editor
        const prefs = this.state.preferences.editor;
        const applyEditorOpts = (editor) => {
            if (!editor) return;
            editor.setTheme(prefs.theme);
            editor.setFontSize(prefs.fontSize);
            editor.setOption('fontFamily', prefs.fontFamily);
            editor.setOption('tabSize', prefs.tabSize);
            editor.setOption('useSoftTabs', true);
            editor.setOption('wrap', prefs.wrapLines ? 'free' : false);
            editor.setOption('showLineNumbers', prefs.showLineNumbers);
            editor.setOption('showGutter', prefs.showLineNumbers);
            editor.setOption('highlightActiveLine', prefs.highlightActiveLine);
            // SHELX/CIF files are column/format driven - never auto-indent the
            // next line when pressing Enter (keeps new lines at column 0).
            editor.setOption('enableAutoIndent', false);
            editor.setOption('behavioursEnabled', false);
        };
        applyEditorOpts(this.state.editors.res);
        applyEditorOpts(this.state.editors.cif);
        if (this.state.editors.lst) applyEditorOpts(this.state.editors.lst);
        if (this.state.fileTabs) {
            Object.values(this.state.fileTabs).forEach(t => applyEditorOpts(t.editor));
        }

        // Viewer
        const bgColor = this.state.preferences.viewer.backgroundColor;
        if (this.state.scene) {
            this.state.scene.background = new THREE.Color(bgColor);
        }

        // Sync toolbar map controls
        this.applyMapControlsFromPrefs();

        // Apply map display style (wireframe vs smooth surface) and opacity
        if (this.state.densityRenderer) {
            this.state.densityRenderer.setStyle(this.state.preferences.map.style || 'wireframe');
            this.state.densityRenderer.setOpacity(this.state.preferences.map.opacity != null
                ? this.state.preferences.map.opacity : 0.4);
        }

        // Re-render 3D content to apply bond/color changes
        if (this.state.loadedContent) {
            this.renderContent(this.state.loadedContent, this.state.loadedType);
        }

        // Refresh the map (color etc.) if one is currently visible
        if (this.state.currentMapData && this.state.densityRenderer) {
            const btn = document.getElementById('tool-map-toggle');
            if (btn && btn.classList.contains('active')) {
                this.renderDensitySurface(
                    this.state.cachedMapData,
                    this.state.currentMapData.cell,
                    parseFloat(document.getElementById('map-level').value) || 1.0,
                    this.state.currentMapRadius,
                    this.state.currentMapBounds,
                    this.state.currentMapCenter
                );
            }
        }
    }

    // --- Project Manager Methods ---

    // Helper for API URL
    getApiUrl(path) {
        // Default to port 3000 on the same host
        const host = window.location.hostname;
        return `http://${host}:3000${path}`;
    }

    async apiListProjects() {
        const res = await fetch(this.getApiUrl('/projects'));
        if (!res.ok) throw new Error('Failed to list projects');
        return res.json();
    }

    async apiLoadProject(name) {
        const res = await fetch(this.getApiUrl(`/projects/${name}`));
        if (!res.ok) throw new Error('Failed to load project');
        return res.json();
    }

    async apiSaveProject(name, content, type) {
        const res = await fetch(this.getApiUrl(`/projects/${name}/save`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, type })
        });
        if (!res.ok) throw new Error('Failed to save project');
        return res.json();
    }

    async apiSaveProjectFile(name, filename, content) {
        const res = await fetch(this.getApiUrl(`/projects/${name}/savefile`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content })
        });
        if (!res.ok) throw new Error('Failed to save file');
        return res.json();
    }

    // Write a copy of a file into the project's backup/ directory (used to keep
    // the original reflection data before an in-place absorption correction).
    async apiBackupProjectFile(name, filename, content) {
        const res = await fetch(this.getApiUrl(`/projects/${encodeURIComponent(name)}/backupfile`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, content })
        });
        if (!res.ok) throw new Error('Failed to back up file');
        return res.json();
    }

    // Upload binary/large project companion files (HKL reflection data, SQUEEZE
    // .fab masks, ...) to a server project without holding their content in the
    // browser. Files keep their original names server-side.
    async apiUploadProjectFiles(name, files) {
        const form = new FormData();
        for (const f of files) form.append('file', f, f.name);
        const res = await fetch(this.getApiUrl(`/projects/${encodeURIComponent(name)}/upload`), {
            method: 'POST',
            body: form
        });
        if (!res.ok) {
            let detail = '';
            try { const e = await res.json(); detail = e.error || e.details || ''; } catch (err) { /* ignore */ }
            throw new Error(detail || `Upload failed (HTTP ${res.status})`);
        }
        return res.json();
    }

    async apiListBackups(name) {
        const res = await fetch(this.getApiUrl(`/projects/${name}/backups`));
        if (!res.ok) throw new Error('Failed to list backups');
        return res.json();
    }

    async apiGetBackup(name, filename) {
        const res = await fetch(this.getApiUrl(`/projects/${name}/backups/${filename}`));
        if (!res.ok) throw new Error('Failed to get backup');
        return res.json();
    }

    async apiListProjectFiles(name) {
        const res = await fetch(this.getApiUrl(`/projects/${name}/files`));
        if (!res.ok) throw new Error('Failed to list project files');
        return res.json();
    }

    async apiListPrograms() {
        const res = await fetch(this.getApiUrl('/programs'));
        if (!res.ok) throw new Error('Failed to list programs');
        return res.json();
    }

    // POST an HKL file to the xrdspace analysis endpoint.
    // `hklText` may be null when the HKL is a server-project file; in that case
    // `project` names the project directory whose same-basename .hkl is used.
    // `cell` is optional: "a b c alpha beta gamma" or null.
    // `spaceGroup` is optional: number or Hermann-Mauguin symbol, or null.
    // `signal` is an optional AbortSignal for cancellation.
    async apiXrdspaceAnalyze(hklText, cell, spaceGroup, signal, project) {
        const formData = new FormData();
        if (hklText) {
            formData.append('hkl', new Blob([hklText], { type: 'text/plain' }), 'data.hkl');
        } else if (project) {
            formData.append('project', project);
        } else {
            throw new Error('No HKL data available for xrdspace analysis.');
        }
        if (cell) formData.append('cell', cell);
        if (spaceGroup !== undefined && spaceGroup !== null && spaceGroup !== '') {
            formData.append('spaceGroup', String(spaceGroup));
        }
        const url = this.getApiUrl('/xrdspace/analyze');
        let res;
        try {
            const combined = signal
                ? (typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([AbortSignal.timeout(180000), signal])
                    : signal)
                : AbortSignal.timeout(180000);
            res = await fetch(url, { method: 'POST', body: formData, signal: combined });
        } catch (e) {
            if (e && e.name === 'AbortError' && signal && signal.aborted) {
                throw e; // user cancelled
            }
            const hint = (e && e.name === 'TimeoutError')
                ? 'The analysis took too long and timed out.'
                : 'Is the backend server running? (node server.js)';
            throw new Error(`Could not reach xrdspace at ${url} — ${hint} (${e.message})`);
        }
        if (!res.ok) throw new Error('Space-group analysis failed');
        return res.json();
    }

    // Search the COD / PDB by unit cell (server-side, metadata only).
    async apiDbSearch(params) {
        const res = await fetch(this.getApiUrl('/xrdspace/db-search'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        if (!res.ok) {
            let detail = '';
            try { const e = await res.json(); detail = e.error || e.details || ''; } catch (err) { /* ignore */ }
            throw new Error(detail || `Database search failed (HTTP ${res.status})`);
        }
        return res.json();
    }

    // Download a COD / PDB entry into a new project on the server.
    async apiDbFetch(database, id, opts = {}) {
        const res = await fetch(this.getApiUrl('/xrdspace/db-fetch'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ database, id, ...opts })
        });
        if (!res.ok) {
            let detail = '';
            try { const e = await res.json(); detail = e.error || e.details || ''; } catch (err) { /* ignore */ }
            throw new Error(detail || `Fetch failed (HTTP ${res.status})`);
        }
        return res.json();
    }

    async apiGetProjectFile(projectName, filename) {
        const res = await fetch(this.getApiUrl(`/projects/${projectName}/files/${filename}`));
        if (!res.ok) throw new Error('Failed to fetch project file');
        return res.text();
    }

    // POST a .res/.ins model to transform its asymmetric unit into the target
    // space group (expands/removes symmetry-related molecules on the server).
    async apiTransformModelToSg(modelText, spaceGroup) {
        const formData = new FormData();
        formData.append('res', new Blob([modelText], { type: 'text/plain' }), 'structure.res');
        formData.append('spaceGroup', String(spaceGroup));
        const res = await fetch(this.getApiUrl('/xrdspace/transform-model'), { method: 'POST', body: formData });
        if (!res.ok) {
            let detail = '';
            try { const e = await res.json(); detail = e.error || e.details || ''; } catch (err) { /* ignore */ }
            throw new Error(detail || `Transform failed (HTTP ${res.status})`);
        }
        return res.json();
    }

    // Apply the transform result to the editor: replace the structure with the
    // new .res text (transformed, re-labeled atoms) and report the change.
    applyTransformModelToSg(result) {
        if (!result || !result.res) return;
        this.loadStructureIntoEditor(result.res, this.state.loadedFilename || 'structure.res');
        const lines = [result.report || ''];
        if (result.removed > 0) lines.push(`Removed ${result.removed} symmetry-redundant atom(s).`);
        if (result.added > 0) lines.push(`Added ${result.added} symmetry-related atom(s).`);
        lines.push('The model has been re-set to the target space group and loaded into the editor.');
        alert(lines.join('\n\n'));
    }

    // --- Publish Methods ---

    async apiListTemplates() {
        const res = await fetch(this.getApiUrl('/templates'));
        if (!res.ok) throw new Error('Failed to list templates');
        return res.json();
    }

    async apiGetCifValues(project) {
        const res = await fetch(this.getApiUrl(`/projects/${project}/cif-values`));
        if (!res.ok) throw new Error('Failed to read CIF values');
        return res.json();
    }

    openPublishModal(mode) {
        const project = this.state.currentProject;
        if (!project) {
            alert('Please open a server project first (Project > Project Manager).');
            return;
        }
        const modalEl = document.getElementById('publishModal');
        const info = document.getElementById('publish-project-info');
        info.textContent = `Project: ${project}`;
        document.getElementById('publish-status').innerHTML = '';

        // Show/hide sections based on mode
        const cifSection = document.getElementById('publish-cif-section');
        const reportSection = document.getElementById('publish-report-section');
        const btnCif = document.getElementById('btn-generate-cif');
        const btnReport = document.getElementById('btn-generate-report');
        const title = document.getElementById('publishModalTitle');

        if (mode === 'cif') {
            title.textContent = 'Create Publish CIF';
            cifSection.style.display = '';
            reportSection.style.display = 'none';
            btnCif.style.display = '';
            btnReport.style.display = 'none';
            this.loadPublishTemplates();
            this.loadPublishFormValues(project);
        } else {
            title.textContent = 'Crystallographic Report (DOCX)';
            cifSection.style.display = 'none';
            reportSection.style.display = '';
            btnCif.style.display = 'none';
            btnReport.style.display = '';
        }

        new bootstrap.Modal(modalEl).show();
    }

    async loadPublishTemplates() {
        const userSel = document.getElementById('pub-user-template');
        const devSel = document.getElementById('pub-device-template');
        if (!userSel || !devSel) return;
        try {
            const { users, devices } = await this.apiListTemplates();
            const prevUser = userSel.value;
            const prevDev = devSel.value;
            userSel.innerHTML = '<option value="">-- none --</option>' +
                users.map(u => `<option value="${u}">${u}</option>`).join('');
            devSel.innerHTML = '<option value="">-- none --</option>' +
                devices.map(d => `<option value="${d}">${d}</option>`).join('');
            if (prevUser && users.includes(prevUser)) userSel.value = prevUser;
            if (prevDev && devices.includes(prevDev)) devSel.value = prevDev;
        } catch (e) {
            console.error('Failed to load templates:', e);
        }
    }

    // Pre-fill the Crystal Setting / Other Settings form from the project CIF.
    async loadPublishFormValues(project) {
        try {
            const v = await this.apiGetCifValues(project);
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el && val) el.value = val;
            };
            // Selects: only set if the option exists.
            const setSel = (id, val) => {
                const el = document.getElementById(id);
                if (!el || !val) return;
                const match = Array.from(el.options).some(o => o.value === val);
                if (match) el.value = val;
            };
            setSel('pub-colour', v._exptl_crystal_colour);
            setSel('pub-shape', v._exptl_crystal_description);
            set('pub-moiety', v._chemical_formula_moiety);
            set('pub-size-min', v._exptl_crystal_size_min);
            set('pub-size-mid', v._exptl_crystal_size_mid);
            set('pub-size-max', v._exptl_crystal_size_max);
            setSel('pub-cell-setting', v._symmetry_cell_setting);
            set('pub-space-hm', v._symmetry_space_group_name_Hall);
            set('pub-z', v._cell_formula_units_Z);
            set('pub-abs-min', v._exptl_absorpt_correction_T_min);
            set('pub-abs-max', v._exptl_absorpt_correction_T_max);
            set('pub-temp', v._diffrn_ambient_temperature);
            setSel('pub-h-treat', v._refine_ls_hydrogen_treatment);
        } catch (e) {
            console.error('Failed to pre-fill publish form:', e);
        }
    }

    // Collect the form values into a key->value map (empty values omitted).
    collectPublishFormValues() {
        const val = (id) => (document.getElementById(id)?.value || '').trim();
        const map = {
            '_chemical_formula_moiety': val('pub-moiety'),
            '_exptl_crystal_colour': val('pub-colour'),
            '_exptl_crystal_description': val('pub-shape'),
            '_exptl_crystal_size_min': val('pub-size-min'),
            '_exptl_crystal_size_mid': val('pub-size-mid'),
            '_exptl_crystal_size_max': val('pub-size-max'),
            '_symmetry_cell_setting': val('pub-cell-setting'),
            '_symmetry_space_group_name_Hall': val('pub-space-hm'),
            '_cell_formula_units_Z': val('pub-z'),
            '_exptl_absorpt_correction_T_min': val('pub-abs-min'),
            '_exptl_absorpt_correction_T_max': val('pub-abs-max'),
            '_diffrn_ambient_temperature': val('pub-temp'),
            '_refine_ls_hydrogen_treatment': val('pub-h-treat'),
        };
        const out = {};
        for (const [k, v] of Object.entries(map)) {
            if (v && v !== '?') out[k] = v;
        }
        return out;
    }

    wirePublishModal() {
        const btnCif = document.getElementById('btn-generate-cif');
        if (btnCif) btnCif.addEventListener('click', () => this.generatePublishCif());

        const btnReport = document.getElementById('btn-generate-report');
        if (btnReport) btnReport.addEventListener('click', () => this.generateReportDocx());
    }

    setPublishStatus(html, isError = false) {
        const el = document.getElementById('publish-status');
        if (el) el.innerHTML = `<span class="${isError ? 'text-danger' : 'text-success'}">${html}</span>`;
    }

    async generatePublishCif() {
        const project = this.state.currentProject;
        if (!project) return;

        const body = {
            mode: 'template',
            userTemplate: document.getElementById('pub-user-template').value,
            deviceTemplate: document.getElementById('pub-device-template').value,
            extraValues: this.collectPublishFormValues(),
        };

        this.setPublishStatus('Generating publish CIF...');
        try {
            const res = await fetch(this.getApiUrl(`/projects/${project}/publish-cif`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Failed to generate publish CIF');

            this.downloadText(data.content, 'publish.cif');
            this.setPublishStatus('Publish CIF created and downloaded (also saved to project as publish.cif).');
        } catch (e) {
            this.setPublishStatus('Error: ' + e.message, true);
        }
    }

    async generateReportDocx() {
        const project = this.state.currentProject;
        if (!project) return;
        const title = document.getElementById('report-title').value.trim();

        this.setPublishStatus('Generating DOCX report...');
        try {
            const res = await fetch(this.getApiUrl(`/projects/${project}/report-docx`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title }),
            });
            if (!res.ok) {
                let msg = 'Failed to generate report';
                try { msg = (await res.json()).error || msg; } catch (_) { /* ignore */ }
                throw new Error(msg);
            }
            const blob = await res.blob();
            this.downloadBlob(blob, `${project}_report.docx`);
            this.setPublishStatus('Report generated and downloaded.');
        } catch (e) {
            this.setPublishStatus('Error: ' + e.message, true);
        }
    }

    downloadText(text, filename) {
        const blob = new Blob([text], { type: 'text/plain' });
        this.downloadBlob(blob, filename);
    }

    downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // Reset all loaded, project-specific UI state (editors, file tabs, the 3D
    // scene, HKL/FCF/map references, status badges) without confirmation.
    // Nothing on the server is touched. Called when switching projects and by
    // clearAllData().
    resetLoadedProject() {
        // Clear the structure/CIF/LST editors.
        ['res', 'cif', 'lst'].forEach(type => {
            const ed = this.state.editors[type];
            if (ed) ed.setValue('', -1);
        });
        this.setCifTabVisible(false);

        // Close and destroy every file tab.
        const tabKeys = Object.keys(this.state.fileTabs);
        for (const key of tabKeys) {
            const tab = this.state.fileTabs[key];
            const safeKey = this.safeId(key);
            const btn = document.getElementById('tab-file-' + safeKey);
            const pane = document.getElementById('pane-file-' + safeKey);
            if (btn) btn.closest('li')?.remove();
            if (pane) pane.remove();
            if (tab && tab.editor) tab.editor.destroy();
        }
        this.state.fileTabs = {};

        // Clear the 3D scene (molecule + any density map mesh).
        if (this.state.moleculeRenderer) {
            this.state.moleculeRenderer.clear();
            this.state.moleculeRenderer.clearHighlights();
            this.state.moleculeRenderer.expandedAtoms = [];
            this.state.moleculeRenderer.boundingRadius = undefined;
            this.state.moleculeRenderer.atomMeshes = {};
            this.state.moleculeRenderer.materials = {};
            this.state.moleculeRenderer.labelCache = {};
        }
        if (this.state.densityRenderer) {
            this.state.densityRenderer.disposeMeshes();
        }
        if (this.state.moleculeRenderer && this.state.moleculeRenderer.group) {
            while (this.state.moleculeRenderer.group.children.length > 0) {
                this.state.moleculeRenderer.group.remove(this.state.moleculeRenderer.group.children[0]);
            }
        }
        this.resetView();
        this.deselectAll();

        // Reset loaded-data state.
        this.state.loadedContent = null;
        this.state.loadedFilename = null;
        this.state.loadedType = 'res';
        this.state.currentProject = null;
        this.state.hklContent = null;
        this.state.hklName = null;
        this.state.hklServerProject = null;
        this.state.fcfRawContent = null;
        this.state.pendingCifFile = null;
        this.state.cachedMapData = null;
        this.state.currentMapData = null;
        this.state.currentMapBounds = null;
        this.state.currentMapCenter = null;
        this.state.currentMapRadius = null;
        this.state.mapFocusFrac = null;
        this.state.xrdspaceIns = null;
        this.state.lastStructureTabKey = null;
        this.state.selectionOrder = [];
        this.state.parsedData = null;
        this.state.rsr = { active: false, from: null, to: null };
        this.state.fragment = { active: false, selectedId: null, placedAtoms: null };

        // Reset the HKL status badge and status bar.
        const statusHkl = document.getElementById('status-hkl');
        if (statusHkl) {
            statusHkl.classList.remove('bg-success');
            statusHkl.classList.add('bg-secondary');
            statusHkl.title = "HKL File Status";
        }
        const statusBar = document.getElementById('status-bar-content');
        if (statusBar) statusBar.textContent = 'Ready';
    }

    // Unload everything from the UI: reset the loaded state and forget the
    // persisted session. Nothing on the server is touched.
    clearAllData() {
        if (!confirm("Clear all loaded data from the UI?\n\nFiles on the server are not deleted.")) return;

        this.resetLoadedProject();

        // Forget the persisted session so a refresh does not restore anything.
        try {
            ['webxtl_res_content', 'webxtl_loaded_type', 'webxtl_loaded_filename',
             'webxtl_current_project', 'webxtl_file_tabs', 'webxtl_hkl_content',
             'webxtl_hkl_name', 'webxtl_hkl_project', 'webxtl_fcf_content', 'webxtl_ai_logs'].forEach(k => localStorage.removeItem(k));
        } catch (e) { /* ignore */ }

        // Stop any running AI analysis / solve pipeline.
        this.stopAIAnalysis();
        if (this.solveAbort) { try { this.solveAbort.abort(); } catch (e) { /* */ } this.solveAbort = null; }
        this.state.aiLogs = [];
        this.state.aiLog = null;
        this.refreshAILogList && this.refreshAILogList();

        console.log("Cleared all data from the UI.");
    }

    async openProjectManager() {
         const modalEl = document.getElementById('projectManagerModal');
         const modal = new bootstrap.Modal(modalEl);
         modal.show();
         
         // Reset UI
         const listEl = document.getElementById('project-list');
         listEl.innerHTML = '<div class="text-center p-3"><span class="spinner-border spinner-border-sm"></span> Loading...</div>';
         document.getElementById('btn-load-project').disabled = true;
         document.getElementById('project-file-list').innerHTML = '';
         document.getElementById('backup-list').innerHTML = '';
         document.getElementById('btn-restore-backup').disabled = true;
         document.getElementById('backup-project-name').textContent = 'Select a project to view backups.';
         document.getElementById('files-project-name').textContent = 'Select a project to view files.';

         try {
             const projects = await this.apiListProjects();
             listEl.innerHTML = '';
             if (projects.length === 0) {
                 listEl.innerHTML = '<div class="list-group-item text-muted">No projects found.</div>';
             } else {
                 projects.forEach(p => {
                     const item = document.createElement('a');
                     item.className = 'list-group-item list-group-item-action';
                     item.textContent = p;
                     item.href = '#';
                     item.onclick = (e) => {
                         e.preventDefault();
                         // Deselect others
                         listEl.querySelectorAll('a').forEach(a => a.classList.remove('active'));
                         item.classList.add('active');
                         this.selectProjectInManager(p);
                     };
                     listEl.appendChild(item);
                 });
             }
         } catch (err) {
             console.error(err);
             listEl.innerHTML = `<div class="text-danger p-3">Error loading projects: ${err.message}</div>`;
         }
    }
    
    async selectProjectInManager(projectName) {
        document.getElementById('btn-load-project').disabled = false;
        document.getElementById('btn-load-project').onclick = () => this.loadProjectFromServer(projectName);
        
        const fileListEl = document.getElementById('project-file-list');
        const backupListEl = document.getElementById('backup-list');
        
        fileListEl.innerHTML = '<div class="text-center p-2"><span class="spinner-border spinner-border-sm"></span></div>';
        backupListEl.innerHTML = '<div class="text-center p-2"><span class="spinner-border spinner-border-sm"></span></div>';
        
        document.getElementById('files-project-name').textContent = `Files in: ${projectName}`;
        document.getElementById('backup-project-name').textContent = `Backups for: ${projectName}`;
        
        // Load Files
        try {
            const files = await this.apiListProjectFiles(projectName);
            fileListEl.innerHTML = '';
            if (files.length === 0) {
                fileListEl.innerHTML = '<div class="list-group-item text-muted small">No files found.</div>';
            } else {
                files.forEach(f => {
                    const item = document.createElement('a');
                    item.className = 'list-group-item list-group-item-action py-1 d-flex justify-content-between align-items-center';
                    item.href = '#';
                    const icon = this.getFileIcon(f.name);
                    item.innerHTML = `<span><i class="${icon} me-2 text-secondary"></i><small>${f.name}</small></span>
                                     <span class="badge bg-light text-dark border small" style="font-size: 0.65rem;">${(f.size/1024).toFixed(1)} KB</span>`;
                    item.onclick = (e) => {
                         e.preventDefault();
                         fileListEl.querySelectorAll('a').forEach(a => a.classList.remove('active'));
                         item.classList.add('active');
                         this.loadSpecificFileFromServer(projectName, f.name);
                    };
                    fileListEl.appendChild(item);
                });
            }
        } catch (err) {
             fileListEl.innerHTML = `<div class="text-danger small">Error: ${err.message}</div>`;
        }

        // Load Backups
        try {
            const backups = await this.apiListBackups(projectName);
            backupListEl.innerHTML = '';
            if (backups.length === 0) {
                backupListEl.innerHTML = '<div class="list-group-item text-muted small">No backups found.</div>';
            } else {
                backups.forEach(f => {
                    const item = document.createElement('a');
                    item.className = 'list-group-item list-group-item-action py-1';
                    item.href = '#';
                    item.innerHTML = `<small>${f}</small>`;
                    item.onclick = (e) => {
                         e.preventDefault();
                         backupListEl.querySelectorAll('a').forEach(a => a.classList.remove('active'));
                         item.classList.add('active');
                         document.getElementById('btn-restore-backup').disabled = false;
                         document.getElementById('btn-restore-backup').onclick = () => this.restoreBackupFromServer(projectName, f);
                    };
                    backupListEl.appendChild(item);
                });
            }
        } catch (err) {
             backupListEl.innerHTML = `<div class="text-danger small">Error: ${err.message}</div>`;
        }
    }

    getFileIcon(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        if (ext === 'res' || ext === 'ins') return 'fa-solid fa-file-lines';
        if (ext === 'hkl') return 'fa-solid fa-table';
        if (ext === 'fcf') return 'fa-solid fa-mountain-sun';
        if (ext === 'fab') return 'fa-solid fa-droplet';
        if (ext === 'lst' || ext === 'log') return 'fa-solid fa-list';
        return 'fa-solid fa-file';
    }

    safeId(str) {
        return String(str).replace(/[^a-zA-Z0-9_-]/g, '-');
    }

    getAceModeForExt(type) {
        if (type === 'cif') return 'ace/mode/cif';
        if (['res', 'ins', 'shelx'].includes(type)) return 'ace/mode/shelx';
        return 'ace/mode/text';
    }

    switchToTab(id) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('active')) {
            new bootstrap.Tab(el).show();
        }
    }

    // Show/hide the CIF tab. It is only meaningful when the project actually
    // has a CIF (primary structure or a companion), never as an empty tab.
    setCifTabVisible(visible) {
        const li = document.getElementById('tab-cif-item');
        if (!li) return;
        li.style.display = visible ? '' : 'none';
        if (!visible) {
            const btn = document.getElementById('tab-cif');
            if (btn && btn.classList.contains('active')) this.switchToTab('tab-split');
        }
    }

    openFileTab(filename, content, type, sourceProject = null, activate = true) {
        const key = filename;
        let tab = this.state.fileTabs[key];

        if (tab) {
            // Existing tab: refresh content if changed
            if (content !== undefined && tab.editor.getValue() !== content) {
                tab.editor.setValue(content, -1);
                tab.dirty = true;
            }
            if (sourceProject) this.state.currentProject = sourceProject;
            if (activate) this.activateFileTab(key);
            return tab;
        }

        // --- Create tab button ---
        const tabsUl = document.getElementById('mainTabs');
        const li = document.createElement('li');
        li.className = 'nav-item';
        li.setAttribute('role', 'presentation');

        const btn = document.createElement('button');
        btn.className = 'nav-link w-100 text-start fw-bold rounded-0 py-2 d-flex align-items-center';
        btn.style.cssText = 'padding-left: 4px !important; padding-right: 4px !important; font-size: 0.65rem;';
        btn.id = 'tab-file-' + this.safeId(key);
        btn.setAttribute('data-bs-toggle', 'tab');
        btn.setAttribute('data-bs-target', '#pane-file-' + this.safeId(key));
        btn.setAttribute('type', 'button');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('title', filename);

        // Label shows just the extension (deduplicated), full name in tooltip
        const extLabel = (type || filename.split('.').pop() || 'txt').toUpperCase();
        const existingWithLabel = Object.values(this.state.fileTabs).filter(t => t.label === extLabel).length;
        const label = existingWithLabel === 0 ? extLabel : extLabel + (existingWithLabel + 1);

        const labelEl = document.createElement('span');
        labelEl.className = 'text-truncate';
        labelEl.textContent = label;
        btn.appendChild(labelEl);

        const saveBtn = document.createElement('span');
        saveBtn.className = 'tab-save-btn ms-1';
        saveBtn.setAttribute('title', 'Save to server');
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk" style="font-size: 0.6rem; color: #6c757d;"></i>';
        saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.saveFileTab(key);
        });
        btn.appendChild(saveBtn);

        li.appendChild(btn);
        tabsUl.appendChild(li);

        // --- Create pane ---
        const contentDiv = document.getElementById('mainTabContent');
        const pane = document.createElement('div');
        pane.className = 'tab-pane fade h-100 w-100';
        pane.id = 'pane-file-' + this.safeId(key);
        pane.setAttribute('role', 'tabpanel');
        const editorDiv = document.createElement('div');
        editorDiv.id = 'editor-file-' + this.safeId(key);
        editorDiv.className = 'h-100 w-100';
        pane.appendChild(editorDiv);
        contentDiv.appendChild(pane);

        // --- Create Ace editor ---
        const editor = ace.edit(editorDiv.id);
        editor.setTheme(this.state.preferences.editor.theme);
        editor.setFontSize(this.state.preferences.editor.fontSize);
        editor.setOption('fontFamily', this.state.preferences.editor.fontFamily);
        // Never auto-indent new lines or pair brackets - SHELX/CIF text is
        // column driven, so pressing Enter must land at the start of the line.
        editor.setOption('enableAutoIndent', false);
        editor.setOption('behavioursEnabled', false);
        editor.session.setMode(this.getAceModeForExt(type));
        editor.setValue(content, -1);

        tab = {
            filename,
            label,
            type,
            editor,
            project: sourceProject || this.state.currentProject,
            dirty: false
        };
        this.state.fileTabs[key] = tab;

        editor.session.on('change', () => {
            tab.dirty = true;
            if (tab.type === 'hkl') this.state.hklContent = editor.getValue();
            if (tab.type === 'fcf') this.state.fcfRawContent = editor.getValue();
            const tBtn = document.getElementById('tab-file-' + this.safeId(key));
            if (tBtn) tBtn.title = tab.filename + ' (unsaved)';
        });

        if (activate) this.activateFileTab(key);
        return tab;
    }

    activateFileTab(key) {
        const btn = document.getElementById('tab-file-' + this.safeId(key));
        if (btn && !btn.classList.contains('active')) {
            new bootstrap.Tab(btn).show();
        }
    }

    async saveFileTab(key) {
        const tab = this.state.fileTabs[key];
        if (!tab) return;

        const project = tab.project || this.state.currentProject || tab.filename.replace(/\.[^.]+$/, '');
        if (!project) {
            alert("No project available to save to.");
            return;
        }

        try {
            const content = tab.editor.getValue();
            await this.apiSaveProjectFile(project, tab.filename, content);
            tab.dirty = false;
            tab.content = content;
            if (tab.type === 'hkl') this.state.hklContent = content;
            if (tab.type === 'fcf') this.state.fcfRawContent = content;
            const btn = document.getElementById('tab-file-' + this.safeId(key));
            if (btn) btn.title = tab.filename;
            alert(`Saved '${tab.filename}' to project '${project}'.`);
        } catch (err) {
            alert(`Save failed: ${err.message}`);
        }
    }

    closeFileTab(key) {
        const tab = this.state.fileTabs[key];
        if (!tab) return;
        if (tab.dirty && !confirm(`'${tab.filename}' has unsaved changes. Close anyway?`)) return;

        const safeKey = this.safeId(key);
        const btn = document.getElementById('tab-file-' + safeKey);
        const pane = document.getElementById('pane-file-' + safeKey);
        if (btn) btn.closest('li')?.remove();
        if (pane) pane.remove();
        if (tab.editor) tab.editor.destroy();
        delete this.state.fileTabs[key];
    }

    async loadSpecificFileFromServer(projectName, filename, silent = false, activate = true) {
        const ext = filename.split('.').pop().toLowerCase();

        try {
            // HKL files are kept server-side (they can be very large). Opening a
            // project or clicking one of its files should NOT stream the whole
            // reflection list into the browser - only the reference is recorded.
            if (ext === 'hkl') {
                this.state.currentProject = projectName;
                this.state.hklName = filename;
                this.state.hklContent = null;
                this.state.hklServerProject = projectName;
                this.refreshHklStatus();
                this.saveStateToLocalStorage();
                if (activate) {
                    const statusHkl = document.getElementById('status-hkl');
                    if (statusHkl) statusHkl.title = 'HKL on server: ' + filename;
                }
                return;
            }
            // .fab (SQUEEZE solvent mask) is consumed server-side by SHELXL next
            // to <basename>.ins - no need to pull its content into the browser.
            if (ext === 'fab') {
                this.state.currentProject = projectName;
                this.saveStateToLocalStorage();
                if (activate) alert('FAB mask is already available in project "' + projectName + '" as ' + filename + '.\nSHELXL will pick it up when the model uses ABIN.');
                return;
            }
            const content = await this.apiGetProjectFile(projectName, filename);

            if (['res', 'ins'].includes(ext)) {
                // Primary structure (RES/INS) -> main split view
                this.state.currentProject = projectName;
                this.state.loadedType = (ext === 'ins' ? 'res' : ext);
                this.state.loadedContent = content;
                this.state.loadedFilename = filename;

                const editor = this.state.editors.res;
                if (editor) editor.setValue(content, -1);
                this.renderContent(content, 'res');
                this.resetView();
                if (activate) this.switchToTab('tab-split');
            } else if (ext === 'cif' || ext === 'mmcif') {
                // CIF / PDBx-mmCIF -> CIF tab + 3D render
                this.state.currentProject = projectName;
                this.state.loadedType = 'cif';
                this.state.loadedContent = content;
                this.state.loadedFilename = filename;
                this.setCifTabVisible(true);

                // Very large CIF/mmCIF files are rendered in 3D but only a
                // truncated head is put into the Ace editor (loading 100s of
                // MB of text into Ace crashes/hangs the tab).
                if (this.state.editors.cif) {
                    this.setEditorValueProgrammatic(this.state.editors.cif, this.truncateContent(content));
                    this.state.editors.cif.loadedFile = content;
                    this.state.editors.cif.fileId = this.state.fileId;
                }
                this.renderContent(content, 'cif');
                this.resetView();
                if (activate) this.switchToTab('tab-cif');
            } else if (ext === 'pdb') {
                // PDB -> 3D render + editable text tab
                this.state.currentProject = projectName;
                this.state.loadedType = 'pdb';
                this.state.loadedContent = content;
                this.state.loadedFilename = filename;

                this.renderContent(content, 'pdb');
                this.resetView();
                this.openFileTab(filename, content, ext, projectName, activate);
            } else {
                // FCF: read only to render the electron-density map client-side
                // (never open in a text tab - it is a static companion file).
                this.state.currentProject = projectName;
                if (ext === 'fcf') {
                    this.renderMap(content);
                } else {
                    // lst, log, ... -> editable text tab
                    this.openFileTab(filename, content, ext, projectName, activate);
                }
            }
        } catch (err) {
            console.error(`loadSpecificFileFromServer('${projectName}', '${filename}') failed:`, err);
            if (!silent) alert(`Load failed: ${err.message}`);
        }
        this.saveStateToLocalStorage();
    }

    // Fetch a project's companion CIF into the CIF editor on demand (not during
    // project load, since CIFs can be several MB and Ace is slow with them).
    async loadCifCompanion(project, filename) {
        try {
            const content = await this.apiGetProjectFile(project, filename);
            if (this.state.editors.cif) {
                this.setEditorValueProgrammatic(this.state.editors.cif, this.truncateContent(content));
                this.state.editors.cif.loadedFile = content;
                this.state.editors.cif.fileId = this.state.fileId;
            }
            this.setCifTabVisible(true);
        } catch (e) {
            console.warn('Failed to load CIF companion:', e.message);
        }
    }

    async loadProjectFromServer(name, opts = {}) {
        const silent = !!(opts && opts.silent);
        console.time(`[project] load ${name}`);
        try {
            // 1. Load Main Structure
            const data = await this.apiLoadProject(name);
            if (!data || !data.content) {
                // Project has no structure file (.res/.ins/.cif/.pdb) - nothing to display.
                if (!silent) alert(`Project '${name}' has no structure file (.res/.ins/.cif/.pdb) to load.`);
                return false;
            }
            // Switching projects: drop the previous project's loaded state
            // (editors, tabs, HKL/FCF/map references) so nothing stale leaks in.
            if (this.state.currentProject && this.state.currentProject !== data.name) {
                this.resetLoadedProject();
            }
            this.state.currentProject = data.name;
            this.state.loadedType = data.type;
            this.state.loadedContent = data.content;

            // The project folder name drives server-side runs (SHELXL/PLATON)
            // and HKL matching. Warn when the structure file stored inside has a
            // different basename, since those runs will look for <project>.hkl.
            if (data.filename) {
                const structBase = String(data.filename).replace(/\.[^.]+$/, '');
                if (structBase.toLowerCase() !== String(name).toLowerCase()) {
                    const msg = `Project name '${name}' differs from its structure file '${data.filename}'.\n\n`
                        + `Refinement and other server-side runs use the project name '${name}', `
                        + `so they look for '${name}.ins' and '${name}.hkl'. Rename the files to match the `
                        + `project (or create a project named '${structBase}') before refining.`;
                    if (silent) console.warn(msg);
                    else alert(msg);
                }
            }

            const editor = this.state.editors[data.type] || this.state.editors.res;
            if (editor && data.type !== 'pdb') {
                if (data.type === 'cif') {
                    this.setEditorValueProgrammatic(editor, this.truncateContent(data.content));
                    editor.loadedFile = data.content;
                    editor.fileId = this.state.fileId;
                } else {
                    editor.setValue(data.content, -1);
                }
            }
            console.time(`[project] renderStructure ${name}`);
            this.renderContent(data.content, data.type);
            console.timeEnd(`[project] renderStructure ${name}`);
            this.resetView();
            // Non-SHELX primaries (database-fetched CIF/PDB projects) get their
            // own view: CIF tab for CIF, a file tab for PDB.
            if (data.type === 'cif') {
                this.setCifTabVisible(true);
                this.switchToTab('tab-cif');
            } else if (data.type === 'pdb') {
                this.openFileTab(data.filename, data.content, 'pdb', name, true);
            }

            // 2. Auto-load associated HKL and FCF if they exist
            const files = await this.apiListProjectFiles(name);
            
            // Look for HKL (register the same-basename reflections file so runs
            // reuse it server-side; content is never downloaded to the browser).
            const lower = name.toLowerCase();
            const hklFile = files.find(f => f.name.toLowerCase() === `${lower}.hkl`)
                || files.find(f => /\.hkl$/i.test(f.name) && f.name.toLowerCase().startsWith(lower + '_'))
                || files.find(f => /\.hkl$/i.test(f.name));
            if (hklFile) {
                this.state.currentProject = name;
                this.state.hklName = hklFile.name;
                this.state.hklContent = null;
                this.state.hklServerProject = name;
                this.refreshHklStatus();
            } else {
                // Project has no HKL companion - no server-side reflections.
                this.state.hklContent = null;
                this.state.hklServerProject = null;
            }
            
            // FCF map: build it *after* the structure is shown. The map
            // calculation is synchronous and can take a while, so deferring it
            // keeps opening a project responsive.
            const fcfFile = files.find(f => f.name.toLowerCase() === `${name.toLowerCase()}.fcf`)
                || files.find(f => /\.fcf$/i.test(f.name) && f.name.toLowerCase().startsWith(name.toLowerCase() + '_'))
                || files.find(f => /\.fcf$/i.test(f.name));
            if (fcfFile) {
                const fcfName = fcfFile.name;
                setTimeout(() => {
                    // Guard against a quick project switch before this runs.
                    if (this.state.currentProject === name) {
                        this.loadSpecificFileFromServer(name, fcfName, true, false);
                    }
                }, 0);
            }

            // CIF companion: NEVER fetched automatically (refinement CIFs can be
            // several MB). Only remember the reference; the content is pulled
            // when the user explicitly opens the CIF tab (and confirmed for
            // large files).
            const cifFile = files.find(f => f.name.toLowerCase() === `${name.toLowerCase()}.cif`);
            this.state.pendingCifFile = (cifFile && this.state.loadedType !== 'cif')
                ? { project: name, filename: cifFile.name, size: cifFile.size || 0 }
                : null;
            // Only show the CIF tab when a CIF is actually available.
            this.setCifTabVisible(!!cifFile || this.state.loadedType === 'cif');
            
            this.saveStateToLocalStorage();

            const modalEl = document.getElementById('projectManagerModal');
            const modal = modalEl ? bootstrap.Modal.getInstance(modalEl) : null;
            if (modal && !silent) modal.hide();

            console.timeEnd(`[project] load ${name}`);
            return true;
        } catch (err) {
            console.timeEnd(`[project] load ${name}`);
            if (!silent) alert(`Error loading project: ${err.message}`);
            return false;
        }
    }
    
    async restoreBackupFromServer(projectName, filename) {
        if (!confirm(`Are you sure you want to restore ${filename}? Current unsaved changes will be lost.`)) return;
        
        try {
            const data = await this.apiGetBackup(projectName, filename);
            const type = filename.endsWith('.ins') ? 'ins' : 'res';
            
            this.state.currentProject = projectName;
            this.state.loadedType = type;
            this.state.loadedContent = data.content;
            
            const editor = this.state.editors[type] || this.state.editors.res;
            if (editor) {
                editor.setValue(data.content, -1);
            }
            this.renderContent(data.content, type);
            this.saveStateToLocalStorage();
            
            const modalEl = document.getElementById('projectManagerModal');
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
            
            alert(`Restored backup: ${filename}`);
        } catch (err) {
            alert(`Error restoring backup: ${err.message}`);
        }
    }
    
    async saveCurrentProjectToServer() {
         // If a file tab is active, save it
         const activeTab = document.querySelector('.nav-link.active');
         if (activeTab && activeTab.id.startsWith('tab-file-')) {
             return this.saveFileTab(activeTab.id.replace('tab-file-', ''));
         }
         
         if (!this.state.currentProject) {
             alert("No server-side project currently loaded. Use 'Refine' or 'Project Manager' first.");
             return;
         }
         
         try {
             const type = this.state.loadedType || 'res';
             const filename = this.state.loadedFilename || `structure.${type}`;
             
             // If this file is already open as a file tab, save via the tab
             if (filename && this.state.fileTabs[filename]) {
                 return this.saveFileTab(filename);
             }
             
             const editor = this.state.editors[type] || this.state.editors.res;
             const content = editor.getValue();
             
             if (type === 'res' || type === 'ins') {
                 await this.apiSaveProject(this.state.currentProject, content, type);
             } else {
                 await this.apiSaveProjectFile(this.state.currentProject, filename, content);
             }
             alert("Saved to server successfully.");
         } catch (err) {
             alert(`Save failed: ${err.message}`);
         }
    }
    truncateContent(content, limit = 5 * 1024 * 1024) { // 5MB limit
        if (content.length <= limit) return content;
        return content.substring(0, limit) + "\n\n# ... FILE TRUNCATED FOR PERFORMANCE (Original size: " + (content.length / 1024 / 1024).toFixed(2) + " MB) ...";
    }

    // Set editor text without triggering the debounced re-render used for user
    // edits. Needed because the parsed source of truth (`loadedContent`) can be
    // larger than what the editor holds (huge CIF/mmCIF files are truncated in
    // the editor but rendered in full).
    setEditorValueProgrammatic(editor, text) {
        if (!editor) return;
        this._suppressEditorRender = true;
        try {
            editor.setValue(text, -1);
        } finally {
            this._suppressEditorRender = false;
        }
    }

    // Calculate anomalous dispersion (f', f") for every element on SFAC at the
    // wavelength given on CELL, and insert DISP instructions between the last
    // SFAC and the UNIT instruction (where SHELXL requires them).
    async calculateDisp() {
        const editor = this.state.editors.res;
        if (!editor) { alert('Open a structure (.res/.ins) first.'); return; }
        const doc = editor.getSession().getDocument();
        const lines = doc.getAllLines();

        let wavelength = null;
        let sfacRow = -1;
        let unitRow = -1;
        let elements = [];
        for (let i = 0; i < lines.length; i++) {
            const parts = lines[i].trim().split(/\s+/);
            const key = (parts[0] || '').toUpperCase();
            if (key === 'CELL' && parts.length >= 2) {
                const wl = parseFloat(parts[1]);
                if (isFinite(wl) && wl > 0) wavelength = wl;
            } else if (key === 'SFAC') {
                if (i > sfacRow) {
                    sfacRow = i;
                    elements = [];
                    for (let j = 1; j < parts.length; j++) {
                        if (isNaN(parseFloat(parts[j]))) elements.push(parts[j].replace(/^\$/, ''));
                    }
                }
            } else if (key === 'UNIT' && unitRow === -1) {
                unitRow = i;
            }
        }
        if (sfacRow === -1) { alert('No SFAC instruction found.'); return; }
        if (wavelength === null) { alert('No wavelength found on the CELL line.'); return; }

        const energy = 12398.4198 / wavelength;

        if (!this._dispersionTable) {
            try {
                const resp = await fetch('data/anomalous.json');
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                this._dispersionTable = await resp.json();
            } catch (e) {
                alert('Could not load anomalous-scattering data (data/anomalous.json): ' + e.message);
                return;
            }
        }
        const table = this._dispersionTable && this._dispersionTable.elements;
        if (!table) { alert('Anomalous-scattering data is empty.'); return; }
        if (!this._dispIndex) {
            this._dispIndex = {};
            Object.keys(table).forEach(k => { this._dispIndex[k.toUpperCase()] = k; });
        }

        const dispLines = [];
        const missing = [];
        const seen = new Set();
        elements.forEach(elRaw => {
            const upper = elRaw.toUpperCase();
            const lookUpper = upper === 'D' ? 'H' : upper;
            if (seen.has(lookUpper)) return;
            seen.add(lookUpper);
            const key = this._dispIndex[lookUpper];
            const rows = key ? table[key] : null;
            if (!rows || !rows.length) { missing.push(elRaw); return; }
            if (energy < rows[0][0] || energy > rows[rows.length - 1][0]) { missing.push(elRaw + ' (out of range)'); return; }
            let lo = 0, hi = rows.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (rows[mid][0] <= energy) lo = mid; else hi = mid;
            }
            const [E0, a0, b0] = rows[lo];
            const [E1, a1, b1] = rows[hi];
            const t = E1 === E0 ? 0 : (energy - E0) / (E1 - E0);
            const fp = a0 + (a1 - a0) * t;
            const fpp = b0 + (b1 - b0) * t;
            dispLines.push(`DISP ${key} ${fp.toFixed(4)} ${fpp.toFixed(4)}`);
        });

        if (!dispLines.length) {
            alert(`No dispersion data for: ${missing.join(', ') || elements.join(', ')}`);
            return;
        }

        // Replace any existing DISP instructions, then insert the new ones
        // immediately after the last SFAC line (before UNIT).
        for (let i = doc.getLength() - 1; i >= 0; i--) {
            if (/^\s*DISP\b/i.test(doc.getLine(i))) doc.removeLines(i, i);
        }
        let newSfacRow = -1;
        for (let i = 0; i < doc.getLength(); i++) {
            if (/^\s*SFAC\b/i.test(doc.getLine(i))) newSfacRow = i;
        }
        if (newSfacRow === -1) return;
        editor.session.insert({ row: newSfacRow + 1, column: 0 }, dispLines.join('\n') + '\n');

        editor.loadedFile = editor.getValue();
        this.state.loadedContent = editor.getValue();
        const status = document.getElementById('status-bar-content');
        if (status) {
            let msg = `Inserted ${dispLines.length} DISP line(s) at λ=${wavelength} Å (${energy.toFixed(0)} eV).`;
            if (missing.length) msg += ` No data: ${missing.join(', ')}.`;
            status.textContent = msg;
        }
    }

    // Correct a SHELX .hkl reflection file for spherical absorption.
    // hklfType 3 stores F/sigma(F) (scale by 1/sqrt(T)); other types store
    // F^2/sigma(F^2) (scale by 1/T).
    correctHklText(text, { mu, radiusA, cell, wavelength, hklfType = 4, matrix = null }) {
        const muR = mu * radiusA * 1e-8;
        const lines = text.split(/\r?\n/);
        const items = [];
        let tmin = Infinity, tmax = -Infinity, count = 0, maxAbs = 0;
        lines.forEach((line, idx) => {
            const t = line.trim();
            if (!t || t.startsWith('!') || t.startsWith('#')) return;
            const parts = t.split(/\s+/);
            if (parts.length < 5) return;
            const h = parseInt(parts[0], 10), k = parseInt(parts[1], 10), l = parseInt(parts[2], 10);
            if (isNaN(h) || isNaN(k) || isNaN(l)) return;
            const ht = matrix ? matrix[0] * h + matrix[1] * k + matrix[2] * l : h;
            const kt = matrix ? matrix[3] * h + matrix[4] * k + matrix[5] * l : k;
            const lt = matrix ? matrix[6] * h + matrix[7] * k + matrix[8] * l : l;
            const st = SphericalAbsorption.sinTheta(ht, kt, lt, cell, wavelength);
            const T = SphericalAbsorption.transmissionTheta(muR, Math.asin(st));
            if (!(T > 0)) return;
            const scale = hklfType === 3 ? 1 / Math.sqrt(T) : 1 / T;
            const v3 = parseFloat(parts[3]) * scale;
            const v4 = parseFloat(parts[4]) * scale;
            if (!isFinite(v3) || !isFinite(v4)) return;
            if (T < tmin) tmin = T;
            if (T > tmax) tmax = T;
            maxAbs = Math.max(maxAbs, Math.abs(v3), Math.abs(v4));
            count++;
            items.push({ idx, h, k, l, v3, v4, extra: parts.slice(5) });
        });
        // Dividing by T can multiply the values many-fold, so the corrected
        // numbers would overflow the fixed 8-column SHELX fields and run the
        // F^2 and sigma columns together (corrupting the file). Rescale the
        // whole dataset by a power of ten first: the absolute scale is
        // arbitrary because the refinement scale factor absorbs it.
        let outScale = 1;
        while (maxAbs * outScale >= 10000) outScale /= 10;
        const byIdx = new Map();
        for (const it of items) {
            const f8 = (x) => {
                const s = (outScale * x).toFixed(2);
                return s.length > 8 ? s.slice(0, 8) : s.padStart(8);
            };
            // Keep the SHELX fixed format FORMAT(3I4,2F8.2,I4); collapsing the
            // fields to free format makes SHELXL report "WRONG FORMAT".
            let rebuilt = String(it.h).padStart(4) + String(it.k).padStart(4) + String(it.l).padStart(4)
                + f8(it.v3) + f8(it.v4);
            if (it.extra.length) rebuilt += ' ' + it.extra.join(' ');
            byIdx.set(it.idx, rebuilt);
        }
        const out = lines.map((line, idx) => (byIdx.has(idx) ? byIdx.get(idx) : line));
        return { text: out.join('\n'), tmin, tmax, count, scale: outScale };
    }

    // Fit the spherical absorption parameter muR to the current model by
    // minimising R1 = sum|Fo* - k Fc| / sum|Fo*| over a range of muR, using the
    // Fo^2 / Fc values in the last SHELXL .fcf. This determines the crystal
    // size / absorption empirically instead of asking the user to guess it.
    // Returns { muR, R1, table } or null when no usable model data is present.
    fitMuRFromFcf(fcfReflections, cell, wavelength, { min = 0, max = 6, steps = 25 } = {}) {
        if (!Array.isArray(fcfReflections) || !fcfReflections.length) return null;
        const refl = fcfReflections.filter(r =>
            r && Number.isFinite(r.Fo2) && r.Fo2 > 0 && Number.isFinite(r.Fc) && r.Fc > 0);
        if (refl.length < 20) return null;
        const r1For = (muR) => {
            let sfo = 0, sfofc = 0, sfc2 = 0;
            const fo = refl.map(r => {
                const st = SphericalAbsorption.sinTheta(r.h, r.k, r.l, cell, wavelength);
                const T = SphericalAbsorption.transmissionTheta(muR, Math.asin(st));
                const f = Math.sqrt(r.Fo2 / (T > 0 ? T : 1));
                sfo += f; sfofc += f * r.Fc; sfc2 += r.Fc * r.Fc;
                return f;
            });
            const k = sfc2 > 0 ? sfofc / sfc2 : 1;
            let num = 0;
            for (let i = 0; i < refl.length; i++) num += Math.abs(fo[i] - k * refl[i].Fc);
            return sfo > 0 ? num / sfo : Infinity;
        };
        let best = { muR: 0, R1: r1For(0) };
        const table = [];
        for (let i = 0; i <= steps; i++) {
            const muR = min + (max - min) * i / steps;
            const R1 = r1For(muR);
            table.push({ muR, R1 });
            if (R1 < best.R1) best = { muR, R1 };
        }
        return { muR: best.muR, R1: best.R1, table };
    }

    // Build {h,k,l,Fo2,Fc} pairs for the muR fit: Fo^2 from the (original) HKL,
    // Fc from the last SHELXL .fcf. Using the original, uncorrected Fo^2 keeps
    // the fit meaningful even after a previous absorption correction.
    buildAbsorptionFitData(hklText) {
        const foMap = new Map();
        for (const line of (hklText || '').split(/\r?\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('!') || t.startsWith('#')) continue;
            const p = t.split(/\s+/);
            if (p.length < 5) continue;
            const h = parseInt(p[0], 10), k = parseInt(p[1], 10), l = parseInt(p[2], 10), v = parseFloat(p[3]);
            if ([h, k, l, v].some(x => !Number.isFinite(x))) continue;
            foMap.set(`${h},${k},${l}`, v);
        }
        const out = [];
        let fcf = null;
        try { fcf = this.state.fcfRawContent ? this.state.parsers.fcf.parse(this.state.fcfRawContent) : null; } catch (e) { /* ignore */ }
        if (fcf && fcf.reflections) {
            for (const r of fcf.reflections) {
                const fc = (r.Fc != null && r.Fc > 0) ? r.Fc
                    : (r.Fc2 != null && r.Fc2 > 0 ? Math.sqrt(r.Fc2) : null);
                if (!(fc > 0)) continue;
                let fo2 = foMap.get(`${r.h},${r.k},${r.l}`);
                if (fo2 == null) fo2 = foMap.get(`${-r.h},${-r.k},${-r.l}`);
                if (fo2 > 0) out.push({ h: r.h, k: r.k, l: r.l, Fo2: fo2, Fc: fc });
            }
        }
        return out;
    }

    // Parse the structure and reflection source, compute mu and locate the
    // pristine (uncorrected) HKL. Shared by the manual and automatic absorption
    // workflows. Returns a context object, or null after alerting.
    async prepareAbsorptionContext() {
        const editor = this.state.editors.res;
        const structure = this.getStructureContent() || (editor && editor.getValue());
        if (!structure) { alert('Open a structure (.res/.ins) first.'); return; }

        let wavelength = null;
        const cell = {};
        let elements = [];
        let unitCounts = null;
        let z = 1;
        let sizeDims = null;
        let hklfType = 4;
        let hklMatrix = null;
        for (const line of structure.split(/\r?\n/)) {
            const parts = line.trim().split(/\s+/);
            const key = (parts[0] || '').toUpperCase();
            if (key === 'CELL') {
                const wl = parseFloat(parts[1]);
                if (isFinite(wl) && wl > 0) wavelength = wl;
                cell.a = parseFloat(parts[2]); cell.b = parseFloat(parts[3]); cell.c = parseFloat(parts[4]);
                cell.alpha = parseFloat(parts[5]); cell.beta = parseFloat(parts[6]); cell.gamma = parseFloat(parts[7]);
            } else if (key === 'SFAC') {
                elements = [];
                for (let j = 1; j < parts.length; j++) {
                    if (isNaN(parseFloat(parts[j]))) elements.push(parts[j].replace(/^\$/, ''));
                }
            } else if (key === 'UNIT') {
                unitCounts = parts.slice(1).map(Number);
            } else if (key === 'ZERR') {
                const zz = parseFloat(parts[1]);
                if (isFinite(zz) && zz > 0) z = zz;
            } else if (key === 'SIZE') {
                sizeDims = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])].filter(x => isFinite(x) && x > 0);
            } else if (key === 'HKLF') {
                const hh = parseInt(parts[1], 10);
                if (isFinite(hh)) hklfType = hh;
                // Optional reorientation matrix r11..r33 (applied to the file
                // indices before refinement, so T must use the transformed hkl).
                if (parts.length >= 12) {
                    const r = parts.slice(3, 12).map(Number);
                    if (r.length === 9 && r.every(isFinite)) hklMatrix = r;
                }
            }
        }
        if (!elements.length) { alert('No SFAC instruction found.'); return; }
        if (wavelength === null) { alert('No wavelength found on the CELL line.'); return; }
        if (!(cell.a > 0)) { alert('No unit-cell parameters found on the CELL line.'); return; }

        // muR (and hence the sphere radius R) is resolved below, once the
        // reflection source is known, so it can be fitted to the model when no
        // SIZE instruction is present instead of asking the user to guess it.

        // Atoms per unit cell (from UNIT, else asymmetric unit x Z).
        const counts = {};
        if (unitCounts && unitCounts.length) {
            elements.forEach((el, i) => { counts[el] = unitCounts[i] || 0; });
        } else {
            const au = {};
            const atoms = (this.state.parsedData && this.state.parsedData.atoms) || [];
            atoms.forEach(a => { const el = (a.element || 'C').toUpperCase(); au[el] = (au[el] || 0) + 1; });
            elements.forEach(el => { counts[el] = Math.round((au[el.toUpperCase()] || 0) * z); });
        }

        // f" for each element at the experiment energy.
        let table = null;
        try {
            if (!this._dispersionTable) {
                const resp = await fetch('data/anomalous.json');
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                this._dispersionTable = await resp.json();
            }
            table = this._dispersionTable.elements;
        } catch (e) {
            alert('Could not load anomalous-scattering data: ' + e.message);
            return;
        }
        if (!this._dispIndex) {
            this._dispIndex = {};
            Object.keys(table).forEach(k => { this._dispIndex[k.toUpperCase()] = k; });
        }
        const energy = 12398.4198 / wavelength;
        const fpp = {};
        elements.forEach(el => {
            const key = this._dispIndex[el.toUpperCase() === 'D' ? 'H' : el.toUpperCase()];
            const rows = key ? table[key] : null;
            if (!rows) return;
            let lo = 0, hi = rows.length - 1;
            while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m][0] <= energy) lo = m; else hi = m; }
            const [E0, , b0] = rows[lo];
            const [E1, , b1] = rows[hi];
            fpp[el] = b0 + (b1 - b0) * (energy - E0) / (E1 - E0);
        });

        const d2r = Math.PI / 180;
        const ca = Math.cos(cell.alpha * d2r), cb = Math.cos(cell.beta * d2r), cg = Math.cos(cell.gamma * d2r);
        const volume = cell.a * cell.b * cell.c * Math.sqrt(Math.max(0, 1 - ca * ca - cb * cb - cg * cg + 2 * ca * cb * cg));
        let muCm = SphericalAbsorption.linearMu({ cellVolume: volume, wavelength, counts, fpp });

        // Prefer the mu SHELXL reported in the .lst, but only when it agrees
        // with the composition value to within a factor of four: SHELXL derives
        // it from the model's UNIT, which is occasionally wrong, and then the
        // whole correction would be wildly off.
        const lstText = this.state.editors.lst ? this.state.editors.lst.getValue() : '';
        const muMatch = lstText && lstText.match(/Mu\s*=\s*([\d.]+)\s*mm-1/i);
        const lstMuCm = muMatch ? parseFloat(muMatch[1]) * 10 : null;
        const muSource = (isFinite(lstMuCm) && lstMuCm > 0 && muCm > 0 &&
            lstMuCm > 0.25 * muCm && lstMuCm < 4 * muCm) ? 'from .lst' : 'from composition + f"';
        if (muSource === 'from .lst') muCm = lstMuCm;

        // Reflection source. Prefer the HKL that belongs to the current project
        // (server-side) so we never correct/save a stale HKL from another
        // project; only fall back to browser HKL content when there is no
        // project HKL at all.
        const project = this.state.currentProject || this.state.hklServerProject || null;
        let hklText = null;
        let hklFromServer = false;
        let hklSaveName = null;
        if (project) {
            try {
                const files = await this.apiListProjectFiles(project);
                const lower = project.toLowerCase();
                const hklFile = files.find(f => f.name.toLowerCase() === `${lower}.hkl`)
                    || (this.state.hklName && files.find(f => f.name === this.state.hklName))
                    || files.find(f => /\.hkl$/i.test(f.name));
                if (hklFile) {
                    hklText = await this.apiGetProjectFile(project, hklFile.name);
                    hklFromServer = true;
                    hklSaveName = hklFile.name;
                }
            } catch (e) { /* fall through to browser content */ }
        }
        if (!hklText && this.state.hklContent) {
            hklText = this.state.hklContent;
            hklFromServer = false;
        }

        // Always correct from the ORIGINAL, uncorrected reflections. Re-applying
        // the correction to an already-corrected file multiplies 1/T in again
        // and again, driving the intensities to enormous values (which then
        // overflow the fixed SHELX columns) - that is what used to blow up the
        // structure. Keep one pristine copy and always start from it.
        let sourceText = hklText;
        let originalName = null;
        if (hklFromServer && hklSaveName && project) {
            originalName = hklSaveName.replace(/\.[^.]+$/, '') + '.hkl.original';
            try {
                const orig = await this.apiGetProjectFile(project, originalName);
                if (orig && orig.trim()) sourceText = orig;
            } catch (e) {
                try { await this.apiSaveProjectFile(project, originalName, hklText); } catch (e2) { /* ignore */ }
            }
        }

        return {
            cell, wavelength, energy, muCm, muSource, project, hklSaveName, hklFromServer,
            sourceText, originalName, hklfType, hklMatrix, sizeDims,
        };
    }

    // Menu entry: open the spherical absorption dialog, offering BOTH a manual
    // muR and an automatic fit to the current model.
    async openAbsorptionDialog() {
        const ctx = await this.prepareAbsorptionContext();
        if (!ctx) return;
        this.state.absorptionContext = ctx;

        const murInput = document.getElementById('abs-mur-input');
        const info = document.getElementById('abs-info');
        const dims = ctx.sizeDims || [];
        ['abs-dim-a', 'abs-dim-b', 'abs-dim-c'].forEach((id, i) => {
            const el = document.getElementById(id);
            if (el) el.value = dims[i] != null ? dims[i] : '';
        });

        // Default muR: from SIZE when present, otherwise fit to the model.
        let muR = null, note = '';
        if (dims.length) {
            const R = SphericalAbsorption.equivalentSphereRadius(dims);
            muR = ctx.muCm * R * 1e7 * 1e-8;
            note = `from SIZE (R = ${R.toFixed(4)} mm)`;
        } else {
            const fit = this.fitMuRFromFcf(this.buildAbsorptionFitData(ctx.sourceText), ctx.cell, ctx.wavelength);
            if (fit && isFinite(fit.muR)) { muR = fit.muR; note = `fitted to model (R1 = ${fit.R1.toFixed(4)})`; }
        }
        if (murInput) murInput.value = muR != null ? muR.toFixed(3) : '';
        if (info) {
            info.textContent = `mu = ${(ctx.muCm / 10).toFixed(4)} mm-1 (${ctx.muSource})` +
                (muR != null ? `;  A*(muR) = ${SphericalAbsorption.transmission(muR).toFixed(4)}` : '') +
                (note ? `  -  ${note}` : '');
        }

        const modalEl = document.getElementById('absorptionModal');
        if (modalEl) new bootstrap.Modal(modalEl).show();
    }

    // Fit muR to the current model and show the result in the dialog.
    fitAbsorptionMuR() {
        const ctx = this.state.absorptionContext;
        if (!ctx) { alert('Open the absorption dialog first.'); return; }
        const fit = this.fitMuRFromFcf(this.buildAbsorptionFitData(ctx.sourceText), ctx.cell, ctx.wavelength);
        if (!fit || !isFinite(fit.muR)) {
            alert('Could not fit muR: no Fc data in the loaded .fcf (refine the structure first).');
            return;
        }
        const murInput = document.getElementById('abs-mur-input');
        const info = document.getElementById('abs-info');
        if (murInput) murInput.value = fit.muR.toFixed(3);
        if (info) info.textContent = `mu = ${(ctx.muCm / 10).toFixed(4)} mm-1 (${ctx.muSource});  fitted muR = ${fit.muR.toFixed(3)}, R1 = ${fit.R1.toFixed(4)}`;
    }

    // Convert the dialog's crystal-size inputs into muR (manual route).
    absorptionMuRFromSize() {
        const ctx = this.state.absorptionContext;
        if (!ctx) { alert('Open the absorption dialog first.'); return; }
        const dims = ['abs-dim-a', 'abs-dim-b', 'abs-dim-c']
            .map(id => parseFloat((document.getElementById(id) || {}).value))
            .filter(x => isFinite(x) && x > 0);
        if (!dims.length) { alert('Enter at least one crystal dimension (mm).'); return; }
        const R = SphericalAbsorption.equivalentSphereRadius(dims);
        const muR = ctx.muCm * R * 1e7 * 1e-8;
        const murInput = document.getElementById('abs-mur-input');
        const info = document.getElementById('abs-info');
        if (murInput) murInput.value = muR.toFixed(3);
        if (info) info.textContent = `mu = ${(ctx.muCm / 10).toFixed(4)} mm-1 (${ctx.muSource});  R = ${R.toFixed(4)} mm  ->  muR = ${muR.toFixed(3)}, A*(muR) = ${SphericalAbsorption.transmission(muR).toFixed(4)}`;
    }

    // Apply the correction with the muR currently shown in the dialog.
    async performSphericalAbsorption() {
        const ctx = this.state.absorptionContext;
        if (!ctx) { alert('Open the absorption dialog first.'); return; }
        const murInput = document.getElementById('abs-mur-input');
        const muR = parseFloat(murInput && murInput.value);
        if (!(muR >= 0) || !isFinite(muR)) { alert('Enter a valid muR (>= 0), or use "Fit from model".'); return; }
        const radiusA = ctx.muCm > 0 ? muR / (ctx.muCm * 1e-8) : 0;
        const aStar = SphericalAbsorption.transmission(muR);
        const common = `Spherical absorption correction\n` +
            `lambda = ${ctx.wavelength} A (${ctx.energy.toFixed(0)} eV)\n` +
            `mu = ${(ctx.muCm / 10).toFixed(4)} mm-1 (${ctx.muSource})\n` +
            `muR = ${muR.toFixed(4)},  A*(muR) = ${aStar.toFixed(4)}` +
            (muR > 10 ? '\nWARNING: muR > 10 - the spherical approximation is unreliable.' : '');

        const modalEl = document.getElementById('absorptionModal');
        if (modalEl) { const m = bootstrap.Modal.getInstance(modalEl); if (m) m.hide(); }

        if (ctx.sourceText) {
            const res = this.correctHklText(ctx.sourceText, { mu: ctx.muCm, radiusA, cell: ctx.cell, wavelength: ctx.wavelength, hklfType: ctx.hklfType, matrix: ctx.hklMatrix });
            if (!res.count) { alert(common + '\n\nNo reflections found in the HKL file.'); return; }
            const target = ctx.hklFromServer ? `project file ${ctx.hklSaveName}` : 'the loaded HKL';
            const origNote = ctx.originalName ? `\nAlways re-applied to the original (${ctx.originalName}); repeated corrections cannot compound.` : '';
            if (!confirm(`${common}\nHKLF ${ctx.hklfType}${ctx.hklMatrix ? ' (reorientation matrix applied)' : ''}: ${res.count} reflections\nTmin = ${res.tmin.toFixed(4)}  Tmax = ${res.tmax.toFixed(4)}${origNote}\n\nOverwrite ${target} with the corrected data?`)) return;
            if (ctx.hklFromServer) {
                // Pre-correction backup (the pristine original is kept separately).
                try { await this.apiBackupProjectFile(ctx.project, ctx.hklSaveName, ctx.sourceText); } catch (e) { /* non-fatal */ }
                try {
                    await this.apiSaveProjectFile(ctx.project, ctx.hklSaveName, res.text);
                    this.state.hklName = ctx.hklSaveName;
                } catch (e) { alert('Failed to save corrected HKL: ' + e.message); return; }
            } else {
                this.state.hklContent = res.text;
            }
            this.setPublishAbsorptionFields(res.tmin, res.tmax);
            const status = document.getElementById('status-bar-content');
            if (status) status.textContent = `Spherical absorption: mu=${(ctx.muCm / 10).toFixed(3)} mm-1, muR=${muR.toFixed(3)}, Tmin=${res.tmin.toFixed(4)}, Tmax=${res.tmax.toFixed(4)}`;
            alert(`Corrected ${res.count} reflections.\nmuR = ${muR.toFixed(4)}   Tmin = ${res.tmin.toFixed(4)}  Tmax = ${res.tmax.toFixed(4)}\n\nRe-run the refinement. Re-applying always starts from the original reflection file, so it cannot be corrected twice.`);
            return;
        }

        // No HKL: correct the loaded FCF reflections (for the CIF Tmin/Tmax).
        if (this.state.fcfRawContent) {
            let fcf = null;
            try { fcf = this.state.parsers.fcf.parse(this.state.fcfRawContent); } catch (e) { /* ignore */ }
            if (fcf && fcf.reflections && fcf.reflections.length) {
                const mapCell = fcf.cell && fcf.cell.a ? fcf.cell : ctx.cell;
                const res = SphericalAbsorption.apply(fcf.reflections, { mu: ctx.muCm, radiusA, cell: mapCell, wavelength: ctx.wavelength });
                this.setPublishAbsorptionFields(res.Tmin, res.Tmax);
                alert(`${common}\nFCF: ${res.reflections.length} reflections\nTmin = ${res.Tmin.toFixed(4)}  Tmax = ${res.Tmax.toFixed(4)}\n\n(T_min/T_max copied to the publish CIF fields. Load an .hkl to correct the data used for refinement.)`);
                return;
            }
        }

        alert(common + '\n\nNo HKL or FCF reflection data found to correct.');
    }

    setPublishAbsorptionFields(tmin, tmax) {
        const tminEl = document.getElementById('pub-abs-min');
        const tmaxEl = document.getElementById('pub-abs-max');
        if (tminEl) tminEl.value = tmin.toFixed(4);
        if (tmaxEl) tmaxEl.value = tmax.toFixed(4);
    }

    // Resolve the atom behind a raycaster hit, supporting both the normal
    // instanced spheres and the large-structure THREE.Points cloud.
    resolveHitAtom(hit) {
        const o = hit && hit.object;
        if (!o || !o.userData || !o.userData.atomMap) return null;
        if (o.isPoints) return o.userData.atomMap[hit.index];
        if (o.isInstancedMesh) return o.userData.atomMap[hit.instanceId];
        return null;
    }

    setupEditorCommands() {
        const editor = this.state.editors.res;
        if (!editor) return;

        // Helper to get editor
        const getEditor = () => {
            // Determine active editor (RES or CIF)
            // For now, most commands are for RES (Shelx)
            return this.state.editors.res;
        };

        // --- Standard Edit Commands ---
        // Note: Cut/Copy/Paste are often restricted by browser, but we can try execCommand
        
        // Duplicate Line/Selection (Ctrl-Alt-D)
        editor.commands.addCommand({
            name: 'duplicate',
            bindKey: {win: 'Ctrl-Alt-D', mac: 'Command-Alt-D'},
            exec: (editor) => {
                editor.copyLinesDown();
            }
        });

        // Toggle Comment (Ctrl-/)
        editor.commands.addCommand({
            name: 'toggleComment',
            bindKey: {win: 'Ctrl-/', mac: 'Command-/'},
            exec: (editor) => {
                editor.toggleCommentLines();
            }
        });



        // --- Custom Shelx Commands ---

        // Add Trailer (Alt-T)
        editor.commands.addCommand({
            name: 'addTrailer',
            bindKey: {win: 'Alt-T', mac: 'Alt-T'},
            exec: (editor) => {
                const trailer = prompt("Enter text to append to atom labels:");
                if (trailer) {
                    const range = editor.getSelectionRange();
                    const doc = editor.getSession().getDocument();
                    const startRow = range.start.row;
                    const endRow = range.end.row;
                    
                    for (let i = startRow; i <= endRow; i++) {
                        const line = doc.getLine(i);
                        // Find first token (atom label)
                        const match = line.match(/^(\s*)(\S+)(.*)$/);
                        if (match) {
                            const indent = match[1];
                            const label = match[2];
                            const rest = match[3];
                            
                            // Check if it looks like an atom (starts with letter)
                            if (/^[A-Za-z]/i.test(label)) {
                                const newLabel = label + trailer;
                                const newLine = indent + newLabel + rest;
                                doc.removeInLine(i, 0, line.length);
                                doc.insertInLine({row: i, column: 0}, newLine);
                            }
                        }
                    }
                    // Force update
                    this.tryRender('res');
                }
            }
        });

        // Relabel Atoms (Ctrl-Shift-L)
        editor.commands.addCommand({
            name: 'relabelAtoms',
            bindKey: {win: 'Ctrl-Shift-L', mac: 'Command-Shift-L'},
            exec: (editor) => {
                this.openRelabelDialog(editor);
            }
        });

        // Cluster Molecules & Relabel (Alt-M)
        editor.commands.addCommand({
            name: 'clusterMolecules',
            bindKey: {win: 'Alt-M', mac: 'Alt-M'},
            exec: (editor) => {
                this.openClusterDialog(editor);
            }
        });

        editor.commands.addCommand({
            name: 'autoHfix',
            bindKey: {win: 'Ctrl-Shift-H', mac: 'Command-Shift-H'},
            exec: (editor) => {
                if (!this.state.parsedData || !this.state.parsedData.atoms || !this.state.parsedData.cell) {
                    alert("No structure data available. Please load a valid file.");
                    return;
                }

                const atoms = this.state.parsedData.atoms;
                const cell = this.state.parsedData.cell;
                const hfixInstructions = [];

                // Helper to get element from label or type
                const getElement = (atom) => {
                    return atom.element ? atom.element.toUpperCase() : 'C';
                };

                // 1. Identify Carbons and Calculate Bonds
                // Python logic:
                // 1.0 < d < 1.28: 
                //    C -> t
                //    O -> d (1.2-1.28) or t (1.0-1.20)
                //    N -> d (1.21-1.35) or t (1.0-1.20)
                // 1.31 < d < 1.45:
                //    C -> d
                //    N/O/F (1.35-1.44) -> s
                //    Else (1.31-1.40) N/O -> d
                //    Else -> d
                // 1.44 < d < 2.1: s

                const carbons = atoms.filter(a => getElement(a) === 'C');
                const assignments = new Map(); // label -> [] of bond types ('s', 'd', 't')

                carbons.forEach(cAtom => {
                    const bondTypes = [];
                    
                    atoms.forEach(neighbor => {
                        if (cAtom === neighbor) return;
                        
                        const nEl = getElement(neighbor);
                        
                        // Skip Hydrogens in bond calculation for HFIX assignment purposes?
                        // Python code: "if 'C' in atom... elif 'O' in atom..." implies it checks neighbor types.
                        // It iterates "calcbonds" which likely excludes H?
                        // Usually HFIX is done before H are added, or we ignore existing H.
                        // Let's ignore H neighbors.
                        // Ignore Q-peaks
                        if (nEl === 'H' || nEl === 'Q') return;

                        const d = this.calculateDistance(cAtom, neighbor, cell);
                        
                        let type = null;

                        if (d > 1.0 && d < 1.28) {
                            if (nEl === 'C') type = 't';
                            else if (nEl === 'O') {
                                if (d > 1.2) type = 'd';
                                else type = 't';
                            } else if (nEl === 'N') {
                                if (d > 1.21) type = 'd';
                                else type = 't';
                            }
                        } else if (d >= 1.28 && d < 1.45) { // Gap 1.28-1.31? Python said 1.31. Let's cover gap or stick to Python.
                             // Python: 1.31 < calcbond < 1.45.
                             // What about 1.28-1.31? Maybe 'd'?
                             // Let's use Python's ranges strictly.
                             if (d > 1.31) {
                                 if (nEl === 'C') type = 'd';
                                 else if (['N', 'O', 'F'].includes(nEl) && d > 1.35 && d < 1.44) type = 's';
                                 else if (['N', 'O'].includes(nEl) && d < 1.40) type = 'd';
                                 else if (!['N', 'O'].includes(nEl)) type = 'd';
                             }
                        } else if (d > 1.44 && d < 1.85) {

                            type = 's';
                        }

                        if (type) {
                            bondTypes.push(type);
                        }
                    });
                    
                    assignments.set(cAtom.label, bondTypes);
                });

                // 2. Generate Instructions
                let count = 0;
                assignments.forEach((types, label) => {
                    let code = null;
                    const l = types.length;
                    
                    if (l === 1) {
                        if (types[0] === 's') code = 137; // Methyl
                        else if (types[0] === 'd') code = 93;
                        else if (types[0] === 't') code = 163;
                    } else if (l === 2) {
                        const t1 = types[0];
                        const t2 = types[1];
                        if (t1 === 's' && t2 === 's') code = 23; // Methylene
                        else if ((t1 === 'd' && t2 === 'd') || 
                                 (t1 === 'd' && t2 === 's') || 
                                 (t1 === 's' && t2 === 'd')) code = 43; // Aromatic/Ethenyl
                    } else if (l === 3) {
                        if (types.every(t => t === 's')) code = 13; // Methine
                    }

                    if (code) {
                        hfixInstructions.push(`HFIX ${code} ${label}`);
                        count++;
                    }
                });

                if (hfixInstructions.length > 0) {
                    // 3. Insert after UNIT
                    const doc = editor.getSession().getDocument();
                    const lines = doc.getAllLines();
                    let unitLineIndex = -1;
                    
                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].trim().startsWith('UNIT')) {
                            unitLineIndex = i;
                            break;
                        }
                    }

                    if (unitLineIndex !== -1) {
                        // Insert after UNIT (Python says loc1 + 2, but that might be specific to their list handling.
                        // Safest is immediately after UNIT).
                        const insertRow = unitLineIndex + 1;
                        const text = hfixInstructions.join('\n') + '\n';
                        editor.session.insert({row: insertRow, column: 0}, text);
                        alert(`Generated ${count} HFIX instructions after UNIT.`);
                    } else {
                        // Fallback to cursor if UNIT not found
                        const cursor = editor.getCursorPosition();
                        const text = hfixInstructions.join('\n') + '\n';
                        editor.session.insert(cursor, text);
                        alert(`Generated ${count} HFIX instructions (UNIT not found, inserted at cursor).`);
                    }
                } else {
                    alert("No suitable Carbon atoms found for HFIX assignment.");
                }
            }
        });

        // Kill Commands Helper
        const killPattern = (pattern, name, confirmAll = false) => {
            const range = editor.getSelectionRange();
            const doc = editor.getSession().getDocument();
            let startRow = 0;
            let endRow = doc.getLength() - 1;
            let processAll = false;

            if (range.isEmpty() || editor.getSelectedText().length < 10) {
                // If no selection or very small selection, assume whole file (or ask)
                if (confirmAll) {
                    if (!confirm(`Delete all ${name}?`)) return;
                }
                processAll = true;
            } else {
                startRow = range.start.row;
                endRow = range.end.row;
            }

            // Get lines to process
            const lines = [];
            for (let i = startRow; i <= endRow; i++) {
                lines.push(doc.getLine(i));
            }

            // Filter
            const newLines = lines.filter(line => !pattern.test(line.trim()));
            
            // Replace
            const replacement = newLines.join('\n');
            
            if (processAll) {
                editor.setValue(replacement, -1);
            } else {
                // Replace range
                editor.session.replace({
                    start: {row: startRow, column: 0},
                    end: {row: endRow, column: doc.getLine(endRow).length}
                }, replacement);
            }
            this.tryRender('res');
        };

        // Kill Q (Ctrl-Alt-K). Always removes ALL Q-peak lines in the document
        // regardless of the current selection - a Q peak (difference peak) is a
        // whole-file concept and killing only a highlighted fragment confuses users.
        editor.commands.addCommand({
            name: 'killQ',
            bindKey: {win: 'Ctrl-Alt-K', mac: 'Command-Alt-K'},
            exec: (editor) => {
                const doc = editor.getSession().getDocument();
                const lines = doc.getAllLines();
                const keep = [];
                lines.forEach((line, i) => {
                    if (/^Q\d+/i.test(line.trim())) return;
                    keep.push(i);
                });
                if (keep.length === lines.length) {
                    const status = document.getElementById('status-bar-content');
                    if (status) status.textContent = 'No Q peaks found.';
                    return;
                }
                const kept = lines.filter(line => !/^Q\d+/i.test(line.trim()));
                editor.setValue(kept.join('\n'), -1);
                this.tryRender('res');
                const removed = lines.length - kept.length;
                const status = document.getElementById('status-bar-content');
                if (status) status.textContent = `Removed ${removed} Q peak(s).`;
            }
        });

        // Kill H (Ctrl-Alt-H)
        editor.commands.addCommand({
            name: 'killH',
            bindKey: {win: 'Ctrl-Alt-H', mac: 'Command-Alt-H'},
            exec: (editor) => {
                // Special handling for H: also remove AFIX if doing all
                const range = editor.getSelectionRange();
                const doc = editor.getSession().getDocument();
                
                if (range.isEmpty() || editor.getSelectedText().length < 10) {
                    if (confirm("Delete all H atoms and AFIX instructions?")) {
                        const lines = doc.getAllLines();
                        const newLines = lines.filter(line => {
                            const trimmed = line.trim();
                            // Remove H followed by digit OR AFIX
                            if (/^H\d+/i.test(trimmed)) return false;
                            if (/^AFIX/i.test(trimmed)) return false;
                            return true;
                        });
                        editor.setValue(newLines.join('\n'), -1);
                    }
                } else {
                    // Selection only: just kill H
                    killPattern(/^H\d+/i, "H Atoms", false);
                }
            }
        });

        // Kill HTAB
        editor.commands.addCommand({
            name: 'killHTAB',
            exec: (editor) => killPattern(/^HTAB/i, "HTAB")
        });

        // Kill MOLE
        editor.commands.addCommand({
            name: 'killMOLE',
            exec: (editor) => killPattern(/^MOLE/i, "MOLE")
        });

        // Kill RESI
        editor.commands.addCommand({
            name: 'killRESI',
            exec: (editor) => killPattern(/^RESI/i, "RESI")
        });

        // --- Options Menu Commands ---

        // Isotropic (Ctrl-Alt-I)
        editor.commands.addCommand({
            name: 'makeIsotropic',
            bindKey: {win: 'Ctrl-Alt-I', mac: 'Command-Alt-I'},
            exec: (editor) => {
                // Remove anisotropic Uij parameters, keeping the isotropic form:
                //   Label type x y z sof Uiso
                // SHELX wraps long atom lines by ending the physical line with
                // "=" and continuing the remaining Uij on the next line(s), so a
                // single atom may span several editor rows. Merge the wrapped
                // continuation lines first, then keep only the first 7 tokens.
                const doc = editor.getSession().getDocument();
                const range = editor.getSelectionRange();
                const startRow = range.isEmpty() ? 0 : range.start.row;
                const endRow = range.isEmpty() ? doc.getLength() - 1 : range.end.row;

                // Continuation line => previous line ended with "=" and this one
                // starts with a number (or "="), i.e. still atom data.
                const isContinuation = (line) => {
                    const trimmed = line.trim();
                    if (!trimmed) return false;
                    if (trimmed === '=') return true;
                    const first = trimmed.split(/\s+/)[0];
                    return /^[+\-]?\d/.test(first);
                };

                const segments = []; // { start, end, tokens[] }
                for (let i = startRow; i <= endRow; i++) {
                    let line = doc.getLine(i);
                    let parts = line.trim().split(/\s+/).filter(p => p && p !== '=');
                    // Atom lines must start with a label; skip keywords/instructions.
                    if (!parts.length || !/^[A-Za-z]/.test(parts[0])) continue;
                    if (this.getShelxKeywords().includes(parts[0].toUpperCase())) continue;

                    let start = i;
                    let tokens = parts.slice();
                    let j = i;
                    // Absorb wrapped continuation rows that belong to this atom
                    // (SHELX ends a physical line with "=" when it wraps).
                    while (j + 1 <= endRow && /=\s*$/.test(doc.getLine(j))) {
                        const next = doc.getLine(j + 1);
                        if (!isContinuation(next)) break;
                        j++;
                        const nextParts = next.trim().split(/\s+/).filter(p => p && p !== '=');
                        tokens = tokens.concat(nextParts);
                    }
                    // Anisotropic atom: >7 tokens -> Label type x y z sof U11 U22 U33 U23 U13 U12
                    if (tokens.length > 7) {
                        const u11 = parseFloat(tokens[6]);
                        const u22 = parseFloat(tokens[7]);
                        const u33 = parseFloat(tokens[8]);
                        const uiso = (Number.isFinite(u11) && Number.isFinite(u22) && Number.isFinite(u33))
                            ? ((u11 + u22 + u33) / 3).toFixed(5) : (tokens[6] || '0.05');
                        segments.push({ start, end: j, tokens: tokens.slice(0, 6), uiso });
                    }
                    i = j;
                }

                // Rebuild lines bottom-up so row indices stay valid.
                for (let k = segments.length - 1; k >= 0; k--) {
                    const seg = segments[k];
                    // Keep the standard column spacing (label, type, coords, sof, Uiso).
                    const label = seg.tokens[0];
                    const type = seg.tokens[1];
                    const x = seg.tokens[2];
                    const y = seg.tokens[3];
                    const z = seg.tokens[4];
                    const sof = seg.tokens[5];
                    const newLine = `${label.padEnd(4)} ${type}  ${x}  ${y}  ${z}  ${sof}  ${seg.uiso}`;
                    const Range = ace.require('ace/range').Range;
                    const last = doc.getLine(seg.end);
                    editor.session.replace(new Range(seg.start, 0, seg.end, last.length), newLine);
                }
            }
        });

        // HFIX (Alt-H)
        editor.commands.addCommand({
            name: 'addHFIX',
            bindKey: {win: 'Alt-H', mac: 'Alt-H'},
            exec: (editor) => {
                const hfix = prompt("Enter HFIX instruction (e.g. 137):");
                if (hfix) {
                    const doc = editor.getSession().getDocument();
                    const instructions = [];

                    // Collect every selected row across all ranges. Atom selections made by
                    // Ctrl-clicking in the model/editor create one separate Ace range per row,
                    // so getSelectionRange() (the primary range) would only ever see one atom.
                    const selectedRows = new Set();
                    const ranges = editor.selection.getAllRanges();
                    const hasSelection = ranges.length > 0 && !(ranges.length === 1 && ranges[0].isEmpty());
                    if (hasSelection) {
                        ranges.forEach(r => {
                            for (let i = r.start.row; i <= r.end.row; i++) selectedRows.add(i);
                        });
                    } else {
                        // No text selection: fall back to the line under the cursor
                        selectedRows.add(editor.getCursorPosition().row);
                    }

                    // Identify atoms in selection
                    selectedRows.forEach(row => {
                        const parts = doc.getLine(row).trim().split(/\s+/);
                        // Check if atom: starts with letter, has coordinates (at least 4 parts)
                        // Heuristic: Label starts with letter, not a keyword
                        const keywords = ['TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HFIX', 'BOND', 'CONF', 'MPLA', 'HTAB', 'EQIV', 'CONN', 'PART', 'AFIX', 'RESI', 'MOLE', 'PLAN', 'SIZE', 'TEMP', 'WGHT', 'FVAR', 'HKLF', 'END', 'REM', 'Q', 'OMIT', 'DISP', 'ISOR', 'RIGI', 'SIMU', 'DELU', 'DANG', 'BUMP'];
                        if (parts.length >= 4 && /^[A-Z]/i.test(parts[0]) && !keywords.includes(parts[0].toUpperCase())) {
                            instructions.push(`HFIX ${hfix} ${parts[0]}`);
                        }
                    });

                    if (instructions.length > 0) {
                        // Find UNIT to insert after
                        const allLines = doc.getAllLines();
                        let unitLineIndex = -1;
                        for (let i = 0; i < allLines.length; i++) {
                            if (allLines[i].trim().startsWith('UNIT')) {
                                unitLineIndex = i;
                                break;
                            }
                        }

                        const text = instructions.join('\n') + '\n';
                        
                        if (unitLineIndex !== -1) {
                            editor.session.insert({row: unitLineIndex + 1, column: 0}, text);
                        } else {
                            // Fallback: insert at cursor
                            const cursor = editor.getCursorPosition();
                            editor.session.insert(cursor, text);
                        }
                    } else {
                        // No atoms selected? Just insert generic HFIX at cursor
                        const cursor = editor.getCursorPosition();
                        editor.session.insert(cursor, `HFIX ${hfix} \n`);
                    }
                }
            }
        });

        // Sort Atoms (Alt-S)
        editor.commands.addCommand({
            name: 'sortAtoms',
            bindKey: {win: 'Alt-S', mac: 'Alt-S'},
            exec: (editor) => {
                let range = editor.getSelectionRange();
                const doc = editor.getSession().getDocument();
                
                if (range.isEmpty()) {
                    // Auto-select all atoms (contiguous block)
                    const lines = doc.getAllLines();
                    let firstAtomLine = -1;
                    let lastAtomLine = -1;
                    
                    // Helper to identify atoms (including keyword exclusion)
                    // We duplicate the check here to find the bounds
                    const isAtomCheck = (line) => {
                        const parts = line.trim().split(/\s+/);
                        if (parts.length < 4) return false;
                        
                        const label = parts[0].toUpperCase();
                        const keywords = new Set([
                            'TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HKLF', 
                            'SIZE', 'TEMP', 'MOLE', 'RESI', 'MOVE', 'ANIS', 'AFIX', 'HFIX', 
                            'EQIV', 'CONN', 'PART', 'BIND', 'FREE', 'DANG', 'BOND', 'CONF',
                            'MPLA', 'RTAB', 'HTAB', 'LIST', 'ACTA', 'WGHT', 'FVAR', 'REM',
                            'END', 'OMIT', 'SADI', 'SAME', 'SIMU', 'DELU', 'RIGU', 'ISOR',
                            'NCSY', 'SUMP', 'L.S.', 'CGLS', 'BLOC', 'DAMP', 'STIR', 'TWIN',
                            'BASF', 'SWAT', 'HOPE', 'MERG', 'SPEC', 'RESC', 'RIGU'
                        ]);
                        
                        if (keywords.has(label)) return false;

                        return (/^[A-Z]/i.test(parts[0]) && !isNaN(parseFloat(parts[2])));
                    };

                    lines.forEach((line, index) => {
                         if (isAtomCheck(line)) {
                             if (firstAtomLine === -1) firstAtomLine = index;
                             lastAtomLine = index;
                         }
                    });

                    if (firstAtomLine !== -1 && lastAtomLine !== -1) {
                        // Extend lastAtomLine to include continuations (e.g. ADPs)
                        while (lastAtomLine + 1 < lines.length) {
                             const nextLine = lines[lastAtomLine + 1].trim();
                             if (!nextLine) break; // Stop at empty line
                             
                             // If next line is a new atom or keyword, stop
                             if (isAtomCheck(nextLine)) break;
                             
                             // Check for keywords explicitly to stop
                             const parts = nextLine.split(/\s+/);
                             const label = parts[0].toUpperCase();
                             const keywords = new Set([
                                'TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HKLF', 
                                'SIZE', 'TEMP', 'MOLE', 'RESI', 'MOVE', 'ANIS', 'AFIX', 'HFIX', 
                                'EQIV', 'CONN', 'PART', 'BIND', 'FREE', 'DANG', 'BOND', 'CONF',
                                'MPLA', 'RTAB', 'HTAB', 'LIST', 'ACTA', 'WGHT', 'FVAR', 'REM',
                                'END', 'OMIT', 'SADI', 'SAME', 'SIMU', 'DELU', 'RIGU', 'ISOR',
                                'NCSY', 'SUMP', 'L.S.', 'CGLS', 'BLOC', 'DAMP', 'STIR', 'TWIN',
                                'BASF', 'SWAT', 'HOPE', 'MERG', 'SPEC', 'RESC', 'RIGU'
                             ]);
                             if (keywords.has(label)) break;

                             // Otherwise, assume it's part of the atom (continuation or ADP data)
                             lastAtomLine++;
                        }

                        const Range = ace.require('ace/range').Range;
                        // Select everything from the first atom to the end of last atom block
                        range = new Range(firstAtomLine, 0, lastAtomLine, doc.getLine(lastAtomLine).length);
                        editor.selection.setRange(range);
                    } else {
                        alert("No atoms found to sort.");
                        return;
                    }
                }
                // Get lines from range
                const linesToSort = doc.getLines(range.start.row, range.end.row);
                
                const atomBlocks = [];
                const header = [];
                const footer = [];
                let currentBlock = null;
                let state = 'HEADER'; // HEADER, BODY, FOOTER

                // Function to check if a line is a Primary Atom (Start of a sorting block)
                const isPrimaryAtom = (line) => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 4) return false;
                        
                    const label = parts[0].toUpperCase();
                    // Keywords to exclude from being an Atom
                    const keywords = new Set([
                        'TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HKLF', 
                        'SIZE', 'TEMP', 'MOLE', 'RESI', 'MOVE', 'ANIS', 'AFIX', 'HFIX', 
                        'EQIV', 'CONN', 'PART', 'BIND', 'FREE', 'DANG', 'BOND', 'CONF',
                        'MPLA', 'RTAB', 'HTAB', 'LIST', 'ACTA', 'WGHT', 'FVAR', 'REM',
                        'END', 'OMIT', 'SADI', 'SAME', 'SIMU', 'DELU', 'RIGU', 'ISOR',
                        'NCSY', 'SUMP', 'L.S.', 'CGLS', 'BLOC', 'DAMP', 'STIR', 'TWIN',
                        'BASF', 'SWAT', 'HOPE', 'MERG', 'SPEC', 'RESC', 'RIGU', 'SHEL'
                    ]);
                    
                    if (keywords.has(label)) return false;

                    // Exclude Hydrogens from being Primary Sort Keys (Riders)
                    // Q-peaks ARE Primary Atoms (should be sorted)
                    if (/^H\d+/i.test(label)) return false;
                    
                    // Must look like an atom (Label x y z)
                    return (/^[A-Z]/i.test(parts[0]) && !isNaN(parseFloat(parts[2])));
                };

                // Function to check if a line definitely starts the footer
                const isFooterStart = (line) => {
                    const label = line.trim().split(/\s+/)[0].toUpperCase();
                    // HKLF and END are definitive stoppers. WGHT often comes after atoms.
                    return ['HKLF', 'END', 'WGHT'].includes(label);
                };

                linesToSort.forEach(line => {
                    const trimmed = line.trim();
                    if (!trimmed) {
                        // Empty line handling
                        if (state === 'HEADER') header.push(line);
                        else if (state === 'BODY') {
                             if (currentBlock) currentBlock.lines.push(line); // Keep with atom
                             else header.push(line); // Should not happen in BODY if logic correct
                        }
                        else footer.push(line);
                        return;
                    }

                    if (state === 'HEADER') {
                        if (isPrimaryAtom(line)) {
                            state = 'BODY';
                            currentBlock = {
                                label: trimmed.split(/\s+/)[0],
                                lines: [line]
                            };
                        } else {
                            if (isFooterStart(line)) {
                                state = 'FOOTER'; // Jump straight to footer if no atoms found yet
                                footer.push(line);
                            } else {
                                header.push(line);
                            }
                        }
                    } else if (state === 'BODY') {
                        if (isFooterStart(line)) {
                            // Close current block
                            if (currentBlock) {
                                atomBlocks.push(currentBlock);
                                currentBlock = null;
                            }
                            state = 'FOOTER';
                            footer.push(line);
                        } else if (isPrimaryAtom(line)) {
                            // New atom block
                            if (currentBlock) atomBlocks.push(currentBlock);
                            currentBlock = {
                                label: trimmed.split(/\s+/)[0],
                                lines: [line]
                            };
                        } else {
                            // Rider / Continuation / Attached Instruction (AFIX, H, ANIS)
                            // Append to current block
                            if (currentBlock) {
                                currentBlock.lines.push(line);
                            } else {
                                // Orphaned line in BODY but no block? Treat as header leak?
                                // Should imply we haven't started a block yet, but state is BODY.
                                // Logic error or odd file. Put in header or start dummy block?
                                header.push(line);
                            }
                        }
                    } else { // FOOTER
                        footer.push(line);
                    }
                });

                // Close last block
                if (currentBlock) atomBlocks.push(currentBlock);
                
                // Sort blocks by label
                atomBlocks.sort((a, b) => {
                    return a.label.localeCompare(b.label, undefined, {numeric: true, sensitivity: 'base'});
                });
                
                // Reconstruct: Header -> Sorted Blocks -> Footer
                let resultLines = [...header]; 
                atomBlocks.forEach(block => {
                    resultLines = resultLines.concat(block.lines);
                });
                resultLines = resultLines.concat(footer);
                
                const replacement = resultLines.join('\n');
                
                editor.session.replace({
                    start: {row: range.start.row, column: 0},
                    end: {row: range.end.row, column: doc.getLine(range.end.row).length}
                }, replacement);
            }
        });

        // Find Duplicate Labels (Ctrl-Alt-L)
        editor.commands.addCommand({
            name: 'findDuplicates',
            bindKey: {win: 'Ctrl-Alt-L', mac: 'Command-Alt-L'},
            exec: (editor) => {
                const doc = editor.getSession().getDocument();
                const lines = doc.getAllLines();
                const labels = {};
                const duplicates = [];
                
                lines.forEach((line, index) => {
                    const label = line.trim().split(/\s+/)[0];
                    if (label && /^[A-Z]/i.test(label) && label.length < 5) { // Simple filter for atom-like labels
                        if (labels[label]) {
                            duplicates.push({label, line: index + 1});
                        } else {
                            labels[label] = true;
                        }
                    }
                });

                if (duplicates.length > 0) {
                    alert("Found duplicates:\n" + duplicates.map(d => `${d.label} at line ${d.line}`).join('\n'));
                } else {
                    alert("No duplicate labels found.");
                }
            }
        });

        // Get Molecular Formula
        editor.commands.addCommand({
            name: 'getFormula',
            exec: (editor) => {
                const doc = editor.getSession().getDocument();
                const lines = doc.getAllLines();
                const sfac = this.parseSfacElements(lines);
                const counts = {};
                lines.forEach(line => {
                    if (!this.isShelxAtomLine(line)) return;
                    if (/^Q\d+$/i.test(line.trim().split(/\s+/)[0])) return;
                    const el = this.elementOfAtomLine(line, sfac);
                    if (!el) return;
                    counts[el] = (counts[el] || 0) + 1;
                });
                const keys = Object.keys(counts);
                if (!keys.length) { alert('No atom lines found.'); return; }
                // SFAC order where possible, then alphabetical.
                keys.sort((a, b) => {
                    const ia = sfac.indexOf(a);
                    const ib = sfac.indexOf(b);
                    if (ia !== -1 && ib !== -1) return ia - ib;
                    if (ia !== -1) return -1;
                    if (ib !== -1) return 1;
                    return a.localeCompare(b);
                });
                const formula = keys.map(el => `${el}${counts[el]}`).join(' ');
                alert(`Estimated Formula (asymmetric unit):\n${formula}`);
            }
        });

        // Correct Molecular Formula (UNIT instruction)
        editor.commands.addCommand({
            name: 'correctFormula',
            exec: (editor) => {
                const doc = editor.getSession().getDocument();
                const lines = doc.getAllLines();
                const sfac = this.parseSfacElements(lines);
                if (!sfac.length) { alert('No SFAC instruction found.'); return; }

                let unitRow = -1;
                let z = 1;
                lines.forEach((line, i) => {
                    const parts = line.trim().split(/\s+/);
                    const key = (parts[0] || '').toUpperCase();
                    if (key === 'UNIT') unitRow = i;
                    if (key === 'ZERR' && parts.length >= 2) {
                        const zz = parseFloat(parts[1]);
                        if (isFinite(zz) && zz > 0) z = zz;
                    }
                });

                const counts = {};
                sfac.forEach(el => { counts[el] = 0; });
                lines.forEach(line => {
                    if (!this.isShelxAtomLine(line)) return;
                    if (/^Q\d+$/i.test(line.trim().split(/\s+/)[0])) return;
                    const el = this.elementOfAtomLine(line, sfac);
                    if (!el) return;
                    counts[el] = (counts[el] || 0) + 1;
                });

                // Preserve the cell scale already implied by the existing UNIT
                // (the cell holds Z/Z' asymmetric units), so correcting the
                // formula does not change Z. Fall back to ZERR Z when there is
                // no usable UNIT.
                let scale = null;
                if (unitRow !== -1) {
                    const unitVals = doc.getLine(unitRow).trim().split(/\s+/).slice(1).map(Number);
                    const ratios = [];
                    sfac.forEach((el, i) => {
                        if (isFinite(unitVals[i]) && counts[el] > 0) ratios.push(unitVals[i] / counts[el]);
                    });
                    if (ratios.length) {
                        ratios.sort((a, b) => a - b);
                        scale = Math.round(ratios[Math.floor(ratios.length / 2)]);
                    }
                }
                if (!scale || scale < 1) scale = z;
                const perCell = sfac.map(el => Math.round((counts[el] || 0) * scale));
                const formula = sfac.filter(el => counts[el] > 0).map(el => `${el}${counts[el]}`).join(' ');
                const unitText = 'UNIT ' + perCell.join(' ');
                if (!confirm(`Asymmetric-unit content: ${formula || '(none)'}\ncell scale = ${scale}  ->  ${unitText}\n\nUpdate the UNIT instruction?`)) return;

                if (unitRow !== -1) {
                    const old = doc.getLine(unitRow);
                    const lead = old.match(/^\s*/)[0];
                    doc.removeInLine(unitRow, 0, old.length);
                    doc.insertInLine({ row: unitRow, column: 0 }, lead + unitText);
                } else {
                    let sfacRow = -1;
                    for (let i = 0; i < doc.getLength(); i++) {
                        if (/^\s*SFAC\b/i.test(doc.getLine(i))) sfacRow = i;
                    }
                    const row = sfacRow === -1 ? 0 : sfacRow + 1;
                    editor.session.insert({ row, column: 0 }, unitText + '\n');
                }
                editor.loadedFile = editor.getValue();
                this.state.loadedContent = editor.getValue();
                const status = document.getElementById('status-bar-content');
                if (status) status.textContent = `UNIT updated: ${perCell.join(' ')} (scale=${scale})`;
            }
        });

        // Change U(iso)
        editor.commands.addCommand({
            name: 'changeUiso',
            exec: (editor) => {
                const val = prompt("Enter new U(iso) value:", "0.05");
                if (val) {
                    const range = editor.getSelectionRange();
                    const doc = editor.getSession().getDocument();
                    const startRow = range.isEmpty() ? 0 : range.start.row;
                    const endRow = range.isEmpty() ? doc.getLength() - 1 : range.end.row;

                    for (let i = startRow; i <= endRow; i++) {
                        let line = doc.getLine(i);
                        let parts = line.trim().split(/\s+/);
                        // Atom line: Label type x y z sof Uiso ...
                        // We target the 7th token (index 6)
                        const label = parts[0].toUpperCase();
                        const keywords = ['TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HFIX', 'BOND', 'CONF', 'MPLA', 'HTAB', 'EQIV', 'CONN', 'PART', 'AFIX', 'RESI', 'MOLE', 'PLAN', 'SIZE', 'TEMP', 'WGHT', 'FVAR', 'HKLF', 'END', 'REM', 'Q', 'OMIT', 'DISP', 'ISOR', 'RIGI', 'SIMU', 'DELU', 'DANG', 'BUMP', 'TWIN', 'BASF'];
                        
                        if (parts.length > 6 && /^[A-Z]/i.test(parts[0]) && !keywords.includes(label)) {
                             // Check if it's likely an atom (has coordinates)
                             if (!isNaN(parseFloat(parts[2]))) {
                                 parts[6] = val;
                                 // Reconstruct line preserving spacing? 
                                 // Ace doesn't make it easy to preserve exact spacing if we split/join.
                                 // But Shelx is space-delimited.
                                 const newLine = parts.join('  ');
                                 doc.removeInLine(i, 0, line.length);
                                 doc.insertInLine({row: i, column: 0}, newLine);
                             }
                        }
                    }
                }
            }
        });

        // Change Occupancy (sof) for selected atoms
        editor.commands.addCommand({
            name: 'changeOccupancy',
            exec: (editor) => {
                this.openChangeOccupancyDialog(editor);
            }
        });

        // OMIT Error/ESD>9
        editor.commands.addCommand({
            name: 'omitError',
            exec: (editor) => {
                // This usually implies looking at the .lst file or .res file comments?
                // Or maybe just adding an OMIT instruction?
                // "OMIT reflections with ERROR/ESD>9"
                // This sounds like a specific Shelx command or a cleanup script.
                // I'll just insert "OMIT -3 50" as a placeholder or similar.
                // Or maybe it filters HKL?
                // Let's assume it adds a standard OMIT instruction.
                editor.insert("OMIT 0 999\n"); 
            }
        });

        // Calculate DISP
        editor.commands.addCommand({
            name: 'calcDisp',
            exec: () => { this.calculateDisp(); }
        });

        // Assign Q as Carbons
        editor.commands.addCommand({
            name: 'qToC',
            exec: (editor) => {
                const doc = editor.getSession().getDocument();
                const lines = doc.getAllLines();
                const range = editor.getSelectionRange();
                const startRow = range.isEmpty() ? 0 : range.start.row;
                const endRow = range.isEmpty() ? doc.getLength() - 1 : range.end.row;

                for (let i = startRow; i <= endRow; i++) {
                    let line = doc.getLine(i);
                    if (line.trim().startsWith('Q')) {
                        // Replace Q with C
                        // Q1 ... -> C1 ...
                        // Also need to change scattering factor index usually (2nd token).
                        // Let's just change the label Q->C and maybe the type if it's explicit.
                        let newLine = line.replace(/^Q/i, 'C');
                        // If 2nd token is a number (SFAC index), might need to change it to 1 (Carbon)?
                        // Let's ask user or assume 1.
                        // For now, just label change.
                        doc.removeInLine(i, 0, line.length);
                        doc.insertInLine({row: i, column: 0}, newLine);
                    }
                }
            }
        });
    }

    // Removed duplicate deselectAll


    selectByNuclei() {
        const modalEl = document.getElementById('selectNucleiModal');
        if (modalEl) {
            const modal = new bootstrap.Modal(modalEl);
            const input = document.getElementById('select-nuclei-input');
            if (input) input.value = ''; // Clear previous
            modal.show();
            
            // Focus input after modal is shown
            modalEl.addEventListener('shown.bs.modal', () => {
                if (input) input.focus();
            }, { once: true });
        }
    }

    performSelectByNuclei(element) {
        const editor = this.state.editors.res;
        if (!editor || !element) return;

        const targetElement = element.trim().toUpperCase();
        const doc = editor.getSession().getDocument();
        const lines = doc.getAllLines();
        const rowsToSelect = [];

        // 1. Parse SFAC to get element mapping
        const sfacElements = [];
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts[0].toUpperCase() === 'SFAC') {
                for (let i = 1; i < parts.length; i++) {
                    // Ignore numbers (coefficients)
                    if (isNaN(parseFloat(parts[i]))) {
                        sfacElements.push(parts[i].toUpperCase());
                    }
                }
            }
        });

        // Clear existing selection
        this.deselectAll();

        lines.forEach((line, index) => {
            const parts = line.trim().split(/\s+/);
            const keywords = ['TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HFIX', 'BOND', 'CONF', 'MPLA', 'HTAB', 'EQIV', 'CONN', 'PART', 'AFIX', 'RESI', 'MOLE', 'PLAN', 'SIZE', 'TEMP', 'WGHT', 'FVAR', 'HKLF', 'END', 'REM', 'Q', 'OMIT', 'DISP', 'ISOR', 'RIGI', 'SIMU', 'DELU', 'DANG', 'BUMP', 'TWIN', 'BASF'];
            
            // Check if atom line
            if (parts.length >= 4 && /^[A-Z]/i.test(parts[0]) && !keywords.includes(parts[0].toUpperCase())) {
                let atomElement = null;

                // Try to get element from SFAC index (2nd token)
                const sfacIndex = parseInt(parts[1]);
                if (!isNaN(sfacIndex) && sfacIndex > 0 && sfacIndex <= sfacElements.length) {
                    atomElement = sfacElements[sfacIndex - 1];
                } else {
                    // Fallback to label parsing if SFAC index invalid or missing
                    const match = parts[0].match(/^[A-Za-z]+/);
                    if (match) {
                        atomElement = match[0].replace(/\d+$/, '').toUpperCase();
                    }
                }

                // Special handling for Q-peaks: Treat as 'Q' regardless of SFAC (usually SFAC 1=C)
                if (/^Q\d+$/i.test(parts[0])) {
                    atomElement = 'Q';
                }

                if (atomElement === targetElement || targetElement === '*') {
                    rowsToSelect.push(index);
                }
            }
        });

        if (rowsToSelect.length > 0) {
            const selection = editor.getSelection();
            selection.clearSelection();
            rowsToSelect.forEach(row => {
                selection.addRange(new ace.Range(row, 0, row, doc.getLine(row).length));
                this.state.selectionOrder.push(row);
            });
            
            // Scroll to first
            editor.scrollToLine(rowsToSelect[0], true, true, function() {});
        } else {
            alert(`No ${targetElement} atoms found.`);
        }
    }

    getRelabelKeywords() {
        // Any SHELX instruction keyword is not an atom label. Reuse the
        // canonical instruction list so the two never drift apart (a missing
        // keyword such as L.S., LIST or FMAP made the relabeler treat the
        // instruction as an atom and rewrite it, e.g. "L.S. 10" -> "L1 10").
        return this.getShelxKeywords();
    }

    // Parse SFAC line(s) from the document into an ordered list of element symbols
    getSfacElements(lines) {
        const sfacElements = [];
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 0 && parts[0].toUpperCase() === 'SFAC') {
                for (let i = 1; i < parts.length; i++) {
                    if (isNaN(parseFloat(parts[i]))) {
                        sfacElements.push(parts[i].toUpperCase());
                    }
                }
            }
        });
        return sfacElements;
    }

    // Return { label, element, num } for an atom line, or null if it's not an atom line
    parseRelabelAtomLine(line, sfacElements) {
        if (!line || line.trim().startsWith('=')) return null;
        const parts = line.trim().split(/\s+/);
        // A SHELX atom line is "label type x y z [sof U ...]", so it needs the
        // label, the SFAC type and three coordinates. Requiring five tokens
        // with numeric x/y/z rejects instruction lines such as "LIST 6",
        // "FMAP 2" or "L.S. 10" even if the keyword list is incomplete.
        if (parts.length < 5) return null;
        if (!/^[A-Za-z]+/.test(parts[0])) return null;
        if (this.getRelabelKeywords().includes(parts[0].toUpperCase())) return null;
        if (isNaN(parseFloat(parts[2])) || isNaN(parseFloat(parts[3])) || isNaN(parseFloat(parts[4]))) return null;

        const label = parts[0];
        let element = null;

        const sfacIndex = parseInt(parts[1]);
        if (!isNaN(sfacIndex) && sfacIndex > 0 && sfacIndex <= sfacElements.length) {
            element = sfacElements[sfacIndex - 1];
        } else {
            const m = label.match(/^[A-Za-z]+/);
            if (m) element = m[0].toUpperCase();
        }
        // Q-peaks are always 'Q' regardless of SFAC
        if (/^Q/i.test(label)) element = 'Q';

        if (!element) return null;

        const numMatch = label.match(/\d+/);
        const num = numMatch ? parseInt(numMatch[0], 10) : 0;

        return { label, element, num };
    }

    // Largest number currently used for a given element across the whole document
    getMaxNumberForElement(lines, sfacElements, element) {
        let max = 0;
        lines.forEach(line => {
            const atom = this.parseRelabelAtomLine(line, sfacElements);
            if (atom && atom.element === element && atom.num > max) {
                max = atom.num;
            }
        });
        return max;
    }

    openRelabelDialog(editor) {
        const modalEl = document.getElementById('relabelModal');
        if (!modalEl) return;
        const modal = new bootstrap.Modal(modalEl);
        const elInput = document.getElementById('relabel-element-input');
        const sufInput = document.getElementById('relabel-suffix-input');
        if (elInput) elInput.value = '';
        if (sufInput) sufInput.value = '';

        // Show the scope in the hint
        const hint = document.getElementById('relabel-scope-hint');
        if (hint) {
            let scope = 'No atoms selected - all atoms will be relabeled.';
            if (editor) {
                const ranges = editor.selection.getAllRanges();
                const hasSelection = ranges.length > 0 && !(ranges.length === 1 && ranges[0].isEmpty());
                if (hasSelection) {
                    const doc = editor.getSession().getDocument();
                    const lines = doc.getAllLines();
                    const sfacElements = this.getSfacElements(lines);
                    const count = this.state.selectionOrder.filter(r => this.parseRelabelAtomLine(doc.getLine(r), sfacElements) !== null).length;
                    scope = count > 0 ? `${count} selected atom(s) will be relabeled.` : 'No atoms selected - all atoms will be relabeled.';
                }
            }
            hint.textContent = scope;
        }

        modal.show();
        modalEl.addEventListener('shown.bs.modal', () => {
            if (elInput) elInput.focus();
        }, { once: true });
    }

    performRelabel() {
        const editor = this.state.editors.res;
        if (!editor) return;

        const doc = editor.getSession().getDocument();
        const lines = doc.getAllLines();
        const sfacElements = this.getSfacElements(lines);

        const elInput = document.getElementById('relabel-element-input');
        const sufInput = document.getElementById('relabel-suffix-input');
        const elementInput = elInput ? elInput.value.trim() : '';
        const suffix = sufInput ? sufInput.value.trim() : '';

        // Forced element (when the user types an element in the input field)
        let forceElement = null;
        if (elementInput) {
            const m = elementInput.match(/^[A-Za-z]+/);
            if (m) {
                forceElement = m[0].toUpperCase();
            } else {
                alert("Invalid atom type. Enter an element symbol such as C, N or O.");
                return;
            }
        }

        // Determine which rows to relabel
        const ranges = editor.selection.getAllRanges();
        const hasSelection = ranges.length > 0 && !(ranges.length === 1 && ranges[0].isEmpty());
        let rows = [];

        if (!hasSelection) {
            // All atoms, in document order
            lines.forEach((line, i) => {
                if (this.parseRelabelAtomLine(line, sfacElements)) rows.push(i);
            });
        } else {
            // Sync selectionOrder with current Ace selection
            const currentAceRows = new Set();
            ranges.forEach(r => {
                if (!r.isEmpty()) {
                    for (let i = r.start.row; i <= r.end.row; i++) {
                        currentAceRows.add(i);
                    }
                }
            });
            this.state.selectionOrder = this.state.selectionOrder.filter(r => currentAceRows.has(r));
            currentAceRows.forEach(r => {
                if (!this.state.selectionOrder.includes(r)) {
                    this.state.selectionOrder.push(r);
                }
            });
            this.state.selectionOrder.forEach(r => {
                if (this.parseRelabelAtomLine(doc.getLine(r), sfacElements)) rows.push(r);
            });
        }

        if (rows.length === 0) {
            alert("No atoms found to relabel.");
            return;
        }

        // Determine starting number per element
        //  - Forced type: always continue after the largest number already in the file (no duplicates),
        //    e.g. after C10 the next atom becomes C11, after C1A it becomes C2A.
        //  - Keeping types: when all atoms are relabeled, renumber each type from 1 (C3XR -> C1);
        //    when only a subset is selected, continue after the largest existing number for that type.
        const counters = {};
        rows.forEach(row => {
            const atom = this.parseRelabelAtomLine(doc.getLine(row), sfacElements);
            if (!atom) return;
            const element = forceElement || atom.element;
            if (!(element in counters)) {
                if (forceElement || hasSelection) {
                    counters[element] = this.getMaxNumberForElement(lines, sfacElements, element) + 1;
                } else {
                    counters[element] = 1;
                }
            }
        });

        // Ensure the forced element exists in the SFAC list
        let forcedSfacIndex = -1;
        if (forceElement) {
            const existingIndex = sfacElements.findIndex(e => e.toUpperCase() === forceElement);
            if (existingIndex !== -1) {
                forcedSfacIndex = existingIndex + 1; // 1-based
            } else {
                // Append to SFAC
                sfacElements.push(forceElement);
                forcedSfacIndex = sfacElements.length;
                const sfacLineIndex = lines.findIndex(line => line.trim().startsWith('SFAC'));
                if (sfacLineIndex !== -1) {
                    const newSfacLine = `SFAC ${sfacElements.join(' ')}`;
                    doc.removeInLine(sfacLineIndex, 0, doc.getLine(sfacLineIndex).length);
                    doc.insertInLine({row: sfacLineIndex, column: 0}, newSfacLine);
                    lines[sfacLineIndex] = newSfacLine;
                }
            }
        }

        const applied = [];
        const qPeaksToMove = [];
        rows.forEach(row => {
            const line = doc.getLine(row);
            const atom = this.parseRelabelAtomLine(line, sfacElements);
            if (!atom) return;
            const element = forceElement || atom.element;
            const number = counters[element];
            const newLabel = element + number + suffix;

            const oldLabel = atom.label;
            const match = line.match(/\S+/);
            if (!match) return;
            let newLine = line.substring(0, match.index) + newLabel + line.substring(match.index + oldLabel.length);

            // Update SFAC index (2nd token) when forcing a type
            if (forceElement && forcedSfacIndex !== -1) {
                const escapedLabel = newLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const sfacRegex = new RegExp(`(${escapedLabel}\\s+)(\\d+)`);
                const sfacMatch = newLine.match(sfacRegex);
                if (sfacMatch) {
                    newLine = newLine.replace(sfacMatch[0], sfacMatch[1] + forcedSfacIndex);
                }
            }

            if (atom.element === 'Q') {
                // A relabeled Q-peak becomes a real atom and is moved to the
                // end of the atom list (deferred until the in-place edits are
                // applied so row indices stay valid).
                qPeaksToMove.push({ row, newLine });
            } else {
                doc.removeInLine(row, 0, line.length);
                doc.insertInLine({row: row, column: 0}, newLine);
            }
            counters[element] = number + 1;
            applied.push({ element, number, label: newLabel });
        });

        // Move the relabeled Q-peaks to the end of the atom list, preserving
        // their original relative order.
        if (qPeaksToMove.length > 0) {
            const ordered = qPeaksToMove.slice().sort((a, b) => a.row - b.row);
            // Remove from the bottom up so earlier rows keep their indices.
            qPeaksToMove.slice().sort((a, b) => b.row - a.row).forEach(item => {
                doc.removeLines(item.row, item.row);
            });
            const currentLines = doc.getAllLines();
            // The atom list ends at the HKLF instruction (the Q-peaks that
            // follow it are residual peaks, not part of the model). Insert the
            // relabeled atom just before HKLF; if there is no HKLF, fall back
            // to after the last atom line.
            let insertRow = -1;
            for (let i = 0; i < currentLines.length; i++) {
                if (/^\s*HKLF\b/i.test(currentLines[i])) { insertRow = i; break; }
            }
            if (insertRow === -1) {
                insertRow = currentLines.length;
                for (let i = currentLines.length - 1; i >= 0; i--) {
                    if (this.parseRelabelAtomLine(currentLines[i], sfacElements)) {
                        insertRow = i + 1;
                        break;
                    }
                }
            }
            doc.insertLines(insertRow, ordered.map(item => item.newLine));
        }

        // Warn if SHELX's 999-atoms-per-type limit is exceeded
        const overLimit = applied.filter(a => a.number > 999);
        if (overLimit.length > 0) {
            const types = [...new Set(overLimit.map(a => a.element))].join(', ');
            alert(`Warning: atom numbering for ${types} exceeds SHELX's limit of 999 atoms per type. Continuing anyway.`);
        }

        this.tryRender('res');

        // Deselect atoms after relabeling
        this.deselectAll();

        // Close the modal
        const modalEl = document.getElementById('relabelModal');
        if (modalEl) {
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
        }
    }

    // SHELX instruction keywords that are not atoms (shared by the occupancy
    // guards, the atom-line detector and the relabeler).
    getShelxKeywords() {
        return ['TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HFIX', 'BOND', 'CONF', 'MPLA', 'HTAB', 'EQIV', 'CONN', 'PART', 'AFIX', 'RESI', 'MOLE', 'PLAN', 'SIZE', 'TEMP', 'WGHT', 'FVAR', 'HKLF', 'END', 'REM', 'Q', 'OMIT', 'DISP', 'ISOR', 'RIGI', 'SIMU', 'DELU', 'DANG', 'BUMP', 'TWIN', 'BASF', 'MERG', 'SPEC', 'HOPE', 'SWAT', 'SADI', 'SAME', 'NCSY', 'L.S.', 'CGLS', 'BLOC', 'DAMP', 'STIR', 'ACTA', 'LIST', 'SHEL', 'ANIS', 'MOVE', 'RTAB', 'EXYZ', 'EADP', 'RIGU', 'RESC', 'GRID', 'CALC', 'FMAP', 'TREF', 'MORE', 'DFIX', 'CHIV', 'FLAT', 'FREE', 'SUMP', 'SPAF', 'LAUE', 'OPIA', 'FRAG', 'FEND', 'BIND', 'REST', 'SAVE', 'WPDB', 'DEFS', 'FIX'];
    }

    // True when an editor line looks like a SHELX atom line (label, x y z present).
    isShelxAtomLine(line) {
        if (!line || !line.trim()) return false;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) return false;
        const label = parts[0].toUpperCase();
        if (this.getShelxKeywords().includes(label)) return false;
        return (/^[A-Z]/i.test(parts[0])
            && !isNaN(parseFloat(parts[2]))
            && !isNaN(parseFloat(parts[3]))
            && !isNaN(parseFloat(parts[4])));
    }

    // Element symbols in SFAC order (from the last SFAC instruction).
    parseSfacElements(lines) {
        let els = [];
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if ((parts[0] || '').toUpperCase() === 'SFAC') {
                els = [];
                for (let j = 1; j < parts.length; j++) {
                    if (isNaN(parseFloat(parts[j]))) els.push(parts[j].replace(/^\$/, ''));
                }
            }
        });
        return els;
    }

    // Element of a SHELX atom line: SFAC index (2nd token) first, otherwise a
    // label-based fallback (C1 -> C, Ni1 -> Ni, Cl12 -> Cl).
    elementOfAtomLine(line, sfac) {
        const parts = line.trim().split(/\s+/);
        const idx = parseInt(parts[1], 10);
        if (!isNaN(idx) && idx >= 1 && idx <= sfac.length) return sfac[idx - 1];
        const raw = parts[0];
        if (!/^[A-Za-z]/.test(raw)) return null;
        const two = raw.length >= 2 && /[a-z]/.test(raw[1]) ? raw.slice(0, 2) : raw[0];
        return two.charAt(0).toUpperCase() + two.slice(1).toLowerCase();
    }

    // -----------------------------------------------------------------------
    // Disorder restraints: apply SIMU/DELU/FLAT/ISOR/EADP/SADI to the atoms
    // that are selected in the RES editor (whole document if nothing selected).
    // Restraint instruction lines are inserted before the first atom record.
    // -----------------------------------------------------------------------

    // Natural (alphanumeric) sort used to order atom labels C1A, C10A ...
    naturalAtomCompare(a, b) {
        const re = /(\d+)|(\D+)/g;
        const split = (s) => {
            const out = [];
            let m;
            while ((m = re.exec(s)) !== null) out.push([m[1] ? parseInt(m[1], 10) : null, (m[2] || '').toLowerCase()]);
            return out;
        };
        const aa = split(a), bb = split(b);
        for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
            const x = aa[i], y = bb[i];
            if (!x) return -1;
            if (!y) return 1;
            if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
            if (x[0] === null && y[0] !== null) return -1;
            if (x[0] !== null && y[0] === null) return 1;
            if (x[0] !== null && y[0] !== null && x[0] !== y[0]) return x[0] - y[0];
        }
        return 0;
    }

    // Atom label (first token) of a line, or null if it is not an atom.
    atomLabelOf(line) {
        if (!this.isShelxAtomLine(line)) return null;
        const label = line.trim().split(/\s+/)[0];
        if (/^Q/i.test(label)) return null; // Q peaks cannot be restrained
        return label;
    }

    // Row numbers that are atom records inside the current selection
    // (whole document when the selection is empty).
    selectedAtomRows(editor) {
        const doc = editor.getSession().getDocument();
        const lines = doc.getAllLines();
        const ranges = editor.selection.getAllRanges();
        const hasSel = ranges.length > 0 && !(ranges.length === 1 && ranges[0].isEmpty());
        const rows = new Set();
        if (hasSel) {
            ranges.forEach(r => { for (let i = r.start.row; i <= r.end.row; i++) rows.add(i); });
        } else {
            lines.forEach((_, i) => rows.add(i));
        }
        return [...rows].filter(i => this.isShelxAtomLine(lines[i]));
    }

    // Sorted unique atom labels of the current selection.
    selectedDisorderLabels(editor) {
        const doc = editor.getSession().getDocument();
        const rows = this.selectedAtomRows(editor);
        const labels = [...new Set(rows.map(r => this.atomLabelOf(doc.getLine(r))).filter(Boolean))];
        labels.sort((a, b) => this.naturalAtomCompare(a, b));
        return labels;
    }

    // Row right before the first atom record of the document (restraints are
    // typically placed before the atom list).
    firstAtomRow(editor) {
        const doc = editor.getSession().getDocument();
        for (let i = 0; i < doc.getLength(); i++) {
            if (this.isShelxAtomLine(doc.getLine(i))) return i;
        }
        return 0;
    }

    // Insert instruction lines directly above the selected atom block
    // (falls back to the first atom of the document when nothing is selected),
    // preserving undo.
    insertRestraintLines(text) {
        const editor = this.state.editors.res;
        if (!editor) return;
        const ranges = editor.selection.getAllRanges();
        const hasSel = ranges.length > 0 && !(ranges.length === 1 && ranges[0].isEmpty());
        const selRows = this.selectedAtomRows(editor); // atom rows within the selection
        let row;
        if (hasSel && selRows.length) {
            // Insert just above the first atom line of the selection.
            row = selRows[0];
        } else {
            row = this.firstAtomRow(editor);
        }
        editor.session.insert({ row, column: 0 }, text + '\n');
        this.tryRender('res');
        const status = document.getElementById('status-bar-content');
        if (status) status.textContent = `Inserted restraints:\n${text}`;
    }

    // Generic: "REST esd label label ..." inserted for selected atoms.
    applyDisorderRestraint(rest, esd) {
        const editor = this.state.editors.res;
        if (!editor) return;
        const labels = this.selectedDisorderLabels(editor);
        if (!labels.length) { alert('No atom lines selected/available to restrain.'); return; }
        const head = rest + (esd ? ' ' + esd : '');
        const lines = this.chunkLabels(labels).map(c => `${head} ${c.join(' ')}`.trim());
        this.insertRestraintLines(lines.join('\n'));
    }

    // Split a label list into lines of at most `per` atoms (SHELXL restraint
    // instructions are usually kept to a limited number of atoms per line).
    chunkLabels(labels, per = 18) {
        const chunks = [];
        for (let i = 0; i < labels.length; i += per) chunks.push(labels.slice(i, i + per));
        return chunks;
    }

    // Menu entry wrappers ---------------------------------------------------
    disorderSimu() { this.applyDisorderRestraint('SIMU', '0.01'); }
    disorderDelu() { this.applyDisorderRestraint('DELU', '0.01'); }
    disorderFlat() { this.applyDisorderRestraint('FLAT', '0.01'); }
    disorderIsor() { this.applyDisorderRestraint('ISOR', '0.01'); }
    disorderEadp() { this.applyDisorderRestraint('EADP', ''); }
    disorderSadiBonds() { this.applyDisorderSadiBondsCore(); }
    disorderSadiAngles() { this.applyDisorderSadiAnglesCore(); }

    // SADI for bonds: chain of consecutive pairs (a-b, b-c, c-d, ...).
    applyDisorderSadiBondsCore() {
        const editor = this.state.editors.res;
        if (!editor) return;
        const labels = this.selectedDisorderLabels(editor);
        if (labels.length < 2) { alert('Select at least two atoms for SADI restraints.'); return; }
        const pairs = [];
        for (let i = 0; i + 1 < labels.length; i++) pairs.push(labels[i], labels[i + 1]);
        const lines = this.chunkLabels(pairs).map(c => `SADI 0.02 ${c.join(' ')}`);
        this.insertRestraintLines(lines.join('\n'));
    }

    // SADI for angles: pair each atom with the one after next (a-c, b-d, ...).
    applyDisorderSadiAnglesCore() {
        const editor = this.state.editors.res;
        if (!editor) return;
        const labels = this.selectedDisorderLabels(editor);
        if (labels.length < 3) { alert('Select at least three atoms for angle SADI restraints.'); return; }
        const pairs = [];
        for (let i = 0; i + 2 < labels.length; i++) pairs.push(labels[i], labels[i + 2]);
        const lines = this.chunkLabels(pairs).map(c => `SADI 0.02 ${c.join(' ')}`);
        this.insertRestraintLines(lines.join('\n'));
    }

    // Remove all restraint keywords (SIMU/DELU/FLAT/ISOR/EADP/SADI/DFIX/DANG/
    // RIGU/SAME) from the document - undoes accidentally inserted restraints.
    clearDisorderRestraints() {
        const editor = this.state.editors.res;
        if (!editor) return;
        const doc = editor.getSession().getDocument();
        const keys = ['SIMU', 'DELU', 'FLAT', 'ISOR', 'EADP', 'SADI', 'DFIX', 'DANG', 'RIGU', 'SAME', 'AFIX'];
        const rows = [];
        for (let i = 0; i < doc.getLength(); i++) {
            const first = doc.getLine(i).trim().split(/\s+/)[0];
            if (keys.includes(first)) rows.push(i);
        }
        if (!rows.length) { alert('No restraint instructions found to remove.'); return; }
        for (let k = rows.length - 1; k >= 0; k--) doc.removeLines(rows[k], rows[k]);
        this.tryRender('res');
        const status = document.getElementById('status-bar-content');
        if (status) status.textContent = `Removed ${rows.length} restraint line(s).`;
    }


    openChangeOccupancyDialog(editor) {
        const modalEl = document.getElementById('occupancyModal');
        if (!modalEl) return;
        const input = document.getElementById('occ-value-input');
        if (input) input.value = '10.5';

        const hint = document.getElementById('occ-scope-hint');
        if (hint) {
            const selRows = this.getOccupancyTargetRows(editor);
            if (selRows.onlySelection) {
                hint.textContent = `${selRows.rows.length} selected atom line(s) will have their occupancy changed.`;
            } else {
                hint.textContent = 'No atoms selected - all atom lines in the document will have their occupancy changed. Select atom lines in the editor to limit the change to those atoms only.';
            }
        }

        const modal = new bootstrap.Modal(modalEl);
        modal.show();
        modalEl.addEventListener('shown.bs.modal', () => {
            if (input) input.focus();
        }, { once: true });
    }

    // Work out which rows the occupancy change should touch.
    getOccupancyTargetRows(editor) {
        const doc = editor.getSession().getDocument();
        const lines = doc.getAllLines();
        const ranges = editor.selection.getAllRanges();
        const hasSelection = ranges.length > 0 && !(ranges.length === 1 && ranges[0].isEmpty());

        if (hasSelection) {
            const rows = new Set();
            ranges.forEach(r => {
                for (let i = r.start.row; i <= r.end.row; i++) rows.add(i);
            });
            return { onlySelection: true, rows: Array.from(rows).filter(i => this.isShelxAtomLine(lines[i])) };
        }

        // No selection: touch every atom line, but never a "PART -n" disorder
        // line or anything outside the atom block? Simpler: whole document atoms.
        const rows = [];
        lines.forEach((line, i) => {
            if (this.isShelxAtomLine(line)) rows.push(i);
        });
        return { onlySelection: false, rows };
    }

    performChangeOccupancy() {
        const editor = this.state.editors.res;
        if (!editor) return;

        const input = document.getElementById('occ-value-input');
        const rawVal = input ? input.value : '';
        const newVal = parseFloat(rawVal);
        if (rawVal === '' || isNaN(newVal) || newVal < 0) {
            alert('Please enter a valid non-negative occupancy value.');
            return;
        }

        const { rows } = this.getOccupancyTargetRows(editor);
        if (!rows.length) {
            alert('No atom lines found in the current selection/document.');
            return;
        }

        const doc = editor.getSession().getDocument();
        let changed = 0;
        const skipFvar = [];

        rows.forEach(i => {
            const line = doc.getLine(i);
            const parts = line.trim().split(/\s+/);
            // Atom line: Label type x y z sof Uiso ...
            // sof is token index 5.
            if (parts.length < 6) {
                // No sof column present (rare). Insert the value before any U column.
                parts.push(''); // ensure we have index 6 free below via splice
            }
            const fvarCode = Math.abs(parseFloat(parts[5]));
            // Keep SHELX FVAR reference intact unless the user truly intends it:
            // a "10*k+n" sof (>=10) means the occupancy is refined via FVAR k,
            // so the numeric value also encodes the free-variable multiplier.
            // Here we simply write the explicit sof the user typed.
            parts[5] = String(newVal);
            if (fvarCode >= 10) skipFvar.push(i);
            const newLine = parts.join('  ');
            doc.removeInLine(i, 0, line.length);
            doc.insertInLine({ row: i, column: 0 }, newLine);
            changed++;
        });

        this.tryRender('res');

        const status = document.getElementById('status-bar-content');
        if (status) {
            status.textContent = `Occupancy set to ${newVal} for ${changed} atom line(s)`;
            if (skipFvar.length) {
                console.warn(`Note: ${skipFvar.length} line(s) had FVAR-linked sof (>=10) and were overwritten with an explicit value.`);
            }
        }

        // Close the modal
        const modalEl = document.getElementById('occupancyModal');
        if (modalEl) {
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
        }
    }

    // Collect atom rows from the editor document (label -> row index map)
    collectClusterAtoms() {
        const editor = this.state.editors.res;
        if (!editor) return null;
        const doc = editor.getSession().getDocument();
        const lines = doc.getAllLines();
        const sfacElements = this.getSfacElements(lines);
        const atoms = [];
        const rows = [];
        lines.forEach((line, i) => {
            const atom = this.parseRelabelAtomLine(line, sfacElements);
            if (!atom) return;
            atoms.push({ label: atom.label, element: atom.element, x: 0, y: 0, z: 0 });
            rows.push(i);
        });
        return { atoms, rows, lines };
    }

    openClusterDialog(editor) {
        if (!this.state.parsedData || !this.state.parsedData.atoms || !this.state.parsedData.cell) {
            alert("No structure data available. Please load a valid file.");
            return;
        }
        const modalEl = document.getElementById('clusterModal');
        if (!modalEl) return;
        const modal = new bootstrap.Modal(modalEl);
        const body = document.getElementById('cluster-preview-body');
        const summary = document.getElementById('cluster-summary');
        const btnApply = document.getElementById('btn-cluster-apply');
        if (body) body.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Click Analyze to preview</td></tr>';
        if (summary) summary.textContent = '';
        if (btnApply) btnApply.disabled = true;
        this.state.clusterResult = null;
        modal.show();
    }

    analyzeCluster() {
        // Always re-parse the live editor content so the plan matches the
        // current labels (parsedData can be stale after edits/relabels).
        const editor = this.state.editors.res;
        if (!editor) {
            alert("No editor available.");
            return;
        }
        const content = editor.getSession().getValue();
        const parsed = new ShelxParser().parse(content);
        if (!parsed || !parsed.atoms || !parsed.atoms.length || !parsed.cell) {
            alert("No structure data available. Please load a valid file.");
            return;
        }

        // Q-peaks are not real atoms yet (unrefined difference peaks), so they
        // are excluded from clustering and left untouched in the file.
        const realAtoms = parsed.atoms.filter(a => !/^Q/i.test(a.label));
        if (!realAtoms.length) {
            alert("No (non-Q) atoms found to cluster.");
            return;
        }

        const bondFactor = parseFloat(document.getElementById('cluster-bond-factor').value) || 1.25;
        const minBond = parseFloat(document.getElementById('cluster-min-bond').value) || 0.85;
        const maxBond = parseFloat(document.getElementById('cluster-max-bond').value) || 2.2;

        const cluster = new MoleculeCluster(parsed.cell, realAtoms, { bondFactor, minBond, maxBond });
        const result = cluster.buildPlan();
        this.state.clusterResult = result;

        const body = document.getElementById('cluster-preview-body');
        const summary = document.getElementById('cluster-summary');
        const btnApply = document.getElementById('btn-cluster-apply');

        if (body) {
            body.innerHTML = '';
            result.molecules.forEach((mol, mi) => {
                const tr = document.createElement('tr');
                const comp = Object.entries(mol.composition)
                    .map(([el, n]) => el + n)
                    .join(' ');
                const pos = `${mol.centroid.x.toFixed(3)} ${mol.centroid.y.toFixed(3)} ${mol.centroid.z.toFixed(3)}`;
                const molPlan = result.plan.filter(p => mol.indices.includes(p.index));
                const oldLabels = molPlan.map(p => p.oldLabel).join(' ');
                const newLabels = molPlan.map(p => p.newLabel).join(' ');
                [mi + 1, mol.indices.length, comp, pos, oldLabels, newLabels].forEach((val, ci) => {
                    const td = document.createElement('td');
                    td.textContent = val;
                    if (ci >= 4) td.style.fontFamily = 'monospace';
                    tr.appendChild(td);
                });
                body.appendChild(tr);
            });
        }

        if (summary) {
            const total = result.plan.length;
            const changed = result.plan.filter(p => p.oldLabel !== p.newLabel).length;
            summary.textContent = `${result.molecules.length} molecule(s) found, ${total} atoms, ${changed} label(s) will change.`;
        }

        if (btnApply) btnApply.disabled = result.plan.length === 0;
    }

    applyClusterRelabel() {
        const result = this.state.clusterResult;
        if (!result || !result.plan.length) {
            alert("Nothing to apply. Run Analyze first.");
            return;
        }

        const editor = this.state.editors.res;
        if (!editor) return;
        const doc = editor.getSession().getDocument();

        const lines = doc.getAllLines();

        // The plan was built from a fresh parse of this same content, so its
        // oldLabels are exactly the current real-atom labels. Use that set to
        // detect atom rows (avoids mis-identifying header lines like
        // "created by..." or ZERR/UNIT as atoms, and leaves Q-peaks alone).
        const atomLabels = new Set(result.plan.map(p => p.oldLabel));
        const firstToken = (line) => (line.trim().split(/\s+/)[0] || '');
        const isAtomRow = (line) => atomLabels.has(firstToken(line));
        const isKeyword = (line) => this.getRelabelKeywords().includes(firstToken(line).toUpperCase());

        const atomLabelRows = [];
        lines.forEach((line, i) => {
            if (isAtomRow(line)) atomLabelRows.push(i);
        });
        if (atomLabelRows.length === 0) {
            alert("No atoms found.");
            return;
        }

        // Build a block for each atom: its label line plus any ADP
        // continuation lines that follow (stops at a blank line, the next atom,
        // or a keyword). This keeps ADPs attached even for the last atom.
        const blocksByLabel = {};
        atomLabelRows.forEach((row) => {
            const label = firstToken(lines[row]);
            const block = [lines[row]];
            let r = row + 1;
            while (r < lines.length) {
                const next = lines[r];
                if (!next.trim() || isAtomRow(next) || isKeyword(next)) break;
                block.push(next);
                r++;
            }
            blocksByLabel[label] = block;
        });

        // The real atoms are contiguous (Q-peaks excluded), so the region to
        // replace runs from the first atom label row to the end of the last
        // atom block. Extend the start upward to absorb any REM MOLn separators
        // left over from a previous run (keeps the operation idempotent).
        let firstRow = atomLabelRows[0];
        let sawRem = false;
        while (firstRow - 1 >= 0) {
            const t = lines[firstRow - 1].trim();
            if (/^REM\s+MOL\d+/i.test(t)) {
                firstRow--;
                sawRem = true;
            } else if (t === '' && sawRem) {
                firstRow--;
            } else {
                break;
            }
        }
        const lastBlock = blocksByLabel[firstToken(lines[atomLabelRows[atomLabelRows.length - 1]])];
        const lastRow = atomLabelRows[atomLabelRows.length - 1] + lastBlock.length - 1;

        // Rebuild the region: for each molecule (in order) emit a REM MOLn
        // separator followed by its atoms in proximity-walk order, relabeled.
        const out = [];
        let applied = 0;
        result.molecules.forEach((mol, mi) => {
            out.push(`REM MOL${mi + 1}`);
            const molPlan = result.plan.filter(p => p.molecule === mi + 1);
            molPlan.forEach(p => {
                const block = blocksByLabel[p.oldLabel];
                if (!block) return;
                const relabeled = block.map((line, li) => {
                    if (li !== 0) return line;
                    const match = line.match(/\S+/);
                    if (!match) return line;
                    return line.substring(0, match.index) + p.newLabel + line.substring(match.index + p.oldLabel.length);
                });
                out.push(...relabeled);
                if (p.oldLabel !== p.newLabel) applied++;
            });
        });

        // Replace the atom region with the reordered, relabeled clusters.
        editor.session.replace({
            start: { row: firstRow, column: 0 },
            end: { row: lastRow, column: doc.getLine(lastRow).length }
        }, out.join('\n'));

        this.tryRender('res');
        this.deselectAll();

        const modalEl = document.getElementById('clusterModal');
        if (modalEl) {
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();
        }
        alert(`Grouped ${result.molecules.length} molecule(s) with REM separators and relabeled ${applied} atom(s).`);
    }

    setupUIEvents() {
        // Handle Tab Switching
        const tabEls = document.querySelectorAll('button[data-bs-toggle="tab"]');
        tabEls.forEach(tabEl => {
            tabEl.addEventListener('shown.bs.tab', event => {
                const targetId = event.target.id;
                
                // Ignore preference tabs (or any tab not part of the main view)
                if (!['tab-split', 'tab-cif', 'tab-lst'].includes(targetId) && !targetId.startsWith('tab-file-')) {
                    return;
                }
                
                if (targetId === 'tab-split') {
                    this.enableSplitView();
                } else {
                    this.disableSplitView();
                }

                // Track the most recently shown structure file tab so external
                // programs (SHELXD, SHELXT, SHELXL, ...) run on the file the user
                // is actually looking at, rather than a stale cached copy.
                if (targetId.startsWith('tab-file-')) {
                    for (const key of Object.keys(this.state.fileTabs)) {
                        const btn = document.getElementById('tab-file-' + this.safeId(key));
                        if (btn && btn.id === targetId) {
                            const tab = this.state.fileTabs[key];
                            if (['ins', 'res', 'cif'].includes(tab.type)) {
                                this.state.lastStructureTabKey = key;
                            }
                            break;
                        }
                    }
                }

                if (targetId === 'tab-split') {
                    this.onWindowResize();
                } else if (targetId === 'tab-cif' || targetId === 'tab-lst') {
                    // Static CIF/LST panes are 0x0 while hidden - re-measure and
                    // re-render the editor once their tab becomes visible so the
                    // last lines of text are never clipped.
                    setTimeout(() => {
                        if (this.state.editors.cif) this.state.editors.cif.resize();
                        if (this.state.editors.lst) this.state.editors.lst.resize();
                    }, 50);
                } else if (targetId.startsWith('tab-file-')) {
                    // Resize the active file-tab editor
                    setTimeout(() => {
                        this.onWindowResize();
                    }, 50);
                } 
                
                if (targetId === 'tab-split') {
                    // Lazy load RES content if available and not yet loaded
                    if (this.state.loadedType === 'res' && this.state.loadedContent) {
                        if (!this.state.editors.res.loadedFile || this.state.editors.res.loadedFile !== this.state.loadedContent) {
                            const truncated = this.truncateContent(this.state.loadedContent);
                            this.state.editors.res.setValue(truncated, -1);
                            this.state.editors.res.loadedFile = this.state.loadedContent;
                            this.state.editors.res.fileId = this.state.fileId;
                        }
                    }
                }
                
                if (targetId === 'tab-cif') {
                    // Lazy load CIF content if available and not yet loaded
                    if (this.state.loadedType === 'cif' && this.state.loadedContent) {
                        if (!this.state.editors.cif.loadedFile || this.state.editors.cif.loadedFile !== this.state.loadedContent) {
                            const truncated = this.truncateContent(this.state.loadedContent);
                            this.setEditorValueProgrammatic(this.state.editors.cif, truncated);
                            this.state.editors.cif.loadedFile = this.state.loadedContent;
                            this.state.editors.cif.fileId = this.state.fileId;
                        }
                    } else if (this.state.pendingCifFile) {
                        // Companion CIF for a .res/.ins project: only on explicit
                        // user action, and confirm first when it is large.
                        const p = this.state.pendingCifFile;
                        const big = p.size > 2 * 1024 * 1024;
                        if (!big || confirm(`Load companion CIF '${p.filename}' (${(p.size / 1048576).toFixed(1)} MB)?`)) {
                            this.state.pendingCifFile = null;
                            this.loadCifCompanion(p.project, p.filename);
                        }
                    }
                }
            });
        });

        // View Settings Toggles
        const toolUnitCell = document.getElementById('tool-unitcell');
        if (toolUnitCell) {
            toolUnitCell.addEventListener('click', (e) => {
                // Prevent Bootstrap from interfering if we want full control, 
                // but since we are keeping data-bs-toggle, we just sync with it.
                // Actually, let's force the state to match our internal state to be sure.
                
                // Toggle internal state
                this.state.viewSettings.showUnitCell = !this.state.viewSettings.showUnitCell;
                console.log("Toggle Unit Cell:", this.state.viewSettings.showUnitCell);

                // Force button visual state to match
                if (this.state.viewSettings.showUnitCell) {
                    toolUnitCell.classList.add('active');
                    toolUnitCell.setAttribute('aria-pressed', 'true');
                } else {
                    toolUnitCell.classList.remove('active');
                    toolUnitCell.setAttribute('aria-pressed', 'false');
                }

                const type = this.state.loadedType || 'res';
                if (this.state.editors[type]) {
                     this.renderContent(this.state.editors[type].getValue(), type);
                } else if (this.state.loadedContent) {
                    this.renderContent(this.state.loadedContent, this.state.loadedType);
                }
            });
        }

        const toolSymmetry = document.getElementById('tool-symmetry');
        if (toolSymmetry) {
            toolSymmetry.addEventListener('click', () => {
                this.state.viewSettings.showSymmetry = !this.state.viewSettings.showSymmetry;
                console.log("Toggle Symmetry:", this.state.viewSettings.showSymmetry);
                
                if (this.state.viewSettings.showSymmetry) {
                    toolSymmetry.classList.add('active');
                    toolSymmetry.setAttribute('aria-pressed', 'true');
                } else {
                    toolSymmetry.classList.remove('active');
                    toolSymmetry.setAttribute('aria-pressed', 'false');
                }

                const type = this.state.loadedType || 'res';
                if (this.state.editors[type]) {
                     this.renderContent(this.state.editors[type].getValue(), type);
                } else if (this.state.loadedContent) {
                    this.renderContent(this.state.loadedContent, this.state.loadedType);
                }
            });
        }

        const toolCamera = document.getElementById('tool-camera');
        if (toolCamera) {
            toolCamera.addEventListener('click', () => {
                this.state.viewSettings.orthographic = !this.state.viewSettings.orthographic;
                this.switchCamera();
                
                const type = this.state.loadedType || 'res';
                if (this.state.editors[type]) {
                     this.renderContent(this.state.editors[type].getValue(), type);
                } else if (this.state.loadedContent) {
                    this.renderContent(this.state.loadedContent, this.state.loadedType);
                }
                
                // Update icon/style
                toolCamera.classList.toggle('active');
            });
        }

        const toolLabels = document.getElementById('tool-labels');
        if (toolLabels) {
            toolLabels.addEventListener('click', () => {
                setTimeout(() => {
                    this.state.viewSettings.showLabels = toolLabels.classList.contains('active');
                    
                    const type = this.state.loadedType || 'res';
                    if (this.state.editors[type]) {
                         this.renderContent(this.state.editors[type].getValue(), type);
                    } else if (this.state.loadedContent) {
                        this.renderContent(this.state.loadedContent, this.state.loadedType);
                    }
                }, 0);
            });
        }

        const toolToggleEditor = document.getElementById('tool-toggle-editor');
        if (toolToggleEditor) {
            toolToggleEditor.addEventListener('click', () => {
                this.toggleEditor();
            });
        }

        // --- Menu Wiring ---

        // Settings (Menu)
        const menuSettings = document.getElementById('menu-settings');
        const toolSettings = document.getElementById('tool-settings'); // Define it here
        if (menuSettings && toolSettings) {
            menuSettings.addEventListener('click', () => toolSettings.click());
        }
        // View Toggles (Menu) - Sync with Toolbar
        const menuUnitCell = document.getElementById('menu-unitcell');
        // toolUnitCell is already defined earlier
        if (menuUnitCell && toolUnitCell) {
            menuUnitCell.addEventListener('click', () => toolUnitCell.click());
        }

        const menuCamera = document.getElementById('menu-camera');
        // toolCamera is already defined earlier
        if (menuCamera && toolCamera) {
            menuCamera.addEventListener('click', () => toolCamera.click());
        }

        // Project Manager Events
        const menuProjectManager = document.getElementById('menu-project-manager');
        if (menuProjectManager) {
            menuProjectManager.addEventListener('click', (e) => {
                e.preventDefault();
                this.openProjectManager();
            });
        }
        
        const menuSaveServer = document.getElementById('menu-save-server');
        if (menuSaveServer) {
            menuSaveServer.addEventListener('click', (e) => {
                e.preventDefault();
                this.saveCurrentProjectToServer();
            });
        }

        const menuClearData = document.getElementById('menu-clear-data');
        if (menuClearData) {
            menuClearData.addEventListener('click', (e) => {
                e.preventDefault();
                this.clearAllData();
            });
        }

        const menuLabels = document.getElementById('menu-labels');
        // toolLabels is already defined earlier
        if (menuLabels && toolLabels) {
            menuLabels.addEventListener('click', () => toolLabels.click());
        }

        const toolADPs = document.getElementById('tool-adps');
        const menuADPs = document.getElementById('menu-show-adps');

        // Toggle function
        const toggleADPs = () => {
             this.state.viewSettings.showADPs = !this.state.viewSettings.showADPs;
             const isOn = this.state.viewSettings.showADPs;
             
             if (menuADPs) {
                 if (isOn) menuADPs.classList.add('checked');
                 else menuADPs.classList.remove('checked');
             }
             if (toolADPs) {
                 if (isOn) {
                     toolADPs.classList.add('active');
                     toolADPs.setAttribute('aria-pressed', 'true');
                 } else {
                     toolADPs.classList.remove('active');
                     toolADPs.setAttribute('aria-pressed', 'false');
                 }
             }

             const type = this.state.loadedType || 'res';
             if (this.state.editors[type]) {
                  this.renderContent(this.state.editors[type].getValue(), type);
             } else if (this.state.loadedContent) {
                 this.renderContent(this.state.loadedContent, this.state.loadedType);
             }
        };

        if (menuADPs) {
            menuADPs.addEventListener('click', (e) => {
                 e.preventDefault();
                 toggleADPs();
            });
        }
        
        if (toolADPs) {
            toolADPs.addEventListener('click', (e) => {
                e.preventDefault();
                toggleADPs();
            });
        }

        // Reset Camera (Menu & Toolbar)
        const resetCamera = () => {
            this.resetView();
        };

        const toolReset = document.getElementById('tool-reset');
        if (toolReset) toolReset.addEventListener('click', resetCamera);

        const menuReset = document.getElementById('menu-reset');
        if (menuReset) menuReset.addEventListener('click', resetCamera);

        // About Modal
        const menuAbout = document.getElementById('menu-about');
        if (menuAbout) {
            menuAbout.addEventListener('click', () => {
                const aboutModal = new bootstrap.Modal(document.getElementById('aboutModal'));
                aboutModal.show();
            });
        }

        const toolSplit = document.getElementById('tool-split');
        console.log("Tool Split found:", toolSplit);
        if (toolSplit) {
            toolSplit.addEventListener('click', () => {
                console.log("Split button clicked");
                this.toggleSplitView();
            });
        }

        // Refine Button
        const refineStructure = () => {
            this.refineStructure();
        };

        const toolRefine = document.getElementById('tool-refine');
        if (toolRefine) toolRefine.addEventListener('click', refineStructure);

        const menuRefine = document.getElementById('menu-refine');
        if (menuRefine) menuRefine.addEventListener('click', refineStructure);

        const menuRefineWeight = document.getElementById('menu-refine-weight');
        if (menuRefineWeight) {
            menuRefineWeight.addEventListener('click', () => this.refineWeight());
        }

        const menuXrdspace = document.getElementById('menu-xrdspace');
        if (menuXrdspace) {
            menuXrdspace.addEventListener('click', () => this.runSpaceGroupAnalysis());
        }
        const menuXrdspaceForce = document.getElementById('menu-xrdspace-force');
        if (menuXrdspaceForce) {
            menuXrdspaceForce.addEventListener('click', () => {
                const input = prompt(
                    'Force a specific space group.\nEnter a space group number or Hermann-Mauguin symbol\n(e.g. 14, or "P 21/c", "P-1", "C 2/c"):');
                if (input === null || input.trim() === '') return;
                this.runSpaceGroupAnalysis(input.trim());
            });
        }
        const menuSgTransform = document.getElementById('menu-sg-transform');
        if (menuSgTransform) {
            menuSgTransform.addEventListener('click', () => this.transformModelToSgPrompt());
        }

        // Fetch Structure from COD / PDB
        const menuFetchDb = document.getElementById('menu-fetch-db');
        if (menuFetchDb) menuFetchDb.addEventListener('click', () => this.openFetchDbModal());
        const btnFetchUseCell = document.getElementById('btn-fetch-use-cell');
        if (btnFetchUseCell) btnFetchUseCell.addEventListener('click', () => this.useCurrentCellForFetch());
        const btnFetchSearch = document.getElementById('btn-fetch-search');
        if (btnFetchSearch) btnFetchSearch.addEventListener('click', () => this.runDbCellSearch());
        const btnFetchById = document.getElementById('btn-fetch-by-id');
        if (btnFetchById) btnFetchById.addEventListener('click', () => this.fetchDbById());
        const fetchIdDb = document.getElementById('fetch-id-db');
        if (fetchIdDb) {
            const toggleFmt = () => {
                const wrap = document.getElementById('fetch-id-format-wrap');
                if (wrap) wrap.classList.toggle('d-none', fetchIdDb.value !== 'PDB');
            };
            fetchIdDb.addEventListener('change', toggleFmt);
            toggleFmt();
        }

        // Solve Structure & Validate / Validate (CheckCIF-style)
        const menuSolve = document.getElementById('menu-solve');
        if (menuSolve) menuSolve.addEventListener('click', () => this.openSolveModal('solve'));
        const menuValidate = document.getElementById('menu-validate');
        if (menuValidate) menuValidate.addEventListener('click', () => this.openSolveModal('validate'));

        // Solve modal buttons
        const btnSolveRun = document.getElementById('btn-solve-run');
        if (btnSolveRun) btnSolveRun.addEventListener('click', () => this.runSolvePipeline());
        const btnSolveLoadRes = document.getElementById('btn-solve-load-res');
        if (btnSolveLoadRes) btnSolveLoadRes.addEventListener('click', () => this.loadSolveResultRes());
        const btnSolveCopyReport = document.getElementById('btn-solve-copy-report');
        if (btnSolveCopyReport) btnSolveCopyReport.addEventListener('click', () => {
            const out = document.getElementById('solve-report-text');
            if (out && navigator.clipboard) navigator.clipboard.writeText(out.textContent);
        });

        // --- Publish Menu ---
        const menuPublishCif = document.getElementById('menu-publish-cif');
        if (menuPublishCif) {
            menuPublishCif.addEventListener('click', () => this.openPublishModal('cif'));
        }
        const menuReportDocx = document.getElementById('menu-report-docx');
        if (menuReportDocx) {
            menuReportDocx.addEventListener('click', () => this.openPublishModal('report'));
        }
        this.wirePublishModal();

        // --- External Programs Menu ---
        const programsDropdown = document.getElementById('programsDropdown');
        if (programsDropdown) {
            programsDropdown.parentElement.addEventListener('show.bs.dropdown', () => {
                this.loadPrograms();
            });
        }
        this.loadPrograms();

        // --- Select Menu ---
        const menuDeselectAll = document.getElementById('menu-deselect-all');
        if (menuDeselectAll) {
            menuDeselectAll.addEventListener('click', () => {
                this.deselectAll();
            });
        }

        const menuSelectNuclei = document.getElementById('menu-select-nuclei');
        if (menuSelectNuclei) {
            menuSelectNuclei.addEventListener('click', () => {
                this.selectByNuclei();
            });
        }

        // Select Nuclei Modal Logic
        const btnPerformSelectNuclei = document.getElementById('btn-perform-select-nuclei');
        const inputSelectNuclei = document.getElementById('select-nuclei-input');
        
        if (btnPerformSelectNuclei && inputSelectNuclei) {
            const doSelect = () => {
                const val = inputSelectNuclei.value;
                if (val) {
                    this.performSelectByNuclei(val);
                    const modalEl = document.getElementById('selectNucleiModal');
                    const modal = bootstrap.Modal.getInstance(modalEl);
                    if (modal) modal.hide();
                }
            };

            btnPerformSelectNuclei.addEventListener('click', doSelect);
            
            // Handle Enter key
            inputSelectNuclei.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    doSelect();
                }
            });
        }

        // Relabel Atoms Modal Logic
        const btnPerformRelabel = document.getElementById('btn-perform-relabel');
        const elInputRelabel = document.getElementById('relabel-element-input');
        const sufInputRelabel = document.getElementById('relabel-suffix-input');
        
        if (btnPerformRelabel) {
            const doRelabel = () => {
                this.performRelabel();
            };

            btnPerformRelabel.addEventListener('click', doRelabel);

            // Handle Enter key
            [elInputRelabel, sufInputRelabel].forEach(input => {
                if (input) {
                    input.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            doRelabel();
                        }
                    });
                }
            });
        }

        // Spherical Absorption Modal Logic (manual muR + automatic fit).
        const btnAbsFit = document.getElementById('btn-abs-fit');
        const btnAbsSize = document.getElementById('btn-abs-size');
        const btnAbsApply = document.getElementById('btn-abs-apply');
        const absMurInput = document.getElementById('abs-mur-input');
        if (btnAbsFit) btnAbsFit.addEventListener('click', () => this.fitAbsorptionMuR());
        if (btnAbsSize) btnAbsSize.addEventListener('click', () => this.absorptionMuRFromSize());
        if (btnAbsApply) btnAbsApply.addEventListener('click', () => this.performSphericalAbsorption());
        if (absMurInput) {
            absMurInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.performSphericalAbsorption(); }
            });
        }

        // Cluster Molecules Modal Logic
        const btnClusterAnalyze = document.getElementById('btn-cluster-analyze');
        const btnClusterApply = document.getElementById('btn-cluster-apply');
        if (btnClusterAnalyze) {
            btnClusterAnalyze.addEventListener('click', () => this.analyzeCluster());
        }
        if (btnClusterApply) {
            btnClusterApply.addEventListener('click', () => this.applyClusterRelabel());
        }

        // Change Occupancy Modal Logic
        const btnPerformOccupancy = document.getElementById('btn-perform-occupancy');
        const occInput = document.getElementById('occ-value-input');
        if (btnPerformOccupancy) {
            const doChangeOcc = () => this.performChangeOccupancy();
            btnPerformOccupancy.addEventListener('click', doChangeOcc);
            if (occInput) {
                occInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        doChangeOcc();
                    }
                });
            }
        }
    }

    enableSplitView() {
        if (this.state.splitView) return;
        this.state.splitView = true;
        
        const container = document.getElementById('mainTabContent');
        const pane3D = document.getElementById('pane-3d');
        const paneRes = document.getElementById('pane-res');
        const gutter = document.getElementById('split-gutter');
        
        container.classList.add('split-layout');
        
        // Force Grid Layout via JS
        container.style.display = 'grid';
        container.style.gridTemplateColumns = this.state.showEditor ? '1fr 5px 1fr' : '1fr';
        
        // Force 3D Pane
        if (pane3D) {
            pane3D.style.display = 'block';
            pane3D.style.width = '100%';
            pane3D.style.minWidth = '0';
            pane3D.style.gridColumn = '1';
            pane3D.style.opacity = '1';
        }
        
        // Force RES Pane
        if (paneRes) {
            paneRes.classList.add('show', 'active'); // Ensure Ace renders
            paneRes.style.display = 'block';
            paneRes.style.width = '100%';
            paneRes.style.minWidth = '0';
            paneRes.style.gridColumn = '3';
            paneRes.style.opacity = '1';
        }

        // Ensure Gutter
        if (gutter) {
            gutter.style.display = 'block';
            gutter.style.gridColumn = '2';
            gutter.style.width = '5px';
        }

        this.applyEditorVisibility();

        // Initialize Split.js (split-grid)
        try {
            this.state.splitInstance = Split({
                columnGutters: [{
                    track: 1,
                    element: gutter,
                }],
                minSize: 100, // Optional constraint
                onDragEnd: () => this.onWindowResize()
            });
        } catch(e) {
            console.error("Split.js initialization failed:", e);
        }
        
        // Force resize
        setTimeout(() => {
            this.onWindowResize();
            if (this.state.editors.res) this.state.editors.res.resize();
        }, 50);
    }

    disableSplitView() {
        if (!this.state.splitView) return;
        this.state.splitView = false;
        
        const container = document.getElementById('mainTabContent');
        const pane3D = document.getElementById('pane-3d');
        const paneRes = document.getElementById('pane-res');
        const gutter = document.getElementById('split-gutter');
        
        container.classList.remove('split-layout');
        
        // Reset Container Styles
        container.style.display = '';
        container.style.gridTemplateColumns = '';
        
        // Reset 3D Pane Styles
        if (pane3D) {
            pane3D.style.display = '';
            pane3D.style.width = '';
            pane3D.style.minWidth = '';
            pane3D.style.gridColumn = '';
            pane3D.style.opacity = '';
        }
        
        // Reset RES Pane Styles
        if (paneRes) {
            // Remove the 'show active' classes that enableSplitView added.
            // Bootstrap's tab switching only cleans up the pane of the previously
            // active tab (pane-split), so these would otherwise leave the RES
            // editor visible on top of the CIF/file-tab panes.
            paneRes.classList.remove('show', 'active');
            paneRes.style.display = '';
            paneRes.style.width = '';
            paneRes.style.minWidth = '';
            paneRes.style.gridColumn = '';
            paneRes.style.opacity = '';
        }
        
        // Reset Gutter
        if (gutter) {
            gutter.style.display = '';
            gutter.style.gridColumn = '';
        }

        if (this.state.splitInstance) {
            this.state.splitInstance.destroy();
            this.state.splitInstance = null;
        }
        
        setTimeout(() => this.onWindowResize(), 50);
    }

    applyEditorVisibility() {
        const container = document.getElementById('mainTabContent');
        const paneRes = document.getElementById('pane-res');
        const gutter = document.getElementById('split-gutter');
        const btn = document.getElementById('tool-toggle-editor');

        if (this.state.showEditor) {
            if (container) container.style.gridTemplateColumns = '1fr 5px 1fr';
            if (paneRes) {
                paneRes.style.display = 'block';
                paneRes.style.gridColumn = '3';
            }
            if (gutter) {
                gutter.style.display = 'block';
                gutter.style.gridColumn = '2';
            }
        } else {
            if (container) container.style.gridTemplateColumns = '1fr';
            if (paneRes) {
                paneRes.style.display = 'none';
                paneRes.style.gridColumn = '';
            }
            if (gutter) {
                gutter.style.display = 'none';
                gutter.style.gridColumn = '';
            }
        }

        if (btn) {
            btn.classList.toggle('active', this.state.showEditor);
            btn.setAttribute('aria-pressed', this.state.showEditor ? 'true' : 'false');
        }
    }

    toggleEditor() {
        this.state.showEditor = !this.state.showEditor;

        const activeTab = document.querySelector('.nav-link.active');
        if (activeTab && activeTab.id !== 'tab-split') {
            new bootstrap.Tab(document.getElementById('tab-split')).show();
        } else if (!this.state.splitView) {
            this.enableSplitView();
        }

        this.applyEditorVisibility();
        setTimeout(() => {
            this.onWindowResize();
            if (this.state.editors.res) this.state.editors.res.resize();
        }, 60);
    }

    setupEditors() {
        // RES Editor
        this.state.editors.res = ace.edit("res-editor");
        this.state.editors.res.setTheme("ace/theme/chrome");
        this.state.editors.res.session.setMode("ace/mode/shelx", () => {
            // Configure comment character for toggleCommentLines
            const mode = this.state.editors.res.session.getMode();
            mode.lineCommentStart = "REM ";
        });
        this.state.editors.res.setFontSize(18); // User requested 14px
        this.state.editors.res.setValue("TITL Example RES\nCELL 0.71073 10.0 10.0 10.0 90 90 90\nZERR 2 0.01 0.01 0.01 0 0 0\nLATT -1\nSFAC C H O\nUNIT 10 20 5\nC1 1 0.1 0.1 0.1 11.0 0.05\nO1 3 0.2 0.2 0.2 11.0 0.05\nEND", -1);
        
        this.state.editors.res.session.on('change', () => {
            if (this.state.loadedType === 'res') {
                this.tryRender('res');
            }
        });

        // Highlight atoms in 3D when selection changes in editor
        this.state.editors.res.selection.on('changeSelection', () => {
            if (this.state.loadedType === 'res' && this.state.moleculeRenderer) {
                const ranges = this.state.editors.res.selection.getAllRanges();
                const selectedLines = new Set();
                ranges.forEach(range => {
                    for (let i = range.start.row; i <= range.end.row; i++) {
                        selectedLines.add(i + 1); // 1-based line numbers
                    }
                });
                this.state.moleculeRenderer.highlightAtoms(selectedLines);
                this.updateStatusBar();
            }
        });

        if (document.getElementById('editor-cif')) {
            this.state.editors.cif = ace.edit("editor-cif");
            this.state.editors.cif.setTheme(this.state.preferences.editor.theme);
            this.state.editors.cif.session.setMode("ace/mode/cif");
            this.state.editors.cif.setFontSize(this.state.preferences.editor.fontSize);
            this.state.editors.cif.setOption('fontFamily', this.state.preferences.editor.fontFamily);
        }

        if (document.getElementById('editor-lst')) {
            this.state.editors.lst = ace.edit("editor-lst");
            this.state.editors.lst.setTheme(this.state.preferences.editor.theme);
            this.state.editors.lst.session.setMode("ace/mode/text");
            this.state.editors.lst.setFontSize(this.state.preferences.editor.fontSize);
            this.state.editors.lst.setOption('fontFamily', this.state.preferences.editor.fontFamily);
            this.state.editors.lst.setReadOnly(true);
        }
        // CIF Editor Event
        if (this.state.editors.cif) {
            this.state.editors.cif.session.on('change', () => {
                // Ignore programmatic setValue (file loads, tab lazy-load): only
                // user edits should re-parse. Otherwise loading a huge CIF would
                // re-render its truncated editor copy (no atoms) over the good
                // full-content render.
                if (this._suppressEditorRender) return;
                if (this.state.loadedType === 'cif') {
                    this.tryRender('cif');
                }
            });
        }
    }

    tryRender(type) {
        if (this.state.renderTimeout) clearTimeout(this.state.renderTimeout);
        this.state.renderTimeout = setTimeout(() => {
            const content = this.state.editors[type].getValue();
            this.state.loadedContent = content; // Keep source of truth in sync
            this.renderContent(content, type);
        }, 500);
    }

    renderContent(content, type) {
        let data = null;
        try {
            if (type === 'res') {
                data = this.state.parsers.shelx.parse(content);
            } else if (type === 'pdb') {
                data = this.state.parsers.pdb.parse(content);
            } else {
                const maxAtoms = this.state.preferences.viewer.maxAtoms;
                data = this.state.parsers.cif.parse(content, { maxAtoms });
            }
            
            this.state.parsedData = data; // Store for calculations (e.g. bond length)
            this.state.cachedMapData = null; // Invalidate map cache as atoms changed
            this.state.mapFocusFrac = null; // Structure changed: reset recentered map focus
            
            if (data && this.state.moleculeRenderer) {
                const renderSettings = {
                    ...this.state.viewSettings,
                    preferences: this.state.preferences
                };
                this.state.moleculeRenderer.render(data, renderSettings);
            }
            // Tell the user when a very large structure was capped (the viewer
            // renders as a points cloud above ~150k atoms automatically).
            if (data && data.truncated) {
                const statusEl = document.getElementById('status-bar-content');
                if (statusEl) {
                    statusEl.textContent = `Large structure: showing first ${data.atoms.length.toLocaleString()} `
                        + `of ${data.totalAtoms.toLocaleString()} atoms (raise "Max atoms" in Settings)`;
                }
            }
            this.saveStateToLocalStorage();
        } catch (e) {
            console.error("Parse error:", e);
            alert("Error parsing file: " + e.message);
        }
    }

    setup3D() {
        const container = document.getElementById('three-container');
        
        // Scene
        this.state.scene = new THREE.Scene();
        this.state.scene.background = new THREE.Color(0xffffff); // White background
        
        // Camera
        const aspect = container.clientWidth / container.clientHeight;
        // Default to Orthographic
        this.state.camera = new THREE.OrthographicCamera(-20 * aspect, 20 * aspect, 20, -20, 0.1, 1000);
        this.state.camera.position.z = 20;
        
        // Store both cameras
        this.state.cameras = {
            perspective: new THREE.PerspectiveCamera(75, aspect, 0.1, 1000),
            orthographic: this.state.camera
        };
        this.state.cameras.perspective.position.z = 20;

        // Renderer
        this.state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.state.renderer.setSize(container.clientWidth, container.clientHeight);
        container.appendChild(this.state.renderer.domElement);

        // Controls
        this.state.controls = new OrbitControls(this.state.camera, this.state.renderer.domElement);
        this.state.controls.enableDamping = true;
        this.state.controls.rotateSpeed = -1.0; // Invert rotation direction

        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6); // Slightly brighter ambient
        this.state.scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(10, 10, 10);
        this.state.scene.add(directionalLight);

        // Molecule Renderer
        this.state.moleculeRenderer = new MoleculeRenderer(this.state.scene);
        this.state.densityRenderer = new DensityRenderer(this.state.moleculeRenderer.group);

        // Initial Render
        this.tryRender('res');

        // Animation Loop
        const animate = () => {
            requestAnimationFrame(animate);
            this.state.controls.update();
            this.state.renderer.render(this.state.scene, this.state.camera);
        };
        animate();

        // Resize Handler
        window.addEventListener('resize', this.onWindowResize);

        // Mouse Interaction State
        this.mouseState = {
            downX: 0,
            downY: 0,
            isDown: false
        };

        // Mouse Down Handler (Track start position)
        this.state.renderer.domElement.addEventListener('pointerdown', (event) => {
            this.mouseState.downX = event.clientX;
            this.mouseState.downY = event.clientY;
            this.mouseState.isDown = true;
        });

        // Mouse Up Handler (Click vs Drag)
        this.state.renderer.domElement.addEventListener('pointerup', (event) => {
            if (!this.mouseState.isDown) return;
            this.mouseState.isDown = false;

            // Calculate distance moved
            const moveX = Math.abs(event.clientX - this.mouseState.downX);
            const moveY = Math.abs(event.clientY - this.mouseState.downY);
            
            // If moved more than 3 pixels, treat as drag/rotate and ignore click
            const threshold = this.state.rsr.active ? 10 : 3;
            if (moveX > threshold || moveY > threshold) return;

            const rect = this.state.renderer.domElement.getBoundingClientRect();
            this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

            this.raycaster.setFromCamera(this.mouse, this.state.camera);
            const intersects = this.raycaster.intersectObjects(this.state.scene.children, true);

            // Middle click on empty space: recenter the orbit/view target and
            // the electron-density map on the plane through the current target,
            // so "center view" works even when no atom/map surface is hit.
            if (intersects.length === 0 && event.button === 1 && !this.state.rsr.active) {
                event.preventDefault();
                const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
                    this.state.camera.getWorldDirection(new THREE.Vector3()),
                    this.state.controls.target
                );
                const hit = new THREE.Vector3();
                if (this.raycaster.ray.intersectPlane(plane, hit)) {
                    this.centerViewAndMapOn(hit);
                }
                return;
            }

            if (intersects.length > 0) {
                // Find first mesh/instancedMesh
                const target = intersects.find(i => i.object.isMesh || i.object.isInstancedMesh);
                
                if (target) {
                    // --- Fragment Placement Mode ---
                    if (this.state.rsr.active && this.state.fragment.active && this.state.fragment.selectedId && !this.state.preview.active) {
                        let atomData = this.resolveHitAtom(target);
                        if (!atomData) {
                            const atomHit = intersects.find(i => this.resolveHitAtom(i));
                            if (atomHit) atomData = this.resolveHitAtom(atomHit);
                        }
                        document.body.style.cursor = 'wait';
                        this.placeFragment(atomData, event);
                        return;
                    }

                    // --- RSR Mode ---
                    if (this.state.rsr.active) {
                        // Find atomData from target or nearest hit
                        let atomData = this.resolveHitAtom(target);
                        if (!atomData) {
                            // If we hit something else (like a bond), try to find a nearby atom
                            const atomHit = intersects.find(i => this.resolveHitAtom(i));
                            if (atomHit) atomData = this.resolveHitAtom(atomHit);
                        }

                        if (atomData) {
                            if (!this.state.rsr.from) {
                                this.state.rsr.from = atomData;
                                // Highlight 'From' atom
                                this.state.moleculeRenderer.highlightAtoms(new Set([atomData.lineNumber || atomData.startLine]));
                                document.getElementById('status-bar-content').textContent = `RSR: Selected ${atomData.label}. Click 'To' atom.`;
                            } else {
                                this.state.rsr.to = atomData;
                                // Highlight both 'From' and 'To' atoms
                                const lines = new Set([
                                    this.state.rsr.from.lineNumber || this.state.rsr.from.startLine,
                                    atomData.lineNumber || atomData.startLine
                                ]);
                                this.state.moleculeRenderer.highlightAtoms(lines);
                                
                                // Show spinner and wait cursor
                                document.getElementById('rsr-progress').classList.remove('d-none');
                                document.body.style.cursor = 'wait';
                                document.getElementById('status-bar-content').textContent = `Refining segment ${this.state.rsr.from.label} to ${atomData.label}...`;
                                
                                setTimeout(() => {
                                    this.performRealSpaceRefinement().then(() => {
                                        document.body.style.cursor = 'default';
                                    });
                                }, 50);
                            }
                        }
                        return;
                    }

                    // Left Click: Scroll to Line or Select
                    if (event.button === 0) {
                        // Find the atom data: prefer the directly-hit atom mesh, otherwise fall
                        // back to the nearest atom hit (bonds/unit-cell meshes intercept rays too)
                        let atomData = this.resolveHitAtom(target);
                        if (!atomData) {
                            const atomHit = intersects.find(i => this.resolveHitAtom(i));
                            if (atomHit) atomData = this.resolveHitAtom(atomHit);
                        }
                        if (atomData && (atomData.lineNumber || atomData.startLine)) {
                                // Scroll RES editor if available
                                if (this.state.editors.res) {
                                    const editor = this.state.editors.res;
                                    const row = (atomData.startLine || atomData.lineNumber) - 1; // 0-based
                                    
                                    if (event.ctrlKey) {
                                        event.preventDefault();

                                        // Toggle selection
                                        const Range = ace.require('ace/range').Range;
                                        const doc = editor.getSession().getDocument();
                                        
                                        // Get all currently selected rows from Ace (source of truth for what is selected)
                                        const currentAceRows = new Set();
                                        const ranges = editor.selection.getAllRanges();
                                        ranges.forEach(r => {
                                            if (!r.isEmpty()) {
                                                for (let i = r.start.row; i <= r.end.row; i++) {
                                                    currentAceRows.add(i);
                                                }
                                            }
                                        });

                                        // Sync selectionOrder with Ace state
                                        // 1. Remove items from order that are no longer selected in Ace
                                        this.state.selectionOrder = this.state.selectionOrder.filter(r => currentAceRows.has(r));
                                        
                                        // 2. Add items from Ace that are missing in order (append them)
                                        currentAceRows.forEach(r => {
                                            if (!this.state.selectionOrder.includes(r)) {
                                                this.state.selectionOrder.push(r);
                                            }
                                        });
                                        
                                        // Toggle the clicked row(s)
                                        // If multi-line atom, we need to toggle all lines
                                        const startRow = (atomData.startLine || atomData.lineNumber) - 1;
                                        const endRow = (atomData.endLine || atomData.lineNumber) - 1;
                                        
                                        // Check if the first line is selected to determine toggle state
                                        const isSelected = this.state.selectionOrder.includes(startRow);
                                        
                                        for (let r = startRow; r <= endRow; r++) {
                                            const idx = this.state.selectionOrder.indexOf(r);
                                            if (isSelected) {
                                                if (idx !== -1) this.state.selectionOrder.splice(idx, 1); // Deselect
                                            } else {
                                                if (idx === -1) this.state.selectionOrder.push(r); // Select
                                            }
                                        }
                                        
                                        // Rebuild selection using fromJSON with plain objects based on selectionOrder
                                        const newRanges = [];
                                        this.state.selectionOrder.forEach(r => {
                                            const lineLength = doc.getLine(r).length;
                                            newRanges.push({
                                                start: {row: r, column: 0},
                                                end: {row: r, column: lineLength},
                                                isBackwards: false
                                            });
                                        });
                                        
                                        if (newRanges.length > 0) {
                                            editor.selection.fromJSON(newRanges);
                                        } else {
                                            editor.selection.clearSelection();
                                        }
                                        
                                        // Manually trigger highlight update since changeSelection might not fire or be delayed
                                        const selectedLines1Based = new Set();
                                        this.state.selectionOrder.forEach(r => selectedLines1Based.add(r + 1));
                                        this.state.moleculeRenderer.highlightAtoms(selectedLines1Based);
                                        this.updateStatusBar();
                                        
                                        editor.renderer.scrollCursorIntoView({row: row, column: 0}, 0.5);
                                    } else {
                                    // Normal click: select the atom's line range
                                    if (atomData.startLine && atomData.endLine) {
                                        // Select the range
                                        try {
                                            const Range = ace.require('ace/range').Range;
                                            const session = editor.getSession();
                                            const docLen = session.getLength();
                                            
                                            let startRow = atomData.startLine - 1;
                                            let endRow = atomData.endLine - 1;

                                            // Clamp
                                            if (startRow < 0) startRow = 0;
                                            if (endRow >= docLen) endRow = docLen - 1;
                                            
                                            if (startRow <= endRow) {
                                                // Select the range (triggers 3D highlight via changeSelection)
                                                editor.selection.setSelectionRange(new Range(startRow, 0, endRow, session.getLine(endRow).length));
                                                editor.scrollToLine(atomData.startLine, true, true, function(){});
                                            }
                                        } catch (err) {
                                            console.error("Navigation fail:", err);
                                            editor.gotoLine(atomData.startLine, 0, true);
                                        }
                                    } else {
                                        // Fallback for old data or single line
                                        const line = atomData.lineNumber || atomData.startLine;
                                        try {
                                            const Range = ace.require('ace/range').Range;
                                            const session = editor.getSession();
                                            editor.selection.setSelectionRange(new Range(line - 1, 0, line - 1, session.getLine(line - 1).length));
                                        } catch (e) {
                                            editor.gotoLine(line, 0, true);
                                        }
                                        editor.scrollToLine(line, true, true, function(){});
                                    }
                                    }
                                    editor.focus();
                                }
                            }
                    }
                    // Middle Click: Center View
                    else if (event.button === 1) { 
                        event.preventDefault();
                        const newTarget = new THREE.Vector3();

                        // Prefer the atom under the cursor. The semi-transparent
                        // density map (and its periodic images) is often the
                        // first ray hit; centering on that surface point would
                        // recenter the map a whole cell away from the model.
                        const atomHit = intersects.find(i =>
                            i.object.isInstancedMesh && i.object.userData.atomMap);
                        const hit = atomHit || target;

                        if (hit.object.isInstancedMesh) {
                            // Center on the clicked atom itself (sphere centre).
                            const matrix = new THREE.Matrix4();
                            hit.object.getMatrixAt(hit.instanceId, matrix);
                            newTarget.setFromMatrixPosition(matrix);
                            newTarget.applyMatrix4(hit.object.matrixWorld);
                        } else if (hit.point) {
                            // Non-instanced object (e.g. density-map surface):
                            // recenter exactly on the point that was clicked.
                            newTarget.copy(hit.point);
                        } else {
                            hit.object.getWorldPosition(newTarget);
                        }

                        this.centerViewAndMapOn(newTarget);
                    }
                }
            } else if (this.state.rsr.active && this.state.fragment.active && this.state.fragment.selectedId && !this.state.preview.active) {
                // Click in empty space while in fragment placement mode
                document.body.style.cursor = 'wait';
                this.placeFragment(null, event);
            }
        });

        // --- Edit Menu Wiring ---
        const bindMenu = (id, command) => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    
                    // Check if it's a class method first
                    if (typeof this[command] === 'function') {
                        this[command]();
                        return;
                    }

                    const editor = this.state.editors.res;
                    if (editor) {
                        editor.focus();
                        if (command === 'copy') {
                            const text = editor.getCopyText();
                            if (text) navigator.clipboard.writeText(text);
                        } else if (command === 'cut') {
                            const text = editor.getCopyText();
                            if (text) {
                                navigator.clipboard.writeText(text);
                                editor.execCommand('cut');
                            }
                        } else if (command === 'paste') {
                            navigator.clipboard.readText().then(text => {
                                if (text) editor.onPaste(text);
                            }).catch(err => {
                                console.error('Failed to read clipboard', err);
                                editor.execCommand('paste', e.clipboardData ? e.clipboardData.getData('text/plain') : null);
                            });
                        } else {
                            editor.execCommand(command);
                        }
                    }
                });
            }
        };

        // Standard
        bindMenu('menu-cut', 'cut'); // Note: might not work due to browser security
        bindMenu('menu-copy', 'copy');
        bindMenu('menu-paste', 'paste');
        bindMenu('menu-delete', 'del'); // 'del' is Ace command for delete
        bindMenu('menu-select-all', 'selectall');
        bindMenu('menu-search', 'find');
        bindMenu('tool-search', 'find'); // Toolbar

        // Custom Edit
        bindMenu('menu-duplicate', 'duplicate');
        bindMenu('menu-add-trailer', 'addTrailer');
        bindMenu('menu-relabel', 'relabelAtoms');
        bindMenu('tool-relabel', 'relabelAtoms'); // Toolbar
        bindMenu('menu-cluster', 'clusterMolecules');
        bindMenu('tool-cluster', 'clusterMolecules'); // Toolbar
        bindMenu('menu-autohfix', 'autoHfix');
        bindMenu('menu-comment', 'toggleComment');

        // Kill Commands
        bindMenu('menu-kill-q', 'killQ');
        bindMenu('tool-kill-q', 'killQ'); // Toolbar
        bindMenu('menu-kill-h', 'killH');
        bindMenu('tool-kill-h', 'killH'); // Toolbar
        bindMenu('menu-kill-htab', 'killHTAB');
        bindMenu('menu-kill-mol', 'killMOLE');
        bindMenu('menu-kill-resi', 'killRESI');

        // Options Menu
        bindMenu('menu-formula', 'getFormula');
        bindMenu('menu-correct-formula', 'correctFormula');
        bindMenu('menu-isotropic', 'makeIsotropic');
        bindMenu('menu-change-uiso', 'changeUiso');
        bindMenu('menu-change-occ', 'changeOccupancy');
        bindMenu('menu-omit', 'omitError');
        bindMenu('menu-disp', 'calcDisp');
        bindMenu('menu-absorb', 'openAbsorptionDialog');
        bindMenu('menu-hfix', 'addHFIX');
        bindMenu('menu-sort', 'sortAtoms');
        bindMenu('tool-sort', 'sortAtoms'); // Toolbar
        bindMenu('menu-duplicates', 'findDuplicates');
        bindMenu('menu-q-to-c', 'qToC');
        bindMenu('menu-rsr', 'toggleRSR');
        bindMenu('tool-rsr', 'toggleRSR');

        // Disorder menu (apply automatic restraints to selected atoms)
        bindMenu('menu-disorder-simu', 'disorderSimu');
        bindMenu('menu-disorder-delu', 'disorderDelu');
        bindMenu('menu-disorder-flat', 'disorderFlat');
        bindMenu('menu-disorder-isor', 'disorderIsor');
        bindMenu('menu-disorder-eadp', 'disorderEadp');
        bindMenu('menu-disorder-sadi-bonds', 'disorderSadiBonds');
        bindMenu('menu-disorder-sadi-angles', 'disorderSadiAngles');
        bindMenu('menu-disorder-clear', 'clearDisorderRestraints');

        // Clipping Plane Control (Ctrl + Scroll)
        this.state.renderer.domElement.addEventListener('wheel', (event) => {
            if (event.ctrlKey) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation(); // Stop OrbitControls
                
                const delta = event.deltaY * 0.05; // Sensitivity
                const camera = this.state.camera;
                
                // Adjusting near plane
                let newNear = camera.near + delta;
                
                // Safety clamps
                if (camera.isOrthographicCamera) {
                     if (newNear < camera.far - 1) {
                         camera.near = newNear;
                     }
                } else {
                    if (newNear > 0.1 && newNear < camera.far - 1) {
                        camera.near = newNear;
                    }
                }
                
                camera.updateProjectionMatrix();
                console.log(`Clipping Plane (Near): ${camera.near.toFixed(2)}`);
            }
        }, { capture: true, passive: false });
    }

    switchCamera() {
        const container = document.getElementById('three-container');
        const oldCamera = this.state.camera;
        
        if (this.state.viewSettings.orthographic) {
            this.state.camera = this.state.cameras.orthographic;
        } else {
            this.state.camera = this.state.cameras.perspective;
        }
        
        // Copy position/rotation to maintain view
        this.state.camera.position.copy(oldCamera.position);
        this.state.camera.quaternion.copy(oldCamera.quaternion);
        this.state.camera.zoom = oldCamera.zoom; // Might need adjustment
        
        // Update controls
        this.state.controls.object = this.state.camera;
        this.state.controls.update();
        
        this.onWindowResize(); // Ensure projection is correct
    }

    onWindowResize() {
        const container = document.getElementById('three-container');

        // Ace editors must always be resized, even when the 3D pane is hidden
        // (e.g. while the CIF/LST/static panes are displayed) so the last lines
        // of text stay visible and scrollable inside the container.
        if (this.state.editors.res) this.state.editors.res.resize();
        if (this.state.editors.cif) this.state.editors.cif.resize();
        if (this.state.editors.lst) this.state.editors.lst.resize();
        if (this.state.fileTabs) {
            Object.values(this.state.fileTabs).forEach(t => t.editor && t.editor.resize());
        }

        // Only resize the renderer/camera when the 3D view is actually visible.
        if (!container || !this.state.camera || !this.state.renderer) return;
        if (container.clientWidth === 0 || container.clientHeight === 0) return;

        const aspect = container.clientWidth / container.clientHeight;
        
        if (this.state.camera.isPerspectiveCamera) {
            this.state.camera.aspect = aspect;
            this.state.camera.updateProjectionMatrix();
        } else {
            const frustumSize = 40; // Match initial setup roughly
            this.state.camera.left = -frustumSize * aspect / 2;
            this.state.camera.right = frustumSize * aspect / 2;
            this.state.camera.top = frustumSize / 2;
            this.state.camera.bottom = -frustumSize / 2;
            this.state.camera.updateProjectionMatrix();
        }
        
        this.state.renderer.setSize(container.clientWidth, container.clientHeight);
    }

    deselectAll() {
        console.log("deselectAll called");
        // Clear internal selection state
        this.state.selectionOrder = [];
        
        // Clear editor selection
        if (this.state.editors.res) {
            console.log("Clearing editor selection");
            this.state.editors.res.selection.clearSelection();
            this.state.editors.res.moveCursorTo(0, 0);
        }
        
        // Clear 3D highlights
        if (this.state.moleculeRenderer) {
            this.state.moleculeRenderer.clearHighlights();
        }
        
        // Update status bar
        this.updateStatusBar();
    }

    updateStatusBar() {
        const statusEl = document.getElementById('status-bar-content');
        if (!statusEl) return;

        const selection = this.state.selectionOrder;
        console.log("updateStatusBar: selection", selection);
        console.log("updateStatusBar: parsedData", this.state.parsedData);
        
        if (selection.length === 0) {
            statusEl.textContent = "Ready";
        } else {
            // Map selected lines to atoms
            const selectedAtoms = new Set();
            if (this.state.parsedData && this.state.parsedData.atoms) {
                selection.forEach(row => {
                    const lineNum = row + 1;
                    const atom = this.state.parsedData.atoms.find(a => {
                        if (a.startLine && a.endLine) {
                            return lineNum >= a.startLine && lineNum <= a.endLine;
                        }
                        return a.lineNumber === lineNum;
                    });
                    if (atom) selectedAtoms.add(atom);
                });
            }

            const uniqueAtoms = Array.from(selectedAtoms);

            if (uniqueAtoms.length === 1) {
                const atom = uniqueAtoms[0];
                statusEl.textContent = `Selected: ${atom.label} (${atom.element})`;
            } else if (uniqueAtoms.length === 2) {
                const a1 = uniqueAtoms[0];
                const a2 = uniqueAtoms[1];
                const dist = this.calculateDistance(a1, a2, this.state.parsedData.cell);
                if (dist !== null) {
                    statusEl.textContent = `Distance ${a1.label}-${a2.label}: ${dist.toFixed(4)} Å`;
                } else {
                    statusEl.textContent = `Selected: ${a1.label}, ${a2.label}`;
                }
            } else {
                statusEl.textContent = `${uniqueAtoms.length} atoms selected`;
            }
        }

    }

    calculateDistance(atom1, atom2, cell) {
        const { a, b, c, alpha, beta, gamma } = cell;
        const toRad = Math.PI / 180;
        const al = alpha * toRad;
        const be = beta * toRad;
        const ga = gamma * toRad;

        const cosAl = Math.cos(al);
        const cosBe = Math.cos(be);
        const cosGa = Math.cos(ga);
        const sinGa = Math.sin(ga);

        const V = a * b * c * Math.sqrt(1 - cosAl*cosAl - cosBe*cosBe - cosGa*cosGa + 2*cosAl*cosBe*cosGa);

        // Orthogonalization Matrix
        const m11 = a;
        const m12 = b * cosGa;
        const m13 = c * cosBe;
        const m22 = b * sinGa;
        const m23 = c * (cosAl - cosBe * cosGa) / sinGa;
        const m33 = V / (a * b * sinGa);

        const x1 = m11 * atom1.x + m12 * atom1.y + m13 * atom1.z;
        const y1 = m22 * atom1.y + m23 * atom1.z;
        const z1 = m33 * atom1.z;

        const x2 = m11 * atom2.x + m12 * atom2.y + m13 * atom2.z;
        const y2 = m22 * atom2.y + m23 * atom2.z;
        const z2 = m33 * atom2.z;

        const dx = x1 - x2;
        const dy = y1 - y2;
        const dz = z1 - z2;

        return Math.sqrt(dx*dx + dy*dy + dz*dz);
    }

    setupFileHandling() {
        const fileInput = document.getElementById('file-input');
        
        // Menu Open
        const toolServerOpen = document.getElementById('tool-server-open');
        if (toolServerOpen) toolServerOpen.addEventListener('click', () => this.openProjectManager());

        const btnRefreshProjects = document.getElementById('btn-refresh-projects');
        if (btnRefreshProjects) btnRefreshProjects.addEventListener('click', () => this.openProjectManager());

        const menuOpen = document.getElementById('menu-open');
        if (menuOpen) menuOpen.addEventListener('click', () => fileInput.click());

        // Toolbar Open
        const toolOpen = document.getElementById('tool-open');
        if (toolOpen) toolOpen.addEventListener('click', () => fileInput.click());

        // HKL/FCF Load Handling
        const menuLoadHkl = document.getElementById('menu-load-hkl');
        if (menuLoadHkl) menuLoadHkl.addEventListener('click', () => document.getElementById('hkl-input').click());
        
        const menuLoadFcf = document.getElementById('menu-load-fcf');
        if (menuLoadFcf) menuLoadFcf.addEventListener('click', () => fileInput.click());

        const hklInput = document.getElementById('hkl-input');

        hklInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            // HKL reflection data is consumed server-side by SHELX/PLATON, so it
            // is uploaded straight into a project and only referenced client-side.
            const ok = await this.loadLocalHklFile(file);
            if (ok) {
                console.log("HKL file uploaded:", file.name);
                this.refreshHklStatus();
                alert("HKL uploaded to server project '" + (this.state.hklServerProject || '?') + "'.");
            } else {
                alert("Could not upload the HKL file to the server. Is the backend running?");
            }
        });

        // Save Handling
        const handleSave = () => {
            // If a file tab is active, save that file's content
            const activeTab = document.querySelector('.nav-link.active');
            if (activeTab && activeTab.id.startsWith('tab-file-')) {
                const tab = this.state.fileTabs[activeTab.id.replace('tab-file-', '')];
                if (!tab) return;
                const blob = new Blob([tab.editor.getValue()], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = tab.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                return;
            }

            if (!this.state.loadedContent) return;
            
            // Get current content from active editor or loaded content
            let content = "";
            if (this.state.loadedType === 'res') {
                // Check if editor has the current file loaded
                if (this.state.editors.res && this.state.editors.res.fileId === this.state.fileId) {
                    content = this.state.editors.res.getValue();
                } else {
                    content = this.state.loadedContent;
                }
            } else if (this.state.loadedType === 'cif') {
                if (this.state.editors.cif && this.state.editors.cif.fileId === this.state.fileId) {
                    content = this.state.editors.cif.getValue();
                } else {
                    content = this.state.loadedContent;
                }
            }

            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            // Use original filename if available, otherwise default
            a.download = this.state.loadedFilename || ('structure.' + this.state.loadedType);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        };

        const menuSave = document.getElementById('menu-save');
        if (menuSave) menuSave.addEventListener('click', handleSave);

        const toolSave = document.getElementById('tool-save');
        if (toolSave) toolSave.addEventListener('click', handleSave);

        fileInput.addEventListener('change', async (e) => {
            console.log("File input changed");
            const files = Array.from(e.target.files);
            if (files.length === 0) return;

            // Structure files: pick the best one to drive the split RES editor.
            // Prefer SHELX .res/.ins over CIF/PDB (and .res over .ins) so that
            // loading a project folder that contains e.g. x.cif, x.res and x.ins
            // fills the RES editor with the real model instead of leaving the
            // startup "Example RES" in place.
            const structureFiles = files.filter(f => {
                const n = f.name.toLowerCase();
                return n.endsWith('.res') || n.endsWith('.ins') || n.endsWith('.cif')
                    || n.endsWith('.mmcif') || n.endsWith('.pdb');
            });
            const rank = f => {
                const n = f.name.toLowerCase();
                if (n.endsWith('.res')) return 0;
                if (n.endsWith('.ins')) return 1;
                if (n.endsWith('.cif') || n.endsWith('.mmcif')) return 2;
                return 3; // .pdb
            };
            structureFiles.sort((a, b) => rank(a) - rank(b));
            const hklFiles = files.filter(f => f.name.toLowerCase().endsWith('.hkl'));
            const fcfFiles = files.filter(f => f.name.toLowerCase().endsWith('.fcf'));
            const fabFiles = files.filter(f => f.name.toLowerCase().endsWith('.fab'));

            // Process structure first
            if (structureFiles.length > 0) {
                const file = structureFiles[0];
                const content = await file.text();
                
                this.state.loadedContent = content;
                this.state.loadedFilename = file.name;
                this.state.fileId++;
                // A freshly loaded structure is authoritative; stop preferring a
                // previously shown file tab for "run program on current file".
                this.state.lastStructureTabKey = null;

                const ext = file.name.split('.').pop().toLowerCase();
                this.state.loadedType = (ext === 'ins' || ext === 'res')
                    ? 'res'
                    : (ext === 'mmcif' ? 'cif' : ext);
                
                this.renderContent(content, this.state.loadedType);
                this.resetView();

                // Populate editor
                const editor = this.state.editors[this.state.loadedType];
                if (editor) {
                    this.setEditorValueProgrammatic(editor, this.truncateContent(content));
                    editor.loadedFile = content;
                    editor.fileId = this.state.fileId;
                }

                // Switch to the appropriate tab
                if (this.state.loadedType === 'cif') {
                    this.switchToTab('tab-cif');
                } else if (this.state.loadedType === 'pdb') {
                    this.openFileTab(file.name, content, 'pdb', null, false);
                    this.switchToTab('tab-split');
                } else {
                    this.switchToTab('tab-split');
                }
            }

            // Process HKL: upload the reflection data server-side; the browser
            // never holds (or localStorage-persists) the full HKL content.
            if (hklFiles.length > 0) {
                const file = hklFiles[0];
                const ok = await this.loadLocalHklFile(file);
                if (!ok) {
                    alert("HKL file could not be uploaded to the server: " + file.name);
                } else {
                    console.log("HKL file uploaded:", file.name);
                }
            }

            // Process FCF: read only to draw the electron-density map client-side
            // (it is a static companion file - never opened in a text tab).
            if (fcfFiles.length > 0) {
                const file = fcfFiles[0];
                const content = await file.text();
                this.renderMap(content);
            }

            // Process FAB (SQUEEZE solvent mask): SHELXL reads <basename>.fab
            // next to the .ins, so upload it into the project directory.
            if (fabFiles.length > 0) {
                const file = fabFiles[0];
                const project = await this.uploadLocalProjectCompanion(file, '.fab');
                if (!project) {
                    alert("FAB file could not be uploaded to the server: " + file.name);
                } else {
                    console.log("FAB file uploaded:", file.name, '->', project);
                }
            }

            this.saveStateToLocalStorage();
        });
    }

    handleFcfFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const content = e.target.result;
            this.renderMap(content);
        };
        reader.readAsText(file);
    }

    // Draw the density surface the way Coot does: a single blue surface for
    // 2Fo-Fc/Fo, and separate green (+) / red (-) surfaces for a Fo-Fc
    // difference map.
    renderDensitySurface(mapData, mapCell, level, radius, bounds, centerFrac) {
        if (!this.state.densityRenderer) return;
        const type = (document.getElementById('map-type') || {}).value || '2Fo-Fc';
        let color = new THREE.Color(this.state.preferences.map.color);
        const options = {};
        if (type === 'Fo-Fc') {
            color = new THREE.Color(0x00cc00);          // positive difference density
            options.negativeLevel = -Math.abs(level);   // negative difference density
            options.negativeColor = 0xff0000;
        }
        this.state.densityRenderer.render(mapData, mapCell, level, color, bounds, centerFrac, radius, options);
    }

    renderMap(content) {
        this.state.fcfRawContent = content;
        this.state.mapFocusFrac = null;
        this.saveStateToLocalStorage();
        try {
            const fcfData = this.state.parsers.fcf.parse(content);

            if (!this.state.parsedData || !this.state.parsedData.atoms) {
                alert("Please load a structure (RES/CIF) first to calculate phases.");
                return;
            }

            const cell = this.state.parsedData.cell; 
            const mapCell = (cell && cell.a) ? cell : fcfData.cell;

            // Phase calculation needs the FULL unit-cell content, not just the
            // asymmetric unit, and must not depend on whether the unit cell is
            // currently drawn. Expand the model with the FCF (or model) symmetry
            // operators so every symmetry mate contributes to the structure
            // factors; otherwise the phases are wrong and the map looks
            // dispersed instead of sitting on the atoms.
            const symOps = (fcfData.symmetry && fcfData.symmetry.length)
                ? fcfData.symmetry
                : ((this.state.parsedData.symmetry && this.state.parsedData.symmetry.length)
                    ? this.state.parsedData.symmetry
                    : null);
            let phaseAtoms = this.state.parsedData.atoms;
            if (symOps) {
                phaseAtoms = Symmetry.generateEquivalentPositions(this.state.parsedData.atoms, symOps, true);
            } else if (this.state.moleculeRenderer && this.state.moleculeRenderer.expandedAtoms) {
                // No symmetry available: fall back to the renderer's atom list.
                const exp = this.state.moleculeRenderer.expandedAtoms;
                const seen = new Set();
                phaseAtoms = [];
                exp.forEach(a => {
                    const key = `${a.x.toFixed(4)},${a.y.toFixed(4)},${a.z.toFixed(4)},${a.element}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        phaseAtoms.push(a);
                    }
                });
            }
            
            // FCF files hold only the unique reflections. Expand them over the
            // Laue group so the Fourier synthesis spans the full reciprocal
            // lattice (otherwise the map uses ~1/8 of the data and looks
            // dispersed instead of showing compact peaks at the atoms).
            // Compute the model phases on the UNIQUE reflections only (up to a
            // symmetry-factor fewer atom*reflection pairs), then expand over the
            // space group and Friedel mates with the correct phase propagation.
            console.time('[map] calculateStructureFactors');
            this.state.mapCalculator.calculateStructureFactors(phaseAtoms, fcfData.reflections, mapCell);
            console.timeEnd('[map] calculateStructureFactors');

            console.time('[map] expandReflections');
            const allReflections = this.state.mapCalculator.expandReflectionsWithPhases(
                fcfData.reflections, symOps);
            console.timeEnd('[map] expandReflections');
            console.log(`[map] phaseAtoms=${phaseAtoms.length}, unique=${fcfData.reflections.length}, expanded=${allReflections.length}, symOps=${symOps ? symOps.length : 0}`);
            
            // Calculate Map
            const level = parseFloat(document.getElementById('map-level').value) || 1.0;
            const radius = parseFloat(document.getElementById('map-radius').value) || 4.0;
            const type = document.getElementById('map-type').value || '2Fo-Fc';
            
            this.state.currentMapData = { reflections: allReflections, cell: mapCell }; // Store for updates
            
            console.time('[map] calculateMap');
            const mapData = this.state.mapCalculator.calculateMap(allReflections, mapCell, this.state.preferences.map.resolution, type); 
            this.state.cachedMapData = mapData; // Cache for RSR
            console.timeEnd('[map] calculateMap');
            console.log(`[map] type=${type} grid=${mapData.nx}x${mapData.ny}x${mapData.nz} min=${mapData.min.toFixed(2)} max=${mapData.max.toFixed(2)}`);
        
        // Calculate Center (Cartesian) and Bounds
        const displayAtoms = this.state.moleculeRenderer && this.state.moleculeRenderer.expandedAtoms 
                             ? this.state.moleculeRenderer.expandedAtoms 
                             : atoms;
        
        // 1. Calculate Cartesian Bounds of Atoms
        // We need the orthogonalization matrix to convert atoms to Cartesian
        const d2r = Math.PI / 180.0;
        const a = mapCell.a;
        const b = mapCell.b;
        const c = mapCell.c;
        const alpha = mapCell.alpha * d2r;
        const beta = mapCell.beta * d2r;
        const gamma = mapCell.gamma * d2r;
        
        const v = Math.sqrt(1 - Math.cos(alpha)**2 - Math.cos(beta)**2 - Math.cos(gamma)**2 + 2*Math.cos(alpha)*Math.cos(beta)*Math.cos(gamma));
        
        const m11 = a;
        const m12 = b * Math.cos(gamma);
        const m13 = c * Math.cos(beta);
        
        const m21 = 0;
        const m22 = b * Math.sin(gamma);
        const m23 = c * (Math.cos(alpha) - Math.cos(beta)*Math.cos(gamma)) / Math.sin(gamma);
        
        const m31 = 0;
        const m32 = 0;
        const m33 = c * v / Math.sin(gamma);
        
        const fracToCartMatrix = new THREE.Matrix4().set(
            m11, m12, m13, 0,
            m21, m22, m23, 0,
            m31, m32, m33, 0,
            0,   0,   0,   1
        );
        
        const cartToFracMatrix = new THREE.Matrix4().copy(fracToCartMatrix).invert();
        
        let minCart = new THREE.Vector3(Infinity, Infinity, Infinity);
        let maxCart = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
        
        const vec = new THREE.Vector3();
        
        displayAtoms.forEach(atom => {
            vec.set(atom.x, atom.y, atom.z);
            vec.applyMatrix4(fracToCartMatrix);
            minCart.min(vec);
            maxCart.max(vec);
        });
        
        // Cartesian Center
        const centerCart = new THREE.Vector3().addVectors(minCart, maxCart).multiplyScalar(0.5);
        
        // 2. Define Sphere Box in Cartesian
        const r = radius;
        const boxMinCart = { x: centerCart.x - r, y: centerCart.y - r, z: centerCart.z - r };
        const boxMaxCart = { x: centerCart.x + r, y: centerCart.y + r, z: centerCart.z + r };
        
        // 3. Convert Box Corners to Fractional to find Fractional Bounds
        // Invert Matrix
        const det = m11 * (m22 * m33 - m23 * m32) - m12 * (m21 * m33 - m23 * m31) + m13 * (m21 * m32 - m22 * m31);
        const invDet = 1 / det;
        
        const i11 = (m22 * m33 - m23 * m32) * invDet;
        const i12 = (m13 * m32 - m12 * m33) * invDet;
        const i13 = (m12 * m23 - m13 * m22) * invDet;
        
        const i21 = (m23 * m31 - m21 * m33) * invDet;
        const i22 = (m11 * m33 - m13 * m31) * invDet;
        const i23 = (m13 * m21 - m11 * m23) * invDet;
        
        const i31 = (m21 * m32 - m22 * m31) * invDet;
        const i32 = (m12 * m31 - m11 * m32) * invDet;
        const i33 = (m11 * m22 - m12 * m21) * invDet;
        
        const cartToFrac = (x, y, z) => {
            return {
                x: i11 * x + i12 * y + i13 * z,
                y: i21 * x + i22 * y + i23 * z,
                z: i31 * x + i32 * y + i33 * z
            };
        };
        
        const corners = [
            { x: boxMinCart.x, y: boxMinCart.y, z: boxMinCart.z },
            { x: boxMaxCart.x, y: boxMinCart.y, z: boxMinCart.z },
            { x: boxMinCart.x, y: boxMaxCart.y, z: boxMinCart.z },
            { x: boxMaxCart.x, y: boxMaxCart.y, z: boxMinCart.z },
            { x: boxMinCart.x, y: boxMinCart.y, z: boxMaxCart.z },
            { x: boxMaxCart.x, y: boxMinCart.y, z: boxMaxCart.z },
            { x: boxMinCart.x, y: boxMaxCart.y, z: boxMaxCart.z },
            { x: boxMaxCart.x, y: boxMaxCart.y, z: boxMaxCart.z }
        ];
        
        let minFrac = { x: Infinity, y: Infinity, z: Infinity };
        let maxFrac = { x: -Infinity, y: -Infinity, z: -Infinity };
        
        corners.forEach(c => {
            const f = cartToFrac(c.x, c.y, c.z);
            if (f.x < minFrac.x) minFrac.x = f.x;
            if (f.y < minFrac.y) minFrac.y = f.y;
            if (f.z < minFrac.z) minFrac.z = f.z;
            if (f.x > maxFrac.x) maxFrac.x = f.x;
            if (f.y > maxFrac.y) maxFrac.y = f.y;
            if (f.z > maxFrac.z) maxFrac.z = f.z;
        });
        
        const bounds = { min: minFrac, max: maxFrac };
        const centerFrac = cartToFrac(centerCart.x, centerCart.y, centerCart.z);
        
        this.state.currentMapBounds = bounds;
        this.state.currentMapCenter = centerFrac;
        this.state.currentMapRadius = radius;

        // Render only if the user opted to show maps automatically
        if (this.state.preferences.map.autoShow) {
            this.renderDensitySurface(mapData, mapCell, level, radius, bounds, centerFrac);
            const btn = document.getElementById('tool-map-toggle');
            if (btn) {
                btn.classList.add('active');
                btn.setAttribute('aria-pressed', 'true');
            }
        } else {
            // Map loaded but hidden by default; ensure toggle is off
            const btn = document.getElementById('tool-map-toggle');
            if (btn) {
                btn.classList.remove('active');
                btn.setAttribute('aria-pressed', 'false');
            }
        }
            
        } catch (e) {
            console.error("Map error:", e);
            alert("Error rendering map: " + e.message);
        }
    }

    setupMapControls() {
        const typeSelect = document.getElementById('map-type');
        const styleSelect = document.getElementById('map-style');
        const levelInput = document.getElementById('map-level');
        const radiusInput = document.getElementById('map-radius');
        const opacityInput = document.getElementById('map-opacity');
        const toggleBtn = document.getElementById('tool-map-toggle');

        const updateMap = () => {
             if (this.state.currentMapData && this.state.densityRenderer && toggleBtn.classList.contains('active')) {
                 const level = parseFloat(levelInput.value) || 1.0;
                 const radius = parseFloat(radiusInput.value) || 4.0;
                 const type = typeSelect.value;
                 const resolution = this.state.preferences.map.resolution;
                 
                 let needsRecalc = false;
                 
                 if (this.state.lastMapType !== type || this.state.lastMapResolution !== resolution) {
                     needsRecalc = true;
                     this.state.lastMapType = type;
                     this.state.lastMapResolution = resolution;
                 }
                 
                 if (needsRecalc) {
                     const mapData = this.state.mapCalculator.calculateMap(
                         this.state.currentMapData.reflections, 
                         this.state.currentMapData.cell, 
                         resolution, 
                         type
                     );
                     this.state.cachedMapData = mapData;
                 }
                 
                 if (!this.state.cachedMapData && !needsRecalc) {
                      this.state.cachedMapData = this.state.mapCalculator.calculateMap(
                         this.state.currentMapData.reflections, 
                         this.state.currentMapData.cell, 
                         resolution, 
                         type
                     );
                 }
                 
                 // Re-calculate bounds and center
                 const atoms = this.state.moleculeRenderer && this.state.moleculeRenderer.expandedAtoms 
                               ? this.state.moleculeRenderer.expandedAtoms 
                               : this.state.parsedData.atoms;
                 const mapCell = this.state.currentMapData.cell;
                 
                 // 1. Calculate Cartesian Bounds of Atoms
                 const d2r = Math.PI / 180.0;
                 const a = mapCell.a;
                 const b = mapCell.b;
                 const c = mapCell.c;
                 const alpha = mapCell.alpha * d2r;
                 const beta = mapCell.beta * d2r;
                 const gamma = mapCell.gamma * d2r;
                 
                 const v = Math.sqrt(1 - Math.cos(alpha)**2 - Math.cos(beta)**2 - Math.cos(gamma)**2 + 2*Math.cos(alpha)*Math.cos(beta)*Math.cos(gamma));
                 
                 const m11 = a;
                 const m12 = b * Math.cos(gamma);
                 const m13 = c * Math.cos(beta);
                 const m21 = 0;
                 const m22 = b * Math.sin(gamma);
                 const m23 = c * (Math.cos(alpha) - Math.cos(beta)*Math.cos(gamma)) / Math.sin(gamma);
                 const m31 = 0;
                 const m32 = 0;
                 const m33 = c * v / Math.sin(gamma);
                 
                 const fracToCartMatrix = new THREE.Matrix4().set(
                     m11, m12, m13, 0,
                     m21, m22, m23, 0,
                     m31, m32, m33, 0,
                     0,   0,   0,   1
                 );
                 
                 const cartToFracMatrix = new THREE.Matrix4().copy(fracToCartMatrix).invert();
                 
                 let centerCart;
                 if (this.state.mapFocusFrac) {
                     centerCart = new THREE.Vector3(
                         this.state.mapFocusFrac.x,
                         this.state.mapFocusFrac.y,
                         this.state.mapFocusFrac.z
                     ).applyMatrix4(fracToCartMatrix);
                 } else {
                     let minCart = new THREE.Vector3(Infinity, Infinity, Infinity);
                     let maxCart = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
                     
                     const vec = new THREE.Vector3();
                     
                     atoms.forEach(atom => {
                         vec.set(atom.x, atom.y, atom.z);
                         vec.applyMatrix4(fracToCartMatrix);
                         minCart.min(vec);
                         maxCart.max(vec);
                     });
                     
                     centerCart = new THREE.Vector3().addVectors(minCart, maxCart).multiplyScalar(0.5);
                 }
                 
                 const r = radius;
                 // Define box corners in Cartesian
                 const cornersCart = [
                     new THREE.Vector3(centerCart.x - r, centerCart.y - r, centerCart.z - r),
                     new THREE.Vector3(centerCart.x + r, centerCart.y - r, centerCart.z - r),
                     new THREE.Vector3(centerCart.x - r, centerCart.y + r, centerCart.z - r),
                     new THREE.Vector3(centerCart.x + r, centerCart.y + r, centerCart.z - r),
                     new THREE.Vector3(centerCart.x - r, centerCart.y - r, centerCart.z + r),
                     new THREE.Vector3(centerCart.x + r, centerCart.y - r, centerCart.z + r),
                     new THREE.Vector3(centerCart.x - r, centerCart.y + r, centerCart.z + r),
                     new THREE.Vector3(centerCart.x + r, centerCart.y + r, centerCart.z + r)
                 ];
                 
                 let minFrac = new THREE.Vector3(Infinity, Infinity, Infinity);
                 let maxFrac = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
                 
                 cornersCart.forEach(c => {
                     const f = c.clone().applyMatrix4(cartToFracMatrix);
                     minFrac.min(f);
                     maxFrac.max(f);
                 });
                 
                 const bounds = { min: minFrac, max: maxFrac };
                 const centerFrac = centerCart.clone().applyMatrix4(cartToFracMatrix);
                 
                 this.state.currentMapBounds = bounds;
                 this.state.currentMapCenter = centerFrac;
                 this.state.currentMapRadius = radius;
                 
                 this.renderDensitySurface(this.state.cachedMapData, mapCell, level, radius, bounds, centerFrac);
             }
        };

        if (typeSelect) typeSelect.addEventListener('change', updateMap);
        if (levelInput) levelInput.addEventListener('change', updateMap);
        if (radiusInput) radiusInput.addEventListener('change', updateMap);

        // Style switch only swaps the material - no need to re-march the surface
        if (styleSelect) {
            styleSelect.addEventListener('change', () => {
                const style = styleSelect.value;
                this.state.preferences.map.style = style;
                if (this.state.densityRenderer) {
                    this.state.densityRenderer.setStyle(style);
                }
                this.savePreferences();
            });
        }

        // Opacity only tweaks the materials - no re-marching either
        if (opacityInput) {
            opacityInput.addEventListener('input', () => {
                let opacity = parseFloat(opacityInput.value);
                if (!isFinite(opacity)) opacity = 0.4;
                opacity = Math.min(1, Math.max(0, opacity));
                opacityInput.value = opacity;
                this.state.preferences.map.opacity = opacity;
                if (this.state.densityRenderer) {
                    this.state.densityRenderer.setOpacity(opacity);
                }
                this.savePreferences();
            });
        }
        
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                if (toggleBtn.classList.contains('active')) {
                    toggleBtn.classList.remove('active');
                    toggleBtn.setAttribute('aria-pressed', 'false');
                    if (this.state.densityRenderer) {
                        this.state.densityRenderer.setVisible(false);
                    }
                } else {
                    if (!this.state.currentMapData) {
                        alert("No FCF map data loaded. Please open an FCF file first.");
                        // Optional: Trigger file open?
                        // document.getElementById('file-input').click();
                        return;
                    }
                    
                    toggleBtn.classList.add('active');
                    toggleBtn.setAttribute('aria-pressed', 'true');
                    
                    if (!this.state.cachedMapData) {
                        updateMap();
                    } else if (this.state.densityRenderer && this.state.densityRenderer.mesh) {
                        this.state.densityRenderer.setVisible(true);
                    } else {
                        updateMap();
                    }
                }
            });
        }
    }

    // ========== FRAGMENT PLACEMENT ==========

    // Move the orbit/view target (and thus the whole scene's "centre of
    // gravity") to `point`, then recenter the electron-density map to the same
    // point so both move together on a middle click.
    centerViewAndMapOn(point) {
        if (!point || !this.state.controls) return;
        const currentTarget = this.state.controls.target.clone();
        const delta = new THREE.Vector3().subVectors(point, currentTarget);

        this.state.camera.position.add(delta);
        this.state.controls.target.copy(point);
        this.state.controls.update();

        this.recenterMapToWorldPoint(point);
    }

    // Recenter the electron-density map so its centre is the given point in
    // world coordinates. Works for clicks on atoms, on the map surface or in
    // empty space: both the orbit/view target and the map move together.
    recenterMapToWorldPoint(worldPoint) {
        if (!this.state.currentMapData || !this.state.densityRenderer) return;
        // The cache is invalidated whenever the structure editor re-renders
        // (e.g. the delayed re-render after loading a project). Recompute it
        // here, matching the other map paths, so recentering still works.
        if (!this.state.cachedMapData) {
            const type = (document.getElementById('map-type') || {}).value || '2Fo-Fc';
            this.state.cachedMapData = this.state.mapCalculator.calculateMap(
                this.state.currentMapData.reflections,
                this.state.currentMapData.cell,
                this.state.preferences.map.resolution,
                type
            );
        }

        const mapCell = this.state.currentMapData.cell;
        const radius = parseFloat(document.getElementById('map-radius').value) || this.state.currentMapRadius || 4.0;
        const level = parseFloat(document.getElementById('map-level').value) || 1.0;

        // The molecule + map are children of moleculeRenderer.group, which is
        // translated by -center so the whole structure sits at the origin.
        // Recover the map-cell Cartesian frame position of the clicked point.
        let offset = new THREE.Vector3();
        if (this.state.moleculeRenderer && this.state.moleculeRenderer.group) {
            offset.copy(this.state.moleculeRenderer.group.position);
        }
        const cx = worldPoint.x - offset.x;
        const cy = worldPoint.y - offset.y;
        const cz = worldPoint.z - offset.z;

        const cartToFracM = this.getCartToFracMatrix(mapCell);

        // Cube corners in map Cartesian around the point -> fractional bounds
        const deltas = [
            [-1,-1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],
            [-1,-1,1],[1,-1,1],[-1,1,1],[1,1,1]
        ];
        let minFrac = { x: Infinity, y: Infinity, z: Infinity };
        let maxFrac = { x: -Infinity, y: -Infinity, z: -Infinity };
        deltas.forEach(d => {
            const x = cx + d[0] * radius;
            const y = cy + d[1] * radius;
            const z = cz + d[2] * radius;
            const fx = cartToFracM.i11 * x + cartToFracM.i12 * y + cartToFracM.i13 * z;
            const fy = cartToFracM.i21 * x + cartToFracM.i22 * y + cartToFracM.i23 * z;
            const fz = cartToFracM.i31 * x + cartToFracM.i32 * y + cartToFracM.i33 * z;
            if (fx < minFrac.x) minFrac.x = fx;
            if (fy < minFrac.y) minFrac.y = fy;
            if (fz < minFrac.z) minFrac.z = fz;
            if (fx > maxFrac.x) maxFrac.x = fx;
            if (fy > maxFrac.y) maxFrac.y = fy;
            if (fz > maxFrac.z) maxFrac.z = fz;
        });

        const centerFrac = {
            x: cartToFracM.i11 * cx + cartToFracM.i12 * cy + cartToFracM.i13 * cz,
            y: cartToFracM.i21 * cx + cartToFracM.i22 * cy + cartToFracM.i23 * cz,
            z: cartToFracM.i31 * cx + cartToFracM.i32 * cy + cartToFracM.i33 * cz
        };

        const bounds = { min: minFrac, max: maxFrac };

        this.state.currentMapBounds = bounds;
        this.state.currentMapCenter = centerFrac;
        this.state.currentMapRadius = radius;
        this.state.mapFocusFrac = centerFrac;

        const btn = document.getElementById('tool-map-toggle');
        const wasVisible = !btn || btn.classList.contains('active');

        this.renderDensitySurface(this.state.cachedMapData, mapCell, level, radius, bounds, centerFrac);
        if (!wasVisible) {
            this.state.densityRenderer.setVisible(false);
        }
    }

    getFracToCartMatrix(cell) {
        const { a, b, c, alpha, beta, gamma } = cell;
        const toRad = Math.PI / 180;
        const ca = Math.cos(alpha * toRad), cb = Math.cos(beta * toRad), cc = Math.cos(gamma * toRad);
        const sb = Math.sin(beta * toRad), sc = Math.sin(gamma * toRad);
        const V = a * b * c * Math.sqrt(1 - ca*ca - cb*cb - cc*cc + 2*ca*cb*cc);
        const m11 = a, m12 = b * cc, m13 = c * cb;
        const m22 = b * sc, m23 = c * (ca - cb * cc) / sc;
        const m33 = V / (a * b * sc);
        return { m11, m12, m13, m22, m23, m33, V };
    }

    getCartToFracMatrix(cell) {
        const m = this.getFracToCartMatrix(cell);
        const det = m.m11 * (m.m22 * m.m33) + m.m12 * 0 + m.m13 * 0;
        const invDet = 1 / det;
        return {
            i11: (m.m22 * m.m33) * invDet,
            i12: (-m.m12 * m.m33) * invDet,
            i13: (m.m12 * m.m23 - m.m13 * m.m22) * invDet,
            i21: 0, i22: (m.m11 * m.m33) * invDet, i23: (-m.m11 * m.m23) * invDet,
            i31: 0, i32: 0, i33: (m.m11 * m.m22) * invDet
        };
    }

    setupFragmentControls() {
        const fragmentSelect = document.getElementById('fragment-select');
        const placeBtn = document.getElementById('tool-place-fragment');

        const activateFragmentMode = () => {
            const fragmentId = fragmentSelect ? fragmentSelect.value : '';
            if (fragmentId && this.state.loadedContent) {
                if (!this.state.cachedMapData && !this.state.currentMapData) {
                    alert("Please load an FCF map first for fragment placement and refinement.");
                    return;
                }
                this.state.fragment.active = true;
                this.state.fragment.selectedId = fragmentId;
                if (!this.state.rsr.active) {
                    this.state.rsr.active = true;
                    const rsrBtn = document.getElementById('tool-rsr');
                    if (rsrBtn) rsrBtn.classList.add('active');
                }
                document.body.style.cursor = 'crosshair';
                document.getElementById('status-bar-content').textContent =
                    `Place ${FRAGMENTS[fragmentId].name}: Click atom or scene position`;
            }
        };

        if (fragmentSelect) {
            fragmentSelect.addEventListener('change', () => {
                if (this.state.preview.active) return;
                const val = fragmentSelect.value;
                if (val) activateFragmentMode();
                else {
                    this.state.fragment.active = false;
                    this.state.fragment.selectedId = null;
                }
            });
        }

        if (placeBtn) {
            placeBtn.addEventListener('click', () => {
                if (this.state.preview.active) return;
                const val = fragmentSelect ? fragmentSelect.value : '';
                if (val) activateFragmentMode();
                else alert("Select a group from the dropdown first.");
            });
        }

        ['rot-x', 'rot-y', 'rot-z'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => {
                    document.getElementById(id + '-val').textContent = el.value;
                    this.updatePreviewTransform();
                });
            }
        });

        ['trans-x', 'trans-y', 'trans-z'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', () => {
                    document.getElementById(id + '-val').textContent = parseFloat(el.value).toFixed(2);
                    this.updatePreviewTransform();
                });
            }
        });

        const refineBtn = document.getElementById('btn-frag-refine');
        if (refineBtn) {
            refineBtn.addEventListener('click', () => this.refinePreviewFragment());
        }

        const okBtn = document.getElementById('btn-frag-ok');
        if (okBtn) {
            okBtn.addEventListener('click', () => this.acceptFragment());
        }

        const cancelBtn = document.getElementById('btn-frag-cancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.cancelFragmentPlacement());
        }
    }

    placeFragment(clickedAtom, event) {
        const fragmentId = this.state.fragment.selectedId;
        if (!fragmentId || !FRAGMENTS[fragmentId]) return;
        const fragment = FRAGMENTS[fragmentId];
        const cell = this.state.parsedData.cell;
        if (!cell) return;

        // Compute placement position in world Cartesian
        let posCart;
        if (clickedAtom) {
            const m = this.getFracToCartMatrix(cell);
            posCart = new THREE.Vector3(
                m.m11 * clickedAtom.x + m.m12 * clickedAtom.y + m.m13 * clickedAtom.z,
                m.m22 * clickedAtom.y + m.m23 * clickedAtom.z,
                m.m33 * clickedAtom.z
            );
        } else {
            const rect = this.state.renderer.domElement.getBoundingClientRect();
            const mx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            const my = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            const rc = new THREE.Raycaster();
            rc.setFromCamera(new THREE.Vector2(mx, my), this.state.camera);
            const n = new THREE.Vector3();
            this.state.camera.getWorldDirection(n);
            const center = this.state.controls ? this.state.controls.target : new THREE.Vector3(0, 0, 0);
            const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, center);
            const pt = new THREE.Vector3();
            const hit = rc.ray.intersectPlane(plane, pt);
            posCart = hit ? pt : center.clone();
            // Convert from world-space to molecule group local coordinates
            const gPos = this.state.moleculeRenderer
                ? this.state.moleculeRenderer.group.position
                : new THREE.Vector3();
            posCart.sub(gPos);
        }

        // Read editor lines (before any insertions — needed for label generation)
        const editor = this.state.editors.res;
        if (!editor) return;
        const allLines = editor.getValue().split('\n');

        // Parse SFAC
        const sfacElements = [];
        let sfacLineIndex = -1;
        for (let i = 0; i < allLines.length; i++) {
            const parts = allLines[i].trim().split(/\s+/);
            if (parts[0].toUpperCase() === 'SFAC') {
                sfacLineIndex = i;
                for (let j = 1; j < parts.length; j++) {
                    if (isNaN(parseFloat(parts[j]))) sfacElements.push(parts[j].toUpperCase());
                }
                break;
            }
        }
        const neededElements = [...new Set(fragment.atoms.map(a => a.element.toUpperCase()))];
        neededElements.forEach(el => { if (!sfacElements.includes(el)) sfacElements.push(el); });

        // Generate unique labels: the first atom of an element continues from
        // the highest existing number (e.g. C18 -> C18, C19, ... within one
        // group), so a placed ring gets C18-C23 rather than six times C18.
        const nextLabelNum = {};
        const allAtomLabels = [];
        for (let i = 0; i < allLines.length; i++) {
            const m = allLines[i].trim().match(/^(\S+)/);
            if (m) allAtomLabels.push(m[1]);
        }
        if (this.state.parsedData && this.state.parsedData.atoms) {
            this.state.parsedData.atoms.forEach(a => allAtomLabels.push(a.label));
        }
        const getNextLabel = (element) => {
            const el = element.toUpperCase();
            if (nextLabelNum[el] === undefined) {
                let maxNum = 0;
                const re = new RegExp(`^${el}(\\d+)`, 'i');
                allAtomLabels.forEach(l => {
                    const m = l.match(re);
                    if (m) { const n = parseInt(m[1]); if (n > maxNum) maxNum = n; }
                });
                nextLabelNum[el] = maxNum + 1;
            }
            return el + nextLabelNum[el]++;
        };

        // Determine if we placed on an existing atom. A Q-peak is not a real
        // atom: it is replaced by the group's first atom (given the proper
        // element), and the whole group is appended before HKLF.
        const clickedQLabel = (clickedAtom && (clickedAtom.element === 'Q' || /^Q\d*$/i.test(clickedAtom.label || ''))) ? clickedAtom.label : null;
        const usesExistingAtom = clickedAtom !== null && !clickedQLabel;
        const existingAtomLabel = usesExistingAtom ? clickedAtom.label : null;

        const newAtomObjects = [];
        const baseCartAtoms = [];

        const m = this.getFracToCartMatrix(cell);
        const inv = this.getCartToFracMatrix(cell);

        // Initial random rotation
        const angle = Math.random() * 2 * Math.PI;
        const cosA = Math.cos(angle), sinA = Math.sin(angle);

        // Anchor is the first fragment atom (local origin)
        const anchor = fragment.atoms[0];

        fragment.atoms.forEach((fa, idx) => {
            const el = fa.element.toUpperCase();

            // Anchor atom reuses the clicked atom's label; others get new unique labels
            const label = (idx === 0 && usesExistingAtom)
                ? existingAtomLabel
                : getNextLabel(el);

            // Rotate around anchor
            const lx = fa.x - anchor.x, ly = fa.y - anchor.y, lz = fa.z - anchor.z;
            const rx = lx * cosA - ly * sinA;
            const ry = lx * sinA + ly * cosA;
            const rz = lz;

            // A sub-milliangstrom jitter keeps an AFIX rigid group from being
            // mathematically perfect (a degenerate case for SHELX's group fit);
            // the deviation is removed when SHELX idealises the group.
            let jx = 0, jy = 0, jz = 0;
            if (fragment.afix) {
                const jit = 0.005;
                jx = jit * (((idx * 37) % 7) - 3) / 3;
                jy = jit * (((idx * 53) % 5) - 2) / 2;
                jz = jit * (((idx * 29) % 3) - 1);
            }

            // World Cartesian: anchor at click position
            const wx = posCart.x + rx + jx;
            const wy = posCart.y + ry + jy;
            const wz = posCart.z + rz + jz;

            baseCartAtoms.push({ label, element: el, x: wx, y: wy, z: wz });

            const fracX = inv.i11 * wx + inv.i12 * wy + inv.i13 * wz;
            const fracY = inv.i21 * wx + inv.i22 * wy + inv.i23 * wz;
            const fracZ = inv.i31 * wx + inv.i32 * wy + inv.i33 * wz;

            newAtomObjects.push({
                label, element: el,
                x: fracX, y: fracY, z: fracZ,
                occupancy: 11.0, uiso: 0.05, u: null, part: 0
            });
        });

        // Centroid for rotation = posCart (rotation pivots around the anchor
        // which sits at the clicked atom position)
        const centroid = posCart.clone();

        // Store preview state
        this.state.preview.active = true;
        this.state.preview.baseCartAtoms = baseCartAtoms;
        this.state.preview.centroid = centroid;
        this.state.preview.placementPos = posCart.clone();
        this.state.preview.rotation = { x: 0, y: 0, z: 0 };
        this.state.preview.translation = { x: 0, y: 0, z: 0 };
        this.state.preview.fragmentDef = fragment;
        this.state.preview.sfacElements = sfacElements;
        this.state.preview.sfacLineIndex = sfacLineIndex;
        this.state.preview.allLines = allLines;
        this.state.preview.cartAtoms = baseCartAtoms.map(a => ({ ...a }));
        this.state.preview.usesExistingAtom = usesExistingAtom;
        this.state.preview.existingAtomLabel = existingAtomLabel;
        this.state.preview.removedQPeakLabel = clickedQLabel;

        // Render green preview
        this.updatePreviewDisplay();

        // Show panel
        document.getElementById('frag-placement-title').textContent = `Place ${fragment.name}`;
        document.getElementById('frag-placement-status').textContent = 'Preview';
        document.getElementById('fragmentPlacementPanel').style.display = 'block';

        document.getElementById('status-bar-content').textContent = `Adjust ${fragment.name}, then refine or accept.`;
        document.body.style.cursor = 'default';
    }

    getTransformedCartAtoms() {
        const base = this.state.preview.baseCartAtoms;
        if (!base) return [];
        const c = this.state.preview.centroid;
        const rot = this.state.preview.rotation;
        const tr = this.state.preview.translation;

        const toRad = Math.PI / 180;
        const rx = rot.x * toRad, ry = rot.y * toRad, rz = rot.z * toRad;
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cy = Math.cos(ry), sy = Math.sin(ry);
        const cz = Math.cos(rz), sz = Math.sin(rz);

        // Rotation matrices (Z * Y * X)
        const rotMat = (px, py, pz) => {
            // Rotate X
            let y1 = py * cx - pz * sx;
            let z1 = py * sx + pz * cx;
            // Rotate Y
            let x2 = px * cy + z1 * sy;
            let z2 = -px * sy + z1 * cy;
            // Rotate Z
            let x3 = x2 * cz - y1 * sz;
            let y3 = x2 * sz + y1 * cz;
            return { x: x3, y: y3, z: z2 };
        };

        return base.map(a => {
            const rel = { x: a.x - c.x, y: a.y - c.y, z: a.z - c.z };
            const rotRel = rotMat(rel.x, rel.y, rel.z);
            return {
                label: a.label,
                element: a.element,
                x: c.x + rotRel.x + tr.x,
                y: c.y + rotRel.y + tr.y,
                z: c.z + rotRel.z + tr.z
            };
        });
    }

    getAtomColor(element) {
        const colors = {
            'H': 0x90FF90, 'C': 0x00FF00, 'N': 0x00CC00, 'O': 0x00FF00,
            'F': 0x00FF66, 'CL': 0x00FF33, 'BR': 0x00FF00, 'I': 0x00AA00,
            'S': 0x00FF00, 'P': 0x00FF00
        };
        return colors[element.toUpperCase()] || 0x00FF00;
    }

    updatePreviewDisplay() {
        this.clearPreviewMeshes();

        const transformed = this.getTransformedCartAtoms();
        this.state.preview.cartAtoms = transformed;

        const sphereGeo = new THREE.SphereGeometry(0.35, 16, 16);
        const targetGroup = this.state.moleculeRenderer
            ? this.state.moleculeRenderer.group
            : this.state.scene;

        transformed.forEach(a => {
            const color = this.getAtomColor(a.element);
            const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5 });
            const mesh = new THREE.Mesh(sphereGeo, mat);
            mesh.position.set(a.x, a.y, a.z);
            mesh.renderOrder = 999;
            mesh.userData.isPreviewAtom = true;
            targetGroup.add(mesh);
            this.state.preview.meshes.push(mesh);

            const canvas = document.createElement('canvas');
            canvas.width = 128;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.font = 'Bold 32px Arial';
            ctx.fillStyle = '#00ff00';
            ctx.fillText(a.label, 4, 36);
            const tex = new THREE.CanvasTexture(canvas);
            const sprMat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false });
            const sprite = new THREE.Sprite(sprMat);
            sprite.position.set(a.x, a.y + 0.5, a.z);
            sprite.scale.set(1.0, 0.5, 1);
            sprite.renderOrder = 999;
            sprite.userData.isPreviewLabel = true;
            targetGroup.add(sprite);
            this.state.preview.labels.push(sprite);
        });
    }

    clearPreviewMeshes() {
        const targetGroup = this.state.moleculeRenderer
            ? this.state.moleculeRenderer.group
            : this.state.scene;
        this.state.preview.meshes.forEach(m => {
            targetGroup.remove(m);
            m.geometry.dispose();
            m.material.dispose();
        });
        this.state.preview.meshes = [];
        this.state.preview.labels.forEach(s => {
            targetGroup.remove(s);
            s.material.map?.dispose();
            s.material.dispose();
        });
        this.state.preview.labels = [];
    }

    updatePreviewTransform() {
        if (!this.state.preview.active) return;
        this.state.preview.rotation.x = parseFloat(document.getElementById('rot-x').value) || 0;
        this.state.preview.rotation.y = parseFloat(document.getElementById('rot-y').value) || 0;
        this.state.preview.rotation.z = parseFloat(document.getElementById('rot-z').value) || 0;
        this.state.preview.translation.x = parseFloat(document.getElementById('trans-x').value) || 0;
        this.state.preview.translation.y = parseFloat(document.getElementById('trans-y').value) || 0;
        this.state.preview.translation.z = parseFloat(document.getElementById('trans-z').value) || 0;
        this.updatePreviewDisplay();
    }

    refinePreviewFragment() {
        if (!this.state.preview.active) return;
        const cartAtoms = this.state.preview.cartAtoms;
        if (!cartAtoms || cartAtoms.length === 0) return;

        const refineProgress = document.getElementById('frag-refine-progress');
        if (refineProgress) refineProgress.classList.remove('d-none');
        document.getElementById('btn-frag-refine').disabled = true;

        try {
            if (!this.state.cachedMapData && this.state.currentMapData) {
                const type = document.getElementById('map-type').value || '2Fo-Fc';
                this.state.cachedMapData = this.state.mapCalculator.calculateMap(
                    this.state.currentMapData.reflections,
                    this.state.currentMapData.cell,
                    this.state.preferences.map.resolution,
                    type
                );
            }

            if (!this.state.cachedMapData) {
                alert("No map data for refinement.");
                if (refineProgress) refineProgress.classList.add('d-none');
                document.getElementById('btn-frag-refine').disabled = false;
                return;
            }

            const cell = this.state.parsedData.cell;
            const inv = this.getCartToFracMatrix(cell);

            // Convert current Cartesian positions to fractional for refinement
            const fracAtoms = cartAtoms.map(a => ({
                label: a.label,
                element: a.element,
                x: inv.i11 * a.x + inv.i12 * a.y + inv.i13 * a.z,
                y: inv.i21 * a.x + inv.i22 * a.y + inv.i23 * a.z,
                z: inv.i31 * a.x + inv.i32 * a.y + inv.i33 * a.z,
                occupancy: 11.0,
                uiso: 0.05
            }));

            // Run rigid-body RSR (preserves fragment geometry)
            this.state.realSpaceRefiner.refineRigid(fracAtoms, this.state.cachedMapData, cell);

            // Convert back to Cartesian for display
            const m = this.getFracToCartMatrix(cell);
            const refinedCart = fracAtoms.map(a => ({
                label: a.label,
                element: a.element,
                x: m.m11 * a.x + m.m12 * a.y + m.m13 * a.z,
                y: m.m22 * a.y + m.m23 * a.z,
                z: m.m33 * a.z
            }));

            // Update base atoms to refined positions, reset transforms
            this.state.preview.baseCartAtoms = refinedCart;
            this.state.preview.rotation = { x: 0, y: 0, z: 0 };
            this.state.preview.translation = { x: 0, y: 0, z: 0 };

            // Recompute centroid
            let cx = 0, cy = 0, cz = 0;
            refinedCart.forEach(a => { cx += a.x; cy += a.y; cz += a.z; });
            cx /= refinedCart.length; cy /= refinedCart.length; cz /= refinedCart.length;
            this.state.preview.centroid = new THREE.Vector3(cx, cy, cz);

            // Reset sliders
            ['rot-x', 'rot-y', 'rot-z', 'trans-x', 'trans-y', 'trans-z'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = 0;
                const valEl = document.getElementById(id + '-val');
                if (valEl) {
                    const isRot = id.startsWith('rot');
                    valEl.textContent = isRot ? '0' : '0.00';
                }
            });

            this.updatePreviewDisplay();
            document.getElementById('frag-placement-status').textContent = 'Refined';
            document.getElementById('status-bar-content').textContent = 'Fragment refined. Adjust or accept.';
        } catch (e) {
            console.error("Refine preview error:", e);
            alert("Refinement error: " + e.message);
        } finally {
            if (refineProgress) refineProgress.classList.add('d-none');
            document.getElementById('btn-frag-refine').disabled = false;
        }
    }

    acceptFragment() {
        if (!this.state.preview.active) return;

        const cartAtoms = this.state.preview.cartAtoms;
        const sfacElements = this.state.preview.sfacElements;
        const sfacLineIndex = this.state.preview.sfacLineIndex;
        const editor = this.state.editors.res;
        if (!editor || !cartAtoms) return;

        const cell = this.state.parsedData.cell;
        const inv = this.getCartToFracMatrix(cell);
        const doc = editor.getSession().getDocument();

        // Update SFAC if needed
        if (sfacLineIndex !== -1) {
            const existing = doc.getLine(sfacLineIndex);
            const parts = existing.trim().split(/\s+/);
            if (parts[0].toUpperCase() === 'SFAC') {
                const currentEls = [];
                for (let j = 1; j < parts.length; j++) {
                    if (isNaN(parseFloat(parts[j]))) currentEls.push(parts[j].toUpperCase());
                }
                const origCount = currentEls.length;
                sfacElements.forEach(el => {
                    if (!currentEls.includes(el)) currentEls.push(el);
                });
                const added = currentEls.length - origCount;
                if (added > 0) {
                    doc.removeInLine(sfacLineIndex, 0, existing.length);
                    doc.insertInLine({ row: sfacLineIndex, column: 0 }, 'SFAC ' + currentEls.join(' '));
                    // UNIT must have one numeric entry per SFAC element; append
                    // zeros for the newly added elements so SHELX does not abort.
                    for (let i = 0; i < doc.getLength(); i++) {
                        const uParts = doc.getLine(i).trim().split(/\s+/);
                        if (uParts[0] && uParts[0].toUpperCase() === 'UNIT') {
                            const pad = ' ' + new Array(added).fill('0').join(' ');
                            doc.insertInLine({ row: i, column: doc.getLine(i).length }, pad);
                            break;
                        }
                    }
                }
            }
        }

        // A group placed on a Q-peak replaces that peak: delete the Q line so
        // the fragment's atom (with the proper element) appears only once.
        const removedQLabel = this.state.preview.removedQPeakLabel;
        if (removedQLabel) {
            for (let i = 0; i < doc.getLength(); i++) {
                const first = doc.getLine(i).trim().match(/^(\S+)/);
                if (first && first[1] === removedQLabel) {
                    doc.removeLines(i, i);
                    break;
                }
            }
        }

        // Generate SHELX lines (skip anchor if placed on an existing atom)
        const getSfacIndex = (el) => {
            const idx = sfacElements.indexOf(el.toUpperCase());
            return idx >= 0 ? idx + 1 : 1;
        };

        const usesExisting = this.state.preview.usesExistingAtom;
        const existingLabel = this.state.preview.existingAtomLabel;
        const fragmentDef = this.state.preview.fragmentDef || {};
        const afix = fragmentDef.afix || null;

        const shexLines = [];
        const currentLines = doc.getAllLines();
        let existingRow = -1;

        cartAtoms.forEach((a, idx) => {
            const fx = inv.i11 * a.x + inv.i12 * a.y + inv.i13 * a.z;
            const fy = inv.i21 * a.x + inv.i22 * a.y + inv.i23 * a.z;
            const fz = inv.i31 * a.x + inv.i32 * a.y + inv.i33 * a.z;
            const sfacIdx = getSfacIndex(a.element);

            if (idx === 0 && usesExisting && existingLabel) {
                // Update the existing atom's line in place
                for (let li = 0; li < currentLines.length; li++) {
                    const labelMatch = currentLines[li].trim().match(/^(\S+)/);
                    if (labelMatch && labelMatch[1] === existingLabel) {
                        const parts = currentLines[li].trim().split(/\s+/);
                        if (parts.length >= 5) {
                            const leadingWS = currentLines[li].match(/^\s*/)[0];
                            parts[2] = fx.toFixed(5);
                            parts[3] = fy.toFixed(5);
                            parts[4] = fz.toFixed(5);
                            // Update SFAC index if needed
                            parts[1] = String(sfacIdx);
                            currentLines[li] = leadingWS + parts.join(' ');
                            existingRow = li;
                        }
                        break;
                    }
                }
            } else {
                shexLines.push(`${a.label}  ${sfacIdx}  ${fx.toFixed(5)}  ${fy.toFixed(5)}  ${fz.toFixed(5)}  11.0  0.05`);
            }
        });

        // Write back existing atom updates
        if (usesExisting && existingLabel) {
            editor.setValue(currentLines.join('\n'), -1);
        }

        // Append atom lines at the end of the atom list (before HKLF, else END).
        const insertAtoms = (text) => {
            const lines = doc.getAllLines();
            let insertPos = -1;
            for (let i = 0; i < lines.length; i++) {
                if (/^\s*HKLF\b/i.test(lines[i])) { insertPos = i; break; }
            }
            if (insertPos === -1) {
                for (let i = lines.length - 1; i >= 0; i--) {
                    if (lines[i].trim().toUpperCase() === 'END') { insertPos = i; break; }
                }
            }
            if (insertPos === -1) {
                insertPos = doc.getLength();
                editor.session.insert({ row: insertPos, column: 0 }, '\n' + text + 'END\n');
            } else {
                editor.session.insert({ row: insertPos, column: 0 }, text);
            }
        };

        // Groups without a built-in SHELX idealised AFIX group are restrained
        // with SADI on their 1,2- (bonded) and 1,3- (angle) distances. Bonds are
        // detected from the fragment geometry, so rings, chains, branched groups
        // and solvent molecules are all handled.
        const sadiLines = [];
        if (!afix && cartAtoms.length >= 2) {
            const radii = {
                H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, P: 1.07, S: 1.05,
                CL: 1.02, BR: 1.20, I: 1.39, B: 0.84, SI: 1.11
            };
            const n = cartAtoms.length;
            const bonded = Array.from({ length: n }, () => new Set());
            const bondPairs = [];
            for (let i = 0; i < n; i++) {
                for (let j = i + 1; j < n; j++) {
                    const ri = radii[cartAtoms[i].element.toUpperCase()] || 1.5;
                    const rj = radii[cartAtoms[j].element.toUpperCase()] || 1.5;
                    const dx = cartAtoms[i].x - cartAtoms[j].x;
                    const dy = cartAtoms[i].y - cartAtoms[j].y;
                    const dz = cartAtoms[i].z - cartAtoms[j].z;
                    if (Math.sqrt(dx * dx + dy * dy + dz * dz) <= (ri + rj) * 1.3) {
                        bonded[i].add(j);
                        bonded[j].add(i);
                        bondPairs.push([i, j]);
                    }
                }
            }
            const emit = (head, list) => {
                if (!list.length) return;
                let cur = head;
                for (const [i, j] of list) {
                    const pair = ` ${cartAtoms[i].label} ${cartAtoms[j].label}`;
                    if (cur.length + pair.length > 78) { sadiLines.push(cur); cur = head; }
                    cur += pair;
                }
                if (cur !== head) sadiLines.push(cur);
            };
            const isCarbon = (k) => cartAtoms[k].element.toUpperCase() === 'C';
            if (cartAtoms.some(a => a.element.toUpperCase() !== 'C')) {
                // Mixed-atom solvents (THF, Et2O, DCM, ...): restrain bond lengths
                // only, with heteroatom bonds and C-C bonds written as separate
                // SADI instructions.
                emit('SADI 0.01', bondPairs.filter(([i, j]) => !isCarbon(i) || !isCarbon(j)));
                emit('SADI 0.01', bondPairs.filter(([i, j]) => isCarbon(i) && isCarbon(j)));
            } else {
                const anglePairs = [];
                for (let i = 0; i < n; i++) {
                    for (let j = i + 1; j < n; j++) {
                        if (bonded[i].has(j)) continue;
                        let shared = false;
                        for (const k of bonded[i]) { if (bonded[j].has(k)) { shared = true; break; } }
                        if (!shared) continue;
                        // iPr has two non-equivalent methyls, so its methyl...methyl
                        // distance is not restrained (tBu's are equivalent and kept).
                        if (fragmentDef.skipMethylMethyl &&
                            bonded[i].size === 1 && bonded[j].size === 1 &&
                            cartAtoms[i].element.toUpperCase() === 'C' &&
                            cartAtoms[j].element.toUpperCase() === 'C') {
                            continue;
                        }
                        anglePairs.push([i, j]);
                    }
                }
                emit('SADI 0.02', bondPairs);
                emit('SADI 0.02', anglePairs);
            }
        }

        // A SHELX rigid group (AFIX) must be a contiguous run of atoms terminated
        // by AFIX 0. When the pivot reuses an existing atom, bracket that atom
        // with the AFIX instructions so the whole group stays together.
        if (shexLines.length > 0) {
            if (afix && usesExisting && existingLabel && existingRow !== -1) {
                // An anisotropic atom record may continue over several lines
                // (each continued line ends with '='), so find the true end of
                // the pivot's record before inserting the rest of the group.
                let recordEnd = existingRow;
                while (recordEnd + 1 < currentLines.length && /=\s*$/.test(currentLines[recordEnd])) {
                    recordEnd++;
                }
                editor.session.insert({ row: existingRow, column: 0 }, `AFIX ${afix}\n`);
                editor.session.insert({ row: recordEnd + 2, column: 0 },
                    shexLines.join('\n') + '\nAFIX 0\n');
            } else if (afix) {
                insertAtoms(`AFIX ${afix}\n` + shexLines.join('\n') + '\nAFIX 0\n');
            } else {
                // SADI restraints sit immediately before the inserted atoms.
                const pre = sadiLines.length ? sadiLines.join('\n') + '\n' : '';
                insertAtoms(pre + shexLines.join('\n') + '\n');
            }
        }

        editor.loadedFile = editor.getValue();
        this.state.loadedContent = editor.getValue();

        this.clearPreviewMeshes();
        this.state.preview.active = false;

        document.getElementById('fragmentPlacementPanel').style.display = 'none';

        this.exitFragmentMode();

        this.renderContent(this.state.loadedContent, 'res');
        const acceptedCount = usesExisting ? shexLines.length + 1 : cartAtoms.length;
        document.getElementById('status-bar-content').textContent = `Accepted ${acceptedCount} atoms.`;
    }

    cancelFragmentPlacement() {
        this.clearPreviewMeshes();
        this.state.preview.active = false;

        document.getElementById('fragmentPlacementPanel').style.display = 'none';

        this.exitFragmentMode();
        document.getElementById('status-bar-content').textContent = 'Placement cancelled.';
    }

    exitFragmentMode() {
        this.state.fragment.active = false;
        this.state.fragment.selectedId = null;
        this.state.fragment.placedAtoms = null;
        this.state.preview.active = false;
        this.state.preview.cartAtoms = null;
        this.state.preview.baseCartAtoms = null;
        this.state.preview.usesExistingAtom = false;
        this.state.preview.existingAtomLabel = null;
        this.state.preview.removedQPeakLabel = null;
        if (this.state.rsr.active) {
            this.state.rsr.active = false;
            this.state.rsr.from = null;
            this.state.rsr.to = null;
            const rsrBtn = document.getElementById('tool-rsr');
            if (rsrBtn) rsrBtn.classList.remove('active');
        }
        const fragmentSelect = document.getElementById('fragment-select');
        if (fragmentSelect) fragmentSelect.value = '';
        document.body.style.cursor = 'default';
    }

    // Parse the SHELXL .lst output and return HTML for a highlighted summary of
    // the key refinement statistics (R1, wR2, GooF, Flack, diff peak/hole, ...).
    buildRefinementSummary(lstText) {
        if (!lstText) return '';
        // Return the last match array (with capture groups) for a regex.
        const last = (re) => {
            const m = lstText.match(re);
            return m || null;
        };

        // R1 (gt) and R1 (all) from the final summary line.
        const r1Line = last(/R1\s*=\s*([\d.]+)\s+for\s+\d+\s+Fo\s*>\s*\d+sig\(Fo\)\s+and\s+([\d.]+)\s+for\s+all\s+\d+\s+data/);
        const r1gt = r1Line ? r1Line[1] : null;
        const r1all = r1Line ? r1Line[2] : null;

        // R1 for the merged reflections used for Fourier.
        const r1four = last(/R1\s*=\s*([\d.]+)\s+for\s+\d+\s+unique reflections after merging for Fourier/);

        // wR2 and GooF from the final "for all data" line.
        const wrLine = last(/wR2\s*=\s*([\d.]+),\s+GooF\s*=\s*S\s*=\s*([\d.]+)/);
        const wr2 = wrLine ? wrLine[1] : null;
        const goof = wrLine ? wrLine[2] : null;

        // Flack parameter (classical fit).
        const flack = last(/Flack\s*x\s*=\s*([\d.\-()]+)/);

        // Difference map peak / hole.
        const peak = last(/Highest\s+peak\s+([\d.\-]+)/);
        const hole = last(/Deepest\s+hole\s+([\d.\-]+)/);

        // Final max shift.
        const shiftLine = last(/Mean shift\/esd\s*=\s*([\d.\-]+)\s+Maximum\s*=\s*([\d.\-]+)/);
        const shiftMax = shiftLine ? shiftLine[2] : null;

        // Grade a numeric value as 'good' (green), 'ok' (yellow) or 'bad' (red).
        const g = {
            r1gt:   v => v < 0.05 ? 'good' : v < 0.10 ? 'ok' : 'bad',
            r1all:  v => v < 0.08 ? 'good' : v < 0.15 ? 'ok' : 'bad',
            r1four: v => v < 0.05 ? 'good' : v < 0.10 ? 'ok' : 'bad',
            wr2:    v => v < 0.15 ? 'good' : v < 0.25 ? 'ok' : 'bad',
            goof:   v => Math.abs(v - 1) <= 0.1 ? 'good' : Math.abs(v - 1) <= 0.2 ? 'ok' : 'bad',
            flack:  v => { const d = Math.abs(v - 0.5); return d > 0.40 ? 'good' : d > 0.25 ? 'ok' : 'bad'; },
            peak:   v => v < 1.0 ? 'good' : v < 2.0 ? 'ok' : 'bad',
            hole:   v => v > -1.0 ? 'good' : v > -2.0 ? 'ok' : 'bad',
            shift:  v => Math.abs(v) < 0.5 ? 'good' : Math.abs(v) < 1.0 ? 'ok' : 'bad',
        };

        const items = [
            { label: 'R1 (gt)', value: r1gt, grade: r1gt !== null ? g.r1gt(parseFloat(r1gt)) : null },
            { label: 'R1 (all)', value: r1all, grade: r1all !== null ? g.r1all(parseFloat(r1all)) : null },
            { label: 'R1 (Fourier)', value: r1four ? r1four[1] : null, grade: r1four ? g.r1four(parseFloat(r1four[1])) : null },
            { label: 'wR2', value: wr2, grade: wr2 !== null ? g.wr2(parseFloat(wr2)) : null },
            { label: 'GooF', value: goof, grade: goof !== null ? g.goof(parseFloat(goof)) : null },
            { label: 'Flack x', value: flack ? flack[1] : null, grade: flack ? g.flack(parseFloat(flack[1])) : null },
            { label: 'Peak', value: peak ? peak[1] : null, unit: 'e/Å³', grade: peak ? g.peak(parseFloat(peak[1])) : null },
            { label: 'Hole', value: hole ? hole[1] : null, unit: 'e/Å³', grade: hole ? g.hole(parseFloat(hole[1])) : null },
            { label: 'Max shift', value: shiftMax, unit: 'esd', grade: shiftMax !== null ? g.shift(parseFloat(shiftMax)) : null },
        ].filter(i => i.value !== null && i.value !== '');

        if (!items.length) return '';

        const color = {
            good: 'border-success text-success',
            ok: 'border-warning text-warning-emphasis',
            bad: 'border-danger text-danger',
        };

        const cells = items.map(i => {
            const accent = i.grade ? color[i.grade] : 'border-secondary-subtle text-body';
            const unit = i.unit ? `<span class="text-muted fw-normal small"> ${i.unit}</span>` : '';
            return `<div class="border rounded p-2 text-center bg-white ${accent}">
                        <div class="text-muted small text-uppercase">${i.label}</div>
                        <div class="fw-bold fs-6">${i.value}${unit}</div>
                    </div>`;
        }).join('');

        return `<div class="border rounded p-2 bg-light">
                    <div class="fw-semibold small text-uppercase text-muted mb-2">Refinement summary
                        <span class="ms-2 fw-normal text-muted normal-case">
                            <span class="text-success">●</span> good
                            <span class="text-warning-emphasis ms-1">●</span> ok
                            <span class="text-danger ms-1">●</span> poor
                        </span>
                    </div>
                    <div class="d-grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));">${cells}</div>
                </div>`;
    }

    // Fetch the external programs available on the server and populate the
    // Programs menu. Programs only appear when their executable is present in
    // the PATH of the server process.
    async loadPrograms() {
        try {
            const { programs } = await this.apiListPrograms();
            this.state.availablePrograms = programs || [];
        } catch (e) {
            console.error('Failed to list server programs:', e);
            this.state.availablePrograms = [];
        }
        this.refreshProgramsMenu();
    }

    refreshProgramsMenu() {
        const menu = document.getElementById('programs-menu');
        if (!menu) return;
        const programs = this.state.availablePrograms || [];
        if (!programs.length) {
            menu.innerHTML = '<li><span class="dropdown-item-text text-muted small">No external programs detected on server</span></li>';
            return;
        }

        const PLATON_ACTIONS = {
            checkcif: 'CheckCIF',
            addsymm: 'ADDSYM',
            squeeze: 'SQUEEZE',
            twinrotmat: 'TwinRotMat'
        };

        let html = '';
        for (const p of programs) {
            if (p.id === 'platon') {
                // PLATON is interactive; offer its most useful single-purpose
                // actions as a submenu, each run with the matching instruction.
                html += `<li class="dropdown-submenu">
                    <a class="dropdown-item" href="#" data-submenu="platon">
                        <div class="d-flex justify-content-between align-items-center">
                            <span>${p.label}</span>
                            <i class="fa-solid fa-chevron-right text-muted small"></i>
                        </div>
                        <div class="text-muted small">${p.description}</div>
                    </a>
                    <ul class="dropdown-menu">
                        ${Object.entries(PLATON_ACTIONS).map(([action, label]) => `
                        <li><a class="dropdown-item" href="#" data-program="platon" data-action="${action}">
                            <div class="d-flex justify-content-between align-items-center">
                                <span>${label}</span>
                                <span class="text-muted small">${action}</span>
                            </div>
                        </a></li>`).join('')}
                    </ul>
                </li>`;
            } else {
                html += `
            <li><a class="dropdown-item" href="#" data-program="${p.id}">
                <div>${p.label}</div>
                <div class="text-muted small">${p.description}</div>
            </a></li>`;
            }
        }
        menu.innerHTML = html;

        menu.querySelectorAll('a[data-program]').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const id = a.getAttribute('data-program');
                const program = programs.find(p => p.id === id);
                if (!program) return;
                const action = a.getAttribute('data-action') || null;
                if (id === 'platon' && !action) {
                    // Opening PLATON itself: default to CheckCIF.
                    this.runExternalProgram({ ...program }, 'checkcif');
                    return;
                }
                this.runExternalProgram({ ...program }, action);
            });
        });
    }

    // Return the structure content (.ins/.res/.cif) the user is currently
    // working on: the most recently shown structure file tab first (this is
    // where edits go), otherwise the main RES editor. Returns null if none.
    getStructureContent() {
        if (this.state.lastStructureTabKey && this.state.fileTabs[this.state.lastStructureTabKey]) {
            const tab = this.state.fileTabs[this.state.lastStructureTabKey];
            const v = tab.editor.getValue();
            if (v && v.trim()) return v;
        }
        if (this.state.editors.res) {
            const v = this.state.editors.res.getValue();
            if (v && v.trim()) return v;
        }
        return null;
    }

    // -----------------------------------------------------------------------
    // HKL availability. Since SHELX/PLATON run on the server against files that
    // live in the project directory, the browser does not need the full HKL
    // content. `hklContent` is only present when the user explicitly loaded a
    // local .hkl for one-shot analysis; otherwise the HKL is referenced by
    // name (`hklName`) and kept server-side in `hklServerProject`.
    // -----------------------------------------------------------------------

    // True when an HKL is usable for a server program run: either full content
    // is in the browser, or the same-basename .hkl is stored in a server project.
    hasHkl() {
        return !!this.state.hklContent || !!this.state.hklServerProject;
    }

    // When the browser holds no HKL content, locate the reflections on the
    // server by listing the project directory that matches the current run
    // basename and registering the same-basename .hkl there. Returns true when
    // a usable HKL is available (client content or a server project file).
    async ensureHklForRun() {
        if (this.state.hklContent || this.state.hklServerProject) return true;
        const candidates = [];
        if (this.state.currentProject) candidates.push(this.state.currentProject);
        if (this.state.hklName) candidates.push(this.state.hklName.replace(/\.hkl$/i, ''));
        if (this.state.loadedFilename) {
            candidates.push(this.state.loadedFilename.replace(/\.[^.]+$/, ''));
        }
        const seen = new Set();
        for (const base of candidates) {
            const clean = String(base).replace(/[^a-zA-Z0-9_-]/g, '_');
            if (!clean || seen.has(clean)) continue;
            seen.add(clean);
            try {
                const files = await this.apiListProjectFiles(clean);
                const lower = clean.toLowerCase();
                const hkl = files.find(f => f.name.toLowerCase() === `${lower}.hkl`)
                    || files.find(f => /\.hkl$/i.test(f.name) && f.name.toLowerCase().startsWith(lower + '_'))
                    || files.find(f => /\.hkl$/i.test(f.name));
                if (hkl) {
                    this.state.hklName = hkl.name;
                    this.state.hklContent = null;
                    this.state.hklServerProject = clean;
                    this.state.currentProject = this.state.currentProject || clean;
                    this.refreshHklStatus();
                    this.saveStateToLocalStorage();
                    return true;
                }
            } catch (e) {
                // project dir does not exist - try the next candidate
            }
        }
        return false;
    }

    // The basename SHELX/PLATON runs and project files use (e.g. "efrk1_a").
    // Prefers the HKL name, then the loaded structure name, then the project.
    hklBaseName() {
        if (this.state.hklServerProject) return this.state.hklServerProject;
        if (this.state.hklName) return this.state.hklName.replace(/\.hkl$/i, '');
        if (this.state.loadedFilename) return this.state.loadedFilename.replace(/\.[^.]+$/, '');
        return this.state.currentProject || 'structure';
    }

    // Project name whose directory holds the server-side HKL for the current
    // basename, or null when the HKL only exists as local browser content.
    hklProject() {
        if (this.state.hklServerProject) return this.state.hklServerProject;
        return null;
    }

    // Append the HKL to a run's FormData. When the HKL is a server-project file
    // (no content in the browser) we omit the file - the server reuses the
    // same-basename .hkl already stored in the project directory. Returns the
    // blob field name used, or null when the server-side file should be reused.
    appendHklPart(formData, base) {
        if (this.state.hklContent) {
            formData.append('hkl', new Blob([this.state.hklContent], { type: 'text/plain' }), base + '.hkl');
            return 'hkl';
        }
        return null; // server reuses project-dir <base>.hkl
    }

    // Update the HKL status badge in the toolbar.
    refreshHklStatus() {
        const statusHkl = document.getElementById('status-hkl');
        if (!statusHkl) return;
        const present = this.hasHkl();
        statusHkl.classList.toggle('bg-success', !!present);
        statusHkl.classList.toggle('bg-secondary', !present);
        statusHkl.title = present
            ? (this.state.hklContent
                ? 'HKL Loaded: ' + (this.state.hklName || 'data.hkl')
                : 'HKL on server: ' + (this.state.hklName || (this.hklBaseName() + '.hkl')))
            : 'No HKL loaded';
    }

    // Forget any client-side HKL content but keep the name/project reference so
    // that server-side runs still work without holding the file in the browser.
    keepOnlyHklReference() {
        this.state.hklContent = null;
        this.state.hklName = this.state.hklName || (this.state.currentProject
            ? this.state.currentProject + '.hkl' : null);
        if (this.state.currentProject) this.state.hklServerProject = this.state.currentProject;
        this.refreshHklStatus();
    }

    // Load a local .hkl file picked by the user. SHELX/PLATON consume the data
    // server-side, so the file is uploaded straight into the current (or a new)
    // server project under the canonical <basename>.hkl name and only a
    // reference is kept in the browser - the raw content is never read into
    // memory or localStorage. Returns true when uploaded, false when no server
    // project could be used.
    async loadLocalHklFile(file) {
        const project = await this.uploadLocalProjectCompanion(file, '.hkl');
        if (!project) return false;
        this.state.currentProject = project;
        this.state.hklName = `${project}.hkl`;
        this.state.hklContent = null;
        this.state.hklServerProject = project;
        this.refreshHklStatus();
        this.saveStateToLocalStorage();
        return true;
    }

    // Upload a local companion file (HKL reflections, SQUEEZE .fab mask, ...)
    // into a server project under the canonical <basename><ext> name so the
    // server-side SHELX/PLATON runs find it next to the structure. The content
    // is streamed to the server and never held in the browser. Returns the
    // project name used, or null on failure.
    async uploadLocalProjectCompanion(file, ext) {
        const base = (this.state.currentProject || this.hklBaseName()
            || (this.state.loadedFilename ? this.state.loadedFilename.replace(/\.[^.]+$/, '') : null)
            || file.name.replace(/\.[^.]+$/, ''))
            .replace(/[^a-zA-Z0-9_-]/g, '_');
        try {
            const form = new FormData();
            form.append('file', file, base + ext);
            const res = await fetch(this.getApiUrl(`/projects/${encodeURIComponent(base)}/upload`), {
                method: 'POST', body: form
            });
            if (!res.ok) {
                let detail = '';
                try { const e = await res.json(); detail = e.error || e.details || ''; } catch (err) { /* ignore */ }
                throw new Error(detail || `Upload failed (HTTP ${res.status})`);
            }
            const data = await res.json();
            this.state.currentProject = this.state.currentProject || data.project || base;
            this.saveStateToLocalStorage();
            return this.state.currentProject;
        } catch (e) {
            console.error(`Companion upload failed (${ext}):`, e.message);
            return null;
        }
    }

    // Run an external crystallography program (shelxl, shelxt, platon, ...) on
    // the currently loaded files and show the results in the results modal.
    // `action` is used for PLATON to choose which single-purpose task to run.
    async runExternalProgram(program, action = null) {
        const inputs = program.inputs || [];
        const formData = new FormData();
        if (program.id === 'platon') {
            // The server maps this to the matching PLATON instruction.
            formData.append('action', action || 'checkcif');
        }

        // Programs that need reflections: first make sure an HKL is available.
        // This locates (without loading into the browser) a same-basename .hkl
        // stored in the current project directory when the user did not load one.
        const needsHkl = inputs.includes('.hkl');
        if (needsHkl && !(await this.ensureHklForRun())) {
            alert('No HKL file available. Please load an .hkl file or open a project that contains one.');
            return;
        }

        let baseName = this.hklBaseName().replace(/[^a-zA-Z0-9_-]/g, '_');

        const needsRes = inputs.includes('.res') || inputs.includes('.ins') || inputs.includes('.cif');
        if (needsRes) {
            const ext = inputs.includes('.cif') ? '.cif' : inputs.includes('.ins') ? '.ins' : '.res';
            // Run on the structure file the user is currently working on (the
            // active structure file tab, or the main RES editor). Fall back to
            // the xrdspace-generated .ins only when no editor content is present.
            let content = this.getStructureContent();
            if (!content && this.state.xrdspaceIns) {
                content = this.state.xrdspaceIns.content;
            }
            if (!content) {
                alert('No structure loaded to run.');
                return;
            }

            // SHELXD aborts with "AT LEAST ONE OF PATS, GROP, FIND OR PLOP MUST
            // BE SPECIFIED" unless the .ins contains one of those instructions.
            // Ask for the number of atoms to search for and insert FIND so the
            // run does not fail with a cryptic error. (FIND is also accepted by
            // SHELXT/SHELXS, but they run fine without it via TREF.)
            if (program.id === 'shelxd') {
                const hasSearchDirective = /^\s*(FIND|PATS|GROP|PLOP)\b/m.test(content);
                if (!hasSearchDirective) {
                    const n = prompt(
                        'SHELXD needs a FIND instruction (number of atoms to search for).\n' +
                        'Enter the number of heavy atoms expected in the asymmetric unit:',
                        '4'
                    );
                    if (n === null) return; // cancelled
                    const findCount = parseInt(n, 10);
                    if (!Number.isFinite(findCount) || findCount < 1) {
                        alert('Invalid FIND count - SHELXD was not run.');
                        return;
                    }
                    content = content.replace(/^HKLF.*$/m, `FIND ${findCount}\nHKLF 4`);
                    if (!/^\s*FIND\s+\d+\b/m.test(content)) {
                        content = content.replace(/\s*$/, '') + `\nFIND ${findCount}\nEND\n`;
                    }
                }
            }

            formData.append(ext.slice(1), new Blob([content], { type: 'text/plain' }), baseName + ext);
        } else if (inputs.includes('.hkl') && /^shelx[ces]$/.test(program.id) && this.hasHkl() && !this.state.hklContent) {
            // SHELXC/SHELXE take reflections only (.hkl). When the HKL is a
            // server project file (not uploaded) there must still be at least one
            // uploaded file so the server can resolve the run directory; attach
            // the current structure as <base>.ins if one is present.
            const content = this.getStructureContent();
            if (content) {
                formData.append('ins', new Blob([content], { type: 'text/plain' }), baseName + '.ins');
            } else {
                alert('No structure or HKL content available to run this program on the server.');
                return;
            }
        }
        if (inputs.includes('.hkl')) {
            if (!this.hasHkl()) {
                alert('No HKL file available. Please load an .hkl file or open a project that contains one.');
                return;
            }
            this.appendHklPart(formData, baseName);
        }

        const btn = document.getElementById('tool-refine');
        const originalIcon = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            btn.disabled = true;
        }

        // Progress dialog with cancel support.
        const controller = new AbortController();
        const cancelBtn = document.getElementById('btn-cancel-progress');
        if (cancelBtn) cancelBtn.onclick = () => controller.abort();
        this.showProgressDialog(`Running ${program.label}...`,
            `This may take a while for large structures.`);

        // Absolute safety net: if the request is stuck at the network layer and
        // the abort signal is not honoured, force the UI back to normal so the
        // progress spinner can never stay on screen indefinitely.
        const timeout = this.state.preferences.general.refineTimeout || 180000;
        let settled = false;
        const safetyTimer = setTimeout(() => {
            if (settled) return;
            console.warn(`${program.label} run timed out - forcibly resetting progress UI.`);
            controller.abort();
            this.hideProgressDialog();
            if (btn) {
                btn.innerHTML = originalIcon || '<i class="fa-solid fa-flask"></i>';
                btn.disabled = false;
            }
        }, timeout + 5000);

        try {
            const response = await fetch(this.getApiUrl(`/run/${program.id}`), {
                method: 'POST',
                body: formData,
                signal: this.makeAbortSignal(controller)
            });
            if (!response.ok) throw new Error(`Server error: ${response.statusText}`);
            let data;
            try {
                data = await response.json();
            } catch (e) {
                const txt = await response.text();
                throw new Error('Server returned an invalid response: ' + txt.slice(0, 200));
            }
            this.clearAbortSignalTimeout();
            settled = true;
            clearTimeout(safetyTimer);
            if (data.error) throw new Error(data.error);

            // Load the primary output back into the editor when the program produces it.
            const primary = { shelxl: '.res', shelxs: '.res', shelxt: '.res', shelxd: '.res', shelxh: '.res', shelxe: '.res' }[program.id];
            let primaryKey = primary ? Object.keys(data.files || {}).find(k => k.toLowerCase().endsWith(primary)) : null;
            // PLATON SQUEEZE returns the updated model (.res/.ins) carrying ABIN.
            if (program.id === 'platon' && data.squeezeApplied) {
                primaryKey = Object.keys(data.files || {}).find(k => /\.res$/i.test(k))
                    || Object.keys(data.files || {}).find(k => /\.ins$/i.test(k));
            }
            if (primaryKey && this.state.editors.res) {
                const content = data.files[primaryKey] || '';
                // Never wipe the editor with an empty output (e.g. SHELXL
                // aborting on a bad instruction leaves an empty .res).
                if (content.trim().length > 0) {
                    this.state.editors.res.setValue(content, -1);
                    this.state.loadedContent = content;
                    this.renderContent(content, 'res');
                } else {
                    console.warn(`Program produced an empty ${primaryKey} - keeping current editor content.`);
                }
            }

            // Build combined output for display.
            let combinedOutput = '';
            if (data.stdout) combinedOutput += '--- STDOUT ---\n' + data.stdout + '\n\n';
            if (data.stderr) combinedOutput += '--- STDERR ---\n' + data.stderr + '\n\n';
            if (data.files) {
                for (const [name, content] of Object.entries(data.files)) {
                    combinedOutput += `--- ${name} ---\n${content}\n\n`;
                }
            }
            if (!combinedOutput) combinedOutput = '(no output)';

            const resultsContent = document.getElementById('results-content');
            const resultsSummary = document.getElementById('results-summary');
            const modalEl = document.getElementById('resultsModal');
            if (resultsContent && modalEl) {
                // Solution programs (SHELXT / SHELXD / SHELXS) may return several
                // alternative structures; let the user pick one.
                const isSolutionProgram = ['shelxt', 'shelxd', 'shelxs'].includes(program.id);
                const resFiles = data.files ? Object.keys(data.files).filter(f => f.toLowerCase().endsWith('.res')) : [];
                const solutions = isSolutionProgram ? this.parseShelxSolutions(data.stdout, resFiles) : [];
                this.resetResultsControls();
                this.populateSolutionSelector(solutions, data.files || {});
                resultsContent.textContent = combinedOutput;
                if (resultsSummary) {
                    resultsSummary.innerHTML = program.id === 'shelxl' && data.files
                        ? this.buildRefinementSummary(Object.values(data.files).join('\n'))
                        : '';
                    // Show a clear banner after a successful PLATON SQUEEZE.
                    if (program.id === 'platon' && data.squeezeApplied) {
                        const fab = data.fabReady
                            ? '<span class="text-success">.fab ready</span>'
                            : '<span class="text-danger">.fab missing</span>';
                        resultsSummary.innerHTML = `<div class="alert alert-success py-2 small mb-2">
                            <i class="fa-solid fa-droplet me-1"></i>
                            <strong>SQUEEZE applied:</strong> solvent mask subtracted. ABIN was added to the
                            .ins/.res (now loaded in the editor) and the mask is available to SHELXL as the
                            ${fab} project file. Run <em>Refine Structure</em> to re-refine with the mask.
                        </div>` + resultsSummary.innerHTML;
                    }
                    // Show a clear failure banner when SHELXL aborted.
                    if (program.id === 'shelxl' && (data.success === false || data.message)) {
                        const msg = data.message || 'SHELXL reported an error and did not complete the refinement.';
                        resultsSummary.innerHTML = `<div class="alert alert-danger py-2 small mb-2">
                            <i class="fa-solid fa-triangle-exclamation me-1"></i>
                            <strong>Refinement failed:</strong> ${msg}
                        </div>` + resultsSummary.innerHTML;
                    }
                }
                new bootstrap.Modal(modalEl).show();
            }
        } catch (e) {
            if (e && e.name === 'AbortError') {
                console.log(`${program.label} run cancelled by user`);
                alert(`${program.label} run cancelled or timed out.`);
            } else {
                console.error(`Failed to run ${program.label}:`, e);
                alert(`Failed to run ${program.label}: ${e.message}`);
            }
        } finally {
            settled = true;
            clearTimeout(safetyTimer);
            this.clearAbortSignalTimeout();
            if (btn) {
                btn.innerHTML = originalIcon || '<i class="fa-solid fa-flask"></i>';
                btn.disabled = false;
            }
            this.hideProgressDialog();
        }
    }

    // Parse an element/formula input ("C H N O" or "C12 H16 N2 O4" or
    // "C12H16N2O4") into { elements: [...], counts: [...] }.
    parseFormula(input) {
        const elements = [];
        const counts = [];
        const order = [];
        const map = new Map();
        const re = /([A-Z][a-z]?)(\d*)/g;
        let m;
        while ((m = re.exec(input)) !== null) {
            const el = m[1];
            const count = m[2] ? parseInt(m[2], 10) : 0;
            if (!map.has(el)) { map.set(el, 0); order.push(el); }
            map.set(el, map.get(el) + count);
        }
        for (const el of order) {
            elements.push(el);
            counts.push(map.get(el) || 0);
        }
        return { elements, counts };
    }

    // Replace the SFAC/UNIT lines of a generated SHELX .ins with the user's
    // formula/elements. Returns the modified text (or the original if unparseable).
    applyFormulaToIns(insText, input) {
        const { elements, counts } = this.parseFormula(input || '');
        if (!elements.length) return insText;
        // SHELXD/SHELXS abort with "** WRONG NUMBER OF PARAMETERS **" if there
        // are more than 13 SFAC types, so cap the generated list at that.
        const MAX_SFAC = 13;
        if (elements.length > MAX_SFAC) {
            console.warn(`applyFormulaToIns: formula has ${elements.length} elements; SHELXD/SHELXS accept at most ${MAX_SFAC} - truncating SFAC list.`);
            elements.length = MAX_SFAC;
            counts.length = MAX_SFAC;
        }
        const unitCounts = elements.map((c, i) => counts[i] > 0 ? counts[i] : 20);
        const sfacLine = 'SFAC ' + elements.join(' ');
        const unitLine = 'UNIT ' + unitCounts.join(' ');
        let out = insText.replace(/^SFAC.*$/m, sfacLine);
        out = out.replace(/^UNIT.*$/m, unitLine);
        return out;
    }

    // Load the corrected/merged HKL (SHELX format) as the active HKL in the UI
    // so subsequent steps (e.g. SHELXD / SHELXT) operate on it. The merged data
    // is uploaded into a server project (only referenced client-side), and a
    // matching SHELX .ins with the correct cell/space group is generated.
    // Returns the merged HKL basename, or null if no merged HKL was produced.
    async applyMergedHkl(result) {
        if (!result.merge || !result.merge.shelxHkl) return null;
        let base = 'structure';
        if (this.state.hklName) base = this.state.hklName.replace(/\.hkl$/i, '');
        base = base.replace(/[^a-zA-Z0-9_-]/g, '_');
        const mergedBase = base + '_merged';

        // Persist the merged reflections server-side so SHELXD/SHELXT runs reuse
        // them without the browser ever holding the content.
        try {
            const form = new FormData();
            form.append('file', new Blob([result.merge.shelxHkl], { type: 'text/plain' }), mergedBase + '.hkl');
            const res = await fetch(this.getApiUrl(`/projects/${encodeURIComponent(mergedBase)}/upload`), {
                method: 'POST', body: form
            });
            if (!res.ok) throw new Error('upload failed');
        } catch (e) {
            throw new Error('Could not store the merged HKL on the server: ' + e.message);
        }

        this.state.hklContent = null;
        this.state.hklName = mergedBase + '.hkl';
        this.state.hklServerProject = mergedBase;
        this.refreshHklStatus();

        // Generate a matching SHELX .ins (same basename) so SHELXD / SHELXT
        // can be run directly with the correct unit cell and space group.
        if (result.merge.shelxIns) {
            let insText = result.merge.shelxIns;
            // The composition is not known: ask the user for the expected
            // elements/formula instead of the generic scattering-factor list.
            const formula = prompt(
                'SHELXT: expected chemical elements / formula?\n' +
                '(e.g. "C H N O" or "C12 H16 N2 O4". Leave empty to keep the generic list)');
            if (formula !== null && formula.trim() !== '') {
                insText = this.applyFormulaToIns(insText, formula);
            }
            const insName = mergedBase + '.ins';
            this.state.xrdspaceIns = { filename: insName, content: insText };
            // The merged .ins becomes the active structure; ignore any previously
            // shown file tab when picking the file for external programs.
            this.state.lastStructureTabKey = null;
            if (this.state.editors.res) {
                this.state.editors.res.setValue(insText, -1);
                this.state.loadedContent = insText;
                this.state.loadedType = 'res';
                this.state.loadedFilename = insName;
                this.renderContent(insText, 'res');
            }
            this.openFileTab(insName, insText, 'res', null, false);
        }

        this.saveStateToLocalStorage();
        return mergedBase;
    }

    // Show the progress dialog for long-running jobs (external programs,
    // refinement). The elapsed-time counter updates every second.
    //
    // The dialog is shown and hidden manually rather than through Bootstrap's
    // modal API: Bootstrap animates the show/hide asynchronously, and a job that
    // finishes faster than the show animation (e.g. SHELXL aborting immediately
    // on a bad instruction) left a pending re-show callback that re-opened the
    // dialog forever. Manual show/hide has no such race.
    showProgressDialog(title, subtitle) {
        const el = document.getElementById('progressModal');
        if (!el) return null;
        document.getElementById('progress-title').textContent = title;
        document.getElementById('progress-subtitle').textContent = subtitle || '';
        const timeEl = document.getElementById('progress-time');
        this._progressStart = Date.now();
        if (this._progressInterval) clearInterval(this._progressInterval);
        if (timeEl) timeEl.textContent = 'Elapsed: 0 s';
        this._progressInterval = setInterval(() => {
            if (!timeEl) return;
            const s = Math.floor((Date.now() - this._progressStart) / 1000);
            timeEl.textContent = `Elapsed: ${s} s`;
        }, 1000);

        // Drop any stale Bootstrap modal instance so its pending show/hide
        // callbacks cannot re-show this dialog later.
        try {
            const existing = bootstrap.Modal.getInstance(el);
            if (existing) existing.dispose();
        } catch (e) { /* ignore */ }

        el.classList.add('show');
        el.style.display = 'block';
        el.removeAttribute('aria-hidden');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('role', 'dialog');
        document.body.classList.add('modal-open');
        if (!this._progressBackdrop || !document.body.contains(this._progressBackdrop)) {
            const bd = document.createElement('div');
            bd.className = 'modal-backdrop fade show';
            bd.id = 'progress-modal-backdrop';
            document.body.appendChild(bd);
            this._progressBackdrop = bd;
        }

        // Absolute hard deadline: no matter what drives this dialog, force it
        // closed after the configured timeout so it can never stay stuck.
        const timeout = this.state.preferences.general.refineTimeout || 180000;
        if (this._progressDeadline) clearTimeout(this._progressDeadline);
        this._progressDeadline = setTimeout(() => {
            this.hideProgressDialog();
        }, timeout + 5000);

        return null;
    }

    hideProgressDialog() {
        if (this._progressDeadline) {
            clearTimeout(this._progressDeadline);
            this._progressDeadline = null;
        }
        if (this._progressInterval) {
            clearInterval(this._progressInterval);
            this._progressInterval = null;
        }

        const gen = this._progressGen = (this._progressGen || 0) + 1;
        const forceHide = () => {
            // A newer dialog may have been shown since - do not hide it.
            if (this._progressGen !== gen) return;
            const el = document.getElementById('progressModal');
            if (el) {
                el.classList.remove('show');
                el.removeAttribute('aria-hidden');
                el.style.display = 'none';
            }
            if (this._progressBackdrop && document.body.contains(this._progressBackdrop)) {
                this._progressBackdrop.remove();
                this._progressBackdrop = null;
            }
            // Only release the body scroll lock if no other Bootstrap modal is open.
            const otherModalOpen = document.querySelector('.modal.show:not(#progressModal)') !== null;
            if (!otherModalOpen) {
                document.body.classList.remove('modal-open');
                document.querySelectorAll('.modal-backdrop').forEach(b => b.remove());
            }
        };

        forceHide();
        // A stale Bootstrap transition callback could re-show the dialog shortly
        // afterwards; hide again once transitions settle (guarded by generation).
        setTimeout(forceHide, 400);
        setTimeout(forceHide, 1200);
    }

    // Combined abort signal: user cancel (controller) + server timeout.
    // Falls back to a manual timeout when AbortSignal.any is unavailable so the
    // UI can never wait forever for a hung refinement.
    makeAbortSignal(controller) {
        const timeout = this.state.preferences.general.refineTimeout || 180000;
        if (typeof AbortSignal.any === 'function') {
            return AbortSignal.any([AbortSignal.timeout(timeout), controller.signal]);
        }
        if (this._refineAbortTimeout) clearTimeout(this._refineAbortTimeout);
        this._refineAbortTimeout = setTimeout(() => controller.abort(), timeout);
        return controller.signal;
    }

    // Clear the manual abort timeout created by makeAbortSignal().
    clearAbortSignalTimeout() {
        if (this._refineAbortTimeout) {
            clearTimeout(this._refineAbortTimeout);
            this._refineAbortTimeout = null;
        }
    }

    // -----------------------------------------------------------------------
    // Solve Structure & Validate (CheckCIF-style)
    // -----------------------------------------------------------------------

    async apiSolveInfo() {
        const res = await fetch(this.getApiUrl('/solve-info'));
        if (!res.ok) throw new Error('Failed to query solve pipeline status');
        return res.json();
    }

    openSolveModal(mode = 'solve') {
        const modalEl = document.getElementById('solveModal');
        if (!modalEl) return;
        this.state.solveMode = mode;
        this.state.solveResult = null;
        const title = document.getElementById('solve-modal-title');
        if (title) {
            title.innerHTML = mode === 'validate'
                ? '<i class="fa-solid fa-clipboard-check me-2"></i>Validate Structure (CheckCIF-style)'
                : '<i class="fa-solid fa-wand-magic-sparkles me-2"></i>Solve Structure & Validate';
        }
        // Toggle solve-specific options.
        for (const id of ['solve-program', 'solve-cycles', 'solve-do-refine', 'solve-do-platon']) {
            const el = document.getElementById(id);
            if (el) el.closest('.col-md-2,.col-md-3')?.classList.toggle('d-none', mode === 'validate');
        }
        const hint = modalEl.querySelector('.small.text-muted.mb-2');
        if (hint) {
            hint.textContent = mode === 'validate'
                ? 'Runs disorder/twinning detection and a CheckCIF-style report on the current model + refinement log. No files are modified.'
                : 'Automated pipeline: SHELXT/SHELXS solution (if no model) → SHELXL refinement → disorder/twinning detection + CheckCIF-style validation. Files are saved to projects/<name> on the server.';
        }

        // Context summary.
        const ctx = document.getElementById('solve-context');
        const name = this.state.loadedFilename
            || (this.state.lastStructureTabKey && this.state.fileTabs[this.state.lastStructureTabKey]?.filename)
            || '(none loaded)';
        if (ctx) ctx.textContent = name;
        if (ctx) ctx.title = name;

        // Populate program dropdown from server availability (default auto).
        this.apiSolveInfo().then(info => {
            const sel = document.getElementById('solve-program');
            if (!sel) return;
            const sols = info.solutions || ['shelxt'];
            sel.innerHTML = '<option value="auto">auto</option>'
                + sols.map(p => `<option value="${p}">${p.toUpperCase()}</option>`).join('');
            sel.value = 'auto';
            if (mode === 'solve' && !info.solutions.length) {
                const st = document.getElementById('solve-status');
                if (st) st.textContent = 'No solution program available on the server.';
            }
        }).catch(() => {});

        // Reset output panes.
        for (const id of ['solve-log-text', 'solve-report-text', 'solve-platon-text', 'solve-res-text']) {
            const el = document.getElementById(id);
            if (el) el.textContent = id === 'solve-log-text' ? 'Click Run to start.' : '(waiting for run)';
        }
        const st = document.getElementById('solve-status');
        if (st) st.textContent = '';
        const modal = new bootstrap.Modal(modalEl);
        modal.show();
    }

    // Build multipart body for solve/validate from current editor content.
    buildSolveForm(mode) {
        const structure = this.getStructureContent();
        if (!structure) throw new Error('No structure loaded. Load a .res/.ins/.cif first.');
        const safeBase = this.hklBaseName().replace(/[^a-zA-Z0-9_-]/g, '_');

        if (mode === 'validate') {
            const lst = this.state.editors.lst ? this.state.editors.lst.getValue() : '';
            const form = new FormData();
            form.append('res', new Blob([structure], { type: 'text/plain' }), safeBase + '.res');
            if (lst && lst.trim()) {
                form.append('lst', new Blob([lst], { type: 'text/plain' }), safeBase + '.lst');
            }
            form.append('platon', '0');
            return { form, safeBase };
        }

        if (!this.hasHkl()) {
            throw new Error('No HKL file available. Load an .hkl file or open a project that contains one to run the solve pipeline.');
        }
        const form = new FormData();
        form.append('ins', new Blob([structure], { type: 'text/plain' }), safeBase + '.ins');
        this.appendHklPart(form, safeBase);
        form.append('program', (document.getElementById('solve-program') || {}).value || 'auto');
        form.append('cycles', (document.getElementById('solve-cycles') || {}).value || '3');
        form.append('refine', document.getElementById('solve-do-refine')?.checked ? '1' : '0');
        form.append('platon', document.getElementById('solve-do-platon')?.checked ? '1' : '0');
        return { form, safeBase };
    }

    renderSolveResult(result) {
        this.state.solveResult = result;
        const log = document.getElementById('solve-log-text');
        const report = document.getElementById('solve-report-text');
        const platon = document.getElementById('solve-platon-text');
        const res = document.getElementById('solve-res-text');
        const status = document.getElementById('solve-status');
        if (log) log.textContent = result.logText || (result.steps || []).map(s => `[${s.status}] ${s.label}${s.message ? ' — ' + s.message : ''}`).join('\n');
        if (report) report.textContent = result.reportText || '(no report)';
        if (platon) {
            if (result.platon) {
                const p = result.platon;
                const text = p.ok
                    ? `PLATON completed.\n\n${p.files ? Object.entries(p.files).map(([f, t]) => `===== ${f} =====\n${t}`).join('\n\n') : ''}${p.stdout || p.stderr ? `\n===== stdout/stderr =====\n${p.stdout || ''}${p.stderr || ''}` : ''}`
                    : `PLATON: ${p.reason || 'not run'}\n${p.stdout || ''}${p.stderr ? '\n' + p.stderr : ''}`;
                platon.textContent = text.trim() || 'PLATON returned no output.';
            } else {
                platon.textContent = '(PLATON not run)';
            }
        }
        if (res && result.files && result.files.res) res.textContent = result.files.res;
        if (status) {
            const c = result.report?.count;
            status.textContent = result.success
                ? 'Done — no level-A alerts.'
                : (c ? `Done — A:${c.A} B:${c.B} C:${c.C}` : 'Done');
        }
    }

    async runSolvePipeline() {
        const mode = this.state.solveMode || 'solve';
        const btn = document.getElementById('btn-solve-run');
        if (btn) btn.disabled = true;
        const status = document.getElementById('solve-status');
        const endpoint = mode === 'validate' ? '/validate-structure' : '/solve-structure';
        if (status) status.textContent = 'Running… (SHELX runs can take a while)';
        try {
            if (mode !== 'validate' && !(await this.ensureHklForRun())) {
                throw new Error('No HKL file available. Load an .hkl file or open a project that contains one to run the solve pipeline.');
            }
            const { form } = this.buildSolveForm(mode);
            const controller = new AbortController();
            this.solveAbort = controller;
            const timeout = Math.max(this.state.preferences?.general?.refineTimeout || 180000, 600000);
            const res = await fetch(this.getApiUrl(endpoint), {
                method: 'POST',
                body: form,
                signal: typeof AbortSignal.any === 'function'
                    ? AbortSignal.any([AbortSignal.timeout(timeout), controller.signal])
                    : controller.signal
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || data.details || `HTTP ${res.status}`);
            this.renderSolveResult(data);
        } catch (e) {
            if (status) status.textContent = '';
            const log = document.getElementById('solve-log-text');
            if (log) log.textContent = (e.name === 'TimeoutError') ? 'Pipeline timed out.' : `Error: ${e.message}`;
        } finally {
            this.solveAbort = null;
            if (btn) btn.disabled = false;
        }
    }

    // Load the refined .res produced by a solve run into the structure editor.
    loadSolveResultRes() {
        const result = this.state.solveResult;
        if (!result || !result.files || !result.files.res) {
            alert('No refined .res result to load yet.');
            return;
        }
        const editor = this.state.editors.res;
        if (editor) {
            editor.setValue(result.files.res, -1);
            this.state.loadedContent = result.files.res;
            this.state.loadedFilename = `${result.project || 'structure'}.res`;
            this.state.loadedType = 'res';
            this.renderContent(result.files.res, 'res');
            this.tryRender('res');
        }
        if (result.files && result.files.lst) {
            const lstEditor = this.state.editors.lst;
            if (lstEditor) lstEditor.setValue(result.files.lst, -1);
        }
    }

    // Hide xrdspace-only controls (merged-HKL buttons, solution selector) so a
    // fresh results modal does not show leftovers from a previous run.
    resetResultsControls() {
        const b1 = document.getElementById('btn-load-merged-hkl');
        const b2 = document.getElementById('btn-download-merged-hkl');
        const b3 = document.getElementById('btn-transform-to-sg');
        const sel = document.getElementById('solution-selector');
        if (b1) b1.classList.add('d-none');
        if (b2) b2.classList.add('d-none');
        if (b3) b3.classList.add('d-none');
        if (sel) sel.classList.add('d-none');
    }

    // Parse SHELXT / SHELXD solution rows from stdout and match them to the
    // .res files returned by the server.
    parseShelxSolutions(stdout, resFiles) {
        const bases = new Set(resFiles.map(f => f.replace(/\.res$/i, '')));
        const solutions = [];
        for (const line of (stdout || '').split(/\r?\n/)) {
            const tokens = line.trim().split(/\s+/).filter(Boolean);
            if (tokens.length < 5) continue;
            const idx = tokens.findIndex(t => bases.has(t));
            if (idx === -1) continue;
            const r1 = parseFloat(tokens[0]);
            let sg = '';
            for (let i = idx - 1; i >= 0; i--) {
                const t = tokens[i];
                if (['no', 'Fp', 'input', 'as', '&'].includes(t)) continue;
                if (!isNaN(parseFloat(t))) continue;
                sg = t;
                break;
            }
            solutions.push({
                base: tokens[idx],
                filename: tokens[idx] + '.res',
                r1: isNaN(r1) ? null : r1,
                spaceGroup: sg || '?',
                formula: tokens.slice(idx + 1).join(' '),
            });
        }
        return solutions;
    }

    // Show a selector of structure solutions (e.g. from SHELXT) and load the
    // chosen one into the editor / 3D view.
    populateSolutionSelector(solutions, files) {
        const wrap = document.getElementById('solution-selector');
        const select = document.getElementById('solution-select');
        if (!wrap || !select || !solutions.length) {
            if (wrap) wrap.classList.add('d-none');
            return;
        }
        select.innerHTML = solutions.map((s, i) => {
            const r1 = s.r1 !== null ? `R1=${s.r1.toFixed(3)}` : '';
            const label = `${s.base}: ${s.spaceGroup}${r1 ? '  ' + r1 : ''}${s.formula ? '  ' + s.formula : ''}`;
            return `<option value="${s.filename}">${label}</option>`;
        }).join('');
        select.onchange = () => {
            const filename = select.value;
            if (files[filename]) this.loadSolutionToUi(filename, files);
        };
        wrap.classList.remove('d-none');
    }

    // Load a structure solution (.res) into the editor and 3D view.
    loadSolutionToUi(filename, files) {
        const content = files[filename];
        if (!content || !this.state.editors.res) return;
        this.state.editors.res.setValue(content, -1);
        this.state.loadedContent = content;
        this.state.loadedType = 'res';
        this.state.loadedFilename = filename;
        this.renderContent(content, 'res');
        const statusEl = document.getElementById('status-bar-content');
        if (statusEl) statusEl.textContent = `Solution loaded: ${filename}`;
    }

    // Wire the "Download Merged HKL" and "Load Merged HKL for SHELXT" buttons
    // shown after a xrdspace analysis.
    wireMergedHklButtons(result) {
        const hasMerged = !!(result.merge && result.merge.shelxHkl);
        const btnDownload = document.getElementById('btn-download-merged-hkl');
        const btnLoad = document.getElementById('btn-load-merged-hkl');
        const btnTransform = document.getElementById('btn-transform-to-sg');
        // xrdspace results have no solution selector.
        const selWrap = document.getElementById('solution-selector');
        if (selWrap) selWrap.classList.add('d-none');

        // "Transform model to space group": relevant when a space group is known
        // (forced, or the auto-determined best) AND a model is loaded in editor.
        const sgName = (result.forced && result.forced.hm) || (result.best && result.best.hm) || null;
        const canTransform = !!(sgName && this.getStructureContent());
        if (btnTransform) {
            btnTransform.classList.toggle('d-none', !canTransform);
            if (canTransform) {
                btnTransform.title = `Rewrite the loaded model into space group ${sgName}. Raises symmetry (removes redundant molecules) or lowers it (adds symmetry partners).`;
                btnTransform.onclick = () => this.transformModelToSg(result);
            }
        }

        if (!hasMerged) {
            if (btnDownload) btnDownload.classList.add('d-none');
            if (btnLoad) btnLoad.classList.add('d-none');
            return;
        }
        if (btnDownload) {
            btnDownload.classList.remove('d-none');
            btnDownload.onclick = () => {
                let base = 'structure';
                if (this.state.hklName) base = this.state.hklName.replace(/\.hkl$/i, '');
                base = base.replace(/[^a-zA-Z0-9_-]/g, '_');
                const blob = new Blob([result.merge.shelxHkl], { type: 'text/plain' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = base + '.hkl';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
            };
        }
        if (btnLoad) {
            btnLoad.classList.remove('d-none');
            btnLoad.onclick = async () => {
                try {
                    const mergedBase = await this.applyMergedHkl(result);
                    const summary = document.getElementById('results-summary');
                    if (mergedBase && summary) {
                        const note = document.createElement('div');
                        note.className = 'alert alert-success py-1 px-2 small mb-0 mt-1';
                        note.textContent = `Merged HKL loaded as ${mergedBase}.hkl — ready for SHELXD / SHELXT.`;
                        summary.appendChild(note);
                    }
                } catch (e) {
                    alert('Could not load the merged HKL: ' + e.message);
                }
            };
        }
    }

    // Menu entry: ask which space group to transform the loaded model into.
    async transformModelToSgPrompt() {
        const structure = this.getStructureContent();
        if (!structure) {
            alert('No structure loaded in the editor to transform. Load a .res/.ins model first.');
            return;
        }
        const input = prompt(
            'Transform the loaded model into which space group?\n' +
            'Enter a space group number or Hermann-Mauguin symbol\n(e.g. 14, or "P 21/c", "P-1", "C 2/c"):');
        if (input === null || input.trim() === '') return;
        await this.transformModelToSg({ best: { hm: input.trim() } }, input.trim());
    }

    // Rewrite the loaded model into a space group (from an xrdspace result, or
    // the space group typed by the user). The server expands/removes
    // symmetry-related molecules; the result replaces the structure in editor.
    async transformModelToSg(result, explicitSg = null) {
        const structure = this.getStructureContent();
        if (!structure) {
            alert('No structure loaded in the editor to transform.');
            return;
        }
        const sg = explicitSg
            || (result && ((result.forced && result.forced.hm) || (result.best && result.best.hm)))
            || null;
        if (!sg) {
            alert('No space group available to transform into.');
            return;
        }
        const label = (result && result.forced && result.forced.id)
            ? `${sg} (No. ${result.forced.id})` : String(sg);
        if (!confirm(`Transform the loaded model into space group ${label}?\n\n` +
            'Higher-symmetry target: redundant (symmetry-related) molecules are removed.\n' +
            'Lower-symmetry target: symmetry partners are added.\n\n' +
            'Best results when the current model is a proper asymmetric unit under its declared LATT/SYMM. ' +
            'The transformed model will replace the current editor content.')) {
            return;
        }
        const status = document.getElementById('status-bar-content');
        if (status) status.textContent = `Transforming model to ${sg}...`;
        try {
            const out = await this.apiTransformModelToSg(structure, sg);
            this.applyTransformModelToSg(out);
        } catch (e) {
            alert(`Transform failed: ${e.message}`);
        }
    }

    // --- Fetch Structure from COD / PDB ---------------------------------

    openFetchDbModal() {
        const modalEl = document.getElementById('fetchDbModal');
        if (!modalEl) return;
        const status = document.getElementById('fetch-status');
        if (status) status.textContent = '';
        const body = document.getElementById('fetch-results-body');
        if (body) body.innerHTML = '<tr><td colspan="7" class="text-muted small">Enter a unit cell and search.</td></tr>';
        // Default the ID field to the current project name when it looks like an entry id.
        const idInput = document.getElementById('fetch-id-input');
        if (idInput && !idInput.value && this.state.currentProject) {
            const m = String(this.state.currentProject).match(/^(?:COD|PDB)[_-](.+)$/i);
            if (m) idInput.value = m[1];
        }
        new bootstrap.Modal(modalEl).show();
    }

    // Copy the unit cell of the currently loaded structure into the search box.
    useCurrentCellForFetch() {
        const input = document.getElementById('fetch-cell-input');
        if (!input) return;
        const cell = this.state.parsedData && this.state.parsedData.cell;
        if (cell && [cell.a, cell.b, cell.c, cell.alpha, cell.beta, cell.gamma].every(Number.isFinite)) {
            input.value = [cell.a, cell.b, cell.c, cell.alpha, cell.beta, cell.gamma]
                .map(v => (+v).toFixed(4)).join(' ');
        } else {
            alert('No unit cell available from the loaded structure. Enter a b c alpha beta gamma manually.');
        }
    }

    async runDbCellSearch() {
        const raw = (document.getElementById('fetch-cell-input') || {}).value || '';
        const vals = raw.trim().split(/\s+/).map(Number);
        if (vals.length !== 6 || !vals.every(Number.isFinite)) {
            alert('Enter a unit cell as six numbers: a b c alpha beta gamma.');
            return;
        }
        const databases = [];
        if ((document.getElementById('fetch-db-cod') || {}).checked) databases.push('COD');
        if ((document.getElementById('fetch-db-pdb') || {}).checked) databases.push('PDB');
        if (!databases.length) { alert('Select at least one database.'); return; }

        const tolPct = parseFloat((document.getElementById('fetch-tol') || {}).value) || 1.0;
        const tolAng = parseFloat((document.getElementById('fetch-tol-ang') || {}).value) || 1.5;
        const btn = document.getElementById('btn-fetch-search');
        const status = document.getElementById('fetch-search-status');
        if (btn) btn.disabled = true;
        if (status) status.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Searching… (may take a moment)';
        try {
            const r = await this.apiDbSearch({
                cell: raw,
                databases,
                tolLen: tolPct / 100,
                tolAng,
                limit: 50,
            });
            this.renderDbSearchResults(r);
            if (status) status.textContent = `${r.results.length} match(es) shown of ${r.total} total.`;
        } catch (e) {
            if (status) status.textContent = '';
            alert('Search failed: ' + e.message);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    renderDbSearchResults(result) {
        const body = document.getElementById('fetch-results-body');
        if (!body) return;
        const rows = result && result.results ? result.results : [];
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="7" class="text-muted small">No matching structures found. Widen the tolerances.</td></tr>';
            return;
        }
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        body.innerHTML = rows.map(e => {
            const c = e.cell;
            const cell = c ? `${(+c.a).toFixed(3)} ${(+c.b).toFixed(3)} ${(+c.c).toFixed(3)} ${(+c.alpha).toFixed(1)} ${(+c.beta).toFixed(1)} ${(+c.gamma).toFixed(1)}` : '?';
            const sg = e.spaceGroup ? (e.spaceGroup.hm || ('No. ' + (e.spaceGroup.number || '?'))) : '?';
            const details = e.database === 'COD'
                ? (e.chemname || e.formula || e.title || '')
                : (e.title || '');
            const match = e.match !== undefined && e.match !== null ? (+e.match).toFixed(1) : '';
            const badge = e.database === 'COD' ? 'primary' : 'success';
            return `<tr>
                <td><span class="badge bg-${badge}">${esc(e.database)}</span></td>
                <td class="fw-semibold">${esc(e.id)}</td>
                <td class="small text-nowrap">${cell}</td>
                <td class="small">${esc(sg)}</td>
                <td class="small">${match}</td>
                <td class="small text-truncate" style="max-width:220px;" title="${esc(details)}">${esc(details)}</td>
                <td><button class="btn btn-sm btn-outline-success" data-db="${esc(e.database)}" data-id="${esc(e.id)}"><i class="fa-solid fa-download me-1"></i>Fetch</button></td>
            </tr>`;
        }).join('');
        body.querySelectorAll('button[data-db]').forEach(b => {
            b.onclick = () => this.fetchDbEntry(b.dataset.db, b.dataset.id, b);
        });
    }

    // Download an entry (search result or direct id), save it as a project and
    // load the structure into the viewer.
    async fetchDbEntry(database, id, btn) {
        const status = document.getElementById('fetch-status');
        const opts = {};
        if (database === 'PDB') {
            const fmt = (document.getElementById('fetch-id-format') || {}).value;
            if (fmt) opts.format = fmt;
        }
        const original = btn ? btn.innerHTML : null;
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>'; }
        if (status) {
            status.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Downloading ${database} ${id} and saving project…`;
        }
        try {
            const r = await this.apiDbFetch(database, id, opts);
            if (status) {
                status.innerHTML = `<span class="text-success"><i class="fa-solid fa-check me-1"></i>Saved project <strong>${r.project}</strong> (${(r.files || []).join(', ')}).</span>`;
            }
            const modalEl = document.getElementById('fetchDbModal');
            const modal = modalEl ? bootstrap.Modal.getInstance(modalEl) : null;
            if (modal) modal.hide();
            if (r.structureFile) {
                await this.loadSpecificFileFromServer(r.project, r.structureFile, false, true);
                const statusBar = document.getElementById('status-bar-content');
                if (statusBar) statusBar.textContent = `Fetched ${database} ${id} → project ${r.project}`;
            }
            return r;
        } catch (e) {
            if (status) status.textContent = '';
            alert(`Fetch failed: ${e.message}`);
        } finally {
            if (btn && original !== null) { btn.disabled = false; btn.innerHTML = original; }
        }
    }

    async fetchDbById() {
        const database = (document.getElementById('fetch-id-db') || {}).value || 'COD';
        const id = ((document.getElementById('fetch-id-input') || {}).value || '').trim();
        if (!id) { alert('Enter a COD number or PDB id.'); return; }
        const btn = document.getElementById('btn-fetch-by-id');
        await this.fetchDbEntry(database, id, btn);
    }

    // Run the built-in xrdspace space-group determination on the current HKL
    // data and show the result in the results modal. `forced` optionally pins
    // a specific space group (number or Hermann-Mauguin symbol).
    async runSpaceGroupAnalysis(forced) {
        if (!(await this.ensureHklForRun())) {
            alert('No HKL file available. Please load an .hkl file first.');
            return;
        }
        // The HKL may be stored server-side (project) rather than in the browser.
        const hklContent = this.state.hklContent;
        const project = hklContent ? null : (this.state.hklServerProject || this.state.currentProject);

        const btn = document.getElementById('tool-refine');
        const originalIcon = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            btn.disabled = true;
        }

        // Progress dialog (xrdspace can be slow on large datasets). It is only
        // shown when an analysis is actually about to run — never for the
        // NO_CELL probe that just asks for the unit cell.
        const controller = new AbortController();
        const cancelBtn = document.getElementById('btn-cancel-progress');
        if (cancelBtn) cancelBtn.onclick = () => controller.abort();
        const hasCellInFile = hklContent && /!UNIT_CELL_CONSTANTS\s*=/.test(hklContent);

        try {
            let result;
            if (hasCellInFile) {
                this.showProgressDialog('Space-group determination (xrdspace)...',
                    'Analyzing Laue symmetry, centering and systematic absences.');
            }
            result = await this.apiXrdspaceAnalyze(hklContent, null, forced, controller.signal, project);

            // The HKL file carries no unit-cell parameters: ask for them.
            if (result.error === 'NO_CELL') {
                const input = prompt(
                    'This HKL file has no unit-cell parameters.\nEnter unit cell: a b c alpha beta gamma\n(e.g. 10.5 10.5 14.0 90 90 90)');
                if (input === null) return; // cancelled - no analysis ran, no dialog
                this.showProgressDialog('Space-group determination (xrdspace)...',
                    'Analyzing Laue symmetry, centering and systematic absences.');
                result = await this.apiXrdspaceAnalyze(hklContent, input, forced, controller.signal, project);
            }

            if (!result.ok) {
                throw new Error(result.error || 'Space-group analysis failed');
            }

            const modalEl = document.getElementById('resultsModal');
            const resultsContent = document.getElementById('results-content');
            const resultsSummary = document.getElementById('results-summary');
            if (resultsContent && modalEl) {
                this.resetResultsControls();
                resultsSummary.innerHTML = this.buildSpaceGroupSummary(result);
                resultsContent.textContent = this.buildSpaceGroupReport(result);
                this.wireMergedHklButtons(result);
                new bootstrap.Modal(modalEl).show();
            }
        } catch (e) {
            if (e && e.name === 'AbortError') {
                console.log('xrdspace analysis cancelled by user');
                alert('Space-group analysis cancelled.');
            } else {
                console.error('xrdspace analysis failed:', e);
                alert('Space-group analysis failed: ' + e.message);
            }
        } finally {
            if (btn) {
                btn.innerHTML = originalIcon || '<i class="fa-solid fa-flask"></i>';
                btn.disabled = false;
            }
            this.hideProgressDialog();
        }
    }

    // HTML summary card for the xrdspace result (top of the results modal).
    buildSpaceGroupSummary(result) {
        const s = result.summary;
        const b = result.best;
        const cell = result.cell;
        const fmt = (x) => x === null || x === undefined ? '?' : String(x);
        const items = [
            ['Crystal system', s.crystalSystem + (s.uniqueAxis ? ' (unique ' + s.uniqueAxis + ')' : '')],
            ['Laue class', `${s.laueClass}  (R(sym) ${(s.laueRSym * 100).toFixed(2)} %)`],
            ['Centering', s.centering],
            ['Centrosymmetric', s.centricity],
            ['Format', s.format],
            ['Reflections', s.nReflections],
        ];
        const cellTxt = cell ? `${cell.a} ${cell.b} ${cell.c}  ${cell.alpha} ${cell.beta} ${cell.gamma}` : '?';
        const rows = items.map(([k, v]) =>
            `<tr><td class="text-muted pe-3">${k}</td><td class="fw-semibold">${v}</td></tr>`).join('');
        let sgRow = '';
        if (s.forced) {
            sgRow += `<tr><td class="text-muted pe-3">Forced space group</td>
                <td class="fw-bold fs-6 text-primary">${b.hm} (No. ${b.id})</td></tr>`;
            if (result.determined) {
                sgRow += `<tr><td class="text-muted pe-3">Determined (auto)</td>
                    <td class="fw-semibold">${result.determined.hm} (No. ${result.determined.id})</td></tr>`;
            }
        } else {
            sgRow += `<tr><td class="text-muted pe-3">Best space group</td>
                <td class="fw-bold fs-6 ${b ? 'text-success' : ''}">${b ? b.hm + ' (No. ' + b.id + ')' : 'indeterminate'}</td></tr>`;
        }
        if (result.merge && result.merge.consistency) {
            const c = result.merge.consistency;
            const ok = c.violations === 0;
            sgRow += `<tr><td class="text-muted pe-3">Data consistency</td>
                <td class="fw-semibold ${ok ? 'text-success' : 'text-danger'}">${ok ? 'consistent' : 'INCONSISTENT (' + c.violations + ' violation(s))'}</td></tr>`;
        }
        return `<div class="border rounded p-2 bg-light mb-2">
            <div class="fw-semibold small text-uppercase text-muted mb-1">Space-group determination (xrdspace)</div>
            <table class="table table-sm table-borderless align-middle mb-1">
                <tbody>
                    ${rows}
                    <tr><td class="text-muted pe-3">Unit cell</td><td class="fw-semibold">${cellTxt}</td></tr>
                    ${sgRow}
                </tbody>
            </table>
        </div>`;
    }

    // Plain-text report of the full xrdspace result (scrollable body).
    buildSpaceGroupReport(result) {
        const s = result.summary;
        const out = [];
        out.push('xrdspace — space-group determination');
        out.push('==============================================');
        out.push(`Format        : ${s.format}`);
        if (s.title) out.push(`Title         : ${s.title}`);
        out.push(`Reflections   : ${s.nReflections}`);
        out.push(`Crystal system: ${s.crystalSystem}${s.uniqueAxis ? ' (unique ' + s.uniqueAxis + ')' : ''}`);
        out.push(`Centering     : ${s.centering}`);
        out.push(`Centrosymmetric: ${s.centricity}  (<|E^2-1|> = ${s.centricityScore.toFixed(3)})`);
        out.push(`Laue class    : ${s.laueClass}  R(sym) = ${(s.laueRSym * 100).toFixed(2)} %`);
        if (result.determined && s.forced) {
            out.push(`Determined SG  : ${result.determined.hm} (No. ${result.determined.id})`);
        }
        out.push('');
        out.push('R(sym) by Laue class:');
        for (const row of result.laueTable) {
            out.push(`  ${String(row.name).padEnd(7)} order ${String(row.order).padStart(2)}  R(sym) = ${(row.rsym * 100).toFixed(2)} %${row.chosen ? '  <--' : ''}`);
        }
        out.push('');
        out.push('Space-group candidates (systematic absences):');
        if (!result.candidates.length) {
            out.push('  (no candidates matched)');
        } else {
            for (const c of result.candidates.slice(0, 15)) {
                const mark = result.best && c.id === result.best.id ? '  <-- best' : '';
                out.push(`  ${String(c.id).padStart(3)}  ${c.hm.padEnd(20)} violations ${String(c.violations).padStart(4)}${mark}`);
            }
        }
        if (result.best) {
            out.push('');
            out.push(`Best space group: ${result.best.hm}  (No. ${result.best.id})${s.forced ? '  [forced]' : ''}`);
        }
        if (result.merge && result.merge.consistency) {
            const c = result.merge.consistency;
            const ok = c.violations === 0;
            out.push(`Data consistency: ${ok ? 'consistent with data' : 'INCONSISTENT (' + c.violations + ' violation(s))'}`);
        }
        if (result.merge && result.merge.report) {
            out.push('');
            out.push('');
            out.push(result.merge.report);
        }
        return out.join('\n');
    }

    async refineStructure() {
        if (!this.state.editors.res && !this.state.lastStructureTabKey) return;

        const resContent = this.getStructureContent();
        if (!resContent) {
            alert("No structure loaded to refine.");
            return;
        }

        if (!(await this.ensureHklForRun())) {
            alert("No HKL file available. Please load an .hkl file first.");
            return;
        }

        const formData = new FormData();
        const insBlob = new Blob([resContent], { type: 'text/plain' });

        // Ensure consistent filenames. Use the HKL/project basename if available.
        let baseName = this.hklBaseName().replace(/[^a-zA-Z0-9_-]/g, '_');

        formData.append('ins', insBlob, baseName + '.ins');
        this.appendHklPart(formData, baseName);

        await this.runRefinement(formData, 'tool-refine', 'Refining structure (SHELXL)...');
    }

    // Weight (GOOF) refinement: prompts for the number of SHELXL cycles (default 3)
    // and runs that many refinement cycles to drive the goodness-of-fit toward 1.
    async refineWeight() {
        if (!this.state.editors.res && !this.state.lastStructureTabKey) return;

        const resContent = this.getStructureContent();
        if (!resContent) {
            alert("No structure loaded to refine.");
            return;
        }

        if (!(await this.ensureHklForRun())) {
            alert("No HKL file available. Please load an .hkl file first.");
            return;
        }

        // Prompt for the number of SHELXL refinement cycles (default 3).
        const cyclesInput = prompt("Weight (GOOF) refinement — number of SHELXL cycles:", "3");
        if (cyclesInput === null) return; // cancelled
        let cycles = parseInt(cyclesInput, 10);
        if (!Number.isFinite(cycles) || cycles < 1) cycles = 1;
        if (cycles > 50) cycles = 50;

        const formData = new FormData();
        const insBlob = new Blob([resContent], { type: 'text/plain' });

        let baseName = this.hklBaseName().replace(/[^a-zA-Z0-9_-]/g, '_');

        formData.append('ins', insBlob, baseName + '.ins');
        this.appendHklPart(formData, baseName);
        formData.append('cycles', String(cycles));
        formData.append('mode', 'weight');

        await this.runRefinement(formData, 'tool-refine', 'Weight (GOOF) refinement...');
    }

    // Shared refinement runner: POSTs form data to the server, updates the RES/LST
    // editors and shows the results modal. `btnId` is the toolbar button to spin.
    // `title` is shown in the progress dialog.
    async runRefinement(formData, btnId, title = 'Refining structure (SHELXL)...') {
        const btn = document.getElementById(btnId);
        const originalIcon = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            btn.disabled = true;
        }

        // Progress dialog with cancel support.
        const controller = new AbortController();
        const cancelBtn = document.getElementById('btn-cancel-progress');
        if (cancelBtn) cancelBtn.onclick = () => controller.abort();
        this.showProgressDialog(title, 'SHELXL least-squares refinement in progress.');

        // Absolute safety net: if the request is stuck at the network layer and
        // the abort signal is not honoured, force the UI back to normal so the
        // progress spinner can never stay on screen indefinitely.
        const timeout = this.state.preferences.general.refineTimeout || 180000;
        let settled = false;
        const safetyTimer = setTimeout(() => {
            if (settled) return;
            console.warn('Refinement timed out - forcibly resetting progress UI.');
            controller.abort();
            this.hideProgressDialog();
            if (btn) {
                btn.innerHTML = originalIcon || '<i class="fa-solid fa-flask"></i>';
                btn.disabled = false;
            }
        }, timeout + 5000);

        try {
            const response = await fetch(this.state.preferences.general.serverUrl, {
                method: 'POST',
                body: formData,
                signal: this.makeAbortSignal(controller)
            });

            if (!response.ok) {
                let detail = '';
                try {
                    const errBody = await response.json();
                    detail = errBody.error || errBody.details || '';
                } catch (err) { /* non-JSON error body */ }
                throw new Error(`Server error: ${response.statusText}${detail ? ` — ${detail}` : ''}`);
            }

            const data = await response.json();
            console.log("Server Response Data:", data);
            this.clearAbortSignalTimeout();
            settled = true;
            clearTimeout(safetyTimer);

            if (data.error) {
                throw new Error(data.error);
            }

            // Update RES editor
            if (data.files && data.files.res) {
                this.state.editors.res.setValue(data.files.res, -1);
                this.state.loadedContent = data.files.res; // Update source of truth
                this.renderContent(data.files.res, 'res');
                console.log("Refinement successful");
            }

            // Log LST output
            if (data.files && data.files.lst) {
                console.log("--- SHELXL OUTPUT ---");
                console.log(data.files.lst);

                // Combine stdout and lst
                let combinedOutput = "";
                if (data.stdout) {
                    combinedOutput += "--- STDOUT ---\n" + data.stdout + "\n\n";
                }
                combinedOutput += "--- LST FILE ---\n" + data.files.lst;

                // Update LST Editor
                if (this.state.editors.lst) {
                    this.state.editors.lst.setValue(combinedOutput, -1);
                }

                // Show Results Modal
                const resultsContent = document.getElementById('results-content');
                const resultsSummary = document.getElementById('results-summary');
                const modalEl = document.getElementById('resultsModal');

                if (resultsContent && modalEl) {
                    try {
                        this.resetResultsControls();
                        resultsContent.textContent = combinedOutput;
                        if (resultsSummary) {
                            // If SHELXL aborted (no .res produced / explicit failure),
                            // show a clear error banner instead of a silent "stuck" UI.
                            const failed = data.success === false
                                || (data.files.res !== undefined && data.files.res.trim().length === 0);
                            let summaryHtml = this.buildRefinementSummary(data.files.lst || '');
                            if (failed) {
                                const msg = data.message || 'SHELXL reported an error and did not complete the refinement.';
                                summaryHtml = `<div class="alert alert-danger py-2 small mb-2">
                                    <i class="fa-solid fa-triangle-exclamation me-1"></i>
                                    <strong>Refinement failed:</strong> ${msg}
                                </div>` + summaryHtml;
                            }
                            resultsSummary.innerHTML = summaryHtml;
                        }
                        const resultsModal = new bootstrap.Modal(modalEl);
                        resultsModal.show();
                    } catch (err) {
                        console.error("Error showing modal:", err);
                        alert("Refinement finished. Check console for output.");
                    }
                } else {
                    console.error("Results modal elements not found in DOM");
                }
            } else if (data.files && !data.files.lst) {
                // No LST produced at all - surface the failure clearly.
                console.error("No SHELXL output produced.", data);
                alert(data.message || 'SHELXL produced no output. The refinement was aborted.');
            }

        } catch (e) {
            if (e && e.name === 'AbortError') {
                console.log("Refinement cancelled by user");
                alert("Refinement cancelled or timed out.");
            } else {
                console.error("Refinement failed:", e);
                alert("Refinement failed: " + e.message);
            }
        } finally {
            settled = true;
            clearTimeout(safetyTimer);
            this.clearAbortSignalTimeout();
            if (btn) {
                btn.innerHTML = originalIcon || '<i class="fa-solid fa-flask"></i>';
                btn.disabled = false;
            }
            this.hideProgressDialog();
        }
    }

    resetView() {
        if (!this.state.controls) return;
        this.state.controls.reset();
        
        // Get bounding radius
        const radius = (this.state.moleculeRenderer && this.state.moleculeRenderer.boundingRadius) 
                     ? this.state.moleculeRenderer.boundingRadius 
                     : 10; // Default fallback

        // Reset camera position based on type
        if (this.state.viewSettings.orthographic) {
             // Orthographic: Adjust zoom to fit
             // We assume frustum height is 40 (top=20) from onWindowResize
             // We want visible height/2 = radius / 0.8
             // zoom = top * 0.8 / radius
             // top is 20
             const newZoom = (20 * 0.8) / radius;
             
             this.state.camera.zoom = Math.max(0.1, newZoom);
             this.state.camera.position.set(0, 0, 20);
             this.state.camera.updateProjectionMatrix();
        } else {
             // Perspective: Adjust distance
             // distance = radius / (0.8 * sin(fov/2))
             const fov = this.state.camera.fov * (Math.PI / 180);
             const dist = radius / (0.8 * Math.sin(fov / 2));
             
             this.state.camera.position.set(0, 0, dist);
        }
        this.state.controls.update();
        this.onWindowResize();
    }

    toggleRSR() {
        const btn = document.getElementById('tool-rsr');
        if (this.state.rsr.active) {
            if (this.state.preview.active) {
                this.cancelFragmentPlacement();
            }
            this.state.rsr.active = false;
            this.state.rsr.from = null;
            this.state.rsr.to = null;
            if (btn) btn.classList.remove('active');
            this.deselectAll();
            document.body.style.cursor = 'default';
            document.getElementById('status-bar-content').textContent = "Real Space Refinement Deactivated";
        } else {
            if (!this.state.cachedMapData && !this.state.currentMapData) {
                alert("Please load an FCF map first for Real Space Refinement.");
                return;
            }
            this.state.rsr.active = true;
            this.state.rsr.from = null;
            this.state.rsr.to = null;
            if (btn) btn.classList.add('active');
            document.body.style.cursor = 'crosshair';
            document.getElementById('status-bar-content').textContent = "Real Space Refinement: Click 'From' atom";
        }
    }

    async performRealSpaceRefinement() {
        const from = this.state.rsr.from;
        const to = this.state.rsr.to;
        
        if (!from || !to) return;
        
        // Find all atoms in range (using lineNumber to match even if symmetry-expanded)
        const atoms = this.state.parsedData.atoms;
        const fromIdx = atoms.findIndex(a => (a.lineNumber || a.startLine) === (from.lineNumber || from.startLine));
        const toIdx = atoms.findIndex(a => (a.lineNumber || a.startLine) === (to.lineNumber || to.startLine));
        
        if (fromIdx === -1 || toIdx === -1) {
            alert("Atoms not found in structure.");
            return;
        }

        const start = Math.min(fromIdx, toIdx);
        const end = Math.max(fromIdx, toIdx);
        
        const subset = atoms.slice(start, end + 1);
        
        console.log(`Refining ${subset.length} atoms...`);
        
        try {
            // Ensure we have a map
            if (!this.state.cachedMapData) {
                const type = document.getElementById('map-type').value || '2Fo-Fc';
                this.state.cachedMapData = this.state.mapCalculator.calculateMap(
                    this.state.currentMapData.reflections, 
                    this.state.currentMapData.cell, 
                    this.state.preferences.map.resolution, 
                    type
                );
            }

            this.state.realSpaceRefiner.refine(subset, this.state.cachedMapData, this.state.parsedData.cell);

            this.updateEditorLines(subset);

            this.renderContent(this.state.loadedContent, this.state.loadedType);

            document.getElementById('status-bar-content').textContent = `Refined ${subset.length} atoms.`;
            
        } catch (e) {
            console.error("RSR Error:", e);
            alert("RSR Error: " + e.message);
        } finally {
            // Reset RSR selection but keep mode active
            this.state.rsr.from = null;
            this.state.rsr.to = null;
            document.getElementById('rsr-progress').classList.add('d-none');
            this.deselectAll();
            document.getElementById('status-bar-content').textContent = "Real Space Refinement: Click 'From' atom";
        }
    }

    updateEditorLines(atoms) {
        if (this.state.loadedType !== 'res') return;
        const editor = this.state.editors.res;
        if (!editor) return;

        const lines = editor.getValue().split('\n');
        const labelToLine = {};
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].trim().match(/^(\S+)/);
            if (m) labelToLine[m[1]] = i;
        }

        atoms.forEach(atom => {
            const lineIdx = labelToLine[atom.label];
            if (lineIdx !== undefined && lineIdx >= 0 && lineIdx < lines.length) {
                const line = lines[lineIdx];
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 5) {
                    parts[2] = atom.x.toFixed(5);
                    parts[3] = atom.y.toFixed(5);
                    parts[4] = atom.z.toFixed(5);
                    const leadingWS = line.match(/^\s*/)[0];
                    lines[lineIdx] = leadingWS + parts.join(' ');
                }
            }
        });

        const newContent = lines.join('\n');
        editor.setValue(newContent, -1);
        this.state.loadedContent = newContent;
    }
}

// Initialize App
const app = new WMOLApp();
app.init();
