// Turn the "Most Disagreeable Reflections" table of a SHELXL .lst into OMIT
// instructions.
//
// At the end of its log SHELXL prints the reflections that disagree most with
// the model:
//
//      h   k   l          Fo^2          Fc^2    Error/esd  Fc/Fc(max)  Resolution(A)
//      4   0   6       3827.76        668.06      11.20       0.051       2.97
//     -3   1   3       2075.68        391.66      10.37       0.039       4.70
//
// Reflections whose Error/esd exceeds 9 are normally omitted from the next
// refinement with the SHELX instruction `OMIT h k l` (one per reflection).
// This module parses the table and produces those instructions; it is a pure
// function so it can be tested and reused (UI, MCP) without a DOM.

export const OMIT_ERROR_ESD_THRESHOLD = 9;

// Header that introduces the table (tolerates varying spacing).
const HEADER_RE = /^\s*h\s+k\s+l\s+Fo\^2\s+Fc\^2\s+Error\/esd/i;
// One data row: h k l Fo^2 Fc^2 Error/esd [Fc/Fc(max) Resolution] [*]
const ROW_RE = /^\s*([+-]?\d+)\s+([+-]?\d+)\s+([+-]?\d+)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)\s+([-+]?[\d.]+(?:[eE][-+]?\d+)?)/;

// Parse every row of the (first) most-disagreeable-reflections table.
export function parseMostDisagreeableReflections(lstText) {
    const out = [];
    if (!lstText) return out;
    const lines = String(lstText).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!HEADER_RE.test(lines[i])) continue;
        for (i++; i < lines.length && !lines[i].trim(); i++) { /* skip gap after header */ }
        for (; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) break;
            const m = ROW_RE.exec(line);
            if (!m) break;
            out.push({
                h: parseInt(m[1], 10),
                k: parseInt(m[2], 10),
                l: parseInt(m[3], 10),
                fo2: parseFloat(m[4]),
                fc2: parseFloat(m[5]),
                errorEsd: parseFloat(m[6]),
                flagged: line.includes('*')
            });
        }
    }
    return out;
}

// Reflections with Error/esd strictly above `threshold`, as OMIT instructions.
export function omitInstructionsFromLst(lstText, threshold = OMIT_ERROR_ESD_THRESHOLD) {
    const reflections = parseMostDisagreeableReflections(lstText);
    const selected = reflections.filter(r => Number.isFinite(r.errorEsd) && r.errorEsd > threshold);
    const instructions = selected.map(r => `OMIT ${r.h} ${r.k} ${r.l}`);
    return { reflections, selected, instructions };
}

// Merge freshly derived OMIT instructions into a structure text. Existing
// `OMIT h k l` lines (including those a user added by hand) are preserved; only
// reflections not already omitted are added right after the UNIT instruction
// (falling back to before HKLF/END when there is no UNIT). Returns the new text
// plus the lines that were actually inserted.
export function mergeOmitInstructions(resText, instructions) {
    const eol = String(resText).includes('\r\n') ? '\r\n' : '\n';
    const lines = String(resText).split(/\r?\n/);

    const existing = new Set();
    lines.forEach(line => {
        const m = /^\s*OMIT\s+([+-]?\d+)\s+([+-]?\d+)\s+([+-]?\d+)\s*$/i.exec(line);
        if (m) existing.add(`${+m[1]} ${+m[2]} ${+m[3]}`);
    });

    const inserted = [];
    instructions.forEach(instr => {
        const key = instr.replace(/^OMIT\s+/i, '').trim().split(/\s+/).map(Number).join(' ');
        if (!existing.has(key)) {
            existing.add(key);
            inserted.push(instr);
        }
    });
    if (!inserted.length) return { text: resText, inserted, changed: false };

    // Insert after the last UNIT instruction (where SHELX restraint/instruction
    // lines conventionally live); fall back to before HKLF, then END.
    let unitIdx = -1;
    lines.forEach((l, i) => { if (/^[ \t]*UNIT\b/i.test(l)) unitIdx = i; });
    if (unitIdx !== -1) {
        lines.splice(unitIdx + 1, 0, ...inserted);
    } else {
        let idx = lines.findIndex(l => /^[ \t]*HKLF\b/i.test(l));
        if (idx === -1) idx = lines.findIndex(l => /^[ \t]*END\b/i.test(l));
        if (idx === -1) lines.push(...inserted);
        else lines.splice(idx, 0, ...inserted);
    }

    return { text: lines.join(eol), inserted, changed: true };
}
