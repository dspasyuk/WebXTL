#!/usr/bin/env node
// WebXTL MCP server.
//
// Exposes the functionality of the WebXTL program as Model Context Protocol
// (MCP) tools so that an AI assistant (e.g. Claude Code / opencode) can read,
// edit and refine SHELX structures through the WebXTL HTTP backend.
//
// The WebXTL backend (server.js, port 3000 by default) must be running. Point
// the tools at a different host with the WEBXTL_URL environment variable, e.g.
//
//   WEBXTL_URL=http://localhost:3000 node mcp-server.js
//
// Register with an MCP client as a stdio server:
//
//   node <path-to-repo>/mcp/mcp-server.js
//
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
    summarizeStructure,
    setOccupancy,
    setUiso,
    makeIsotropic,
    killQPeaks,
    killHydrogens,
    relabelAtoms,
    findDuplicateLabels
} from './structureTextOps.js';

const WEBXTL_URL = (process.env.WEBXTL_URL || 'http://localhost:3000').replace(/\/+$/, '');
const MAX_TEXT = 5 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Small HTTP client for the WebXTL backend.
// ---------------------------------------------------------------------------

async function getText(path) {
    const res = await fetch(`${WEBXTL_URL}${path}`);
    if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
    return res.text();
}

async function getJson(path) {
    const res = await fetch(`${WEBXTL_URL}${path}`);
    if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
    return res.json();
}

