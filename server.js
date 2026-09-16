import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { buildPublishCif, buildPublishCifFromTemplates, buildReportDocx, parseDevFile, parseCif } from './publish.js';
import { analyzeHkl } from './src/js/xrdspace/index.js';
import { transformModelToSpaceGroup } from './src/js/xrdspace/sg-model.js';
import { searchByCell } from './src/js/xrdspace/cell-search.js';
import { importStructureToProject } from './src/js/xrdspace/fetch-structure.js';
import { validateStructure, renderReport, parseStructure, detectDisorder, detectTwinning } from './src/js/validate/structureValidation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
// Middleware
app.use(cors({
    origin: '*', // Allow all origins for dev
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100mb' }));

// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Ensure projects directory exists
const PROJECTS_DIR = path.join(__dirname, 'projects');
if (!fs.existsSync(PROJECTS_DIR)) {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

// Templates directory (user .cif + device .dev templates)
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const DEVICE_DIR = path.join(TEMPLATES_DIR, 'device');

// Serve static files from 'dist' directory
app.use(express.static(path.join(__dirname, 'dist')));

// ---------------------------------------------------------------------------
// External crystallography programs
// ---------------------------------------------------------------------------

// Hard timeout for any spawned crystallography program.
const RUN_TIMEOUT_MS = 180000;

// If a spawned process produces no output at all for this long it is presumed
// stuck (e.g. SHELXL blocked on an interactive error prompt) and is killed.
const NO_OUTPUT_KILL_MS = 120000;

// Registry of programs the server can run. `exe` is looked up in PATH; a
// program is only offered to the client when it is actually available.
// `inputs` are the file extensions the client must supply; `outputs` are the
// files collected from the project dir and returned to the client. `stdin`
// is optional text piped to the process for interactive programs.
const PROGRAMS = {
    shelxl: {
        label: 'SHELXL',
        description: 'Least-squares structure refinement',
        exe: 'shelxl',
        inputs: ['.ins', '.hkl'],
        outputs: ['.res', '.lst', '.fcf'],
        stdin: null,
    },
    shelxs: {
        label: 'SHELXS',
        description: 'Structure solution (Patterson / direct methods)',
        exe: 'shelxs',
        inputs: ['.ins', '.hkl'],
        outputs: ['.res', '.lst'],
        stdin: null,
    },
    shelxt: {
        label: 'SHELXT',
        description: 'Structure solution (dual-space methods)',
        exe: 'shelxt',
        inputs: ['.ins', '.hkl'],
        outputs: ['.res', '.lst'],
        stdin: null,
    },
    shelxd: {
        label: 'SHELXD',
        description: 'Heavy-atom / dual-space structure solution',
        exe: 'shelxd',
        inputs: ['.ins', '.hkl'],
        outputs: ['.res', '.lst'],
        stdin: null,
    },
    shelxh: {
        label: 'SHELXH',
        description: 'Least-squares refinement (macromolecular)',
        exe: 'shelxh',
        inputs: ['.ins', '.hkl'],
        outputs: ['.res', '.lst', '.fcf'],
        stdin: null,
    },
    shelxe: {
        label: 'SHELXE',
        description: 'SAD/MAD phasing and density modification',
        exe: 'shelxe',
        inputs: ['.hkl'],
        outputs: ['.res', '.phs', '.psd', '.pdb', '.lst'],
        stdin: null,
    },
    shelxc: {
        label: 'SHELXC',
        description: 'Data merging and preparation for SAD/MAD',
        exe: 'shelxc',
        inputs: ['.hkl'],
        outputs: ['.hkl', '.lst'],
        stdin: null,
    },
    platon: {
        label: 'PLATON',
        description: 'Structure validation, geometry and graphics (PLATON)',
        exe: 'platon',
        inputs: ['.res'],
        outputs: ['.ckf', '.lst', '.fab', '.fcf', '.cif', '.txt'],
        stdin: null,
    },
};

// Check whether an executable is reachable through the system PATH.
function isExecutableAvailable(exe) {
    const isWin = process.platform === 'win32';
    const names = isWin ? [exe, `${exe}.exe`, `${exe}.cmd`, `${exe}.bat`] : [exe];
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const name of names) {
            try {
                const p = path.join(dir, name);
                if (fs.existsSync(p) && fs.statSync(p).isFile() && (isWin || (fs.statSync(p).mode & 0o111))) {
                    return true;
                }
            } catch (e) { /* ignore */ }
        }
    }
    return false;
}

// Programs that are present in the global environment (computed at startup).
const availablePrograms = Object.keys(PROGRAMS).filter(id => isExecutableAvailable(PROGRAMS[id].exe));
console.log(`Available crystallography programs: ${availablePrograms.length ? availablePrograms.join(', ') : 'none'}`);

// Run <program> once on <basename> in <projectDir>. Resolves with { code, stdout, stderr }.
// `stdin` is optional text piped to the process. `signal` is an optional
// AbortSignal; when aborted (e.g. the client cancelled) the child is killed.
function runProgram(program, args, cwd, stdin, signal) {
    return new Promise((resolve) => {
        // Always connect stdin so interactive prompts (e.g. SHELXL asking the
        // user whether to continue after an error) can be answered instead of
        // the process spinning forever on an EOF. `detached` puts the child in
        // its own process group so we can kill any descendants it spawns.
        const child = spawn(program.exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        let stdout = '';
        let stderr = '';
        let aborted = false;
        let done = false;
        let lastOutput = Date.now();
        let watchdog = null;
        let stdinFeeder = null;

        // Kill the whole process group so grandchildren cannot keep the stdio
        // pipes open and prevent the 'close' event (which resolves the promise).
        const killChild = () => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* already dead */ }
            try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
        };

        const cleanup = () => {
            clearTimeout(timer);
            if (watchdog) clearInterval(watchdog);
            if (stdinFeeder) clearInterval(stdinFeeder);
            if (signal) signal.removeEventListener('abort', onAbort);
        };

        const timer = setTimeout(() => killChild(), RUN_TIMEOUT_MS);
        const onAbort = () => { aborted = true; killChild(); };
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        // Watchdog: if the process is still running but has been silent for
        // NO_OUTPUT_KILL_MS, it is stuck - kill it so the server never hangs.
        watchdog = setInterval(() => {
            if (done) return;
            if (Date.now() - lastOutput > NO_OUTPUT_KILL_MS) {
                console.warn(`[${program.exe}] no output for ${NO_OUTPUT_KILL_MS}ms - killing`);
                killChild();
            }
        }, 2000);

        child.stdout.on('data', (d) => { stdout += d.toString(); lastOutput = Date.now(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); lastOutput = Date.now(); });
        child.on('close', (code) => { done = true; cleanup(); resolve({ code, aborted, stdout, stderr }); });
        child.on('error', (err) => { done = true; cleanup(); resolve({ code: -1, aborted, stdout, stderr: stderr + '\n' + err.message }); });

        if (stdin) {
            child.stdin.write(stdin);
            child.stdin.end();
        } else {
            // No scripted stdin: keep the pipe open and answer any interactive
            // prompt with <Enter> once the process goes silent. Without a writer
            // the pipe reads as EOF and some programs loop on that condition.
            stdinFeeder = setInterval(() => {
                if (done || child.stdin.destroyed) return;
                if (Date.now() - lastOutput > 1500) {
                    try { child.stdin.write('\n'); } catch (e) { /* stdin closed */ }
                }
            }, 1000);
        }
    });
}

// Run SHELXL once on <basename> in <projectDir>. Resolves with { code, stdout, stderr }.
// Every run is guaranteed an L.S. instruction: SHELXL does no refinement at all
// without one, and its own .res output (fed back as the next .ins) has none.
function runShelxl(projectDir, basename, signal, cycles) {
    ensureLsInstruction(path.join(projectDir, `${basename}.ins`), cycles);
    return runProgram(PROGRAMS.shelxl, [basename], projectDir, undefined, signal);
}

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// List non-hidden, non-backup files in a project directory (files only).
function listProjectFiles(projectDir) {
    try {
        return fs.readdirSync(projectDir).filter(f =>
            f !== 'backup' && !f.startsWith('.') && fs.statSync(path.join(projectDir, f)).isFile());
    } catch (e) {
        return [];
    }
}

// Promote any <basename>_*<ext> companion file (e.g. PLATON's <base>_sq.fab or
// <base>_sq.hkl) to the canonical <basename><ext> name SHELXL/PLATON look for,
// so a same-basename file stored in a project is exposed to the next run even
// when the client did not upload it. Returns the canonical path, or null.
function promoteCompanionToCanonical(projectDir, basename, ext) {
    if (!fs.existsSync(projectDir)) return null;
    const canonical = path.join(projectDir, `${basename}${ext}`);
    if (fs.existsSync(canonical)) {
        try {
            if (fs.statSync(canonical).size > 0) return canonical;
        } catch (e) { /* fall through */ }
    }
    const re = new RegExp('^' + escapeRegExp(basename) + '_[^.]*' + escapeRegExp(ext) + '$', 'i');
    const match = listProjectFiles(projectDir).find(f => re.test(f));
    if (!match) return null;
    try {
        fs.copyFileSync(path.join(projectDir, match), canonical);
        return canonical;
    } catch (e) {
        return null;
    }
}

// Ensure the companion files a program needs are present in the project
// directory under the canonical <basename><ext> name. Files the client already
// uploaded are kept as-is; anything else is taken from a same-basename file
// already stored in the project (including _sq variants). Returns the list of
// canonical names that are actually available for the run.
function ensureCompanionInputs(projectDir, basename, uploadedNames, exts) {
    const available = [];
    for (const ext of exts || []) {
        const name = `${basename}${ext}`;
        if (uploadedNames.includes(name)) {
            available.push(name);
            continue;
        }
        if (fs.existsSync(path.join(projectDir, name))) {
            available.push(name);
            continue;
        }
        if (promoteCompanionToCanonical(projectDir, basename, ext)) {
            available.push(name);
        }
    }
    return available;
}

// After a program run, promote any suffixed companion outputs (PLATON writes
// <base>_sq.{fab,hkl}, SHELX/PLATON may write other _ variants) back into the
// canonical <basename>.<ext> files in the project directory so the next run of
// SHELXL (or PLATON) picks them up. Returns names that were promoted.
function promoteCompanionOutputs(projectDir, basename, exts) {
    const promoted = [];
    for (const ext of exts || ['.fab', '.fcf', '.hkl']) {
        if (promoteCompanionToCanonical(projectDir, basename, ext)) {
            const name = `${basename}${ext}`;
            if (!promoted.includes(name)) promoted.push(name);
        }
    }
    return promoted;
}

// True when a SHELX instruction file (.ins/.res) requests the SQUEEZE solvent
// mask via an ABIN instruction (SHELXL then needs <basename>.fab next to it).
function insRequestsFab(projectDir, basename) {
    for (const ext of ['.ins', '.res']) {
        const p = path.join(projectDir, `${basename}${ext}`);
        if (!fs.existsSync(p)) continue;
        try {
            if (/^\s*ABIN\b/m.test(fs.readFileSync(p, 'utf8'))) return true;
        } catch (e) { /* ignore */ }
    }
    return false;
}

// Find an HKL (or other companion) file stored in a project under the given
// basename. Prefers the canonical <basename>.<ext>, then any same-basename
// file (e.g. <basename>_sq.hkl, <basename>_merged.hkl). Returns full path.
function findCompanionFile(projectDir, basename, ext) {
    if (!fs.existsSync(projectDir)) return null;
    const canonical = path.join(projectDir, `${basename}${ext}`);
    if (fs.existsSync(canonical)) return canonical;
    const re = new RegExp('^' + escapeRegExp(basename) + '(_[^.]*)?' + escapeRegExp(ext) + '$', 'i');
    const match = listProjectFiles(projectDir).find(f => re.test(f));
    return match ? path.join(projectDir, match) : null;
}

// Parse the "Recommended weighting scheme: WGHT a b" line from a SHELXL .lst.
// Returns { a, b } or null.
function parseRecommendedWght(lstText) {
    const m = lstText.match(/Recommended weighting scheme:\s*WGHT\s+([\d.]+)\s+([\d.]+)/);
    return m ? { a: m[1], b: m[2] } : null;
}

// Replace the first WGHT instruction line in a file with "WGHT a b".
// SHELXL does not update this line itself, so we must do it for WGHT optimization.
function updateWghtInstruction(filePath, a, b) {
    if (!fs.existsSync(filePath)) return false;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    let done = false;
    for (let i = 0; i < lines.length; i++) {
        if (/^WGHT/.test(lines[i].trim())) {
            lines[i] = `WGHT    ${a}   ${b}`;
            done = true;
            break;
        }
    }
    if (done) fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return done;
}

// Ensure the .ins contains an L.S. (least-squares) instruction. SHELXL only
// refines when L.S. is present -- without it, it performs a single structure-
// factor calculation and leaves the model untouched. SHELXL's own .res output
// has no L.S. line, and the client feeds that .res back as the next .ins, so
// every later "refine" silently did zero cycles and the structure never
// changed. Returns true when an L.S. line was inserted.
function ensureLsInstruction(filePath, cycles) {
    if (!fs.existsSync(filePath)) return false;
    const text = fs.readFileSync(filePath, 'utf8');
    // Leave an L.S. instruction provided by the user / SHELXT / a .res alone.
    if (/^[ \t]*L\.?S\.?[ \t]+\d+/im.test(text)) return false;
    // Insert before HKLF (SHELX reads instructions before the atom list / data);
    // fall back to before END, else append.
    const lines = text.split(/\r?\n/);
    let idx = lines.findIndex(l => /^[ \t]*HKLF\b/i.test(l));
    if (idx === -1) idx = lines.findIndex(l => /^[ \t]*END\b/i.test(l));
    const n = Math.max(10, parseInt(cycles, 10) || 10);
    const lsLine = `L.S. ${n}`;
    if (idx === -1) lines.push(lsLine);
    else lines.splice(idx, 0, lsLine);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return true;
}

// Detect a fatal SHELXL error in its combined stdout/.lst output. Returns a
// short human-readable message, or null when none of the known fatal markers
// are present. Warnings (e.g. "Cell contents from UNIT instruction ... do not
// agree") are deliberately NOT matched because SHELXL continues refining.
function detectShelxlError(stdout, lstText) {
    const text = (stdout || '') + '\n' + (lstText || '');
    const markers = [
        /BAD ATOM OR UNKNOWN INSTRUCTION/i,
        /UNKNOWN INSTRUCTION/i,
        /TOO MANY ATOMS/i,
        /TOO MANY PARAMETERS/i,
        /MATRIX SINGULAR/i,
        /SINGULAR MATRIX/i,
        /NO REFLECTIONS/i,
        /TOO FEW REFLECTIONS/i,
        /INSUFFICIENT MEMORY/i,
        /OUT OF MEMORY/i,
        /CANNOT FIND\s+SFAC/i,
        /INVALID\s+SFAC/i,
        /CELL.*DO NOT AGREE/i,
    ];
    for (const re of markers) {
        const m = text.match(re);
        if (m) return m[0].trim();
    }
    return null;
}

/**
 * POST /refine
 * Expects 'ins' and 'hkl' files in multipart/form-data.
 * Optional JSON body: { cycles: <int> } — number of SHELXL refinement cycles (default 1).
 */
app.post('/refine', upload.fields([{ name: 'ins', maxCount: 1 }, { name: 'hkl', maxCount: 1 }, { name: 'cycles', maxCount: 1 }, { name: 'mode', maxCount: 1 }]), async (req, res) => {
    const jobId = uuidv4(); // Still useful for logging

    // Abort the spawned SHELXL process when the client disconnects / cancels.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
        // Validate inputs. The .ins is always required (SHELXL reads it). The
        // .hkl may be omitted when the project directory already holds a
        // same-basename reflection file (the client keeps HKL server-side and
        // never streams it through the browser).
        if (!req.files || !req.files['ins']) {
            return res.status(400).json({ error: 'An .ins file is required.' });
        }

        const insFile = req.files['ins'][0];
        const hklFile = req.files['hkl'] && req.files['hkl'][0] ? req.files['hkl'][0] : null;

        // Determine basename from uploaded .ins file
        const originalName = insFile.originalname;
        const basename = path.parse(originalName).name;

        // Multipart text fields arrive as arrays in req.body.
        const field = (name, dflt) => {
            let v = (req.body && req.body[name]) || dflt;
            if (Array.isArray(v)) v = v[0];
            return v;
        };

        // Refinement mode: 'weight' optimizes the WGHT instruction over several
        // cycles; anything else is a single regular SHELXL run.
        const mode = field('mode', 'regular');
        let cycles = parseInt(field('cycles', '1'), 10);
        if (!Number.isFinite(cycles) || cycles < 1) cycles = 1;
        if (cycles > 50) cycles = 50;

        // Create project directory: projects/[basename]
        const projectDir = path.join(PROJECTS_DIR, basename);
        if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
        }

        // Create backup directory: projects/[basename]/backup
        const backupDir = path.join(projectDir, 'backup');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        // Move files to project directory
        // Use the original filename (or at least the basename + ext)
        const insPath = path.join(projectDir, `${basename}.ins`);
        const hklPath = path.join(projectDir, `${basename}.hkl`);

        // Move (rename) uploaded temp files to project dir
        // Note: renameSync might fail across partitions, but usually fine in same container/fs
        // If upload.dest is on same fs, rename works.
        fs.renameSync(insFile.path, insPath);
        if (hklFile) {
            fs.renameSync(hklFile.path, hklPath);
        } else {
            // No .hkl uploaded: reuse the exact same-basename reflections already
            // stored in this project directory (the client keeps HKL server-side).
            if (!fs.existsSync(hklPath)) {
                return res.status(400).json({
                    error: `No .hkl reflections available for '${basename}'. Upload a .hkl file (File > Load HKL) or run from a project that contains ${basename}.hkl.`
                });
            }
        }
        // SHELXL consumes the SQUEEZE mask only when <basename>.fab sits next to
        // the refinement input; promote any stored _sq fab before refining.
        if (insRequestsFab(projectDir, basename)) {
            promoteCompanionToCanonical(projectDir, basename, '.fab');
        }

        // Create Backup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `${basename}_${timestamp}.ins`);
        fs.copyFileSync(insPath, backupPath);

        const resPath = path.join(projectDir, `${basename}.res`);
        const lstPath = path.join(projectDir, `${basename}.lst`);

        let lastCode = 0;
        let combinedStdout = '';
        let combinedStderr = '';

        if (mode === 'weight') {
            // WGHT optimization loop: run SHELXL, read the recommended WGHT from the
            // .lst, write it into the .ins instruction, and re-run. SHELXL never updates
            // the WGHT instruction itself, so we must apply the recommendation manually.
            console.log(`[${jobId}] Starting WGHT optimization for project '${basename}' (${cycles} cycle(s))...`);
            let lastRec = null;
            for (let c = 1; c <= cycles; c++) {
                console.log(`[${jobId}] WGHT cycle ${c}/${cycles}...`);
                const r = await runShelxl(projectDir, basename, undefined, cycles);
                lastCode = r.code;
                combinedStdout += (c > 1 ? '\n' : '') + `===== SHELXL WGHT cycle ${c} =====\n` + r.stdout;
                combinedStderr += r.stderr;

                // Read the recommended WGHT and apply it to the .ins for the next cycle.
                if (fs.existsSync(lstPath)) {
                    const rec = parseRecommendedWght(fs.readFileSync(lstPath, 'utf8'));
                    if (rec) {
                        lastRec = rec;
                        updateWghtInstruction(insPath, rec.a, rec.b);
                        console.log(`[${jobId}] Recommended WGHT ${rec.a} ${rec.b}`);
                    }
                }
            }
            // SHELXL echoes the WGHT instruction it read, so the .res still shows the
            // previous value. Patch the final .res (and .ins) with the last recommended
            // WGHT so the editor shows it and the next refinement uses it.
            if (lastRec) {
                updateWghtInstruction(resPath, lastRec.a, lastRec.b);
                updateWghtInstruction(insPath, lastRec.a, lastRec.b);
            }
        } else {
            // Regular refinement: a single SHELXL run on the uploaded .ins.
            console.log(`[${jobId}] Starting refinement for project '${basename}'...`);
            const r = await runShelxl(projectDir, basename, undefined, cycles);
            lastCode = r.code;
            combinedStdout = r.stdout;
            combinedStderr = r.stderr;
        }

        console.log(`[${jobId}] Finished with code ${lastCode}`);

        const result = {
            success: lastCode === 0,
            jobId: jobId,
            mode: mode,
            cycles: cycles,
            stdout: combinedStdout,
            stderr: combinedStderr,
            files: {}
        };

        if (fs.existsSync(resPath)) {
            result.files.res = fs.readFileSync(resPath, 'utf8');
        }
        if (fs.existsSync(lstPath)) {
            result.files.lst = fs.readFileSync(lstPath, 'utf8');
        }

        // SHELXL reports success with exit code 0 even when it aborts on a bad
        // instruction (e.g. "** BAD ATOM OR UNKNOWN INSTRUCTION **"), leaving an
        // empty .res. Treat a run with no usable .res as a failure and surface
        // the SHELXL error message so the UI does not look like it is stuck.
        const resContent = result.files.res || '';
        if (lastCode !== 0 || resContent.trim().length === 0) {
            result.success = false;
            result.message = detectShelxlError(combinedStdout, result.files.lst || '')
                || (resContent.trim().length === 0
                    ? 'SHELXL did not produce a .res file (the refinement was aborted).'
                    : 'SHELXL exited with a non-zero status.');
        }

        // NO CLEANUP - Keep files for persistence

        res.json(result);

    } catch (error) {
        console.error(`[${jobId}] Unexpected error:`, error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// --- External Program API ---

// GET /programs
// Returns the external crystallography programs available on the server
// (only those whose executables are present in the global PATH).
app.get('/programs', (req, res) => {
    const programs = availablePrograms.map(id => ({
        id,
        label: PROGRAMS[id].label,
        description: PROGRAMS[id].description,
        inputs: PROGRAMS[id].inputs,
    }));
    res.json({ programs });
});

/**
 * POST /run/:program
 * Runs an external crystallography program on uploaded structure files.
 * Uploaded files are moved into a project directory named after the basename
 * of the first file (each stored as <basename><ext>).
 * Returns { success, jobId, program, stdout, stderr, files: {name: content} }.
 */
app.post('/run/:program', upload.any(), async (req, res) => {
    const jobId = uuidv4();
    const programId = req.params.program;
    const program = PROGRAMS[programId];

    if (!program) {
        return res.status(404).json({ error: `Unknown program: ${programId}` });
    }
    if (!availablePrograms.includes(programId)) {
        return res.status(400).json({ error: `Program '${program.label}' is not available on this server.` });
    }
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'At least one structure file is required.' });
    }

    // Abort the spawned program when the client disconnects / cancels.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    try {
        // Determine basename from the first uploaded file.
        const first = req.files[0];
        const basename = path.parse(first.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '_');

        const projectDir = path.join(PROJECTS_DIR, basename);
        fs.mkdirSync(projectDir, { recursive: true });
        const backupDir = path.join(projectDir, 'backup');
        fs.mkdirSync(backupDir, { recursive: true });

        // Move uploads into the project as <basename><ext>, backing up existing files.
        const uploadedNames = [];
        for (const file of req.files) {
            const ext = path.extname(file.originalname).toLowerCase();
            const dest = path.join(projectDir, `${basename}${ext}`);
            uploadedNames.push(`${basename}${ext}`);
            if (fs.existsSync(dest)) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                fs.copyFileSync(dest, path.join(backupDir, `${basename}_${timestamp}${ext}`));
                fs.rmSync(dest);
            }
            fs.renameSync(file.path, dest);
        }

        console.log(`[${jobId}] Running ${program.label} on '${basename}'...`);

        // Companion files: SHELX/PLATON programs consume the reflections, solvent
        // mask or structure files that share the run's basename. When the client
        // did not upload one of these (they stay server-side in the project dir)
        // expose the same-basename file already stored here so the run works
        // without re-streaming the (potentially huge) content through the browser.
        if (fs.existsSync(projectDir)) {
            if (program.inputs && program.inputs.length) {
                // Only .fab/.fcf are safely promoted from _sq variants; the HKL
                // must remain the exact <basename>.hkl the client is working on.
                const promoteExts = program.inputs.filter(e => ['.fab', '.fcf'].includes(e.toLowerCase()));
                if (promoteExts.length) {
                    ensureCompanionInputs(projectDir, basename, uploadedNames, promoteExts);
                }
            }
            // A SHELXL model carrying ABIN needs <basename>.fab next to the
            // refinement input; promote any _sq fab stored in the project.
            if (insRequestsFab(projectDir, basename)) {
                promoteCompanionToCanonical(projectDir, basename, '.fab');
            }
            if (programId === 'platon') {
                promoteCompanionToCanonical(projectDir, basename, '.fcf');
            }
        }
        // If a program needs a reflection/instruction file that is not uploaded
        // and is not present in the project directory, fail early with a clear
        // message instead of letting the program abort cryptically. SHELXL
        // reads <basename>.hkl, so a _sq/_merged sibling does not substitute.
        if (program.inputs && program.inputs.includes('.hkl')
            && !uploadedNames.includes(`${basename}.hkl`)
            && !fs.existsSync(path.join(projectDir, `${basename}.hkl`))) {
            return res.status(400).json({
                error: `No .hkl reflections available for '${basename}'. Upload a .hkl file (File > Load HKL) or run from a project that contains ${basename}.hkl.`
            });
        }

        // PLATON is interactive/X11 software; the generic runner would hang on
        // the GUI. Use the best-effort check runner instead (short timeout,
        // collects any report files PLATON writes, reports missing runtime).
        let r;
        if (programId === 'platon') {
            const action = (() => {
                let v = req.body && req.body.action;
                if (Array.isArray(v)) v = v[0];
                return PLATON_ACTIONS[v] ? v : 'checkcif';
            })();
            // SQUEEZE / TWINROTMAT need the companion reflection files named
            // exactly <basename>.fcf (PLATON derives them from the model name).
            // If the client did not upload them, reuse any already stored in
            // this project directory so PLATON can actually run.
            if (PLATON_ACTIONS[action].needsFcf) {
                if (!fs.existsSync(path.join(projectDir, `${basename}.fcf`))) {
                    const existing = fs.readdirSync(projectDir).find(f => f.toLowerCase().endsWith('.fcf'));
                    if (existing) fs.copyFileSync(path.join(projectDir, existing), path.join(projectDir, `${basename}.fcf`));
                }
            }
            const p = await runPlatonCheck(projectDir, basename, uploadedNames, controller.signal, { action });
            r = {
                code: p.ok ? 0 : (p.code == null ? 1 : p.code),
                stdout: p.stdout || '',
                stderr: (p.stderr || '') + (p.reason ? `\n${p.reason}` : '')
            };
            if (p.files) {
                for (const [name, content] of Object.entries(p.files)) {
                    if (!r.filesText) r.filesText = {};
                    r.filesText[name] = content;
                }
            }
            if (!r.stdout && !Object.keys(r.filesText || {}).length) {
                r.stderr = (r.stderr || '') + `\n[${PLATON_ACTIONS[action].label}] PLATON produced no output for this model/action.`;
            }

            // --- SQUEEZE integration for SHELXL ---
            // PLATON writes <basename>_sq.{fab,ins,res}. SHELXL consumes the
            // solvent contribution only when (a) an "ABIN" instruction is
            // present in the .ins/.res AND (b) the .fab file sits next to the
            // refinement input named exactly <basename>.fab. Promote those so
            // the next SHELXL run (from the editor or this server) picks up
            // the SQUEEZE-corrected reflections.
            if (action === 'squeeze') {
                const sqFab = path.join(projectDir, `${basename}_sq.fab`);
                const sqIns = path.join(projectDir, `${basename}_sq.ins`);
                const sqRes = path.join(projectDir, `${basename}_sq.res`);
                const fabDest = path.join(projectDir, `${basename}.fab`);
                if (fs.existsSync(sqFab)) {
                    fs.copyFileSync(sqFab, fabDest);
                }
                // Build an updated .ins/.res that carries the ABIN instruction.
                let updated = null;
                if (fs.existsSync(sqIns)) updated = fs.readFileSync(sqIns, 'utf8');
                else if (fs.existsSync(sqRes)) updated = fs.readFileSync(sqRes, 'utf8');
                else updated = fs.existsSync(path.join(projectDir, `${basename}.res`))
                    ? fs.readFileSync(path.join(projectDir, `${basename}.res`), 'utf8') : null;

                if (updated) {
                    if (!/^\s*ABIN\b/m.test(updated)) {
                        updated = updated.replace(/^(\s*WGHT\b)/m, 'ABIN\n$1');
                        if (!/^\s*ABIN\b/m.test(updated)) updated += '\nABIN\n';
                    }
                    fs.writeFileSync(path.join(projectDir, `${basename}.ins`), updated, 'utf8');
                    fs.writeFileSync(path.join(projectDir, `${basename}.res`), updated, 'utf8');
                    r.filesText = r.filesText || {};
                    // Expose the SQUEEZE-ready model back to the client.
                    r.filesText[`${basename}.ins`] = updated;
                    r.filesText[`${basename}.res`] = updated;
                    r.filesText[`${basename}.fab`] = fs.existsSync(fabDest)
                        ? fs.readFileSync(fabDest, 'utf8').slice(0, 4096) : '(fab written to project)';
                    const fabOK = fs.existsSync(fabDest) && fs.statSync(fabDest).size > 0;
                    r.fabReady = fabOK;
                    r.squeezeApplied = true;
                    r.stdout = (r.stdout || '') +
                        `\n\n[SQUEEZE] Applied for SHELXL: ABIN added to ${basename}.ins/.res and solvent mask installed as ${basename}.fab (${fabOK ? 'ready for SHELXL' : 'fab missing'}). Next refinement will subtract the disordered-solvent contribution.`;
                } else {
                    r.stdout = (r.stdout || '') + '\n\n[SQUEEZE] Note: PLATON did not write a usable SQUEEZE model file.';
                }
            }
            // For every PLATON action also promote any produced companion files
            // (_sq.fab, .fcf) back to the canonical project names so a following
            // SHELXL run picks the solvent mask up from the project dir. The
            // reflection dataset (.hkl) is never overwritten by a _sq sibling.
            if (fs.existsSync(projectDir)) {
                promoteCompanionOutputs(projectDir, basename, ['.fab', '.fcf']);
            }
        } else {
            // A manual SHELXL run also needs an L.S. instruction; models loaded
            // from a SHELXL .res carry none.
            if (programId === 'shelxl') {
                ensureLsInstruction(path.join(projectDir, `${basename}.ins`), undefined);
            }
            r = await runProgram(program, [basename], projectDir, program.stdin, controller.signal);
            // Promote any companion outputs the program wrote under suffixed
            // names (e.g. _sq.fab) to the canonical project files so the next
            // SHELXL/PLATON run picks them up from the project dir. The
            // reflection dataset (.hkl) is never overwritten by a _sq sibling.
            if (fs.existsSync(projectDir)) {
                promoteCompanionOutputs(projectDir, basename, ['.fab', '.fcf']);
            }
        }

        const result = {
            success: r.code === 0,
            jobId: jobId,
            program: programId,
            stdout: r.stdout,
            stderr: r.stderr,
            files: {},
        };

        if (r.filesText) {
            Object.assign(result.files, r.filesText);
        }
        if (programId === 'platon') {
            result.squeezeApplied = r.squeezeApplied === true;
            result.fabReady = r.fabReady === true;
        }

        // Collect the output files defined for this program. Programs may write
        // suffixed files (e.g. SHELXT's name_a.res), so scan the whole project
        // directory rather than only exact <basename><ext> names. Uploaded input
        // files and the backup directory are skipped.
        const outExts = program.outputs;
        if (fs.existsSync(projectDir)) {
            for (const f of fs.readdirSync(projectDir)) {
                if (f === 'backup' || f.startsWith('.')) continue;
                const full = path.join(projectDir, f);
                if (!fs.statSync(full).isFile()) continue;
                if (uploadedNames.includes(f)) continue;
                if (!outExts.includes(path.extname(f).toLowerCase())) continue;
                if (fs.statSync(full).size >= 5 * 1024 * 1024) continue;
                try {
                    result.files[f] = fs.readFileSync(full, 'utf8');
                } catch (e) { /* skip binary files */ }
            }
        }

        console.log(`[${jobId}] ${program.label} finished with code ${r.code}`);
        if (programId === 'shelxl') {
            const lstText = result.files[`${basename}.lst`]
                || result.files[`${basename}_a.lst`]
                || result.files.lst || '';
            const resText = result.files[`${basename}.res`]
                || result.files[`${basename}_a.res`]
                || result.files.res || '';
            if (r.code !== 0 || resText.trim().length === 0) {
                result.success = false;
                result.message = detectShelxlError(r.stdout, lstText)
                    || (resText.trim().length === 0
                        ? 'SHELXL did not produce a .res file (the refinement was aborted).'
                        : `SHELXL exited with a non-zero status (${r.code}).`);
            }
        }
        res.json(result);
    } catch (error) {
        console.error(`[${jobId}] ${programId} error:`, error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// --- xrdspace: space-group determination (XPREP alternative) ---

// ===========================================================================
// Structure solution & validation pipeline ("Solve structure fully")
// ===========================================================================

const SOLUTION_PREFERENCE = ['shelxt', 'shelxs'];
const PLATON_TIMEOUT_MS = 60000;

function readUploadText(uploaded) {
    try { return fs.readFileSync(uploaded.path, 'utf8'); } catch (e) { return ''; }
}

// True when a SHELX file already contains an atom model (not only instructions).
function textHasModel(text) {
    const parsed = parseStructure(text || '');
    return parsed.atoms.length > 0;
}

// Which structure-solution programs are installed on the server.
function availableSolutions() {
    return SOLUTION_PREFERENCE.filter(p => availablePrograms.includes(p));
}

// After a solution run, pick the best .res model produced (SHELXT can write
// several candidate models: name_a.res, name_b.res, ...). Prefer the model with
// atoms and the lowest R1 quoted in its TITL/header.
function pickBestModel(projectDir, basename, uploadedNames) {
    let files;
    try { files = fs.readdirSync(projectDir); } catch (e) { return null; }
    const resFiles = files.filter(f =>
        /\.res$/i.test(f) && !uploadedNames.includes(f) && !f.startsWith('.'));
    if (!resFiles.length) return null;

    const score = (text) => {
        const parsed = parseStructure(text);
        if (!parsed.atoms.length) return Infinity;
        const r1 = text.match(/R1\s*=\s*([\d.]+)/i);
        return r1 ? parseFloat(r1[1]) : 1; // model present, mediocre default
    };
    let best = null;
    for (const f of resFiles) {
        let text;
        try { text = fs.readFileSync(path.join(projectDir, f), 'utf8'); } catch (e) { continue; }
        const s = score(text);
        if (s === Infinity) continue;
        if (!best || s < best.score) best = { file: f, text, score: s };
    }
    return best;
}

// Run SHELXL on the model currently stored as basename.ins/.hkl, then, when a
// .res was produced, promote it to .ins so the next refinement starts from the
// refined model. Returns {code, stdout, stderr, res, lst, success, message}.
async function refineModel(projectDir, basename, weightCycles) {
    const resPath = path.join(projectDir, `${basename}.res`);
    const insPath = path.join(projectDir, `${basename}.ins`);
    const lstPath = path.join(projectDir, `${basename}.lst`);

    // SHELXL reads basename.ins; if only a .res was stored, copy it over.
    if (!fs.existsSync(insPath) && fs.existsSync(resPath)) {
        fs.copyFileSync(resPath, insPath);
    }

    // A model carrying ABIN needs <basename>.fab next to the refinement input;
    // make sure any stored SQUEEZE mask (e.g. <basename>_sq.fab) is exposed.
    if (insRequestsFab(projectDir, basename)) {
        promoteCompanionToCanonical(projectDir, basename, '.fab');
    }

    let lastRec = null;
    const cycles = Math.max(1, Math.min(50, weightCycles || 1));
    let r = null;
    let stdout = '', stderr = '';
    for (let c = 1; c <= cycles; c++) {
        r = await runShelxl(projectDir, basename, undefined, cycles);
        stdout += (c > 1 ? '\n' : '') + `===== SHELXL cycle ${c} =====\n` + r.stdout;
        stderr += r.stderr;
        if (fs.existsSync(lstPath)) {
            const rec = parseRecommendedWght(fs.readFileSync(lstPath, 'utf8'));
            if (rec) {
                lastRec = rec;
                if (c < cycles) updateWghtInstruction(insPath, rec.a, rec.b);
            }
        }
    }
    // Promote refined .res to the .ins for the next step and patch the WGHT line.
    if (fs.existsSync(resPath)) {
        const resText = fs.readFileSync(resPath, 'utf8');
        if (resText.trim().length) {
            fs.writeFileSync(insPath, resText, 'utf8');
            if (lastRec) updateWghtInstruction(insPath, lastRec.a, lastRec.b);
        }
    }

    const resText = fs.existsSync(resPath) ? fs.readFileSync(resPath, 'utf8') : '';
    const lstText = fs.existsSync(lstPath) ? fs.readFileSync(lstPath, 'utf8') : '';
    const code = r ? r.code : -1;
    let success = code === 0 && resText.trim().length > 0;
    let message = null;
    if (!success) {
        message = detectShelxlError(stdout, lstText)
            || (resText.trim().length === 0
                ? 'SHELXL did not produce a .res file.'
                : `SHELXL exited with a non-zero status (${code}).`);
    }
    return { code, stdout, stderr, res: resText, lst: lstText, success, message };
}

// PLATON actions selectable from the Programs submenu. Each maps to the text
// instruction(s) that PLATON executes after loading the model. TwinRotMat has
// no standalone text command (it is an interactive GUI mouse action); the
// underlying search it runs is LEPAGE, which lists the candidate twin 2-fold
// axes and the transformation matrix, so that action runs LEPAGE instead.
const PLATON_ACTIONS = {
    checkcif: { label: 'CheckCIF', script: '', needsFcf: false, needsHkl: false },
    addsymm: { label: 'ADDSYM', script: 'CALC ADDSYM', needsFcf: false, needsHkl: false },
    squeeze: { label: 'SQUEEZE', script: 'CALC SQUEEZE', needsFcf: true, needsHkl: false },
    twinrotmat: { label: 'TwinRotMat', script: 'LEPAGE', needsFcf: false, needsHkl: false },
};

// Attempt a PLATON run on the model with an optional instruction script.
// PLATON is interactive / display-oriented software; this is best-effort: we
// spawn it with the .res, feed the action script on stdin, wait briefly and
// return stdout/stderr and any newly written files. When PLATON cannot launch
// (missing runtime libs / no display) the result reports that clearly.
function runPlatonCheck(projectDir, basename, uploadedNames, signal, opts = {}) {
    return new Promise((resolve) => {
        if (!isExecutableAvailable('platon')) {
            return resolve({ ok: false, reason: 'platon executable not found on PATH' });
        }
        const resPath = path.join(projectDir, `${basename}.res`);
        if (!fs.existsSync(resPath)) {
            return resolve({ ok: false, reason: 'No .res model available for PLATON' });
        }
        const action = opts.action && PLATON_ACTIONS[opts.action] ? opts.action : 'checkcif';
        const def = PLATON_ACTIONS[action];
        const before = new Set(fs.readdirSync(projectDir));
        let child;
        try {
            child = spawn('platon', [resPath], {
                cwd: projectDir, stdio: ['pipe', 'pipe', 'pipe'], detached: true
            });
        } catch (e) {
            return resolve({ ok: false, reason: `Could not launch platon: ${e.message}` });
        }
        let stdout = '', stderr = '';
        let done = false;
        const timer = setTimeout(() => {
            done = true;
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* */ }
            try { child.kill('SIGKILL'); } catch (e) { /* */ }
            resolve({ ok: false, reason: 'PLATON did not finish within the timeout (interactive GUI / no display?)', stdout, stderr });
        }, PLATON_TIMEOUT_MS);
        const onAbort = () => {
            done = true; clearTimeout(timer);
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* */ }
            try { child.kill('SIGKILL'); } catch (e) { /* */ }
        };
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
        }
        child.stdout.on('data', d => { stdout += d.toString(); });
        child.stderr.on('data', d => { stderr += d.toString(); });

        // Feed the action instructions, then let stdin hit EOF (normal end).
        try {
            child.stdin.write((def.script ? def.script + '\n' : '') + 'EXIT\n');
            child.stdin.end();
        } catch (e) { /* stdin closed */ }

        child.on('error', (err) => {
            if (done) return; done = true; clearTimeout(timer);
            resolve({ ok: false, reason: `PLATON launch error: ${err.message}`, stdout, stderr });
        });
        child.on('close', (code) => {
            if (done) return; done = true; clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            // Collect files written during the run.
            let after = {};
            try {
                for (const f of fs.readdirSync(projectDir)) {
                    if (f === 'backup' || f.startsWith('.') || before.has(f)) continue;
                    const full = path.join(projectDir, f);
                    if (fs.statSync(full).isFile() && fs.statSync(full).size < 2 * 1024 * 1024) {
                        try { after[f] = fs.readFileSync(full, 'utf8'); } catch (e) { /* */ }
                    }
                }
            } catch (e) { /* */ }
            const anyText = Object.values(after).join('\n') || stdout;
            resolve({ ok: code === 0 || anyText.trim().length > 0, code, stdout, stderr, files: after, action });
        });
    });
}

