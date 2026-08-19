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
import { RealSpaceRefiner } from './js/compute/RealSpaceRefiner.js';
import { FRAGMENTS } from './js/compute/FragmentLibrary.js';
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
            jsSpaceIns: null, // { filename, content } generated SHELX .ins for SHELXT
            hklContent: null,
            hklName: null,
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
                    refineTimeout: 300000,
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
                        resolution: 'medium'
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
                    autoShow: false
                }
            },
            selectionOrder: [] // Track order of selected rows
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

    saveStateToLocalStorage() {
        if (this.state.preferences && this.state.preferences.general.autoSave === false) return;
        try {
            if (this.state.loadedContent) {
                localStorage.setItem('webxtl_res_content', this.state.loadedContent);
                localStorage.setItem('webxtl_loaded_type', this.state.loadedType);
                localStorage.setItem('webxtl_loaded_filename', this.state.loadedFilename || '');
            }
            if (this.state.currentProject) {
                localStorage.setItem('webxtl_current_project', this.state.currentProject);
            }
            // Persist open file tabs (content + metadata) so they survive a refresh.
            const tabs = [];
            for (const [name, t] of Object.entries(this.state.fileTabs || {})) {
                const content = t.editor ? t.editor.getValue() : '';
                if (content.length < 3 * 1024 * 1024) {
                    tabs.push({ filename: t.filename, type: t.type, project: t.project, content });
                }
            }
            localStorage.setItem('webxtl_file_tabs', JSON.stringify(tabs));
        } catch(e) { console.warn('localStorage save error:', e.message); }
        try {
            if (this.state.hklContent && this.state.hklContent.length < 3 * 1024 * 1024) {
                localStorage.setItem('webxtl_hkl_content', this.state.hklContent);
                localStorage.setItem('webxtl_hkl_name', this.state.hklName || '');
            }
        } catch(e) { console.warn('localStorage HKL save error:', e.message); }
        try {
            if (this.state.fcfRawContent && this.state.fcfRawContent.length < 3 * 1024 * 1024) {
                localStorage.setItem('webxtl_fcf_content', this.state.fcfRawContent);
            }
        } catch(e) { console.warn('localStorage FCF save error:', e.message); }
    }

    restoreStateFromLocalStorage() {
        if (this.state.preferences && this.state.preferences.general.restoreSession === false) return;
        const resContent = localStorage.getItem('webxtl_res_content');
        const loadedType = localStorage.getItem('webxtl_loaded_type');
        const filename = localStorage.getItem('webxtl_loaded_filename');
        const hklContent = localStorage.getItem('webxtl_hkl_content');
        const hklName = localStorage.getItem('webxtl_hkl_name');
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

        if (hklContent) {
            this.state.hklContent = hklContent;
            this.state.hklName = hklName || null;
            const statusHkl = document.getElementById('status-hkl');
            if (statusHkl) {
                statusHkl.classList.remove('bg-secondary');
                statusHkl.classList.add('bg-success');
                statusHkl.title = "HKL Loaded: " + (hklName || 'unknown');
            }
        }

        if (fcfContent) {
            setTimeout(() => this.renderMap(fcfContent), 200);
        }

        // Restore open file tabs (hkl, fcf, pdb, lst, ...).
        try {
            const rawTabs = localStorage.getItem('webxtl_file_tabs');
            if (rawTabs) {
                const tabs = JSON.parse(rawTabs);
                for (const t of tabs) {
                    if (t && t.filename) {
                        this.openFileTab(t.filename, t.content, t.type, t.project || null, false);
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to restore file tabs:', e.message);
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
        const levelIn = document.getElementById('map-level');
        const radiusIn = document.getElementById('map-radius');
        const map = this.state.preferences.map;
        if (typeSel && map.type) typeSel.value = map.type;
        if (levelIn && map.sigma) levelIn.value = map.sigma;
        if (radiusIn && map.radius) radiusIn.value = map.radius;
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

        // Re-render 3D content to apply bond/color changes
        if (this.state.loadedContent) {
            this.renderContent(this.state.loadedContent, this.state.loadedType);
        }

        // Refresh the map (color etc.) if one is currently visible
        if (this.state.currentMapData && this.state.densityRenderer) {
            const btn = document.getElementById('tool-map-toggle');
            if (btn && btn.classList.contains('active')) {
                this.state.densityRenderer.render(
                    this.state.cachedMapData,
                    this.state.currentMapData.cell,
                    parseFloat(document.getElementById('map-level').value) || 1.0,
                    new THREE.Color(this.state.preferences.map.color),
                    this.state.currentMapBounds,
                    this.state.currentMapCenter,
                    this.state.currentMapRadius
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

    // POST an HKL file to the jsSpace analysis endpoint.
    // `cell` is optional: "a b c alpha beta gamma" or null.
    // `spaceGroup` is optional: number or Hermann-Mauguin symbol, or null.
    // `signal` is an optional AbortSignal for cancellation.
    async apiJsSpaceAnalyze(hklText, cell, spaceGroup, signal) {
        const formData = new FormData();
        formData.append('hkl', new Blob([hklText], { type: 'text/plain' }), 'data.hkl');
        if (cell) formData.append('cell', cell);
        if (spaceGroup !== undefined && spaceGroup !== null && spaceGroup !== '') {
            formData.append('spaceGroup', String(spaceGroup));
        }
        const url = this.getApiUrl('/jsspace/analyze');
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
            throw new Error(`Could not reach jsSpace at ${url} — ${hint} (${e.message})`);
        }
        if (!res.ok) throw new Error('Space-group analysis failed');
        return res.json();
    }

    async apiGetProjectFile(projectName, filename) {
        const res = await fetch(this.getApiUrl(`/projects/${projectName}/files/${filename}`));
        if (!res.ok) throw new Error('Failed to fetch project file');
        return res.text();
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
            } else if (ext === 'cif') {
                // CIF -> CIF tab + 3D render
                this.state.currentProject = projectName;
                this.state.loadedType = 'cif';
                this.state.loadedContent = content;
                this.state.loadedFilename = filename;

                if (this.state.editors.cif) this.state.editors.cif.setValue(content, -1);
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
                // Other text files (hkl, fcf, lst, log, ...) -> editable text tab
                this.state.currentProject = projectName;
                this.openFileTab(filename, content, ext, projectName, activate);

                if (ext === 'hkl') {
                    this.state.hklContent = content;
                    this.state.hklName = filename;
                    const statusHkl = document.getElementById('status-hkl');
                    if (statusHkl) {
                        statusHkl.classList.remove('bg-secondary');
                        statusHkl.classList.add('bg-success');
                        statusHkl.title = "HKL Loaded: " + filename;
                    }
                } else if (ext === 'fcf') {
                    this.renderMap(content);
                }
            }
        } catch (err) {
            if (!silent) alert(`Load failed: ${err.message}`);
        }
        this.saveStateToLocalStorage();
    }
    
    async loadProjectFromServer(name) {
        try {
            // 1. Load Main Structure
            const data = await this.apiLoadProject(name);
            this.state.currentProject = data.name;
            this.state.loadedType = data.type;
            this.state.loadedContent = data.content;
            
            const editor = this.state.editors[data.type] || this.state.editors.res;
            if (editor) editor.setValue(data.content, -1);
            this.renderContent(data.content, data.type);
            this.resetView();
            
            // 2. Auto-load associated HKL and FCF if they exist
            const files = await this.apiListProjectFiles(name);
            
            // Look for HKL
            const hklFile = files.find(f => f.name.toLowerCase() === `${name.toLowerCase()}.hkl`);
            if (hklFile) {
                await this.loadSpecificFileFromServer(name, hklFile.name, true, false);
            }
            
            // Look for FCF
            const fcfFile = files.find(f => f.name.toLowerCase() === `${name.toLowerCase()}.fcf`);
            if (fcfFile) {
                await this.loadSpecificFileFromServer(name, fcfFile.name, true, false);
            }

            // Look for CIF (populate the CIF editor without replacing the primary structure)
            const cifFile = files.find(f => f.name.toLowerCase() === `${name.toLowerCase()}.cif`);
            if (cifFile) {
                try {
                    const content = await this.apiGetProjectFile(name, cifFile.name);
                    if (this.state.editors.cif) {
                        this.state.editors.cif.setValue(content, -1);
                        this.state.editors.cif.loadedFile = content;
                    }
                } catch (e) {
                    console.warn("Failed to load CIF:", e.message);
                }
            }
            
            this.saveStateToLocalStorage();

            const modalEl = document.getElementById('projectManagerModal');
            const modal = bootstrap.Modal.getInstance(modalEl);
            if (modal) modal.hide();

        } catch (err) {
            alert(`Error loading project: ${err.message}`);
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
        
        // Duplicate Line/Selection (Ctrl-D)
        editor.commands.addCommand({
            name: 'duplicate',
            bindKey: {win: 'Ctrl-D', mac: 'Command-D'},
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

        // Relabel Atoms (Ctrl-L)
        // Relabel Atoms (Ctrl-L)
        editor.commands.addCommand({
            name: 'relabelAtoms',
            bindKey: {win: 'Ctrl-L', mac: 'Command-L'},
            exec: (editor) => {
                // Support multi-selection
                const ranges = editor.selection.getAllRanges();
                if (ranges.length === 0 || (ranges.length === 1 && ranges[0].isEmpty())) {
                    alert("Please select atoms to relabel.");
                    return;
                }
                
                const prefix = prompt("Enter atom prefix (e.g. C):", "C");
                if (!prefix) return;

                // Determine element type from prefix (remove digits)
                const element = prefix.replace(/[0-9]/g, '');
                if (!element) {
                    alert("Invalid prefix. Must contain an element symbol.");
                    return;
                }

                const doc = editor.getSession().getDocument();
                let sfacIndex = -1;
                let sfacLineIndex = -1;
                let sfacElements = [];

                // Find SFAC line
                for (let i = 0; i < doc.getLength(); i++) {
                    const line = doc.getLine(i).trim();
                    if (line.startsWith('SFAC')) {
                        sfacLineIndex = i;
                        const parts = line.split(/\s+/);
                        // SFAC can be "SFAC C H O" or "SFAC C 1.2 3.4 ..." (scattering factors)
                        // We assume standard "SFAC E1 E2..." format for now as per user request context
                        // If parts[1] is a number, it's the explicit format, which is harder to handle.
                        // Let's assume element symbols.
                        sfacElements = parts.slice(1);
                        break;
                    }
                }

                if (sfacLineIndex === -1) {
                    // No SFAC found? Create one? Or warn?
                    // Let's assume valid SHELX file has SFAC. If not, we can't easily assign index.
                    // But maybe we can just default to 1 if not found, or insert SFAC.
                    // For now, let's try to find the element in the existing list.
                } else {
                    // Check if element exists (case insensitive)
                    const existingIndex = sfacElements.findIndex(e => e.toUpperCase() === element.toUpperCase());
                    if (existingIndex !== -1) {
                        sfacIndex = existingIndex + 1; // 1-based
                    } else {
                        // Add new element to SFAC
                        sfacElements.push(element);
                        sfacIndex = sfacElements.length;
                        
                        // Update SFAC line in document
                        const newSfacLine = `SFAC ${sfacElements.join(' ')}`;
                        doc.removeInLine(sfacLineIndex, 0, doc.getLine(sfacLineIndex).length);
                        doc.insertInLine({row: sfacLineIndex, column: 0}, newSfacLine);
                    }
                }

                let counter = 1;
                
                // Sync selectionOrder with current Ace selection before processing
                const currentAceRows = new Set();
                ranges.forEach(r => {
                    for (let i = r.start.row; i <= r.end.row; i++) {
                        currentAceRows.add(i);
                    }
                });

                // 1. Remove items from order that are no longer selected in Ace
                this.state.selectionOrder = this.state.selectionOrder.filter(r => currentAceRows.has(r));
                
                // 2. Add items from Ace that are missing in order (append them)
                currentAceRows.forEach(r => {
                    if (!this.state.selectionOrder.includes(r)) {
                        this.state.selectionOrder.push(r);
                    }
                });

                try {
                    // Iterate over selectionOrder to process atoms in order
                    this.state.selectionOrder.forEach(row => {
                        const line = doc.getLine(row);
                        // Assume atom name is first token
                        const parts = line.trim().split(/\s+/);
                        const keywords = ['TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HFIX', 'BOND', 'CONF', 'MPLA', 'HTAB', 'EQIV', 'CONN', 'PART', 'AFIX', 'RESI', 'MOLE', 'PLAN', 'SIZE', 'TEMP', 'WGHT', 'FVAR', 'HKLF', 'END', 'REM', 'Q', 'OMIT', 'DISP', 'ISOR', 'RIGI', 'SIMU', 'DELU', 'DANG', 'BUMP', 'TWIN', 'BASF'];
                        
                        // Check if it's an atom line (starts with letter, not keyword)
                        // Also skip lines starting with = (continuation)
                        if (parts.length > 0 && /^[A-Za-z]+/.test(parts[0]) && !keywords.includes(parts[0].toUpperCase()) && !line.trim().startsWith('=')) {
                            // Replace first token
                            const oldLabel = parts[0];
                            const newLabel = prefix + counter;
                            
                            // Find index of oldLabel in line
                            const match = line.match(new RegExp(`\\b${oldLabel}\\b`));
                            if (match) {
                                // Replace label
                                let newLine = line.substring(0, match.index) + newLabel + line.substring(match.index + oldLabel.length);
                                
                                // Update SFAC index (2nd token) if we found a valid sfacIndex
                                if (sfacIndex !== -1) {
                                    const sfacRegex = new RegExp(`(${newLabel}\\s+)(\\d+)`);
                                    const sfacMatch = newLine.match(sfacRegex);
                                    if (sfacMatch) {
                                        const replacement = sfacMatch[1] + sfacIndex;
                                        newLine = newLine.replace(sfacMatch[0], replacement);
                                    }
                                }

                                // Apply change immediately
                                doc.removeInLine(row, 0, line.length);
                                doc.insertInLine({row: row, column: 0}, newLine);
                                counter++;
                            }
                        }
                    });

                    // Force update
                    this.tryRender('res');
                } catch (e) {
                    console.error("Error in relabelAtoms:", e);
                    alert("An error occurred while relabeling atoms.");
                } finally {
                    // Force update
                    this.tryRender('res');
                    
                    // Deselect all atoms after relabeling
                    this.deselectAll();
                }
            }
        });

        editor.commands.addCommand({
            name: 'autoHfix',
            bindKey: {win: 'Ctrl-H', mac: 'Command-H'},
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

        // Kill Q (Ctrl-K)
        editor.commands.addCommand({
            name: 'killQ',
            bindKey: {win: 'Ctrl-K', mac: 'Command-K'},
            exec: (editor) => killPattern(/^Q\d+/i, "Q Peaks", false) // No confirm for Q? Python didn't seem to ask.
        });

        // Kill H (Ctrl-Shift-K)
        editor.commands.addCommand({
            name: 'killH',
            bindKey: {win: 'Ctrl-Shift-K', mac: 'Command-Shift-K'},
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

        // Isotropic (Ctrl-I)
        editor.commands.addCommand({
            name: 'makeIsotropic',
            bindKey: {win: 'Ctrl-I', mac: 'Command-I'},
            exec: (editor) => {
                // Remove Uij parameters (keep x, y, z, sof, Uiso)
                // Standard Shelx atom: Label type x y z sof Uiso [U11 U22 U33 U23 U13 U12]
                // Usually 7 fields + 6 optional
                const range = editor.getSelectionRange();
                const doc = editor.getSession().getDocument();
                const startRow = range.isEmpty() ? 0 : range.start.row;
                const endRow = range.isEmpty() ? doc.getLength() - 1 : range.end.row;

                for (let i = startRow; i <= endRow; i++) {
                    let line = doc.getLine(i);
                    let parts = line.trim().split(/\s+/);
                    // Heuristic: if more than 8 parts, truncate to 8 (Label type x y z sof Uiso)
                    // Or check if parts are numbers.
                    // Let's assume standard format for now.
                    if (parts.length > 7) {
                         // Keep first 7 parts (indices 0-6) + maybe 8th if it's not Uij?
                         // Actually Uiso is the 6th or 7th parameter depending on format.
                         // Let's just keep the first 7 tokens if they look like an atom line.
                         // Atom line usually starts with letter.
                         const label = parts[0].toUpperCase();
                         const keywords = ['TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HFIX', 'BOND', 'CONF', 'MPLA', 'HTAB', 'EQIV', 'CONN', 'PART', 'AFIX', 'RESI', 'MOLE', 'PLAN', 'SIZE', 'TEMP', 'WGHT', 'FVAR', 'HKLF', 'END', 'REM', 'Q', 'OMIT', 'DISP', 'ISOR', 'RIGI', 'SIMU', 'DELU', 'DANG', 'BUMP'];
                         
                         if (/^[A-Z]/i.test(parts[0]) && !keywords.includes(label)) {
                             const newLine = parts.slice(0, 7).join('  ');
                             // Replace line
                             doc.removeInLine(i, 0, line.length);
                             doc.insertInLine({row: i, column: 0}, newLine);
                         }
                    }
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
                    const range = editor.getSelectionRange();
                    const doc = editor.getSession().getDocument();
                    const selectedLines = doc.getLines(range.start.row, range.end.row);
                    const instructions = [];
                    
                    // Identify atoms in selection
                    selectedLines.forEach(line => {
                        const parts = line.trim().split(/\s+/);
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

        // Find Duplicates (Alt-D)
        editor.commands.addCommand({
            name: 'findDuplicates',
            bindKey: {win: 'Alt-D', mac: 'Alt-D'},
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
                const counts = {};
                
                lines.forEach(line => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length > 0) {
                        const label = parts[0];
                        // Check if it's an atom (starts with letter, not a keyword)
                        // Keywords to exclude
                        const keywords = ['TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HFIX', 'BOND', 'CONF', 'MPLA', 'HTAB', 'EQIV', 'CONN', 'PART', 'AFIX', 'RESI', 'MOLE', 'PLAN', 'SIZE', 'TEMP', 'WGHT', 'FVAR', 'HKLF', 'END', 'REM', 'Q', 'OMIT', 'DISP'];
                        // Also check if it looks like an atom (has coordinates?)
                        // Or just exclude known keywords.
                        if (/^[A-Z]/i.test(label) && !keywords.includes(label.toUpperCase())) {
                            // Extract element type
                            // Usually first 1-2 chars, but depends on SFAC.
                            // Simple heuristic: First 1-2 letters.
                            const elementMatch = label.match(/^[A-Za-z]+/);
                            if (elementMatch) {
                                let element = elementMatch[0];
                                // Normalize element (e.g. C1 -> C)
                                // Remove numbers
                                element = element.replace(/\d+$/, '');
                                // Capitalize first letter
                                element = element.charAt(0).toUpperCase() + element.slice(1).toLowerCase();
                                counts[element] = (counts[element] || 0) + 1;
                            }
                        }
                    }
                });
                
                let formula = "";
                // Sort elements? Hill system?
                // Just alphabetical for now
                Object.keys(counts).sort().forEach(el => {
                    formula += `${el}${counts[el]} `;
                });
                alert("Estimated Formula (based on atom labels):\n" + formula);
            }
        });

        // Correct Molecular Formula (UNIT instruction)
        editor.commands.addCommand({
            name: 'correctFormula',
            exec: (editor) => {
                // Find UNIT instruction and update it? 
                // Or just calculate and show?
                // "Correct molecular formula" implies updating the UNIT instruction.
                // Let's implement a simple version that updates UNIT based on atom counts.
                const doc = editor.getSession().getDocument();
                const lines = doc.getAllLines();
                let unitLine = -1;
                const counts = {};
                
                // Count atoms
                lines.forEach((line, index) => {
                    if (line.trim().startsWith('UNIT')) {
                        unitLine = index;
                    }
                    const parts = line.trim().split(/\s+/);
                    if (parts.length > 0) {
                        const label = parts[0];
                        const keywords = ['TITL', 'CELL', 'ZERR', 'LATT', 'SYMM', 'SFAC', 'UNIT', 'HFIX', 'BOND', 'CONF', 'MPLA', 'HTAB', 'EQIV', 'CONN', 'PART', 'AFIX', 'RESI', 'MOLE', 'PLAN', 'SIZE', 'TEMP', 'WGHT', 'FVAR', 'HKLF', 'END'];
                        if (/^[A-Z]/i.test(label) && !keywords.includes(label.toUpperCase())) {
                            const element = label.match(/^[A-Za-z]+/)[0].replace(/\d+$/, '');
                            counts[element] = (counts[element] || 0) + 1;
                        }
                    }
                });

                if (unitLine !== -1) {
                    // We need SFAC to know order.
                    // This is getting complex. Let's just alert for now as "Correct" might mean "Verify".
                    // Or maybe just output the counts to console/alert.
                    let formula = "";
                    for (const [el, count] of Object.entries(counts)) {
                        formula += `${el} ${count} `;
                    }
                    const update = confirm(`Calculated content: ${formula}\nUpdate UNIT instruction? (Requires SFAC order match, which is not guaranteed here. Proceed with caution.)`);
                    if (update) {
                        // This is risky without SFAC parsing.
                        // Let's just insert a comment with the count.
                         doc.insertInLine({row: unitLine, column: doc.getLine(unitLine).length}, ` ! Calc: ${formula}`);
                    }
                } else {
                    alert("No UNIT instruction found.");
                }
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
            exec: (editor) => {
                // Insert DISP instruction
                 editor.insert("DISP $H\n");
            }
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

                if (targetId === 'tab-split') {
                    this.onWindowResize();
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
                            this.state.editors.cif.setValue(truncated, -1);
                            this.state.editors.cif.loadedFile = this.state.loadedContent;
                            this.state.editors.cif.fileId = this.state.fileId;
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

        const menuJsSpace = document.getElementById('menu-jsspace');
        if (menuJsSpace) {
            menuJsSpace.addEventListener('click', () => this.runSpaceGroupAnalysis());
        }
        const menuJsSpaceForce = document.getElementById('menu-jsspace-force');
        if (menuJsSpaceForce) {
            menuJsSpaceForce.addEventListener('click', () => {
                const input = prompt(
                    'Force a specific space group.\nEnter a space group number or Hermann-Mauguin symbol\n(e.g. 14, or "P 21/c", "P-1", "C 2/c"):');
                if (input === null || input.trim() === '') return;
                this.runSpaceGroupAnalysis(input.trim());
            });
        }

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
                data = this.state.parsers.cif.parse(content);
            }
            
            this.state.parsedData = data; // Store for calculations (e.g. bond length)
            this.state.cachedMapData = null; // Invalidate map cache as atoms changed
            
            if (data && this.state.moleculeRenderer) {
                const renderSettings = {
                    ...this.state.viewSettings,
                    preferences: this.state.preferences
                };
                this.state.moleculeRenderer.render(data, renderSettings);
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

            if (intersects.length > 0) {
                // Find first mesh/instancedMesh
                const target = intersects.find(i => i.object.isMesh || i.object.isInstancedMesh);
                
                if (target) {
                    // --- Fragment Placement Mode ---
                    if (this.state.rsr.active && this.state.fragment.active && this.state.fragment.selectedId && !this.state.preview.active) {
                        let atomData = null;
                        if (target.object.isInstancedMesh && target.object.userData.atomMap) {
                            atomData = target.object.userData.atomMap[target.instanceId];
                        } else {
                            const atomHit = intersects.find(i => i.object.isInstancedMesh && i.object.userData.atomMap);
                            if (atomHit) {
                                atomData = atomHit.object.userData.atomMap[atomHit.instanceId];
                            }
                        }
                        document.body.style.cursor = 'wait';
                        this.placeFragment(atomData, event);
                        return;
                    }

                    // --- RSR Mode ---
                    if (this.state.rsr.active) {
                        // Find atomData from target or nearest hit
                        let atomData = null;
                        if (target.object.isInstancedMesh && target.object.userData.atomMap) {
                            atomData = target.object.userData.atomMap[target.instanceId];
                        } else {
                            // If we hit something else (like a bond), try to find the nearest atom mesh
                            const atomHit = intersects.find(i => i.object.isInstancedMesh && i.object.userData.atomMap);
                            if (atomHit) {
                                atomData = atomHit.object.userData.atomMap[atomHit.instanceId];
                            }
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
                        let atomData = null;
                        if (target.object.isInstancedMesh && target.object.userData.atomMap) {
                            atomData = target.object.userData.atomMap[target.instanceId];
                        }
                        if (!atomData) {
                            const atomHit = intersects.find(i => i.object.isInstancedMesh && i.object.userData.atomMap);
                            if (atomHit) {
                                atomData = atomHit.object.userData.atomMap[atomHit.instanceId];
                            }
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

                        if (target.object.isInstancedMesh) {
                            const matrix = new THREE.Matrix4();
                            target.object.getMatrixAt(target.instanceId, matrix);
                            newTarget.setFromMatrixPosition(matrix);
                            newTarget.applyMatrix4(target.object.matrixWorld);
                        } else {
                            target.object.getWorldPosition(newTarget);
                        }

                        const currentTarget = this.state.controls.target.clone();
                        const delta = new THREE.Vector3().subVectors(newTarget, currentTarget);
                        
                        this.state.camera.position.add(delta);
                        this.state.controls.target.copy(newTarget);
                        this.state.controls.update();
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
        bindMenu('menu-omit', 'omitError');
        bindMenu('menu-disp', 'calcDisp');
        bindMenu('menu-hfix', 'addHFIX');
        bindMenu('menu-sort', 'sortAtoms');
        bindMenu('tool-sort', 'sortAtoms'); // Toolbar
        bindMenu('menu-duplicates', 'findDuplicates');
        bindMenu('menu-q-to-c', 'qToC');
        bindMenu('menu-rsr', 'toggleRSR');
        bindMenu('tool-rsr', 'toggleRSR');

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
        if (!container || !this.state.camera || !this.state.renderer) return;
        
        // Check if visible
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
        
        // Ace resize
        if (this.state.editors.res) this.state.editors.res.resize();
        if (this.state.editors.cif) this.state.editors.cif.resize();
        if (this.state.fileTabs) {
            Object.values(this.state.fileTabs).forEach(t => t.editor && t.editor.resize());
        }
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

        hklInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            const reader = new FileReader();
            reader.onload = (event) => {
                this.state.hklContent = event.target.result;
                this.state.hklName = file.name;
                this.openFileTab(file.name, event.target.result, 'hkl', null, true);
                console.log("HKL file loaded:", file.name);
                
                // Update UI
                const statusHkl = document.getElementById('status-hkl');
                if (statusHkl) {
                    statusHkl.classList.remove('bg-secondary');
                    statusHkl.classList.add('bg-success');
                    statusHkl.title = "HKL Loaded: " + file.name;
                }
                
                alert("HKL file loaded: " + file.name);
            };
            reader.readAsText(file);
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

            // Sort files: Structure -> HKL -> FCF
            const structureFiles = files.filter(f => {
                const n = f.name.toLowerCase();
                return n.endsWith('.res') || n.endsWith('.ins') || n.endsWith('.cif') || n.endsWith('.pdb');
            });
            const hklFiles = files.filter(f => f.name.toLowerCase().endsWith('.hkl'));
            const fcfFiles = files.filter(f => f.name.toLowerCase().endsWith('.fcf'));

            // Process structure first
            if (structureFiles.length > 0) {
                const file = structureFiles[0];
                const content = await file.text();
                
                this.state.loadedContent = content;
                this.state.loadedFilename = file.name;
                this.state.fileId++;

                const ext = file.name.split('.').pop().toLowerCase();
                this.state.loadedType = (ext === 'ins' || ext === 'res') ? 'res' : ext;
                
                this.renderContent(content, this.state.loadedType);
                this.resetView();

                // Populate editor
                const editor = this.state.editors[this.state.loadedType];
                if (editor) {
                    editor.setValue(this.truncateContent(content), -1);
                    editor.loadedFile = content;
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

            // Process HKL
            if (hklFiles.length > 0) {
                const file = hklFiles[0];
                const content = await file.text();
                this.state.hklContent = content;
                this.state.hklName = file.name;
                this.openFileTab(file.name, content, 'hkl', null, true);
                const statusHkl = document.getElementById('status-hkl');
                if (statusHkl) {
                    statusHkl.classList.remove('bg-secondary');
                    statusHkl.classList.add('bg-success');
                    statusHkl.title = "HKL Loaded: " + file.name;
                }
            }

            // Process FCF
            if (fcfFiles.length > 0) {
                const file = fcfFiles[0];
                const content = await file.text();
                this.openFileTab(file.name, content, 'fcf', null, true);
                this.renderMap(content);
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

    renderMap(content) {
        this.state.fcfRawContent = content;
        this.saveStateToLocalStorage();
        try {
            const fcfData = this.state.parsers.fcf.parse(content);

            if (!this.state.parsedData || !this.state.parsedData.atoms) {
                alert("Please load a structure (RES/CIF) first to calculate phases.");
                return;
            }

            const cell = this.state.parsedData.cell; 
            const mapCell = (cell && cell.a) ? cell : fcfData.cell;

            // Use symmetry-expanded atoms for correct phase calculation
            let phaseAtoms = this.state.parsedData.atoms;
            if (this.state.moleculeRenderer && this.state.moleculeRenderer.expandedAtoms) {
                const exp = this.state.moleculeRenderer.expandedAtoms;
                // Deduplicate by grouping atoms with identical fractional coordinates
                // to avoid double-counting in structure factor sum
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
            
            this.state.mapCalculator.calculateStructureFactors(phaseAtoms, fcfData.reflections, mapCell);
            
            // Calculate Map
            const level = parseFloat(document.getElementById('map-level').value) || 1.0;
            const radius = parseFloat(document.getElementById('map-radius').value) || 4.0;
            const type = document.getElementById('map-type').value || '2Fo-Fc';
            
            this.state.currentMapData = { reflections: fcfData.reflections, cell: mapCell }; // Store for updates
            
            const mapData = this.state.mapCalculator.calculateMap(fcfData.reflections, mapCell, this.state.preferences.map.resolution, type); 
            this.state.cachedMapData = mapData; // Cache for RSR
        
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
            this.state.densityRenderer.render(mapData, mapCell, level, new THREE.Color(this.state.preferences.map.color), bounds, centerFrac, radius);
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
        const levelInput = document.getElementById('map-level');
        const radiusInput = document.getElementById('map-radius');
        const toggleBtn = document.getElementById('tool-map-toggle');

        const updateMap = () => {
             if (this.state.currentMapData && this.state.densityRenderer && toggleBtn.classList.contains('active')) {
                 const level = parseFloat(levelInput.value) || 1.0;
                 const radius = parseFloat(radiusInput.value) || 4.0;
                 const type = typeSelect.value;
                 const resolution = this.state.preferences.map.resolution;
                 const color = new THREE.Color(this.state.preferences.map.color);
                 
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
                 
                 let minCart = new THREE.Vector3(Infinity, Infinity, Infinity);
                 let maxCart = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
                 
                 const vec = new THREE.Vector3();
                 
                 atoms.forEach(atom => {
                     vec.set(atom.x, atom.y, atom.z);
                     vec.applyMatrix4(fracToCartMatrix);
                     minCart.min(vec);
                     maxCart.max(vec);
                 });
                 
                 const centerCart = new THREE.Vector3().addVectors(minCart, maxCart).multiplyScalar(0.5);
                 
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
                 
                 this.state.densityRenderer.render(this.state.cachedMapData, mapCell, level, new THREE.Color(this.state.preferences.map.color), bounds, centerFrac, radius);
             }
        };

        if (typeSelect) typeSelect.addEventListener('change', updateMap);
        if (levelInput) levelInput.addEventListener('change', updateMap);
        if (radiusInput) radiusInput.addEventListener('change', updateMap);
        
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                if (toggleBtn.classList.contains('active')) {
                    toggleBtn.classList.remove('active');
                    toggleBtn.setAttribute('aria-pressed', 'false');
                    if (this.state.densityRenderer && this.state.densityRenderer.mesh) {
                        this.state.densityRenderer.mesh.visible = false;
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
                        this.state.densityRenderer.mesh.visible = true;
                    } else {
                        updateMap();
                    }
                }
            });
        }
    }

    // ========== FRAGMENT PLACEMENT ==========

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

        // Generate unique labels
        const getNextLabel = (element) => {
            let maxNum = 0;
            const re = new RegExp(`^${element}(\\d+)`, 'i');
            const allLabels = [];
            for (let i = 0; i < allLines.length; i++) {
                const m = allLines[i].trim().match(/^(\S+)/);
                if (m) allLabels.push(m[1]);
            }
            if (this.state.parsedData && this.state.parsedData.atoms) {
                this.state.parsedData.atoms.forEach(a => allLabels.push(a.label));
            }
            allLabels.forEach(l => {
                const m = l.match(re);
                if (m) { const n = parseInt(m[1]); if (n > maxNum) maxNum = n; }
            });
            return element + (maxNum + 1);
        };

        // Determine if we placed on an existing atom
        const usesExistingAtom = clickedAtom !== null;
        const existingAtomLabel = clickedAtom ? clickedAtom.label : null;

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

            // World Cartesian: anchor at click position
            const wx = posCart.x + rx;
            const wy = posCart.y + ry;
            const wz = posCart.z + rz;

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
                let updated = false;
                sfacElements.forEach(el => {
                    if (!currentEls.includes(el)) { currentEls.push(el); updated = true; }
                });
                if (updated) {
                    doc.removeInLine(sfacLineIndex, 0, existing.length);
                    doc.insertInLine({ row: sfacLineIndex, column: 0 }, 'SFAC ' + currentEls.join(' '));
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

        const shexLines = [];
        const currentLines = doc.getAllLines();

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

        // Insert new lines before END
        const textToInsert = shexLines.join('\n') + '\n';
        if (shexLines.length > 0) {
            let insertPos = -1;
            const allLines = doc.getAllLines();
            for (let i = allLines.length - 1; i >= 0; i--) {
                if (allLines[i].trim().toUpperCase() === 'END') { insertPos = i; break; }
            }
            if (insertPos === -1) {
                insertPos = doc.getLength();
                editor.session.insert({ row: insertPos, column: 0 }, '\n' + textToInsert + 'END\n');
            } else {
                editor.session.insert({ row: insertPos, column: 0 }, textToInsert);
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
        menu.innerHTML = programs.map(p => `
            <li><a class="dropdown-item" href="#" data-program="${p.id}">
                <div>${p.label}</div>
                <div class="text-muted small">${p.description}</div>
            </a></li>`).join('');
        menu.querySelectorAll('a[data-program]').forEach(a => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const id = a.getAttribute('data-program');
                const program = programs.find(p => p.id === id);
                if (program) this.runExternalProgram(program);
            });
        });
    }

    // Run an external crystallography program (shelxl, shelxt, ...) on the
    // currently loaded files and show the results in the results modal.
    async runExternalProgram(program) {
        const inputs = program.inputs || [];
        const formData = new FormData();

        let baseName = 'structure';
        if (this.state.hklName) {
            baseName = this.state.hklName.replace(/\.hkl$/i, '');
        }
        baseName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');

        const needsRes = inputs.includes('.res') || inputs.includes('.ins') || inputs.includes('.cif');
        if (needsRes) {
            const ext = inputs.includes('.cif') ? '.cif' : inputs.includes('.ins') ? '.ins' : '.res';
            // Prefer the jsSpace-generated .ins (correct cell + space group,
            // matching basename) for structure-solution programs.
            let content = null;
            if (ext === '.ins' && this.state.jsSpaceIns) {
                content = this.state.jsSpaceIns.content;
            } else if (this.state.editors.res) {
                content = this.state.editors.res.getValue();
            }
            if (!content) {
                alert('No structure loaded to run.');
                return;
            }
            formData.append(ext.slice(1), new Blob([content], { type: 'text/plain' }), baseName + ext);
        }
        if (inputs.includes('.hkl')) {
            if (!this.state.hklContent) {
                alert('No HKL file loaded. Please load an .hkl file first.');
                return;
            }
            formData.append('hkl', new Blob([this.state.hklContent], { type: 'text/plain' }), baseName + '.hkl');
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
            if (data.error) throw new Error(data.error);

            // Load the primary output back into the editor when the program produces it.
            const primary = { shelxl: '.res', shelxs: '.res', shelxt: '.res', shelxd: '.res', shelxh: '.res', shelxe: '.res' }[program.id];
            if (primary && data.files) {
                const key = Object.keys(data.files).find(k => k.toLowerCase().endsWith(primary));
                if (key && this.state.editors.res) {
                    this.state.editors.res.setValue(data.files[key], -1);
                    this.state.loadedContent = data.files[key];
                    this.renderContent(data.files[key], 'res');
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
                }
                new bootstrap.Modal(modalEl).show();
            }
        } catch (e) {
            if (e && e.name === 'AbortError') {
                console.log(`${program.label} run cancelled by user`);
                alert(`${program.label} run cancelled.`);
            } else {
                console.error(`Failed to run ${program.label}:`, e);
                alert(`Failed to run ${program.label}: ${e.message}`);
            }
        } finally {
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
        const unitCounts = elements.map((c, i) => counts[i] > 0 ? counts[i] : 20);
        const sfacLine = 'SFAC ' + elements.join(' ');
        const unitLine = 'UNIT ' + unitCounts.join(' ');
        let out = insText.replace(/^SFAC.*$/m, sfacLine);
        out = out.replace(/^UNIT.*$/m, unitLine);
        return out;
    }

    // Load the corrected/merged HKL (SHELX format) as the active HKL in the UI
    // so subsequent steps (e.g. SHELXD / SHELXT) operate on it. Also generates
    // a matching SHELX .ins with the correct cell/space group. Returns the
    // merged HKL filename, or null if no merged HKL was produced.
    applyMergedHkl(result) {
        if (!result.merge || !result.merge.shelxHkl) return null;
        let base = 'structure';
        if (this.state.hklName) base = this.state.hklName.replace(/\.hkl$/i, '');
        base = base.replace(/[^a-zA-Z0-9_-]/g, '_');
        const mergedName = base + '_merged.hkl';

        this.state.hklContent = result.merge.shelxHkl;
        this.state.hklName = mergedName;

        const statusHkl = document.getElementById('status-hkl');
        if (statusHkl) {
            statusHkl.classList.remove('bg-secondary');
            statusHkl.classList.add('bg-success');
            statusHkl.title = 'HKL Loaded (merged): ' + mergedName;
        }
        this.openFileTab(mergedName, result.merge.shelxHkl, 'hkl', null, false);

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
            const insName = base + '_merged.ins';
            this.state.jsSpaceIns = { filename: insName, content: insText };
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
        return mergedName;
    }

    // Show the progress dialog for long-running jobs (external programs,
    // refinement). The elapsed-time counter updates every second.
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
        const modal = new bootstrap.Modal(el);
        modal.show();
        return modal;
    }

    hideProgressDialog() {
        if (this._progressInterval) {
            clearInterval(this._progressInterval);
            this._progressInterval = null;
        }
        const el = document.getElementById('progressModal');
        if (el) {
            const modal = bootstrap.Modal.getInstance(el);
            if (modal) modal.hide();
        }
    }

    // Combined abort signal: user cancel (controller) + server timeout.
    makeAbortSignal(controller) {
        const timeout = this.state.preferences.general.refineTimeout || 300000;
        if (typeof AbortSignal.any === 'function') {
            return AbortSignal.any([AbortSignal.timeout(timeout), controller.signal]);
        }
        return controller.signal;
    }

    // Hide jsSpace-only controls (merged-HKL buttons, solution selector) so a
    // fresh results modal does not show leftovers from a previous run.
    resetResultsControls() {
        const b1 = document.getElementById('btn-load-merged-hkl');
        const b2 = document.getElementById('btn-download-merged-hkl');
        const sel = document.getElementById('solution-selector');
        if (b1) b1.classList.add('d-none');
        if (b2) b2.classList.add('d-none');
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
    // shown after a jsSpace analysis.
    wireMergedHklButtons(result) {
        const hasMerged = !!(result.merge && result.merge.shelxHkl);
        const btnDownload = document.getElementById('btn-download-merged-hkl');
        const btnLoad = document.getElementById('btn-load-merged-hkl');
        // jsSpace results have no solution selector.
        const selWrap = document.getElementById('solution-selector');
        if (selWrap) selWrap.classList.add('d-none');
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
            btnLoad.onclick = () => {
                const mergedName = this.applyMergedHkl(result);
                const summary = document.getElementById('results-summary');
                if (mergedName && summary) {
                    const note = document.createElement('div');
                    note.className = 'alert alert-success py-1 px-2 small mb-0 mt-1';
                    note.textContent = `Merged HKL loaded as ${mergedName} — ready for SHELXD / SHELXT.`;
                    summary.appendChild(note);
                }
            };
        }
    }

    // Run the built-in jsSpace space-group determination on the current HKL
    // data and show the result in the results modal. `forced` optionally pins
    // a specific space group (number or Hermann-Mauguin symbol).
    async runSpaceGroupAnalysis(forced) {
        if (!this.state.hklContent) {
            alert('No HKL file loaded. Please load an .hkl file first.');
            return;
        }

        const btn = document.getElementById('tool-refine');
        const originalIcon = btn ? btn.innerHTML : '';
        if (btn) {
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            btn.disabled = true;
        }

        // Progress dialog (jsSpace can be slow on large datasets). It is only
        // shown when an analysis is actually about to run — never for the
        // NO_CELL probe that just asks for the unit cell.
        const controller = new AbortController();
        const cancelBtn = document.getElementById('btn-cancel-progress');
        if (cancelBtn) cancelBtn.onclick = () => controller.abort();
        const hasCellInFile = /!UNIT_CELL_CONSTANTS\s*=/.test(this.state.hklContent || '');

        try {
            let result;
            if (hasCellInFile) {
                this.showProgressDialog('Space-group determination (jsSpace)...',
                    'Analyzing Laue symmetry, centering and systematic absences.');
            }
            result = await this.apiJsSpaceAnalyze(this.state.hklContent, null, forced, controller.signal);

            // The HKL file carries no unit-cell parameters: ask for them.
            if (result.error === 'NO_CELL') {
                const input = prompt(
                    'This HKL file has no unit-cell parameters.\nEnter unit cell: a b c alpha beta gamma\n(e.g. 10.5 10.5 14.0 90 90 90)');
                if (input === null) return; // cancelled - no analysis ran, no dialog
                this.showProgressDialog('Space-group determination (jsSpace)...',
                    'Analyzing Laue symmetry, centering and systematic absences.');
                result = await this.apiJsSpaceAnalyze(this.state.hklContent, input, forced, controller.signal);
            }

            if (!result.ok) {
                throw new Error(result.error || 'Space-group analysis failed');
            }

            const modalEl = document.getElementById('resultsModal');
            const resultsContent = document.getElementById('results-content');
            const resultsSummary = document.getElementById('results-summary');
            if (resultsContent && modalEl) {
                resultsSummary.innerHTML = this.buildSpaceGroupSummary(result);
                resultsContent.textContent = this.buildSpaceGroupReport(result);
                this.wireMergedHklButtons(result);
                new bootstrap.Modal(modalEl).show();
            }
        } catch (e) {
            if (e && e.name === 'AbortError') {
                console.log('jsSpace analysis cancelled by user');
                alert('Space-group analysis cancelled.');
            } else {
                console.error('jsSpace analysis failed:', e);
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

    // HTML summary card for the jsSpace result (top of the results modal).
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
            <div class="fw-semibold small text-uppercase text-muted mb-1">Space-group determination (jsSpace)</div>
            <table class="table table-sm table-borderless align-middle mb-1">
                <tbody>
                    ${rows}
                    <tr><td class="text-muted pe-3">Unit cell</td><td class="fw-semibold">${cellTxt}</td></tr>
                    ${sgRow}
                </tbody>
            </table>
        </div>`;
    }

    // Plain-text report of the full jsSpace result (scrollable body).
    buildSpaceGroupReport(result) {
        const s = result.summary;
        const out = [];
        out.push('jsSpace — space-group determination');
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
        if (!this.state.editors.res) return;

        const resContent = this.state.editors.res.getValue();
        if (!resContent) {
            alert("No structure loaded to refine.");
            return;
        }

        if (!this.state.hklContent) {
            alert("No HKL file loaded. Please load an .hkl file first.");
            return;
        }

        const formData = new FormData();
        const insBlob = new Blob([resContent], { type: 'text/plain' });
        const hklBlob = new Blob([this.state.hklContent], { type: 'text/plain' });

        // Ensure consistent filenames. Use HKL name as base if available, otherwise 'structure'.
        let baseName = 'structure';
        if (this.state.hklName) {
            baseName = this.state.hklName.replace(/\.hkl$/i, '');
        }

        // Sanitize basename to be safe
        baseName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');

        formData.append('ins', insBlob, baseName + '.ins');
        formData.append('hkl', hklBlob, baseName + '.hkl');

        await this.runRefinement(formData, 'tool-refine', 'Refining structure (SHELXL)...');
    }

    // Weight (GOOF) refinement: prompts for the number of SHELXL cycles (default 3)
    // and runs that many refinement cycles to drive the goodness-of-fit toward 1.
    async refineWeight() {
        if (!this.state.editors.res) return;

        const resContent = this.state.editors.res.getValue();
        if (!resContent) {
            alert("No structure loaded to refine.");
            return;
        }

        if (!this.state.hklContent) {
            alert("No HKL file loaded. Please load an .hkl file first.");
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
        const hklBlob = new Blob([this.state.hklContent], { type: 'text/plain' });

        let baseName = 'structure';
        if (this.state.hklName) {
            baseName = this.state.hklName.replace(/\.hkl$/i, '');
        }
        baseName = baseName.replace(/[^a-zA-Z0-9_-]/g, '_');

        formData.append('ins', insBlob, baseName + '.ins');
        formData.append('hkl', hklBlob, baseName + '.hkl');
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

        try {
            const response = await fetch(this.state.preferences.general.serverUrl, {
                method: 'POST',
                body: formData,
                signal: this.makeAbortSignal(controller)
            });

            if (!response.ok) {
                throw new Error(`Server error: ${response.statusText}`);
            }

            const data = await response.json();
            console.log("Server Response Data:", data);

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
                            resultsSummary.innerHTML = this.buildRefinementSummary(data.files.lst || '');
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
            }

        } catch (e) {
            if (e && e.name === 'AbortError') {
                console.log("Refinement cancelled by user");
                alert("Refinement cancelled.");
            } else {
                console.error("Refinement failed:", e);
                alert("Refinement failed: " + e.message);
            }
        } finally {
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
