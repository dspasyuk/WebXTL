// Copyright (c) 2026 Denis Spasyuk. MIT License.
// Symmetry operation mathematics for xrdspace.
// Handles parsing of Hermann-Mauguin symmetry-operation strings (as used in
// the space-groups.js dictionary, e.g. "-y, x-y, z" or "-x+1/2, -y, z") into
// 3x3 direct-space rotation matrices plus translations, and converts them into
// reciprocal-space (hkl) matrices.

export function parseFraction(str) {
    const s = String(str).replace(/\s+/g, '');
    if (!s) return 0;
    if (s.includes('/')) {
        const [n, d] = s.split('/');
        return (parseFloat(n) || 0) / (parseFloat(d) || 1);
    }
    return parseFloat(s) || 0;
}

// Parse a single coordinate expression ("-x+y+1/4") into coefficients.
export function parseComponent(str) {
    const res = { cx: 0, cy: 0, cz: 0, t: 0 };
    const s = String(str).replace(/\s+/g, '');
    const terms = s.match(/[+-]?[^-+]+/g) || [];
    for (let term of terms) {
        let sign = 1;
        if (term[0] === '-') { sign = -1; term = term.slice(1); }
        else if (term[0] === '+') term = term.slice(1);
        const vmatch = term.match(/[xyz]/);
        if (vmatch) {
            const varName = vmatch[0];
            const c = term.slice(0, vmatch.index);
            const coeff = c ? parseFraction(c) : 1;
            const val = sign * coeff;
            if (varName === 'x') res.cx += val;
            else if (varName === 'y') res.cy += val;
            else res.cz += val;
        } else {
            res.t += sign * parseFraction(term);
        }
    }
    return res;
}

// Parse an operation string ("-y, x-y, z") into { R: 3x3 matrix, t: [tx,ty,tz] }.
// R[i][j] is the coefficient of variable j (0=x,1=y,2=z) in coordinate i.
export function parseOperation(opString) {
    const parts = [];
    for (const s of String(opString).split(',')) parts.push(s.trim());
    if (parts.length !== 3) return null;
    const R = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    const t = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        const c = parseComponent(parts[i]);
        R[i][0] = c.cx;
        R[i][1] = c.cy;
        R[i][2] = c.cz;
        t[i] = c.t;
    }
    return { R, t };
}

// Determinant of a 3x3 matrix.
export function det3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

// Inverse of a 3x3 matrix (as array of arrays). Throws if singular.
export function inverse3(m) {
    const d = det3(m);
    if (Math.abs(d) < 1e-12) throw new Error('Singular matrix');
    const inv = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
    ];
    inv[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d;
    inv[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d;
    inv[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d;
    inv[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d;
    inv[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d;
    inv[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d;
    inv[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d;
    inv[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d;
    inv[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d;
    return inv;
}

// Multiply matrix a * b (3x3).
export function mul3(a, b) {
    const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    return out;
}

// Apply 3x3 matrix m to column vector v.
export function applyMat(m, v) {
    return [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ];
}

// Convert a direct-space operation to its reciprocal-space (hkl) matrix.
// For a direct op x' = R x + t, the reciprocal operation is h' = R^{-T} h.
export function directToReciprocal(R) {
    const inv = inverse3(R);
    // transpose of inverse
    return [
        [inv[0][0], inv[1][0], inv[2][0]],
        [inv[0][1], inv[1][1], inv[2][1]],
        [inv[0][2], inv[1][2], inv[2][2]],
    ];
}

// Build reciprocal-space matrices for an array of operation strings.
export function opsToReciprocalMatrices(ops) {
    const out = [];
    for (const op of ops) {
        const parsed = parseOperation(op);
        if (!parsed) continue;
        out.push({
            M: directToReciprocal(parsed.R),
            t: parsed.t,
            opString: op,
        });
    }
    return out;
}

// Does reciprocal matrix M leave the reflection h unchanged (exactly)?
// Systematic absences arise when R^{-T} h = h as integer index triples
// (i.e. the reflection maps onto itself under the symmetry operation).
export function isInvariant(M, h, tol = 1e-6) {
    const hp = applyMat(M, h);
    for (let i = 0; i < 3; i++) {
        if (Math.abs(hp[i] - h[i]) > tol) return false;
    }
    return true;
}

// Phase of reflection h under translation t:  exp(2*pi*i * h·t)  (scalar = h·t mod 1).
export function phase(h, t) {
    const p = h[0] * t[0] + h[1] * t[1] + h[2] * t[2];
    let r = p - Math.round(p);
    if (r < -0.5) r += 1;
    if (r >= 0.5) r -= 1;
    return r;
}

// Apply reciprocal matrix M to hkl and return the rounded result.
export function rotateHkl(M, h) {
    const hp = applyMat(M, h);
    return [Math.round(hp[0]), Math.round(hp[1]), Math.round(hp[2])];
}

// Normalize a reflection index (hkl) to a canonical representative: apply all
// matrices and return the lexicographically smallest image. Returns { rep, images }.
export function canonicalRep(h, matrices) {
    const h0 = [Math.round(h[0]), Math.round(h[1]), Math.round(h[2])];
    let best = h0;
    const images = [];
    for (const { M } of matrices) {
        const img = rotateHkl(M, h0);
        images.push(img);
        if (lexLess(img, best)) best = img;
    }
    return { rep: best, images };
}

function lexLess(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
}