// Run one full "solve -> refine -> validate" round for a project. Returns the
// log of steps and final report. `reqFiles` are the uploaded ins/hkl entries.
async function runSolvePipeline(projectDir, basename, insText, hklUploaded, opts, signal) {
    const log = [];
    const step = (key, label) => {
        const entry = { key, label, status: 'running' };
        log.push(entry);
        return entry;
    };
    const fail = (entry, msg) => { entry.status = 'failed'; entry.message = msg; };
    const ok = (entry, msg) => { entry.status = 'ok'; if (msg) entry.message = msg; };

    // --- Store inputs -----------------------------------------------
    fs.writeFileSync(path.join(projectDir, `${basename}.ins`), insText, 'utf8');
    const hklPath = path.join(projectDir, `${basename}.hkl`);
    if (hklUploaded && hklUploaded.path) {
        fs.renameSync(hklUploaded.path, hklPath);
    } else if (!fs.existsSync(hklPath)) {
        // The HKL is kept server-side by the client; only the exact canonical
        // <basename>.hkl can feed SHELXL, so require it (no _sq/_merged sibling).
        throw new Error(`No .hkl reflections available for '${basename}'. Upload a .hkl file (File > Load HKL) or run from a project that contains ${basename}.hkl.`);
    }
    const uploadedNames = [`${basename}.ins`, `${basename}.hkl`];

    let modelText = insText;
    let solutionProgram = null;

    // --- 1. Solve if the model is missing --------------------------
    if (!textHasModel(insText)) {
        const desired = opts.program && opts.program !== 'auto' ? [opts.program] : availableSolutions();
        if (!desired.length) {
            throw new Error('No structure-solution program (SHELXT/SHELXS) available on the server.');
        }
        const run = step('solve', `${desired[0].toUpperCase()} structure solution`);
        solutionProgram = desired[0];
        const prog = PROGRAMS[solutionProgram];
        const r = await runProgram(prog, [basename], projectDir, null, signal);
        const best = pickBestModel(projectDir, basename, uploadedNames);
        if (best) {
            modelText = best.text;
            fs.writeFileSync(path.join(projectDir, `${basename}.res`), modelText, 'utf8');
            fs.writeFileSync(path.join(projectDir, `${basename}.ins`), modelText, 'utf8');
            ok(run, `Best model ${best.file} (R1 ${best.score}) from ${solutionProgram.toUpperCase()}`);
        } else {
            fail(run, detectShelxlError(r.stdout, '') || `${solutionProgram.toUpperCase()} produced no model .res file`);
            // keep whatever refinement may still do with the template
        }
    } else {
        const entry = step('model', 'Model present in .ins/.res');
        ok(entry, `${parseStructure(insText).atoms.length} atoms found`);
    }

    // --- 2. Refine (SHELXL) ----------------------------------------
    const cycles = Math.max(1, Math.min(20, opts.cycles || 1));
    let refineResult = null;
    if (opts.refine !== false && modelText && textHasModel(modelText)) {
        const entry = step('refine', `SHELXL refinement${cycles > 1 ? ` (${cycles} WGHT cycles)` : ''}`);
        refineResult = await refineModel(projectDir, basename, cycles);
        if (refineResult.success) {
            ok(entry, refineResult.lst ? refinementSummaryLine(refineResult.lst) : undefined);
            modelText = refineResult.res;
        } else {
            fail(entry, refineResult.message);
        }
    } else {
        step('refine', 'SHELXL refinement skipped').status = 'skipped';
    }

    // --- 3. Disorder + twinning detection + CheckCIF-style report ---
    const lstText = refineResult ? refineResult.lst : '';
    let jsReport = null;
    const entry = step('validate', 'Structure validation (disorder, twinning, CheckCIF-style)');
    try {
        jsReport = validateStructure(modelText, lstText, {});
        ok(entry, `verdict=${jsReport.verdict}  A:${jsReport.count.A} B:${jsReport.count.B} C:${jsReport.count.C} G:${jsReport.count.G}`);
    } catch (e) {
        fail(entry, `Validation failed: ${e.message}`);
    }

    // --- 4. PLATON (best-effort, optional) -------------------------
    let platon = null;
    if (opts.platon && textHasModel(modelText)) {
        const p = step('platon', 'PLATON check (best effort)');
        platon = await runPlatonCheck(projectDir, basename, uploadedNames, signal);
        if (platon.ok) ok(p, platon.code != null ? `exit ${platon.code}` : 'report written');
        else {
            p.status = 'skipped';
            p.message = platon.reason || 'PLATON not usable';
        }
    }

    // Final .res/.lst contents
    let finalRes = modelText;
    let finalLst = lstText;
    if (!refineResult || !refineResult.success) {
        try {
            const rp = path.join(projectDir, `${basename}.res`);
            const lp = path.join(projectDir, `${basename}.lst`);
            if (fs.existsSync(rp)) finalRes = fs.readFileSync(rp, 'utf8');
            if (fs.existsSync(lp)) finalLst = fs.readFileSync(lp, 'utf8');
        } catch (e) { /* */ }
    }

    return { log, modelText, solutionProgram, refineResult, jsReport, platon, finalRes, finalLst };
}