async function postJson(path, body) {
    const res = await fetch(`${WEBXTL_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    if (!res.ok) throw new Error(`POST ${path} failed: HTTP ${res.status} ${data.error || ''}`);
    return data;
}

// ---------------------------------------------------------------------------
// MCP tool helpers
// ---------------------------------------------------------------------------

function toolText(t) {
    if (t == null) return '';
    const s = String(t);
    return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\n...[truncated]' : s;
}

// Load a structure from a server project. Returns { name, filename, content }.
async function loadProjectStructure(project) {
    const data = await getJson(`/projects/${encodeURIComponent(project)}`);
    if (data.content) {
        return { name: project, filename: data.filename || `${project}.res`, content: data.content };
    }
    const files = (data.files || []).filter(f => /\.(res|ins|pdb|m42|cif)$/i.test(f));
    if (!files.length) throw new Error(`Project '${project}' has no structure file.`);
    const filename = files.find(f => /\.res$/i.test(f)) || files[0];
    const content = await getText(`/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(filename)}`);
    return { name: project, filename, content };
}

function describeProjectFiles(files) {
    return files.length ? files.join(', ') : '(empty)';
}

function messageBlock(label, text) {
    return `\n===== ${label} =====\n${toolText(text)}\n`;
}

function textResult(text) {
    return { content: [{ type: 'text', text }] };
}

// Schema helpers ------------------------------------------------------------

// Which source should an edit/read operate on?
const sourceFields = {
    project: z.string().describe('Server project to read the structure from.').optional(),
    content: z.string().describe('Explicit .res/.ins text (takes precedence over project).').optional(),
    labels: z.array(z.string()).describe('Only affect these atom labels, e.g. ["C1","C2"]. Omit to affect all atoms.').optional()
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
    name: 'webxtl',
    version: '1.0.0'
});

// --- Inspection tools ---

server.registerTool('webxtl_list_projects', {
    title: 'List server projects',
    description: 'List the crystallography projects available on the WebXTL server. Each project is a directory that stores structure files (.res/.ins), HKL data, refinement logs (.lst) and results.',
    inputSchema: z.object({})
}, async () => {
    const projects = await getJson('/projects');
    const list = (Array.isArray(projects) ? projects : (projects.projects || []));
    const text = list.length
        ? 'Available projects:\n' + list.map(p => `- ${p}`).join('\n')
        : 'No projects available yet. Load and save a structure in the WebXTL web app first.';
    return textResult(text);
});

server.registerTool('webxtl_list_project_files', {
    title: 'List project files',
    description: 'List all files stored in a server project (e.g. name.res, name.ins, name.hkl, name.lst, name.fcf).',
    inputSchema: z.object({
        project: z.string().describe('Project directory name')
    })
}, async ({ project }) => {
    const data = await getJson(`/projects/${encodeURIComponent(project)}/files`);
    const files = (data.files || []).map(f => f.name);
    return textResult(describeProjectFiles(files));
});

server.registerTool('webxtl_read_project_file', {
    title: 'Read a project file',
    description: 'Return the full text content of a file stored in a server project (structure, HKL, refinement log .lst, etc.).',
    inputSchema: z.object({
        project: z.string().describe('Project name'),
        filename: z.string().describe('File name inside the project, e.g. name.lst')
    })
}, async ({ project, filename }) => {
    const content = await getText(`/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(filename)}`);
    return textResult(toolText(content));
});

server.registerTool('webxtl_save_project_file', {
    title: 'Save a project file',
    description: 'Overwrite (or create) a text file inside a server project. Backs up the previous file on the server. Use to persist edited structure files (e.g. write name.res or name.ins).',
    inputSchema: z.object({
        project: z.string().describe('Project name'),
        filename: z.string().describe('File name, e.g. name.res'),
        content: z.string().describe('Full file text content')
    })
}, async ({ project, filename, content }) => {
    await postJson(`/projects/${encodeURIComponent(project)}/savefile`, { filename, content });
    return textResult(`Saved ${project}/${filename}.`);
});

server.registerTool('webxtl_get_structure', {
    title: 'Get current structure',
    description: 'Fetch the primary structure (.res/.ins) of a project and return its content together with a parsed summary (cell, composition, atom count). This is the main entry point for inspecting a structure.',
    inputSchema: z.object({
        project: z.string().describe('Project name')
    })
}, async ({ project }) => {
    const { filename, content } = await loadProjectStructure(project);
    const summary = summarizeStructure(content);
    let out = `Project: ${project}\nStructure file: ${filename}\n`;
    if (summary.cell) {
        const c = summary.cell;
        out += `Cell: a=${c.a} b=${c.b} c=${c.c} Å, ${c.alpha}/${c.beta}/${c.gamma}°`;
        if (c.wavelength) out += `, λ=${c.wavelength} Å`;
        out += '\n';
    }
    out += `Formula: ${summary.formula}\nAtoms: ${summary.nAtoms} (Q peaks: ${summary.nQ})`;
    if (summary.sfac.length) out += `\nSFAC: ${summary.sfac.join(' ')}`;
    out += messageBlock('STRUCTURE', content);
    return textResult(out);
});

server.registerTool('webxtl_summarize_structure', {
    title: 'Summarize structure',
    description: 'Parse a SHELX .res/.ins text (from the structure argument or from a project) and return cell parameters, composition formula and atom counts. Lightweight - does not return the raw text.',
    inputSchema: z.object({
        project: z.string().describe('Optional project name to read the structure from').optional(),
        content: z.string().describe('Optional raw .res/.ins text (used when project is not given)').optional()
    })
}, async ({ project, content }) => {
    let text = content;
    if (!text && project) {
        const s = await loadProjectStructure(project);
        text = s.content;
    }
    if (!text) throw new Error('Provide either a project name or the structure content.');
    const summary = summarizeStructure(text);
    const out = [
        `Formula: ${summary.formula}`,
        `Atoms: ${summary.nAtoms} (Q peaks: ${summary.nQ})`,
        summary.cell ? `Cell: a=${summary.cell.a} b=${summary.cell.b} c=${summary.cell.c} Å ${summary.cell.alpha}/${summary.cell.beta}/${summary.cell.gamma}°` : '',
        `SFAC: ${summary.sfac.join(' ') || 'n/a'}`
    ].filter(Boolean).join('\n');
    return textResult(out);
});

// --- Editing tools (mirror the WebXTL Options/Edit menu) ---

async function getTextToEdit(args) {
    if (args.content != null) return { text: args.content, filename: null, project: null };
    if (args.project) {
        const s = await loadProjectStructure(args.project);
        return { text: s.content, filename: s.filename, project: s.name };
    }
    throw new Error('Provide a project or explicit content to edit.');
}

const editResultText = (res, before) => {
    const lines = [`Edited ${before.filename || 'structure'}: ${res.changed} line(s) changed.`, ''];
    return lines.concat(String(res.content).split('\n')).join('\n');
};

server.registerTool('webxtl_edit_occupancy', {
    title: 'Set occupancy (sof)',
    description: 'Change the site-occupancy factor (SOF, the 5th numeric column) of atom lines in a SHELX structure. Optionally restrict to specific labels with labels=[]. Supply project to edit the structure stored on the server, or content to edit arbitrary text. Returns the complete edited structure (not saved - use webxtl_save_project_file to persist).',
    inputSchema: z.object({
        ...sourceFields,
        value: z.number().describe('New occupancy factor, e.g. 0.5, 1.0, or >10 to refine via an FVAR free variable')
    })
}, async (args) => {
    const before = await getTextToEdit(args);
    const res = setOccupancy(before.text, args.value, { labels: args.labels });
    return textResult(editResultText(res, before));
});

server.registerTool('webxtl_edit_uiso', {
    title: 'Set U(iso)',
    description: 'Change the isotropic displacement parameter U(iso) (7th column) of atom lines. Optional labels=[] to restrict.',
    inputSchema: z.object({
        ...sourceFields,
        value: z.number().describe('New U(iso) value, e.g. 0.05')
    })
}, async (args) => {
    const before = await getTextToEdit(args);
    const res = setUiso(before.text, args.value, { labels: args.labels });
    return textResult(editResultText(res, before));
});

server.registerTool('webxtl_edit_isotropic', {
    title: 'Make isotropic',
    description: 'Remove anisotropic displacement parameters (U11..U23) from atom lines, keeping only U(iso). Optional labels=[] to restrict.',
    inputSchema: z.object({ ...sourceFields })
}, async (args) => {
    const before = await getTextToEdit(args);
    const res = makeIsotropic(before.text, { labels: args.labels });
    return textResult(editResultText(res, before));
});

server.registerTool('webxtl_edit_kill_q', {
    title: 'Kill Q peaks',
    description: 'Delete all Q-peak atom lines from a structure.',
    inputSchema: z.object({ ...sourceFields })
}, async (args) => {
    const before = await getTextToEdit(args);
    const res = killQPeaks(before.text);
    return textResult(editResultText({ content: res.content, changed: res.removed.length }, before));
});

server.registerTool('webxtl_edit_kill_h', {
    title: 'Kill hydrogen atoms',
    description: 'Delete all hydrogen atom lines from a structure.',
    inputSchema: z.object({ ...sourceFields })
}, async (args) => {
    const before = await getTextToEdit(args);
    const res = killHydrogens(before.text);
    return textResult(editResultText({ content: res.content, changed: res.removed.length }, before));
});

server.registerTool('webxtl_edit_relabel', {
    title: 'Relabel atoms',
    description: 'Renumber atom labels by element in document order (C1, C2, ..., FE1, ...). Optional element= to relabel only one element type, prefix= to prepend letters.',
    inputSchema: z.object({
        project: z.string().describe('Server project to read the structure from').optional(),
        content: z.string().describe('Explicit .res/.ins text (takes precedence over project)').optional(),
        element: z.string().describe('Only relabel this element, e.g. "C"').optional(),
        prefix: z.string().describe('Prefix to prepend to new labels').optional()
    })
}, async (args) => {
    const before = await getTextToEdit(args);
    const res = relabelAtoms(before.text, { element: args.element, prefix: args.prefix });
    return textResult(editResultText({ content: res.content, changed: res.changed }, before));
});

server.registerTool('webxtl_duplicate_labels', {
    title: 'Find duplicate labels',
    description: 'Report any atom labels that appear more than once (with line numbers).',
    inputSchema: z.object({ ...sourceFields })
}, async (args) => {
    const before = await getTextToEdit(args);
    const dupes = findDuplicateLabels(before.text);
    const text = dupes.length
        ? 'Duplicate labels found:\n' + dupes.map(d => `- ${d.label} on lines ${d.rows.join(', ')}`).join('\n')
        : 'No duplicate atom labels found.';
    return textResult(text);
});

// --- Run / refine tools (delegate to the WebXTL backend) ---

server.registerTool('webxtl_available_programs', {
    title: 'List available programs',
    description: 'List the external crystallography programs (SHELXL, SHELXS, SHELXT, ...) available on the WebXTL server.',
    inputSchema: z.object({})
}, async () => {
    const data = await getJson('/programs');
    const progs = data.programs || [];
    const text = progs.length
        ? 'Available programs:\n' + progs.map(p => `- ${p.id} (${p.label}): ${p.description}; needs ${(p.inputs || []).join('+')}`).join('\n')
        : 'No external programs available on the server.';
    return textResult(text);
});

async function sendMultipart(path, fields, files) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) {
        form.append(f.field || 'file', new Blob([f.content], { type: 'text/plain' }), f.filename);
    }
    const res = await fetch(`${WEBXTL_URL}${path}`, { method: 'POST', body: form });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { data = { raw }; }
    if (!res.ok) throw new Error(`POST ${path} failed: HTTP ${res.status} ${data.error || ''}`);
    return data;
}

function renderRunResult(result, label) {
    let out = `${label} finished. success=${result.success} job=${result.jobId || ''}\n`;
    if (result.message) out += `message: ${result.message}\n`;
    if (result.stdout) out += messageBlock('STDOUT', result.stdout);
    if (result.stderr) out += messageBlock('STDERR', result.stderr);
    for (const [name, content] of Object.entries(result.files || {})) {
        out += messageBlock(`OUTPUT ${name}`, content);
    }
    return out;
}

server.registerTool('webxtl_run_refine', {
    title: 'Run SHELXL refinement',
    description: 'Run SHELXL least-squares refinement on a server project using its stored .ins/.res and .hkl files. Returns the resulting .res and .lst output. The structure must already be saved in the project.',
    inputSchema: z.object({
        project: z.string().describe('Project name'),
        cycles: z.number().describe('SHELXL cycles (1 = single regular refinement, larger numbers run WGHT optimisation)').optional()
    })
}, async ({ project, cycles }) => {
    // /refine expects the .ins and .hkl under the multipart field names 'ins'/'hkl'
    // and names the server project after the uploaded .ins basename.
    const allFiles = await getJson(`/projects/${encodeURIComponent(project)}/files`);
    const names = (allFiles.files || []).map(f => f.name);
    const insName = names.find(f => /\.ins$/i.test(f))
        || names.find(f => /\.res$/i.test(f))
        || (await getJson(`/projects/${encodeURIComponent(project)}`)).filename;
    const hklName = names.find(f => /\.hkl$/i.test(f));
    if (!insName) throw new Error(`No .ins/.res structure file found in project '${project}'.`);
    if (!hklName) throw new Error(`No .hkl file found in project '${project}'. Cannot refine.`);

    const insContent = await getText(`/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(insName)}`);
    const hklContent = await getText(`/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(hklName)}`);
    const cyclesInt = Math.max(1, Math.min(50, parseInt(cycles || '1', 10) || 1));

    const result = await sendMultipart('/refine',
        { cycles: String(cyclesInt), mode: cyclesInt > 1 ? 'weight' : 'regular' },
        [
            { field: 'ins', filename: `${project}.ins`, content: insContent },
            { field: 'hkl', filename: `${project}.hkl`, content: hklContent }
        ]);
    return textResult(renderRunResult(result, 'SHELXL refinement'));
});

server.registerTool('webxtl_run_program', {
    title: 'Run an external program',
    description: 'Run a SHELX program (shelxl, shelxs, shelxt, shelxd, ...) on a server project. Uses the project\'s stored structure and HKL files as inputs. Check webxtl_available_programs first.',
    inputSchema: z.object({
        project: z.string().describe('Project name'),
        program: z.string().describe('Program id, e.g. shelxt, shelxs, shelxl')
    })
}, async ({ project, program }) => {
    const avail = await getJson('/programs');
    const prog = (avail.programs || []).find(p => p.id === program);
    if (!prog) throw new Error(`Program '${program}' is not available on the server.`);

    const allFiles = await getJson(`/projects/${encodeURIComponent(project)}/files`);
    const names = (allFiles.files || []).map(f => f.name);
    const exts = (prog.inputs || []).map(e => e.toLowerCase());
    const found = names.filter(n => exts.some(ext => n.toLowerCase().endsWith(ext)));
    if (!found.length) {
        throw new Error(`None of the required input files (.${exts.join(' .')}) were found in project '${project}'.`);
    }
    // Rename inputs to the project basename so all outputs land back in this project.
    const inputs = [];
    for (const name of found) {
        const ext = name.slice(name.lastIndexOf('.'));
        const content = await getText(`/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(name)}`);
        inputs.push({ field: 'file', filename: `${project}${ext}`, content });
    }
    const result = await sendMultipart(`/run/${program}`, {}, inputs);
    const label = `${prog.label} (${program})`;
    let out = `${label} finished. success=${result.success} job=${result.jobId || ''}\n`;
    if (result.message) out += `message: ${result.message}\n`;
    if (result.stdout) out += messageBlock('STDOUT', result.stdout);
    if (result.stderr) out += messageBlock('STDERR', result.stderr);
    for (const [name, content] of Object.entries(result.files || {})) {
        out += messageBlock(`OUTPUT ${name}`, content);
    }
    return textResult(out);
});

server.registerTool('webxtl_summarize_refinement', {
    title: 'Summarize refinement results',
    description: 'Return a plain-text digest of a refinement log (.lst) file in a project (R1, wR2, GooF, Flack, residual peak/hole and the tail of the log).',
    inputSchema: z.object({
        project: z.string().describe('Project name'),
        lstfile: z.string().describe('Optional .lst file name; defaults to <project>.lst').optional()
    })
}, async ({ project, lstfile }) => {
    const data = await getJson(`/projects/${encodeURIComponent(project)}/files`);
    const files = (data.files || []).map(f => f.name);
    const candidates = lstfile ? [lstfile] : files.filter(f => f.toLowerCase().endsWith('.lst'));
    if (!candidates.length) {
        return textResult(`No .lst found for project '${project}'. Run a refinement first.\nAvailable: ${describeProjectFiles(files)}`);
    }
    const chosen = candidates[candidates.length - 1];
    const lst = await getText(`/projects/${encodeURIComponent(project)}/files/${encodeURIComponent(chosen)}`);
    const grab = (re) => {
        const m = lst.match(re);
        return m && m[1] != null ? m[1] : null;
    };
    const lines = [];
    const r1 = grab(/R1\s*=\s*([\d.]+)\s+for\s+\d+\s+Fo\s*>\s*\d+sig\(Fo\)/);
    const wr = lst.match(/wR2\s*=\s*([\d.]+),\s*GooF\s*=\s*S\s*=\s*([\d.]+)/);
    const flack = grab(/Flack\s*x\s*=\s*([\d.\-()]+)/);
    const peak = grab(/Highest\s+peak\s*([\d.\-]+)/);
    const hole = grab(/Deepest\s+hole\s*([\d.\-]+)/);
    const goof = wr ? wr[2] : null;
    const wr2 = wr ? wr[1] : null;
    lines.push(`Refinement log: ${chosen}`);
    if (r1) lines.push(`R1 (I>2σ): ${r1}`);
    if (wr2) lines.push(`wR2: ${wr2}`);
    if (goof) lines.push(`GooF (S): ${goof}`);
    if (flack) lines.push(`Flack x: ${flack}`);
    if (peak) lines.push(`Highest peak: ${peak} e/Å³`);
    if (hole) lines.push(`Deepest hole: ${hole} e/Å³`);
    if (lines.length === 1) lines.push('No recognizable refinement statistics found in the log.');
    lines.push(messageBlock('LST TAIL', lst.slice(-4000)));
    return textResult(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`WebXTL MCP server ready. Backend: ${WEBXTL_URL}`);
