import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { buildPublishCif, buildPublishCifFromTemplates, buildReportDocx, parseDevFile, parseCif } from './publish.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

// Middleware
// Middleware
app.use(cors({
    origin: '*', // Allow all origins for dev
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

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
const RUN_TIMEOUT_MS = 300000;

// Registry of programs the server can run. `exe` is looked up in PATH; a
// program is only offered to the client when it is actually available.
// `inputs` are the file extensions the client must supply; `outputs` are the
// files collected from the project dir and returned to the client. `stdin`
// is optional text piped to the process for interactive programs (PLATON).
const PROGRAMS = {
    shelxl: {
        label: 'SHELXL',
        description: 'Least-squares structure refinement',
        exe: 'shelxl',
        inputs: ['.ins', '.hkl'],
        outputs: ['.res', '.lst', '.fcf'],
        stdin: null,
    },
    platon: {
        label: 'PLATON',
        description: 'Structure validation and geometry analysis',
        exe: 'platon',
        inputs: ['.res', '.cif'],
        outputs: ['.lis', '.txt', '.plt', '.res', '.fcf', '.cif', '.png'],
        stdin: '\n',
    },
    xprep: {
        label: 'XPREP',
        description: 'Data preparation and space-group determination',
        exe: 'xprep',
        inputs: ['.hkl'],
        outputs: ['.ins', '.res', '.txt', '.log'],
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
// `stdin` is optional text piped to the process (needed by interactive programs).
function runProgram(program, args, cwd, stdin) {
    return new Promise((resolve) => {
        const child = spawn(program.exe, args, { cwd, stdio: stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, RUN_TIMEOUT_MS);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message }); });
        if (stdin) {
            child.stdin.write(stdin);
            child.stdin.end();
        }
    });
}

// Run SHELXL once on <basename> in <projectDir>. Resolves with { code, stdout, stderr }.
function runShelxl(projectDir, basename) {
    return runProgram(PROGRAMS.shelxl, [basename], projectDir);
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

/**
 * POST /refine
 * Expects 'ins' and 'hkl' files in multipart/form-data.
 * Optional JSON body: { cycles: <int> } — number of SHELXL refinement cycles (default 1).
 */
app.post('/refine', upload.fields([{ name: 'ins', maxCount: 1 }, { name: 'hkl', maxCount: 1 }, { name: 'cycles', maxCount: 1 }, { name: 'mode', maxCount: 1 }]), async (req, res) => {
    const jobId = uuidv4(); // Still useful for logging

    try {
        // Validate inputs
        if (!req.files || !req.files['ins'] || !req.files['hkl']) {
            return res.status(400).json({ error: 'Both .ins and .hkl files are required.' });
        }

        const insFile = req.files['ins'][0];
        const hklFile = req.files['hkl'][0];

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
        fs.renameSync(hklFile.path, hklPath);

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
                const r = await runShelxl(projectDir, basename);
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
            const r = await runShelxl(projectDir, basename);
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

    try {
        // Determine basename from the first uploaded file.
        const first = req.files[0];
        const basename = path.parse(first.originalname).name.replace(/[^a-zA-Z0-9_-]/g, '_');

        const projectDir = path.join(PROJECTS_DIR, basename);
        fs.mkdirSync(projectDir, { recursive: true });
        const backupDir = path.join(projectDir, 'backup');
        fs.mkdirSync(backupDir, { recursive: true });

        // Move uploads into the project as <basename><ext>, backing up existing files.
        for (const file of req.files) {
            const ext = path.extname(file.originalname).toLowerCase();
            const dest = path.join(projectDir, `${basename}${ext}`);
            if (fs.existsSync(dest)) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                fs.copyFileSync(dest, path.join(backupDir, `${basename}_${timestamp}${ext}`));
                fs.rmSync(dest);
            }
            fs.renameSync(file.path, dest);
        }

        console.log(`[${jobId}] Running ${program.label} on '${basename}'...`);
        const r = await runProgram(program, [basename], projectDir, program.stdin);

        const result = {
            success: r.code === 0,
            jobId: jobId,
            program: programId,
            stdout: r.stdout,
            stderr: r.stderr,
            files: {},
        };

        // Collect the output files defined for this program.
        for (const ext of program.outputs) {
            const p = path.join(projectDir, `${basename}${ext}`);
            if (fs.existsSync(p) && fs.statSync(p).isFile() && fs.statSync(p).size < 5 * 1024 * 1024) {
                try {
                    result.files[`${basename}${ext}`] = fs.readFileSync(p, 'utf8');
                } catch (e) { /* skip binary files */ }
            }
        }

        console.log(`[${jobId}] ${program.label} finished with code ${r.code}`);
        res.json(result);
    } catch (error) {
        console.error(`[${jobId}] ${programId} error:`, error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
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

        const resPath = path.join(projectDir, `${basename}.res`);
        const insPath = path.join(projectDir, `${basename}.ins`);
        
        let content = '';
        let type = 'res';

        if (fs.existsSync(resPath)) {
            content = fs.readFileSync(resPath, 'utf8');
        } else if (fs.existsSync(insPath)) {
            content = fs.readFileSync(insPath, 'utf8');
            type = 'ins';
        } else {
            // If neither exists, just return the file list so the user can pick
            const files = fs.readdirSync(projectDir).filter(f => fs.lstatSync(path.join(projectDir, f)).isFile());
            return res.json({ name: basename, files: files });
        }

        res.json({ name: basename, type: type, content: content });
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