function refinementSummaryLine(lst) {
    const r1 = lst.match(/R1\s*=\s*([\d.]+)\s+for\s+\d+\s+Fo\s*>\s*\d+sig\(Fo\)/);
    const wr = lst.match(/wR2\s*=\s*([\d.]+),\s*GooF\s*=\s*S\s*=\s*([\d.]+)/);
    const parts = [];
    if (r1) parts.push(`R1=${r1[1]}`);
    if (wr) parts.push(`wR2=${wr[1]} GooF=${wr[2]}`);
    return parts.join('  ') || 'refinement complete';
}

function stepsText(log) {
    return log.map(s => `[${s.status.toUpperCase()}] ${s.label}${s.message ? ' — ' + s.message : ''}`).join('\n');
}

/**
 * POST /solve-structure
 * multipart: 'ins' (.ins/.res model or template), 'hkl' (.hkl reflections).
 * fields: program (shelxt|shelxs|auto), cycles (SHELXL weight cycles), refine
 * (0/1), platon (0/1). Runs structure solution (if no atoms yet) -> SHELXL
 * refinement -> validation/disorder/twinning report (+ PLATON best effort).
 * Files are persisted to projects/<basename>.
 */
app.post('/solve-structure', upload.fields([
    { name: 'ins', maxCount: 1 }, { name: 'hkl', maxCount: 1 }
]), async (req, res) => {
    const jobId = uuidv4();
    const field = (n, d) => { let v = (req.body && req.body[n]) || d; if (Array.isArray(v)) v = v[0]; return v; };
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
        if (!req.files || !req.files['ins']) {
            return res.status(400).json({ error: 'An .ins/.res model file is required.' });
        }
        const insFile = req.files['ins'][0];
        const hklFile = req.files['hkl'] && req.files['hkl'][0] ? req.files['hkl'][0] : null;
        const insText = readUploadText(insFile);
        fs.rmSync(insFile.path, { force: true });

        const basename = path.parse(insFile.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const projectDir = path.join(PROJECTS_DIR, basename);
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'backup'), { recursive: true });

        const opts = {
            program: field('program', 'auto'),
            cycles: parseInt(field('cycles', '1'), 10) || 1,
            refine: field('refine', '1') !== '0',
            platon: field('platon', '0') === '1'
        };

        const result = await runSolvePipeline(projectDir, basename, insText, hklFile, opts, controller.signal);
        const reportText = result.jsReport ? renderReport(result.jsReport) : 'Validation could not be produced.';
        const response = {
            success: result.jsReport ? result.jsReport.count.A === 0 : false,
            jobId, project: basename, steps: result.log,
            platon: result.platon || null,
            report: result.jsReport || null,
            reportText,
            logText: stepsText(result.log),
            files: {
                res: result.finalRes,
                lst: result.finalLst
            }
        };
        if (!response.success && result.jsReport) {
            response.message = `Validation finished with ${result.jsReport.count.A} alert(s) of level A.`;
        }
        console.log(`[${jobId}] solve-structure for '${basename}' done`);
        res.json(response);
    } catch (error) {
        console.error(`[${jobId}] solve-structure error:`, error);
        res.status(500).json({ error: 'Structure pipeline failed', details: error.message });
    }
});

