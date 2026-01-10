import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

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

// Serve static files from 'dist' directory
app.use(express.static(path.join(__dirname, 'dist')));

/**
 * POST /refine
 * Expects 'ins' and 'hkl' files in multipart/form-data.
 */
app.post('/refine', upload.fields([{ name: 'ins', maxCount: 1 }, { name: 'hkl', maxCount: 1 }]), async (req, res) => {
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

        console.log(`[${jobId}] Starting refinement for project '${basename}'...`);

        // Spawn SHELXL process
        const shelxl = spawn('shelxl', [basename], {
            cwd: projectDir
        });

        let stdout = '';
        let stderr = '';

        shelxl.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        shelxl.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        shelxl.on('close', (code) => {
            console.log(`[${jobId}] Finished with code ${code}`);

            // Read output files
            const resPath = path.join(projectDir, `${basename}.res`);
            const lstPath = path.join(projectDir, `${basename}.lst`);

            const result = {
                success: code === 0,
                jobId: jobId,
                stdout: stdout,
                stderr: stderr,
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
        });

        shelxl.on('error', (err) => {
            console.error(`[${jobId}] Spawn error:`, err);
            res.status(500).json({ error: 'Failed to start SHELXL process', details: err.message });
        });

    } catch (error) {
        console.error(`[${jobId}] Unexpected error:`, error);
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

        // Prefer .res, fall back to .ins
        if (fs.existsSync(resPath)) {
            content = fs.readFileSync(resPath, 'utf8');
        } else if (fs.existsSync(insPath)) {
            content = fs.readFileSync(insPath, 'utf8');
            type = 'ins';
        } else {
            return res.status(404).json({ error: 'No .res or .ins file found for this project.' });
        }

        res.json({ name: basename, type: type, content: content });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load project', details: error.message });
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

// 4. List Backups
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

app.listen(port, () => {
    console.log(`SHELXL server listening on port ${port}`);
});