/**
 * POST /validate-structure
 * multipart: 'res' (.res/.ins model), optional 'lst' (.lst log), optional
 * field 'platon' (0/1). Runs the built-in validation report (disorder,
 * twinning, CheckCIF-style) on the given model without modifying the project.
 */
app.post('/validate-structure', upload.fields([
    { name: 'res', maxCount: 1 }, { name: 'lst', maxCount: 1 }
]), (req, res) => {
    const jobId = uuidv4();
    try {
        if (!req.files || !req.files['res']) {
            return res.status(400).json({ error: 'A .res/.ins model file is required.' });
        }
        const resText = readUploadText(req.files['res'][0]);
        fs.rmSync(req.files['res'][0].path, { force: true });
        let lstText = '';
        if (req.files['lst'] && req.files['lst'][0]) {
            lstText = readUploadText(req.files['lst'][0]);
            fs.rmSync(req.files['lst'][0].path, { force: true });
        }
        const report = validateStructure(resText, lstText, {});
        res.json({ success: report.count.A === 0, jobId, report, reportText: renderReport(report) });
    } catch (error) {
        console.error(`[${jobId}] validate-structure error:`, error);
        res.status(500).json({ error: 'Validation failed', details: error.message });
    }
});

// GET /solve-info — capability report for the solve/validate UI.
app.get('/solve-info', (req, res) => {
    res.json({
        solutions: availableSolutions(),
        refineAvailable: availablePrograms.includes('shelxl'),
        platonAvailable: isExecutableAvailable('platon')
    });
});

// --- xrdspace: space-group determination (XPREP alternative) ---

/**
 * POST /xrdspace/transform-model
 * Upload a SHELX .res/.ins model (multipart field 'res') and request a target
 * space group (field 'spaceGroup' - number or HM symbol, e.g. 14 or "P 21/c").
 * The model's asymmetric unit is expanded under its current symmetry (LATT +
 * SYMM from the file) to the full cell content, then reduced to an asymmetric
 * unit under the *target* space group. Moving to a higher-symmetry group
 * removes redundant (symmetry-related) molecules; moving to a lower-symmetry
 * group adds the symmetry partners. Returns the transformed .res text and a
 * report of added/removed atoms.
 */
app.post('/xrdspace/transform-model', upload.fields([{ name: 'res', maxCount: 1 }]), (req, res) => {
    try {
        if (!req.files || !req.files['res']) {
            return res.status(400).json({ error: 'A .res/.ins model file is required.' });
        }
        const sgField = (req.body && req.body.spaceGroup);
        const spaceGroup = Array.isArray(sgField) ? sgField[0] : sgField;
        if (spaceGroup === undefined || spaceGroup === null || spaceGroup === '') {
            return res.status(400).json({ error: 'A target space group is required.' });
        }
        const modelText = fs.readFileSync(req.files['res'][0].path, 'utf8');
        fs.rmSync(req.files['res'][0].path, { force: true });
        const result = transformModelToSpaceGroup(modelText, String(spaceGroup).trim());
        if (!result.ok) {
            return res.status(400).json({ error: result.error });
        }
        res.json({
            ok: true,
            hm: result.hm,
            sgId: result.sgId,
            nOldAsu: result.nOldAsu,
            nFull: result.nFull,
            nNewAsu: result.nNewAsu,
            removed: result.removed,
            added: result.added,
            report: result.report,
            res: result.res,
        });
    } catch (error) {
        console.error('xrdspace transform-model error:', error);
        res.status(500).json({ error: 'Failed to transform model', details: error.message });
    }
});

/**
 * POST /xrdspace/analyze
 * Upload an HKL file (multipart field 'hkl'); optionally provide the unit cell
 * in the JSON/field 'cell' as "a b c alpha beta gamma" or {a,b,c,alpha,beta,gamma},
 * and optionally force a space group with 'spaceGroup' (number or HM symbol,
 * e.g. 14 or "P 21/c").
 * Runs the built-in xrdspace space-group determination and returns the full
 * analysis (Laue class, centering, systematic absences, candidate space groups,
 * merged HKL output).
 */
app.post('/xrdspace/analyze', upload.fields([{ name: 'hkl', maxCount: 1 }]), (req, res) => {
    try {
        let text = null;
        // Prefer an uploaded HKL file; otherwise, if the client references an
        // existing server project (field 'project'), reuse the same-basename
        // reflection file already stored there so no big data is streamed.
        if (req.files && req.files['hkl'] && req.files['hkl'][0]) {
            const file = req.files['hkl'][0];
            text = fs.readFileSync(file.path, 'utf8');
            fs.rmSync(file.path, { force: true }); // temp upload, no persistence
        } else {
            const project = req.body && req.body.project;
            if (project) {
                const base = path.basename(String(project)).replace(/\.hkl$/i, '');
                const p = findCompanionFile(path.join(PROJECTS_DIR, base), base, '.hkl');
                if (p) text = fs.readFileSync(p, 'utf8');
            }
            if (text === null) {
                return res.status(400).json({ error: 'An HKL file is required.' });
            }
        }

        let cell = null;
        const cellField = req.body && req.body.cell;
        if (cellField) {
            if (typeof cellField === 'string') {
                const v = cellField.split(/\s+/).map(parseFloat);
                if (v.length === 6 && v.every(Number.isFinite)) {
                    cell = { a: v[0], b: v[1], c: v[2], alpha: v[3], beta: v[4], gamma: v[5] };
                }
            } else if (typeof cellField === 'object' && cellField.a) {
                cell = {
                    a: parseFloat(cellField.a), b: parseFloat(cellField.b), c: parseFloat(cellField.c),
                    alpha: parseFloat(cellField.alpha), beta: parseFloat(cellField.beta), gamma: parseFloat(cellField.gamma),
                };
            }
        }

        let spaceGroup = null;
        const sgField = req.body && req.body.spaceGroup;
        if (sgField) {
            if (typeof sgField === 'string' && sgField.trim() !== '') spaceGroup = sgField.trim();
            else if (typeof sgField === 'number') spaceGroup = sgField;
        }

        const result = analyzeHkl(text, { cell, spaceGroup });
        res.json(result);
    } catch (error) {
        console.error('xrdspace analyze error:', error);
        res.status(500).json({ error: 'Failed to run space-group analysis', details: error.message });
    }
});

// --- xrdspace: COD / PDB structure fetch ---

// Normalise a unit cell supplied as "a b c alpha beta gamma" or an object.
function normalizeCell(cellField) {
    if (!cellField) return null;
    if (typeof cellField === 'string') {
        const v = cellField.trim().split(/\s+/).map(parseFloat);
        if (v.length === 6 && v.every(Number.isFinite)) {
            return { a: v[0], b: v[1], c: v[2], alpha: v[3], beta: v[4], gamma: v[5] };
        }
        return null;
    }
    if (typeof cellField === 'object') {
        const c = {
            a: parseFloat(cellField.a), b: parseFloat(cellField.b), c: parseFloat(cellField.c),
            alpha: parseFloat(cellField.alpha), beta: parseFloat(cellField.beta), gamma: parseFloat(cellField.gamma),
        };
        return [c.a, c.b, c.c, c.alpha, c.beta, c.gamma].every(Number.isFinite) ? c : null;
    }
    return null;
}

/**
 * POST /xrdspace/db-search
 * Search the COD and/or PDB for structures with a matching unit cell.
 * Body (JSON): { cell: "a b c alpha beta gamma" | {a,...}, databases: ['COD','PDB'],
 *                tolLen: 0.01, tolAng: 1.5, limit: 20 }
 * Returns the ranked matches from cell-search.js (metadata only, no downloads).
 */
app.post('/xrdspace/db-search', async (req, res) => {
    try {
        const body = req.body || {};
        const cell = normalizeCell(body.cell);
        if (!cell) {
            return res.status(400).json({ error: 'A unit cell (a b c alpha beta gamma) is required.' });
        }
        let databases = Array.isArray(body.databases) ? body.databases : ['COD', 'PDB'];
        databases = databases.map(d => String(d).toUpperCase()).filter(d => d === 'COD' || d === 'PDB');
        if (!databases.length) databases = ['COD', 'PDB'];

        const tolLen = Number.isFinite(Number(body.tolLen)) ? Number(body.tolLen) : 0.01;
        const tolAng = Number.isFinite(Number(body.tolAng)) ? Number(body.tolAng) : 1.5;
        const limit = Number.isFinite(Number(body.limit)) ? Math.min(Math.max(Number(body.limit), 1), 200) : 20;

        const result = await searchByCell(cell, { databases, tolLen, tolAng, limit });
        res.json(result);
    } catch (error) {
        console.error('xrdspace db-search error:', error);
        res.status(500).json({ error: 'Database search failed', details: error.message });
    }
});

/**
 * POST /xrdspace/db-fetch
 * Download a COD/PDB entry and save it as a new project (projects/<DB>_<id>/).
 * Body (JSON): { database: 'COD'|'PDB', id, format: 'pdb'|'cif', overwrite: bool }
 * Returns the project name, stored files and provenance metadata.
 */
app.post('/xrdspace/db-fetch', async (req, res) => {
    try {
        const body = req.body || {};
        const database = String(body.database || '').toUpperCase();
        const id = body.id;
        if (!database || id === undefined || id === null || String(id).trim() === '') {
            return res.status(400).json({ error: 'database and id are required.' });
        }
        if (database !== 'COD' && database !== 'PDB') {
            return res.status(400).json({ error: `Unknown database '${database}' (expected COD or PDB).` });
        }
        const imported = await importStructureToProject(PROJECTS_DIR, database, id, {
            format: body.format === 'cif' ? 'cif' : 'pdb',
            overwrite: !!body.overwrite,
            includeHkl: body.includeHkl !== false,
        });
        res.json({ ok: true, ...imported });
    } catch (error) {
        console.error('xrdspace db-fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch structure', details: error.message });
    }
});

// --- Project Management API ---

// 1. List Projects
app.get('/projects', (req, res) => {
    try {
        // PROJECTS_DIR ensured at startup
        const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
        const projects = entries
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
        res.json(projects);
    } catch (error) {
        console.error("List projects error:", error);
        res.status(500).json({ error: 'Failed to list projects', details: error.message });
    }
});

// 2. Load Project (Get .res/.ins content)
// 2. Load Project (Get .res/.ins content) - Legacy / Main Entry
app.get('/projects/:name', (req, res) => {
    try {
        const basename = req.params.name;
        const projectDir = path.join(PROJECTS_DIR, basename);
        
        if (!fs.existsSync(projectDir)) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Prefer a structure file that matches the project name, but fall back to
        // any .res/.ins/.cif/.pdb stored in the project directory. Projects are
        // sometimes created by uploading files whose basename differs from the
        // folder name (e.g. project 'nickel3' holding 'denis7.res'), and those
        // must load too. .cif/.pdb are included so database-fetched projects
        // (COD_*/PDB_*) load like any other project.
        const STRUCT_EXTS = ['.res', '.ins', '.cif', '.mmcif', '.pdb'];
        let structPath = null;
        for (const ext of STRUCT_EXTS) {
            const p = path.join(projectDir, `${basename}${ext}`);
            if (fs.existsSync(p)) { structPath = p; break; }
        }
        if (!structPath) {
            const rank = new Map(STRUCT_EXTS.map((e, i) => [e, i]));
            const candidates = fs.readdirSync(projectDir)
                .filter(f => /\.(res|ins|cif|mmcif|pdb)$/i.test(f) && fs.lstatSync(path.join(projectDir, f)).isFile())
                .sort((a, b) => {
                    const ea = path.extname(a).toLowerCase();
                    const eb = path.extname(b).toLowerCase();
                    if (ea !== eb) return (rank.get(ea) ?? 99) - (rank.get(eb) ?? 99);
                    return a.localeCompare(b);
                });
            if (candidates.length) structPath = path.join(projectDir, candidates[0]);
        }

        if (!structPath) {
            // If neither exists, just return the file list so the user can pick
            const files = fs.readdirSync(projectDir).filter(f => fs.lstatSync(path.join(projectDir, f)).isFile());
            return res.json({ name: basename, files: files });
        }

        const filename = path.basename(structPath);
        const structExt = path.extname(structPath).toLowerCase();
        const type = structExt === '.ins' ? 'ins'
            : (structExt === '.cif' || structExt === '.mmcif') ? 'cif'
                : structExt === '.pdb' ? 'pdb'
                    : 'res';
        const content = fs.readFileSync(structPath, 'utf8');

        res.json({ name: basename, filename: filename, type: type, content: content });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load project', details: error.message });
    }
});

// 2b. List all files in project
app.get('/projects/:name/files', (req, res) => {
    try {
        const basename = req.params.name;
        const projectDir = path.join(PROJECTS_DIR, basename);
        if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
        
        const files = fs.readdirSync(projectDir)
            .filter(f => fs.lstatSync(path.join(projectDir, f)).isFile())
            .map(f => ({
                name: f,
                size: fs.statSync(path.join(projectDir, f)).size,
                mtime: fs.statSync(path.join(projectDir, f)).mtime
            }));
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: 'Failed to list project files' });
    }
});

// 2c. Get specific file from project
app.get('/projects/:name/files/:filename', (req, res) => {
    try {
        const basename = req.params.name;
        const filename = req.params.filename;
        const filePath = path.join(PROJECTS_DIR, basename, filename);
        
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        
        res.sendFile(filePath);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch file' });
    }
});

// 3. Save Project (Save to .res or .ins)
app.post('/projects/:name/save', (req, res) => {
    try {
        const basename = req.params.name;
        const { content, type } = req.body; // type should be 'res' or 'ins'
        
        if (!content) return res.status(400).json({ error: 'Content is required' });

        const projectDir = path.join(PROJECTS_DIR, basename);
        if (!fs.existsSync(projectDir)) {
             return res.status(404).json({ error: 'Project not found' });
        }
        
        const ext = type === 'ins' ? '.ins' : '.res';
        const filePath = path.join(projectDir, `${basename}${ext}`);

        // Create a quick backup before overwriting
        const backupDir = path.join(projectDir, 'backup');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `${basename}_manual_save_${timestamp}${ext}`);
        
        if (fs.existsSync(filePath)) {
            fs.copyFileSync(filePath, backupPath);
        }

        fs.writeFileSync(filePath, content, 'utf8');
        
        res.json({ success: true, message: 'Saved successfully' });
    } catch (error) {
        console.error("Save error:", error);
        res.status(500).json({ error: 'Failed to save project', details: error.message });
    }
});

// 4. Save arbitrary file in project (creates project dir if missing)
app.post('/projects/:name/savefile', (req, res) => {
    try {
        const basename = path.basename(req.params.name);
        const { filename, content } = req.body;
        
        if (!filename || content === undefined) {
            return res.status(400).json({ error: 'filename and content are required' });
        }

        const cleanName = path.basename(filename);
        if (!cleanName || cleanName === '.' || cleanName === '..') {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const projectDir = path.join(PROJECTS_DIR, basename);
        if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
        }

        const filePath = path.join(projectDir, cleanName);

        // Create a quick backup before overwriting
        const backupDir = path.join(projectDir, 'backup');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

        if (fs.existsSync(filePath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            fs.copyFileSync(filePath, path.join(backupDir, `${cleanName}_manual_save_${timestamp}`));
        }

        fs.writeFileSync(filePath, content, 'utf8');
        res.json({ success: true, message: `Saved '${cleanName}' successfully` });
    } catch (error) {
        console.error("Save file error:", error);
        res.status(500).json({ error: 'Failed to save file', details: error.message });
    }
});

// Write a copy of a file into the project's backup/ directory, leaving the
// original untouched. Used before destructive in-place edits (e.g. spherical
// absorption correction of the .hkl).
app.post('/projects/:name/backupfile', (req, res) => {
    try {
        const basename = path.basename(req.params.name);
        const { filename, content } = req.body;
        if (!filename || content === undefined) {
            return res.status(400).json({ error: 'filename and content are required' });
        }
        const cleanName = path.basename(filename);
        if (!cleanName || cleanName === '.' || cleanName === '..') {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const projectDir = path.join(PROJECTS_DIR, basename);
        if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
        }
        const backupDir = path.join(projectDir, 'backup');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `${cleanName}_${timestamp}`;
        fs.writeFileSync(path.join(backupDir, backupName), content, 'utf8');
        res.json({ success: true, file: backupName });
    } catch (error) {
        console.error("Backup file error:", error);
        res.status(500).json({ error: 'Failed to back up file', details: error.message });
    }
});

// 4b. Upload an arbitrary binary/large file into a project without forcing the
// client to keep its content in the browser. Files are stored under their
// original names (a same-basename companion of the project structure is kept
// as <project><ext>). Used mainly for HKL reflection data and SQUEEZE .fab
// masks which are consumed by server-side SHELX/PLATON runs.
app.post('/projects/:name/upload', upload.any(), (req, res) => {
    try {
        const basename = path.basename(req.params.name);
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'At least one file is required.' });
        }
        const projectDir = path.join(PROJECTS_DIR, basename);
        fs.mkdirSync(projectDir, { recursive: true });
        const backupDir = path.join(projectDir, 'backup');
        fs.mkdirSync(backupDir, { recursive: true });

        const stored = [];
        for (const file of req.files) {
            const original = path.basename(file.originalname);
            // Canonical companion naming: a file whose stem equals the project
            // name is stored as <project><ext> (what SHELX/PLATON expect).
            const stem = original.replace(/\.[^.]+$/, '');
            const ext = path.extname(original).toLowerCase();
            const name = (stem.toLowerCase() === basename.toLowerCase() || basename + ext === original)
                ? `${basename}${ext}`
                : original;
            const dest = path.join(projectDir, name);
            if (fs.existsSync(dest)) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                fs.copyFileSync(dest, path.join(backupDir, `${name}_${timestamp}`));
                fs.rmSync(dest);
            }
            fs.renameSync(file.path, dest);
            stored.push(name);
        }
        res.json({ success: true, project: basename, files: stored });
    } catch (error) {
        console.error('project upload error:', error);
        res.status(500).json({ error: 'Failed to upload file', details: error.message });
    }
});

// 5. List Backups
app.get('/projects/:name/backups', (req, res) => {
    try {
        const basename = req.params.name;
        const backupDir = path.join(PROJECTS_DIR, basename, 'backup');
        
        if (!fs.existsSync(backupDir)) {
            return res.json([]);
        }

        const files = fs.readdirSync(backupDir);
        // Sort by time (descending)
        files.sort().reverse();
        
        res.json(files);
    } catch (error) {
        res.status(500).json({ error: 'Failed to list backups', details: error.message });
    }
});

// 5. Restore (Get Backup Content)
app.get('/projects/:name/backups/:file', (req, res) => {
    try {
        const basename = req.params.name;
        const filename = req.params.file;
        const backupPath = path.join(PROJECTS_DIR, basename, 'backup', filename);
        
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup file not found' });
        }
        
        const content = fs.readFileSync(backupPath, 'utf8');
        res.json({ content: content });
    } catch (error) {
         res.status(500).json({ error: 'Failed to get backup', details: error.message });
    }
});

// --- Publication API ---

// Find the best source CIF file in a project directory.
// Prefer <basename>.cif, then any .cif that is not a generated publish.cif.
function findCifFile(projectDir, basename) {
    const primary = path.join(projectDir, `${basename}.cif`);
    if (fs.existsSync(primary)) return primary;
    try {
        const any = fs.readdirSync(projectDir).find(f => {
            const lower = f.toLowerCase();
            return lower.endsWith('.cif') && lower !== 'publish.cif';
        });
        if (any) return path.join(projectDir, any);
    } catch (e) { /* ignore */ }
    // Last resort: a previously generated publish.cif
    const pub = path.join(projectDir, 'publish.cif');
    if (fs.existsSync(pub)) return pub;
    return null;
}

// GET /templates
// Returns the list of user (.cif) and device (.dev) templates.
app.get('/templates', (req, res) => {
    try {
        const users = fs.existsSync(TEMPLATES_DIR)
            ? fs.readdirSync(TEMPLATES_DIR).filter(f => f.toLowerCase().endsWith('.cif'))
            : [];
        const devices = fs.existsSync(DEVICE_DIR)
            ? fs.readdirSync(DEVICE_DIR).filter(f => f.toLowerCase().endsWith('.dev'))
            : [];
        res.json({ users, devices });
    } catch (error) {
        console.error('list templates error:', error);
        res.status(500).json({ error: 'Failed to list templates', details: error.message });
    }
});

// GET /projects/:name/cif-values
// Returns the current values of the "Prepare cif for publication" form fields,
// so the client can pre-fill the manual form from the project's CIF.
app.get('/projects/:name/cif-values', (req, res) => {
    try {
        const basename = req.params.name;
        const projectDir = path.join(PROJECTS_DIR, basename);
        if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

        const cifPath = findCifFile(projectDir, basename);
        if (!cifPath) return res.status(404).json({ error: 'No CIF file found in project' });

        const { kv } = parseCif(fs.readFileSync(cifPath, 'utf8'));
        const clean = (v) => (v === undefined ? '' : String(v).replace(/^['"]|['"]$/g, '').trim());
        // The main block renames space-group keys to symmetry keys, so return those.
        // Fall back to the original _space_group_* names when the symmetry keys are absent.
        const fields = {
            '_chemical_formula_moiety': ['_chemical_formula_moiety'],
            '_exptl_crystal_colour': ['_exptl_crystal_colour'],
            '_exptl_crystal_description': ['_exptl_crystal_description'],
            '_exptl_crystal_size_min': ['_exptl_crystal_size_min'],
            '_exptl_crystal_size_mid': ['_exptl_crystal_size_mid'],
            '_exptl_crystal_size_max': ['_exptl_crystal_size_max'],
            '_symmetry_cell_setting': ['_symmetry_cell_setting', '_space_group_crystal_system'],
            '_symmetry_space_group_name_Hall': ['_symmetry_space_group_name_Hall', '_space_group_name_Hall'],
            '_cell_formula_units_Z': ['_cell_formula_units_Z'],
            '_exptl_absorpt_correction_T_min': ['_exptl_absorpt_correction_T_min'],
            '_exptl_absorpt_correction_T_max': ['_exptl_absorpt_correction_T_max'],
            '_diffrn_ambient_temperature': ['_diffrn_ambient_temperature'],
            '_refine_ls_hydrogen_treatment': ['_refine_ls_hydrogen_treatment'],
        };
        const values = {};
        for (const [outKey, srcKeys] of Object.entries(fields)) {
            let v = '';
            for (const k of srcKeys) {
                const c = clean(kv[k]);
                if (c && c !== '?') { v = c; break; }
            }
            values[outKey] = v;
        }
        res.json(values);
    } catch (error) {
        console.error('cif-values error:', error);
        res.status(500).json({ error: 'Failed to read CIF values', details: error.message });
    }
});

// POST /projects/:name/publish-cif
// Body (template mode): { mode: 'template', userTemplate: 'MeCLS.cif', deviceTemplate: 'Can_Light_source_BM.dev', extraValues: {...} }
// Body (manual mode):   { mode: 'manual', includeGlobal: bool, global: {...} }
// Returns the generated publish CIF as text.
app.post('/projects/:name/publish-cif', (req, res) => {
    try {
        const basename = req.params.name;
        const projectDir = path.join(PROJECTS_DIR, basename);
        if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

        const cifPath = findCifFile(projectDir, basename);
        if (!cifPath) return res.status(404).json({ error: 'No CIF file found in project' });

        const cifText = fs.readFileSync(cifPath, 'utf8');
        const body = req.body || {};
        let out;

        if (body.mode === 'template') {
            let userTemplate = '';
            if (body.userTemplate) {
                const upath = path.join(TEMPLATES_DIR, path.basename(body.userTemplate));
                if (!fs.existsSync(upath)) return res.status(404).json({ error: `User template not found: ${body.userTemplate}` });
                userTemplate = fs.readFileSync(upath, 'utf8');
            }
            let deviceValues = {};
            if (body.deviceTemplate) {
                const dpath = path.join(DEVICE_DIR, path.basename(body.deviceTemplate));
                if (!fs.existsSync(dpath)) return res.status(404).json({ error: `Device template not found: ${body.deviceTemplate}` });
                deviceValues = parseDevFile(fs.readFileSync(dpath, 'utf8'));
            }
            out = buildPublishCifFromTemplates(cifText, {
                userTemplate,
                deviceValues,
                extraValues: body.extraValues || {},
            });
        } else {
            out = buildPublishCif(cifText, { includeGlobal: !!body.includeGlobal, global: body.global });
        }

        // Persist as publish.cif in the project for convenience.
        fs.writeFileSync(path.join(projectDir, 'publish.cif'), out, 'utf8');

        res.json({ success: true, filename: 'publish.cif', content: out });
    } catch (error) {
        console.error('publish-cif error:', error);
        res.status(500).json({ error: 'Failed to build publish CIF', details: error.message });
    }
});

// POST /projects/:name/report-docx
// Body: { title?: string }
// Returns the crystallographic report as a DOCX file.
app.post('/projects/:name/report-docx', async (req, res) => {
    try {
        const basename = req.params.name;
        const projectDir = path.join(PROJECTS_DIR, basename);
        if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

        const cifPath = findCifFile(projectDir, basename);
        if (!cifPath) return res.status(404).json({ error: 'No CIF file found in project' });

        const cifText = fs.readFileSync(cifPath, 'utf8');
        const { title } = req.body || {};
        const buffer = await buildReportDocx(cifText, { title });

        const filename = `${basename}_report.docx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (error) {
        console.error('report-docx error:', error);
        res.status(500).json({ error: 'Failed to build report', details: error.message });
    }
});

app.listen(port, () => {
    console.log(`SHELXL server listening on port ${port}`);
});
