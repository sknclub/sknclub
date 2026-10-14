/* SKN browser backend V3.3: username/student-ID login, no email auth.
   Anonymous Supabase session provides only a signed JWT, application credentials are checked via PostgreSQL RPC.
   SQL RLS and SECURITY DEFINER RPCs enforce security; never put a service key here. */
const db = window.SKN_DB;
function assert(cond, msg = 'ไม่มีสิทธิ์ดำเนินการ') { if (!cond)
    throw Error(msg); }
async function result(q) {
    const r = await q;
    if (r.error) {
        const e = Object.assign(new Error(String(r.error.message || 'Supabase request failed')), { code: String(r.error.code || ''), hint: String(r.error.hint || ''), details: String(r.error.details || ''), status: r.status || 0 });
        throw e;
    }
    return r.data;
}
async function all(table, period) { const output = []; for (let start = 0;; start += 1000) {
    let q = db.from(table === 'teachers' ? 'teachers_public' : table === 'students' ? 'students_public' : table).select('*').range(start, start + 999);
    if (period)
        q = q.eq('period_id', period);
    const chunk = await result(q);
    output.push(...chunk);
    if (chunk.length < 1000)
        break;
} return output; }
async function getPeriod(periodId) { const rows = await all('periods'); const p = periodId ? rows.find(r => r.id === periodId) : rows.find(r => r.is_current); if (!p)
    throw Error('ไม่พบภาคเรียนที่เลือก'); return { period: p, periods: rows.sort((a, b) => b.academic_year - a.academic_year || b.semester - a.semester) }; }
async function cfg(periodId) { const rows = await all('period_config', periodId); return Object.fromEntries(rows.map((r) => [r.key, r.value])); }
// R3.8: read aggregate-only registration totals through an authorized DB RPC.
// Supabase RLS deliberately hides other students' registration rows.
async function sknApplicantCounts(periodId) {
    try {
        const rows = await result(db.rpc('skn_club_registration_counts', { p_period: periodId }));
        if (!Array.isArray(rows)) throw Error('รูปแบบผลนับผู้สมัครจาก Supabase ไม่ถูกต้อง');
        return rows;
    } catch (err) {
        const code = String(err?.code || '');
        if (code === 'PGRST202' || code === '42883' || /skn_club_registration_counts.*(does not exist|schema cache|could not find)|could not find the function.*skn_club_registration_counts/i.test(String(err?.message || ''))) {
            throw Object.assign(new Error('ยังไม่ได้ติดตั้ง SQL R3.8 สำหรับนับผู้สมัครจริง: รัน supabase/01_INSTALL_CLUB_REGISTRATION_COUNTS_R38.sql แล้วรีโหลดหน้าเว็บ'), {code: code || 'PGRST202'});
        }
        throw err;
    }
}
function sknCountFailureText(error) {
    const code = String(error?.code || '');
    const status = Number(error?.status || 0);
    const detail = String(error?.message || error || 'ไม่ทราบสาเหตุ');
    if (code === 'PGRST202' || code === '42883' || /skn_club_registration_counts.*(does not exist|schema cache|could not find)/i.test(detail))
        return 'ไม่พบฟังก์ชันนับยอดใน Supabase: ติดตั้ง SQL R3.8/R3.9 และรีโหลด schema cache (' + (code || 'PGRST202') + ')';
    if (code === '42501' || status === 401 || status === 403)
        return 'Supabase ปฏิเสธสิทธิ์นับยอด (' + (code || status) + '): ตรวจเซสชันนักเรียน ภาคเรียน และ GRANT EXECUTE ของฟังก์ชัน';
    if (/failed to fetch|network|load failed/i.test(detail))
        return 'ติดต่อ Supabase ไม่สำเร็จ: ตรวจอินเทอร์เน็ต/เครือข่ายและ Project URL';
    return 'โหลดจำนวนผู้สมัครจาก Supabase ไม่สำเร็จ' + (code ? ' [' + code + ']' : '') + ': ' + detail.slice(0, 200);
}
async function getCurrentUser(sess, periodId) {
    if (sess.type === 'teacher') {
        const u = await result(db.from('teachers').select('id,name,role').eq('id', sess.sub).maybeSingle());
        assert(u, 'บัญชีผู้ใช้งานไม่ถูกต้อง');
        if (u.role !== 'admin') {
            const current = await result(db.from('periods').select('id').eq('is_current', true).maybeSingle());
            const access = current ? await result(db.from('period_teachers').select('teacher_id').eq('period_id', current.id).eq('teacher_id', u.id).maybeSingle()) : null;
            assert(access, 'บัญชีครูไม่ได้รับสิทธิ์ในภาคเรียนปัจจุบัน');
        }
        const m = await result(db.from('period_teachers').select('teacher_id').eq('period_id', periodId).eq('teacher_id', sess.sub).maybeSingle());
        return { ...u, type: 'teacher', isMember: !!m };
    }
    const s = await result(db.from('students').select('id,name,level,room,no').eq('period_id', periodId).eq('id', sess.sub).maybeSingle());
    assert(s, 'ไม่พบข้อมูลนักเรียนในภาคเรียนนี้');
    return { ...s, role: 'student', type: 'student', isMember: true };
}
function canEdit(u, p) { return u.role === 'admin' || Boolean(p.is_current); }
function mustWrite(u, p) { assert(canEdit(u, p), 'ภาคเรียนย้อนหลังเปิดอ่านอย่างเดียว (ยกเว้น Admin)'); }
function mustAdmin(u) { assert(u.role === 'admin', 'เฉพาะผู้ดูแลระบบ'); }
// Read legacy owner_id CSV AND Supabase owner_ids TEXT[] consistently.
// IMPORTANT: this normalizer only improves display and error diagnostics.
// PostgreSQL skn_owns() / RLS remain the final authority for permissions.
function sknClubOwnerIds(club) {
    const source = club?.owner_ids ?? club?.owner_id ?? [];
    const list = Array.isArray(source) ? source : [source];
    const ids = [];
    for (const value of list) {
        if (value == null) continue;
        let parts;
        if (Array.isArray(value)) parts = value;
        else {
            const text = String(value).trim();
            if (text.startsWith('[') && text.endsWith(']')) {
                try { const decoded = JSON.parse(text); parts = Array.isArray(decoded) ? decoded : [text]; }
                catch { parts = [text]; }
            } else parts = [text];
        }
        for (const part of parts) {
            for (const token of String(part).replace(/[，、；|]/g, ',').split(/[,;]/g)) {
                const id = token.trim();
                if (id && !ids.some(x => x.toUpperCase() === id.toUpperCase())) ids.push(id);
            }
        }
    }
    return ids;
}
function owner(u, club) {
    return u.role === 'admin' || (u.role === 'teacher' && sknClubOwnerIds(club)
        .some(id => id.toUpperCase() === String(u.id || '').trim().toUpperCase()));
}
function visibleClub(u, club) { return u.role === 'admin' || owner(u, club) || Boolean(u.archiveRead && u.type === 'teacher'); }
function sknClubPermissionMessage(u, club, isListed) {
    const id = String(u?.id || '');
    const clubId = String(club?.id || '');
    if (!isListed) return `ครูรหัส ${id} ไม่มีชื่ออยู่ในผู้รับผิดชอบชุมนุม ${clubId} (clubs.owner_ids) กรุณาให้ Admin ตรวจรายชื่อครูที่ปรึกษา`;
    return `พบครูรหัส ${id} ในรายชื่อชุมนุม ${clubId} แต่ Supabase ไม่ยืนยันสิทธิ์: ตรวจ clubs.owner_ids ว่าเป็นอาร์เรย์แยกรหัส เช่น {T01,T02} ไม่มีช่องว่าง และตรวจ period_teachers ของภาคเรียนปัจจุบัน`;
}
async function sknRequireOwnClub(u, period, club) {
    if (u.role === 'admin') return;
    assert(u.role === 'teacher', 'เฉพาะครูที่ปรึกษาชุมนุม');
    const isListed = owner(u, club);
    if (!isListed) throw Error(sknClubPermissionMessage(u, club, false));
    // Correct TEXT[] membership is cheap. Only malformed/legacy owner IDs
    // need the extra RPC. Never use a frontend-normalized match to bypass DB RLS.
    if (!Array.isArray(club.owner_ids) || !club.owner_ids.includes(u.id)) {
        const allowed = await result(db.rpc('skn_owns', { p_period: period.id, p_club: club.id }));
        if (allowed !== true) throw Error(sknClubPermissionMessage(u, club, true));
    }
}
async function sknRequireReadClub(u, period, club) {
    if (u.role === 'admin' || Boolean(u.archiveRead && u.type === 'teacher')) return;
    await sknRequireOwnClub(u, period, club);
}
async function clubById(p, id) { const c = await result(db.from('clubs').select('*').eq('period_id', p).eq('id', id).maybeSingle()); assert(c, 'ไม่พบชุมนุม'); return c; }
const twenty = () => Array(20).fill(0);
function validateGrid(g) { assert(g && Array.isArray(g.dates) && g.dates.length === 20, 'วันที่เช็กชื่อต้องมี 20 ครั้ง'); assert(g.records && typeof g.records === 'object', 'ข้อมูลเช็กชื่อผิดรูปแบบ'); const obj = { dates: g.dates.map((x) => typeof x === 'string' ? x.slice(0, 10) : ''), records: {} }; for (const [sid, arr] of Object.entries(g.records)) {
    assert(Array.isArray(arr) && arr.length === 20, 'รายการเช็กชื่อต้องมี 20 ครั้ง');
    obj.records[sid] = arr.map(v => { const n = Number(v); assert(Number.isInteger(n) && n >= 0 && n <= 3, 'สถานะเช็กชื่อไม่ถูกต้อง'); return n; });
} return obj; }
function renderClub(c, regs, teachers) { return { id: c.id, name: c.name, max_capacity: c.max_capacity, current_count: regs.filter(r => r.club_id === c.id).length, level: c.level, owner_id: sknClubOwnerIds(c).join(','), teacher_name: sknClubOwnerIds(c).map((id) => teachers.find(t => String(t.id || '').trim().toUpperCase() === id.toUpperCase())?.name || '').filter(Boolean).join(', '), location: c.location, comment: c.comment }; }
function studentView(s, regs) { return { ...s, password: '', club_id: regs.find(r => r.student_id === s.id)?.club_id || '' }; }
async function gas(action, payload) { return window.SKNFile.invoke(action, payload); }
async function cleanupOldDriveMedia(p, id) {
    const jobs = await result(db.rpc('skn_media_cleanup_candidates', { p_period: p, p_club: id }));
    if (!jobs.length)
        return { cleanupPending: 0, cleanupErrors: [] };
    const deleted = await gas('deleteFiles', { periodId: p, clubId: id, jobs: jobs.map(j => ({ jobId: j.job_id, fileId: j.file_id })) });
    const cleanupErrors = Object.entries(deleted?.errors || {}).map(([key, value]) => key + ': ' + value);
    return { cleanupPending: cleanupErrors.length, cleanupErrors };
}
const sknEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function sknHex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
// Registration IDs are issued by skn_next_reg_id() inside PostgreSQL: REG-2569-1-00001.
// Only account IDs beginning with A are primary admin accounts excluded from teacher statistics.
// Roles are permission flags, not statistical categories: T01 with role=admin still counts.
function isPrimaryAdminId(id) { return String(id ?? '').trim().toUpperCase().startsWith('A'); }
async function sum(p) {
    const [ss, tt, cc, rr] = await Promise.all([all('students', p), all('period_teachers', p), all('clubs', p), all('registrations', p)]);
    const teachers = tt.filter(t => !isPrimaryAdminId(t.teacher_id));
    const owners = new Set(cc.flatMap(c => sknClubOwnerIds(c).map(id => id.toUpperCase())));
    return { student: { total: ss.length, registered: rr.length, unregistered: ss.length - rr.length },
        teacher: { total: teachers.length, hasClub: teachers.filter(t => owners.has(String(t.teacher_id).toUpperCase())).length, noClub: teachers.filter(t => !owners.has(String(t.teacher_id).toUpperCase())).length }, clubsCount: cc.length };
}
const SKN_IMAGE_SLOTS = ['logo', 'photo_1', 'photo_2', 'photo_3', 'photo_4', 'sigTeacher', 'sigHeadClub', 'sigHeadDev', 'sigDeputy', 'sigDirector'];
// From V4.0 image URL columns are TEXT. Drive file IDs remain in media JSON for
// private authorization and safe deletion (URLs cannot authorize a Drive file).
function sknImageSlots(row) { const legacy = row?.media || {}; return Object.fromEntries(SKN_IMAGE_SLOTS.map(k => [k, legacy[k]?.id ? legacy[k] : null])); }
// Only a real URL returned by Google is acceptable; NEVER invent an lh5 endpoint.
function sknDirectImageUrl(value) {
    const url = String(value || '').trim();
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && /^lh[0-9]+\.googleusercontent\.com$/i.test(u.hostname) && u.pathname !== '/' ? url : '';
    }
    catch {
        return '';
    }
}
const SKN_BACKUP_TABLES = ['teachers', 'period_teachers', 'students', 'clubs', 'registrations', 'attendance', 'club_reports', 'period_config'];
function validateBackupSnapshot(data) {
    assert(data?.format === 'SKN-SUPABASE-V1' && data.period?.id, 'ไฟล์สำรองไม่มีข้อมูลภาคเรียน');
    const ids = {};
    for (const name of SKN_BACKUP_TABLES) {
        const rows = data.tables?.[name];
        assert(Array.isArray(rows), 'Backup ขาดตาราง ' + name);
        if (name !== 'teachers')
            for (const row of rows)
                assert(row.period_id === data.period.id, 'Backup ตาราง ' + name + ' มีข้อมูลข้ามภาคเรียน');
        ids[name] = rows.length;
    }
    const students = new Set(data.tables.students.map((s) => s.id));
    const clubs = new Set(data.tables.clubs.map((c) => c.id));
    const teachers = new Set(data.tables.teachers.map((t) => t.id));
    for (const t of data.tables.period_teachers)
        assert(teachers.has(t.teacher_id), 'Backup มีรหัสครูไม่ตรง: ' + t.teacher_id);
    for (const r of data.tables.registrations)
        assert(students.has(r.student_id) && clubs.has(r.club_id), 'Backup การลงทะเบียนไม่สัมพันธ์กับนักเรียนหรือชุมนุม');
    for (const a of data.tables.attendance)
        assert(clubs.has(a.club_id) && Array.isArray(a.grid?.dates) && a.grid.dates.length === 20, 'Backup การเช็กชื่อผิดรูปแบบหรือขาดข้อมูล 20 ครั้ง');
    for (const r of data.tables.club_reports)
        assert(clubs.has(r.club_id) && r.media && typeof r.media === 'object', 'Backup รายงานหรือ Media ไม่ถูกต้อง');
    return ids;
}
async function snapshot(periodId) {
    const data = { format: 'SKN-SUPABASE-V1', created_at: new Date().toISOString(),
        period: (await getPeriod(periodId)).period, tables: {} };
    for (const name of SKN_BACKUP_TABLES) {
        const records = name === 'teachers' ? await all(name) : await all(name, periodId);
        data.tables[name] = records;
    }
    const counts = validateBackupSnapshot(data);
    data.backup_manifest = { version: 'V4.8', counts, containsMediaReferences: true,
        includesBinaryImages: false,
        note: 'ข้อมูลครบ 8 ตาราง รวมรูปใน media (File ID/URL) แต่ไฟล์ภาพต้นฉบับอยู่ใน Drive และรหัสผ่านไม่รวมอยู่ใน JSON' };
    return data;
}
// V4.8: encrypt only the credentials, not the full backup. This leaves all 8 tables
// backwards-compatible and inspectable while preventing passwords from appearing in Drive JSON.
// Passphrase stays in browser memory. No service role keys or secrets are persisted.
const SKN_VAULT_ITERATIONS = 310000;
function sknVaultBase64(data) {
    let result = '';
    for (let i = 0; i < data.length; i += 16384)
        result += String.fromCharCode(...data.subarray(i, i + 16384));
    return btoa(result);
}
function sknVaultFromBase64(s) {
    const binary = atob(s);
    const result = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        result[i] = binary.charCodeAt(i);
    return result;
}
async function sknVaultKey(passphrase, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations, hash: 'SHA-256' }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sknEncryptCredentials(credentials, passphrase) {
    assert(passphrase.length >= 14 && passphrase.length <= 256, 'รหัสลับเข้ารหัส Backup ต้องยาวอย่างน้อย 14 ตัวอักษร');
    assert(Array.isArray(credentials?.teachers) && Array.isArray(credentials?.students), 'ไม่พบข้อมูลรหัสผ่านจาก Supabase');
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await sknVaultKey(passphrase, salt, SKN_VAULT_ITERATIONS);
    const clear = new TextEncoder().encode(JSON.stringify(credentials));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, clear));
    return { version: 1, algorithm: 'AES-256-GCM', kdf: 'PBKDF2-HMAC-SHA256', iterations: SKN_VAULT_ITERATIONS,
        salt: sknVaultBase64(salt), iv: sknVaultBase64(iv), ciphertext: sknVaultBase64(ciphertext),
        counts: { teachers: credentials.teachers.length, students: credentials.students.length } };
}
async function sknDecryptCredentials(vault, passphrase) {
    assert(vault?.version === 1 && vault.algorithm === 'AES-256-GCM' && vault.kdf === 'PBKDF2-HMAC-SHA256', 'รูปแบบไฟล์เข้ารหัสรหัสผ่านไม่รองรับ');
    assert(Number.isInteger(vault.iterations) && vault.iterations >= 200000 && vault.iterations <= 1000000, 'ค่า KDF ในไฟล์สำรองไม่ถูกต้อง');
    assert(passphrase, 'กรุณาป้อนรหัสลับที่ใช้เข้ารหัส Backup');
    try {
        const salt = sknVaultFromBase64(vault.salt), iv = sknVaultFromBase64(vault.iv);
        assert(salt.length === 16 && iv.length === 12, 'ข้อมูล salt/iv ไม่ถูกต้อง');
        const key = await sknVaultKey(passphrase, salt, vault.iterations);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, sknVaultFromBase64(vault.ciphertext));
        const credentials = JSON.parse(new TextDecoder().decode(plain));
        assert(Array.isArray(credentials?.teachers) && Array.isArray(credentials?.students), 'ข้อมูลรหัสผ่านไม่สมบูรณ์');
        assert(credentials.teachers.length === vault.counts.teachers && credentials.students.length === vault.counts.students, 'จำนวนบัญชีใน Vault ไม่ตรงกับไฟล์ Backup');
        return credentials;
    }
    catch (e) {
        throw Error('ถอดรหัส Backup ไม่สำเร็จ: รหัสลับไม่ถูกต้องหรือไฟล์เสียหาย');
    }
}
async function verifyBackupFile(content, stored) {
    assert(stored?.success === true && stored.id, 'Google Drive ไม่ยืนยันว่าเขียนไฟล์สำรองสำเร็จ');
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    const expected = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
    assert(stored.sha256 === expected, 'Checksum ของไฟล์ Backup ที่ GAS เขียนไม่ตรงกับต้นฉบับ');
}
async function mediaSave(input, existing, p, c, slot) {
    if (input === '__DELETE__')
        return null;
    if (!input)
        return existing?.[slot] || null;
    if (typeof input !== 'string')
        throw Error('รูปภาพต้องเป็นข้อความ');
    if (!input.startsWith('data:image/')) { // Legacy stored remote images may be displayed but not stored as uncontrolled external URLs.
        const prior = existing?.[slot];
        if (prior?.id)
            return prior;
        return null;
    }
    const match = input.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    assert(match, 'รองรับรูป PNG, JPEG หรือ WebP เท่านั้น');
    assert(match[2].length <= 8_500_000, 'ภาพมีขนาดใหญ่เกิน 6 MB กรุณาเลือกไฟล์ต้นฉบับที่เล็กลง');
    const sha = sknHex(new Uint8Array(await crypto.subtle.digest('SHA-256', sknEncoder ? sknEncoder.encode(match[2]) : Uint8Array.from(match[2], (c) => c.charCodeAt(0)))));
    if (existing?.[slot]?.sha === sha)
        return existing[slot];
    const r = await gas('saveFile', { periodId: p, clubId: c, slot, fileName: `${slot}-${sha.slice(0, 12)}.${match[1].split('/')[1]}`, mime: match[1], base64: match[2] });
    assert(r?.success === true && r.id, 'Google Drive ไม่ได้ส่ง File ID กลับมา');
    return { id: r.id, sha, mime: match[1], name: r.name || '', url: r.url || `https://drive.google.com/file/d/${encodeURIComponent(r.id)}/view`, previewUrl: r.previewUrl || '', lh5Url: /^https:\/\/lh5\.googleusercontent\.com\//i.test(String(r.lh5Url || '')) ? r.lh5Url : '' };
}
function csvParse(raw) { const text = raw.replace(/^\ufeff/, ''); const first = text.split(/\r?\n/, 1)[0]; const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ','; const out = []; let row = [], cell = '', quoted = false; for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
        if (quoted && text[i + 1] === '"') {
            cell += '"';
            i++;
        }
        else
            quoted = !quoted;
    }
    else if (ch === delim && !quoted) {
        row.push(cell);
        cell = '';
    }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
        if (ch === '\r' && text[i + 1] === '\n')
            i++;
        row.push(cell);
        if (row.some(v => v.trim()))
            out.push(row);
        row = [];
        cell = '';
    }
    else
        cell += ch;
} if (quoted)
    throw Error('CSV เครื่องหมายคำพูดไม่ครบ'); row.push(cell); if (row.some(v => v.trim()))
    out.push(row); return out; }
function filterBulk(s, target, room) { if (target === 'ม.ต้น')
    return ['ม.1', 'ม.2', 'ม.3', 'ม.ต้น'].some(x => s.level.includes(x)); if (target === 'ม.ปลาย')
    return ['ม.4', 'ม.5', 'ม.6', 'ม.ปลาย'].some(x => s.level.includes(x)); if (target === 'ระบุห้อง') {
    const str = s.room.toLowerCase();
    const q = room.trim().toLowerCase();
    const index = str.indexOf(q);
    return !!q && index >= 0 && !/\d/.test(str[index + q.length] || '');
} return false; }
// Human-readable diagnostics: distinguish a browser/network failure from a real Auth API rejection.
function sknAuthError(error) {
    const code = String(error?.code || '').toLowerCase();
    const status = Number(error?.status || 0);
    const detail = String(error?.message || error || 'unknown error');
    if (code === 'anonymous_provider_disabled')
        return Error('Supabase ปิด Anonymous Sign-Ins: เปิดที่ Authentication → Sign In / Providers → Anonymous (' + code + ')');
    if (code === 'signup_disabled')
        return Error('Supabase ปิดการสร้างผู้ใช้ใหม่: ตรวจ Allow new users to sign up สำหรับ Anonymous Auth (' + code + ')');
    if (code === 'captcha_failed' || /captcha/i.test(detail))
        return Error('Supabase ปฏิเสธ CAPTCHA: ตรวจ Bot and Abuse Protection และการส่ง captchaToken (' + code + ': ' + detail + ')');
    if (status === 429 || code === 'over_request_rate_limit')
        return Error('Supabase จำกัดจำนวนการเปิดเซสชันชั่วคราว (429) กรุณาตรวจ Rate Limits');
    if (status === 401 || status === 403)
        return Error('Supabase ปฏิเสธคำขอ (' + status + '): ตรวจ Project URL, Publishable Key และการตั้งค่า Auth (' + detail + ')');
    if (/failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(detail) || error?.name === 'AuthRetryableFetchError')
        return Error('เชื่อมต่อ Supabase ไม่สำเร็จ (Failed to fetch): ตรวจ web/config.js, Project URL, สถานะ Project, เครือข่าย, DNS และส่วนขยายที่บล็อกคำขอ เปิด diagnostics.html เพื่อทดสอบ (ไม่ใช่ข้อสรุปว่า CAPTCHA ผิด)');
    return Error('เปิดเซสชัน Supabase ไม่สำเร็จ: ' + detail + (code ? ' [' + code + ']' : ''));
}
async function checkLogin(username, password) {
    // No email login. Supabase Anonymous Auth only supplies the JWT for RLS;
    // Teachers.username / Students.id and their plaintext passwords are checked by a database-only SQL RPC (NEVER SELECT passwords in browsers).
    if (!db)
        throw Error(window.SKN_CONFIG_ERROR || 'ยังไม่ได้ตั้งค่า Supabase ใน web/config.js');
    let existing;
    try {
        const response = await db.auth.getSession();
        if (response.error)
            throw sknAuthError(response.error);
        existing = response.data?.session;
    }
    catch (e) {
        if (e?.message?.startsWith('เชื่อมต่อ Supabase') || e?.message?.startsWith('เปิดเซสชัน Supabase'))
            throw e;
        throw sknAuthError(e);
    }
    if (!existing?.user?.is_anonymous) {
        if (existing) {
            const revoked = await db.auth.signOut();
            if (revoked.error)
                throw sknAuthError(revoked.error);
        } // V2 email session must not be reused
        let anonymous;
        try {
            anonymous = await db.auth.signInAnonymously();
        }
        catch (e) {
            throw sknAuthError(e);
        }
        if (anonymous.error)
            throw sknAuthError(anonymous.error);
        if (!anonymous.data?.session)
            throw Error('Supabase ไม่ส่งข้อมูลเซสชันกลับมา: ตรวจการตั้งค่า Anonymous Auth');
    }
    const v = await result(db.rpc('skn_login_credentials', {
        p_username: String(username || '').trim(), p_password: String(password || '').trim()
    }));
    if (!v?.success)
        return { success: false, message: v?.message || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    const { period: current } = await getPeriod();
    const actorId = await result(db.rpc('skn_actor_id'));
    const actorRole = await result(db.rpc('skn_actor_role'));
    if (!actorId || !actorRole)
        throw Error('ไม่พบสิทธิ์ผู้ใช้ กรุณาตรวจสอบตาราง Teachers/Students และ Migration V3');
    const type = actorRole === 'student' ? 'student' : 'teacher';
    let period = current;
    if (type === 'student') {
        const record = await result(db.from('students_public').select('id').eq('period_id', current.id).eq('id', actorId).maybeSingle());
        if (!record) {
            const histories = await all('students');
            const valid = new Set(histories.filter(x => x.id === actorId).map(x => x.period_id));
            const p = (await getPeriod()).periods.find(x => valid.has(x.id));
            if (!p)
                throw Error('นักเรียนยังไม่มีข้อมูลในภาคเรียนใด');
            period = p;
            window.SKNBridge.periodId = p.id;
        }
        else
            window.SKNBridge.periodId = '';
    }
    else
        window.SKNBridge.periodId = '';
    const u = await getCurrentUser({ sub: actorId, type }, period.id);
    const reg = type === 'student' ? await result(db.from('registrations').select('club_id').eq('period_id', period.id).eq('student_id', actorId).maybeSingle()) : null;
    const memberships = type === 'teacher' ? await result(db.from('clubs').select('owner_ids').eq('period_id', period.id)) : [];
    return { success: true, user: { id: u.id, name: u.name, role: u.role, level: u.level || '', clubId: reg?.club_id || '', hasClub: memberships.some((c) => sknClubOwnerIds(c).some(id => id.toUpperCase() === String(actorId).toUpperCase())) } };
}
async function sknInvoke(method, args, periodId) {
    if (method === 'getWebAppUrl')
        return location.href;
    if (method === 'checkLogin')
        return checkLogin(args[0], args[1]);
    const { data: { session } } = await db.auth.getSession();
    if (!session)
        throw Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    const actorId = await result(db.rpc('skn_actor_id'));
    const actorRole = await result(db.rpc('skn_actor_role'));
    if (!actorId || !actorRole)
        throw Error('ไม่มีสิทธิ์ใช้ระบบ');
    const sess = { sub: actorId, type: actorRole === 'student' ? 'student' : 'teacher' };
    const { period: p, periods } = await getPeriod(periodId);
    const u = await getCurrentUser(sess, p.id);
    u.archiveRead = !p.is_current;
    const isAdmin = u.role === 'admin';
    let output;
    switch (method) {
        case 'resumeSession': {
            const reg = u.type === 'student' ? await result(db.from('registrations').select('club_id').eq('period_id', p.id).eq('student_id', u.id).maybeSingle()) : null;
            const owned = u.type === 'teacher' ? await result(db.from('clubs').select('owner_ids').eq('period_id', p.id)) : [];
            output = { success: true, user: { id: u.id, name: u.name, role: u.role, level: u.level || '',
                    clubId: reg?.club_id || '', hasClub: owned.some((c) => sknClubOwnerIds(c).some(id => id.toUpperCase() === String(u.id).toUpperCase())) } };
            break;
        }
        case 'getPeriods':
            output = { periods, periodId: p.id, isReadonly: !canEdit(u, p) };
            break;
        case 'getClubRegistrationCounts': {
            // Lightweight refresh for student club enrollment screen. This never
            // exposes other students' names or registration details.
            const rows = await sknApplicantCounts(p.id);
            output = { periodId: p.id, counts: rows.map(r => ({clubId: String(r.club_id), count: Number(r.member_count)})) };
            break;
        }
        case 'getAppData': {
            // R3.8: Student RLS shows only their own registration. That subset
            // cannot be used to calculate the REAL number of applicants in a club.
            // Fetch only the student's own registration + a safe aggregate RPC.
            const studentViewOnly = u.type === 'student';
            // R3.9: failure of the aggregate endpoint must not hide the entire
            // registration page. A missing count is UNKNOWN, never silently 0 or 1.
            const [clubs, regs, config, teachers, memberships, totalsResult] = await Promise.all([
                all('clubs', p.id),
                studentViewOnly
                    ? result(db.from('registrations').select('student_id,club_id').eq('period_id', p.id).eq('student_id', u.id))
                    : all('registrations', p.id),
                cfg(p.id), all('teachers'), all('period_teachers', p.id),
                studentViewOnly
                    ? sknApplicantCounts(p.id).then(rows => ({rows, error: null}))
                        .catch(error => ({rows: null, error: sknCountFailureText(error)}))
                    : Promise.resolve({rows: null, error: null})
            ]);
            // Missing flag in V4.9 data means email was enabled; preserve that on upgrade.
            if (config.allow_report_email !== 'false')
                config.allow_report_email = 'true';
            try {
                const a = JSON.parse(config.adminSettings || '{}');
                config.adminSettings = JSON.stringify({ ...a, semester: String(p.semester), academicYear: String(p.academic_year) });
            }
            catch { }
            const selected = memberships.map(m => ({ id: m.teacher_id, name: m.display_name || teachers.find(t => t.id === m.teacher_id)?.name || '' }));
            const applicantByClub = studentViewOnly && Array.isArray(totalsResult.rows)
                ? new Map(totalsResult.rows.map(r => [String(r.club_id), Number(r.member_count)])) : null;
            let countProblem = studentViewOnly ? totalsResult.error : null;
            const formattedClubs = clubs.map(c => {
                const item = renderClub(c, regs, selected);
                if (studentViewOnly) {
                    const count = applicantByClub?.get(String(c.id));
                    item.count_verified = Number.isSafeInteger(count) && count >= 0;
                    item.current_count = item.count_verified ? count : null;
                    if (!item.count_verified && !countProblem)
                        countProblem = 'Supabase ไม่ส่งยอดผู้สมัครของชุมนุม ' + String(c.id) + ' กลับมา';
                }
                return item;
            });
            output = { clubs: formattedClubs,
                registrationCountStatus: studentViewOnly
                    ? {ok: !countProblem, error: countProblem || '', source: 'skn_club_registration_counts'}
                    : null,
                config, teachers: selected, summary: isAdmin ? await sum(p.id) : null,
                serverTime: Date.now(), periods: periods.map(x => ({ id: x.id, periodCode: x.period_code || `${x.academic_year}-${x.semester}`, academicYear: x.academic_year, semester: x.semester, isCurrent: x.is_current })),
                periodId: p.id, isReadonly: !canEdit(u, p), myClubId: u.type === 'student' ? regs.find(r => r.student_id === u.id)?.club_id || '' : '' };
            break;
        }
        case 'getAdminSummary':
            mustAdmin(u);
            output = await sum(p.id);
            break;
        case 'getClubs': {
            const [clubs, regs, tt] = await Promise.all([all('clubs', p.id), all('registrations', p.id), all('period_teachers', p.id)]);
            output = clubs.map(c => renderClub(c, regs, tt.map(t => ({ id: t.teacher_id, name: t.display_name }))));
            break;
        }
        case 'registerClub': {
            mustWrite(u, p);
            assert(u.type === 'student' && String(args[0]) === u.id, 'ลงทะเบียนได้เฉพาะบัญชีนักเรียนตนเอง');
            const settings = await cfg(p.id);
            const message = await result(db.rpc('skn_register', { p_period: p.id, p_student: u.id, p_club: String(args[1]), p_transfer: settings.allow_transfer === 'true', p_open: settings.open_reg === 'true' }));
            output = { success: true, message };
            break;
        }
        case 'getClubAttendanceGrid': {
            const id = String(args[0]);
            const club = await clubById(p.id, id);
            await sknRequireReadClub(u, p, club);
            const [r, students, regs] = await Promise.all([
                result(db.from('attendance').select('grid').eq('period_id', p.id).eq('club_id', id).maybeSingle()), all('students', p.id), all('registrations', p.id)
            ]);
            const memberIds = new Set(regs.filter(x => x.club_id === id).map(x => x.student_id));
            const members = students.filter(s => memberIds.has(s.id)).sort((a, b) => a.room.localeCompare(b.room, 'th', { numeric: true }) || Number(a.no) - Number(b.no));
            const g = r?.grid || { dates: Array(20).fill(''), records: {} };
            if (!Array.isArray(g.dates) || g.dates.length !== 20)
                g.dates = Array(20).fill('');
            for (const s of members)
                if (!Array.isArray(g.records?.[s.id]))
                    g.records = { ...g.records, [s.id]: twenty() };
            output = { found: !!r, gridData: g, students: members.map(s => studentView(s, regs)) };
            break;
        }
        case 'saveAttendanceGrid': {
            mustWrite(u, p);
            const id = String(args[0]);
            const c = await clubById(p.id, id);
            await sknRequireOwnClub(u, p, c);
            const grid = validateGrid(args[1]);
            const regs = await result(db.from('registrations').select('student_id').eq('period_id', p.id).eq('club_id', id));
            const allowed = new Set(regs.map(r => r.student_id));
            for (const sid of Object.keys(grid.records))
                assert(allowed.has(sid), 'พบข้อมูลนักเรียนที่ไม่ได้อยู่ในชุมนุม');
            await result(db.rpc('skn_save_attendance', { p_period: p.id, p_club: id, p_grid: grid }));
            output = { success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' };
            break;
        }
        case 'getGlobalFailedSummary': {
            mustAdmin(u);
            const [grids, ss, cc] = await Promise.all([all('attendance', p.id), all('students', p.id), all('clubs', p.id)]);
            const map = new Map(ss.map(s => [s.id, s]));
            const clubs = new Map(cc.map(c => [c.id, c.name]));
            const failed = [];
            // Exact old-sheet behavior: only students whose Attendance_Data JSON includes a record
            // are evaluated. A newly reset term without attendance records has no failed list yet.
            for (const row of grids) {
                for (const [stdId, vals] of Object.entries(row.grid?.records || {})) {
                    if (!Array.isArray(vals))
                        continue;
                    const present = vals.filter(x => Number(x) === 1).length;
                    const absent = vals.filter(x => Number(x) === 3).length;
                    if (present === 0 || absent > 3) {
                        const st = map.get(stdId);
                        if (st)
                            failed.push({ id: st.id, name: st.name, level: st.level, room: st.room, no: st.no, clubName: clubs.get(row.club_id) || 'ไม่ระบุ', present, absent });
                    }
                }
            }
            output = failed;
            break;
        }
        case 'findStudentClub': {
            assert(u.role !== 'student');
            const query = String(args[0] || '').toLowerCase().trim();
            const ss = await all('students', p.id);
            const s = ss.find(x => x.id.toLowerCase().includes(query) || x.name.toLowerCase().includes(query));
            if (!s) {
                output = null;
                break;
            }
            const reg = await result(db.from('registrations').select('club_id').eq('period_id', p.id).eq('student_id', s.id).maybeSingle());
            const club = reg ? await clubById(p.id, reg.club_id) : null;
            output = { id: s.id, name: s.name, level: s.level, room: s.room, club_name: club?.name || 'ยังไม่ได้สมัครชุมนุม' };
            break;
        }
        case 'getStudentsByRoom': {
            assert(u.role !== 'student');
            // Backward compatible: old call(level,room) or new call(query). No level is required.
            const query = String(args.length > 1 ? args[1] : args[0] || '').trim().toLocaleLowerCase('th-TH');
            assert(query.length >= 1 && query.length <= 120, 'กรุณากรอกชื่อ รหัสนักเรียน หรือห้อง');
            const [ss, rr, cc] = await Promise.all([all('students', p.id), all('registrations', p.id), all('clubs', p.id)]);
            const clubNames = new Map(cc.map(c => [c.id, c.name]));
            const regByStudent = new Map(rr.map(r => [r.student_id, r.club_id]));
            const normalized = (x) => String(x || '').trim().toLocaleLowerCase('th-TH').replace(/\s+/g, '');
            const compactQuery = normalized(query);
            output = ss.filter(s => [s.id, s.name, s.room, `${s.level}/${s.room}`, `${s.level}${s.room}`].some(v => normalized(v).includes(compactQuery)))
                .sort((a, b) => a.room.localeCompare(b.room, 'th', { numeric: true }) || Number(a.no) - Number(b.no))
                .slice(0, 1000)
                .map(s => ({ id: s.id, name: s.name, level: s.level, room: s.room, no: s.no,
                club_name: clubNames.get(regByStudent.get(s.id)) || 'ยังไม่ได้สมัครชุมนุม' }));
            break;
        }
        case 'getUsersByRole': {
            assert(u.role !== 'student');
            const type = String(args[0]);
            assert(type === 'teacher' || type === 'student');
            if (type === 'teacher') {
                const [tt, mm] = await Promise.all([all('teachers'), all('period_teachers', p.id)]);
                output = tt.filter(t => mm.some(x => x.teacher_id === t.id)).map(t => ({ id: t.id, name: mm.find(x => x.teacher_id === t.id)?.display_name || t.name, username: t.username, password: '', role: t.role })).sort((a, b) => Number(isPrimaryAdminId(b.id)) - Number(isPrimaryAdminId(a.id)) || a.id.localeCompare(b.id, 'th', { numeric: true }));
            }
            else {
                const [ss, rr] = await Promise.all([all('students', p.id), all('registrations', p.id)]);
                output = ss.map(s => studentView(s, rr)).sort((a, b) => a.level.localeCompare(b.level, 'th', { numeric: true }) || a.room.localeCompare(b.room, 'th', { numeric: true }) || Number(a.no) - Number(b.no));
            }
            break;
        }
        case 'getUserPassword': {
            mustAdmin(u);
            const type = String(args[0]);
            const targetId = String(args[1] || '');
            assert(['teacher', 'student'].includes(type) && targetId, 'ประเภทหรือรหัสบัญชีไม่ถูกต้อง');
            output = await result(db.rpc('skn_admin_get_password', {
                p_period: p.id, p_role: type, p_user_id: targetId
            }));
            break;
        }
        case 'saveUser': {
            mustAdmin(u);
            const f = args[0];
            assert(f && ['teacher', 'student'].includes(f.role_type), 'ประเภทผู้ใช้ไม่ถูกต้อง');
            const newId = String(f.new_id || '').trim();
            assert(newId && newId.length <= 64, 'รหัสผู้ใช้ไม่ถูกต้อง');
            const oldId = String(f.id || '').trim();
            if (oldId && oldId !== newId)
                await result(db.rpc('skn_rename_user', { p_period: p.id, p_role: f.role_type, p_old: oldId, p_new: newId }));
            await result(db.rpc('skn_upsert_users', { p_period: p.id, p_role: f.role_type, p_rows: [{ id: newId, name: String(f.name || ''), username: String(f.username || newId), role: f.role || 'teacher', level: String(f.level || ''), room: String(f.room || ''), no: String(f.no || ''), password: String(f.password || '') }] }));
            output = { success: true, message: 'บันทึกข้อมูลเรียบร้อยแล้ว' };
            break;
        }
        case 'importUsersFromCSV': {
            mustAdmin(u);
            const type = String(args[1]);
            assert(['teacher', 'student'].includes(type));
            const raw = String(args[0] || '');
            assert(raw.length <= 3_000_000, 'CSV ใหญ่เกินไป');
            const lines = csvParse(raw), ids = new Set();
            let duplicates = 0, headers = 0;
            const data = [];
            for (let i = 0; i < lines.length; i++) {
                const r = lines[i].map(v => String(v || '').trim());
                const id = r[0].replace(/^\uFEFF/, '');
                if (!id)
                    continue;
                if (/^(id|รหัส|รหัสครู|รหัสนักเรียน|student_id|teacher_id)$/i.test(id) || (i === 0 && /id/i.test(id) && r.length > 1 && /name|ชื่อ/i.test(r[1]))) {
                    headers++;
                    continue;
                }
                if (ids.has(id)) {
                    duplicates++;
                    continue;
                }
                ids.add(id);
                const row = type === 'teacher'
                    ? { id, name: r[1] || '', username: r[2] || id, password: r[3] || '', role: r[4] || 'teacher' }
                    : { id, name: r[1] || '', level: r[2] || '', room: r[3] || '', no: r[4] || '', password: r[5] || '' };
                data.push(row);
            }
            assert(data.length > 0, 'ไม่พบรายการนำเข้าใน CSV');
            assert(data.length <= 10000, 'CSV เกิน 10,000 แถว');
            const out = { addedCount: 0, updatedCount: 0, unchangedCount: 0, duplicateInCsvCount: duplicates, headerRowsSkipped: headers, addedNames: [], updatedNames: [], updatedDetails: [] };
            for (let i = 0; i < data.length; i += 150) {
                const resp = await result(db.rpc('skn_import_users_v49', { p_period: p.id, p_role: type, p_rows: data.slice(i, i + 150) }));
                out.addedCount += Number(resp.addedCount || 0);
                out.updatedCount += Number(resp.updatedCount || 0);
                out.unchangedCount += Number(resp.unchangedCount || 0);
                out.addedNames.push(...(resp.addedNames || []));
                out.updatedNames.push(...(resp.updatedNames || []));
                out.updatedDetails.push(...(resp.updatedDetails || []));
            }
            output = out;
            break;
        }
        case 'deleteUser': {
            mustAdmin(u);
            const id = String(args[0]), type = String(args[1]);
            if (type === 'teacher') {
                assert(id !== u.id, 'ห้ามลบบัญชีตนเอง');
                const tt = await all('teachers');
                assert(!(tt.find(t => t.id === id)?.role === 'admin' && tt.filter(t => t.role === 'admin').length === 1), 'ห้ามลบ Admin คนสุดท้าย');
                const clubs = await all('clubs', p.id);
                for (const c of clubs) {
                    if (sknClubOwnerIds(c).some(x => x.toUpperCase() === id.toUpperCase())) {
                        if (sknClubOwnerIds(c).length === 1)
                            await result(db.rpc('skn_delete_club', { p_period: p.id, p_club: c.id }));
                        else
                            await result(db.from('clubs').update({ owner_ids: sknClubOwnerIds(c).filter((x) => x.toUpperCase() !== id.toUpperCase()) }).eq('period_id', p.id).eq('id', c.id));
                    }
                }
                await result(db.rpc('skn_remove_teacher', { p_period: p.id, p_teacher: id })); // Historical memberships are preserved.
            }
            else {
                await result(db.rpc('skn_delete_students', { p_period: p.id, p_ids: [id] }));
            }
            output = { success: true, message: 'ลบข้อมูลเรียบร้อยแล้ว' };
            break;
        }
        case 'deleteStudentsBulkServer': {
            mustAdmin(u);
            const ss = await all('students', p.id);
            const ids = ss.filter(s => filterBulk(s, String(args[0]), String(args[1] || ''))).map(s => s.id);
            assert(ids.length > 0, 'ไม่พบข้อมูลนักเรียนตามเงื่อนไข');
            await result(db.rpc('skn_delete_students', { p_period: p.id, p_ids: ids }));
            output = { success: true, message: `ลบนักเรียนกลุ่มนี้จำนวน ${ids.length} คน เรียบร้อยแล้ว` };
            break;
        }
        case 'saveClub':
        case 'updateClub': {
            mustWrite(u, p);
            const f = args[0] || {};
            const isEdit = method === 'updateClub';
            const prev = isEdit ? await clubById(p.id, String(f.id)) : null;
            if (isEdit)
                await sknRequireOwnClub(u, p, prev);
            const owners = sknClubOwnerIds({ owner_ids: f.owner_ids || [] });
            assert(owners.length > 0, 'กรุณาเลือกครูอย่างน้อย 1 คน');
            if (!isAdmin)
                assert(owners.includes(u.id), 'ครูต้องเป็นเจ้าของชุมนุมที่สร้าง');
            const members = await all('period_teachers', p.id);
            assert(owners.every(x => members.some(m => m.teacher_id === x)), 'มีชื่อครูที่ไม่ได้อยู่ในภาคเรียนนี้');
            const cap = isAdmin ? Number(f.max_capacity) : owners.length * 20;
            assert(Number.isSafeInteger(cap) && cap >= 0, 'จำนวนที่รับไม่ถูกต้อง');
            const id = await result(db.rpc('skn_save_club', { p_period: p.id, p_id: isEdit ? String(f.id) : '', p_name: String(f.name || '').trim(), p_cap: cap, p_level: String(f.level || 'ทั้งหมด'), p_owners: owners, p_location: String(f.location || ''), p_comment: String(f.comment || '') }));
            output = { success: true, message: isEdit ? 'อัปเดตข้อมูลชุมนุมและรายชื่อนักเรียนแล้ว' : 'สร้างชุมนุมสำเร็จ' };
            break;
        }
        case 'deleteClubAdmin': {
            mustAdmin(u);
            const id = String(args[0]);
            await result(db.rpc('skn_delete_club', { p_period: p.id, p_club: id }));
            output = { success: true, message: 'ลบชุมนุมและข้อมูลที่เกี่ยวข้องเรียบร้อยแล้ว' };
            break;
        }
        case 'updateConfig':
        case 'saveAdvancedSystemSettings': {
            mustAdmin(u);
            const values = args[0] || {};
            assert(typeof values === 'object' && Object.keys(values).length <= 40, 'การตั้งค่าผิดรูปแบบ');
            const protectedKeys = ['adminSettings', 'systemDates', 'holidays'];
            const rows = Object.entries(values).filter(([key]) => method === 'saveAdvancedSystemSettings' || !protectedKeys.includes(key)).map(([key, val]) => ({ period_id: p.id, key, value: typeof val === 'object' ? JSON.stringify(val) : String(val) }));
            if (method === 'saveAdvancedSystemSettings') {
                const settings = values.adminSettings || {};
                const year = Number(settings.academicYear || p.academic_year), sem = Number(settings.semester || p.semester);
                assert(Number.isSafeInteger(year) && year >= 2500 && year <= 2800, 'ปีการศึกษาไม่ถูกต้อง');
                assert(Number.isSafeInteger(sem) && sem >= 1 && sem <= 3, 'ภาคเรียนต้องเป็น 1, 2 หรือ 3');
                const email = String(settings.reportEmail || '').trim();
                assert(!email || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254), 'อีเมลรับรายงานไม่ถูกต้อง');
                if (year !== Number(p.academic_year) || sem !== Number(p.semester))
                    assert(p.is_current, 'เปลี่ยนปี/ภาคเรียนได้เฉพาะภาคเรียนปัจจุบัน');
                await result(db.rpc('skn_save_admin_settings_v36', {
                    p_period: p.id, p_year: year, p_sem: sem, p_settings: { ...settings, reportEmail: email },
                    p_dates: values.systemDates || [], p_holidays: values.holidays || [],
                    p_quota: Number(settings.studentQuota || 20)
                }));
                output = { success: true, message: 'บันทึกการตั้งค่าระบบและปีการศึกษาเรียบร้อย' };
                break;
            }
            if (rows.length)
                await result(db.from('period_config').upsert(rows, { onConflict: 'period_id,key' }));
            output = { success: true, message: 'บันทึกการตั้งค่าระบบเรียบร้อย' };
            break;
        }
        case 'saveClubReportData': {
            mustWrite(u, p);
            const id = String(args[0]), c = await clubById(p.id, id);
            await sknRequireOwnClub(u, p, c);
            const f = args[1] || {};
            const prior = await result(db.from('club_reports').select('media').eq('period_id', p.id).eq('club_id', id).maybeSingle());
            const original = sknImageSlots(prior);
            const media = {};
            media.logo = await mediaSave(f.logo, original, p.id, id, 'logo');
            for (let i = 1; i <= 4; i++)
                media[`photo_${i}`] = await mediaSave(f.photos?.[i], original, p.id, id, `photo_${i}`);
            for (const key of ['sigTeacher', 'sigHeadClub', 'sigHeadDev', 'sigDeputy', 'sigDirector'])
                media[key] = await mediaSave(f.signatures?.[key], original, p.id, id, key);
            // Human-readable media reference for admins; Google-generated file IDs remain authoritative.
            for (const [slot, entry] of Object.entries(media)) {
                const item = entry;
                if (item?.id && !item.code)
                    item.code = 'IMG-' + p.academic_year + '-' + p.semester + '-' + id + '-' + slot.toUpperCase() + '-' + String(item.sha || 'EXISTING').slice(0, 8).toUpperCase();
            }
            // Commit to Supabase first. The database trigger enqueues displaced image IDs atomically.
            await result(db.from('club_reports').upsert({ period_id: p.id, club_id: id, teacher: String(f.teacher || ''), act_data: f.actData || {}, media, updated_at: new Date().toISOString() }, { onConflict: 'period_id,club_id' }));
            let cleanupPending = 0;
            let cleanupErrors = [];
            try {
                const cleanup = await cleanupOldDriveMedia(p.id, id);
                cleanupErrors = cleanup.cleanupErrors;
                cleanupPending = cleanup.cleanupPending;
            }
            catch (err) {
                cleanupPending = 1;
                cleanupErrors.push(String(err?.message || err));
            }
            output = { success: true, message: cleanupPending ? 'บันทึกรายงานสำเร็จ แต่มีภาพเก่าที่รอการย้ายลงถังขยะ Drive' : 'บันทึกรายงานและจัดการรูปเก่าเรียบร้อย', cleanupPending, cleanupErrors };
            break;
        }
        case 'cleanupOldMedia': {
            mustAdmin(u);
            const club = String(args[0]);
            assert(club === 'ADMIN-REPORT', 'ใช้สำหรับลายเซ็นผู้ดูแลเท่านั้น');
            output = { success: true, ...await cleanupOldDriveMedia(p.id, club) };
            break;
        }
        case 'getSavedClubReport': {
            const id = String(args[0]), c = await clubById(p.id, id);
            await sknRequireReadClub(u, p, c);
            const r = await result(db.from('club_reports').select('*').eq('period_id', p.id).eq('club_id', id).maybeSingle());
            if (!r) {
                output = { found: false, data: null };
                break;
            }
            // V4.2: never block opening the report on large Drive images. The frontend
            // progressively loads the private originals after rendering text and grades.
            const references = sknImageSlots(r);
            const directUrls = Object.fromEntries(SKN_IMAGE_SLOTS.map(slot => [slot, sknDirectImageUrl((r.media || {})[slot]?.lh5Url)]));
            output = { found: true, data: { teacher: r.teacher, actData: r.act_data,
                    logo: directUrls.logo || '',
                    photos: { 1: directUrls.photo_1 || '', 2: directUrls.photo_2 || '', 3: directUrls.photo_3 || '', 4: directUrls.photo_4 || '' },
                    signatures: Object.fromEntries(['sigTeacher', 'sigHeadClub', 'sigHeadDev', 'sigDeputy', 'sigDirector'].map(k => [k, directUrls[k] || ''])),
                    mediaRefs: references, mediaErrors: [], mediaUrls: directUrls,
                    previewUrls: {}, deferredMedia: true } };
            break;
        }
        case 'sendClubReportEmail': {
            mustWrite(u, p);
            const f = args[1] || {};
            const club = await clubById(p.id, String(f.clubId || args[2] || ''));
            await sknRequireOwnClub(u, p, club);
            const periodConfig = await cfg(p.id);
            assert(u.role === 'admin' || periodConfig.allow_report_email !== 'false', 'ปิดการส่งเมลสำหรับครู');
            const settings = JSON.parse(periodConfig.adminSettings || '{}');
            const email = String(settings.reportEmail || '').trim();
            assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'กรุณาตั้งค่าอีเมลรับรายงานในหน้าตั้งค่าระบบขั้นสูงก่อน');
            assert(typeof f.pdfFile === 'string' && f.pdfFile.startsWith('data:application/pdf;base64,') && f.pdfFile.length < 12_000_000, 'ระบบสร้าง PDF ไม่สำเร็จ หรือไฟล์เกิน 9 MB');
            const a = await gas('sendReportEmail', { periodId: p.id, clubId: club.id, email, data: { ...f, clubName: club.name, semester: p.semester, academicYear: p.academic_year }, period: `${p.semester}-${p.academic_year}` });
            output = { success: a.success === true, sentTo: a.sentTo || email, pdfBytes: a.pdfBytes || 0 };
            break;
        }
        case 'importLegacyChunk': {
            mustAdmin(u);
            const kind = String(args[0]);
            const items = args[1];
            assert(Array.isArray(items) && items.length <= 150, 'นำเข้าครั้งละไม่เกิน 150 รายการ');
            if (kind === 'Teachers' || kind === 'Students') {
                const r = items.map(x => kind === 'Teachers' ? { id: String(x.id || ''), name: String(x.name || ''), username: String(x.username || x.id || ''), password: String(x.password || '').replace(/^'/, ''), role: String(x.role || 'teacher') }
                    : { id: String(x.id || ''), name: String(x.name || ''), level: String(x.level || ''), room: String(x.room || ''), no: String(x.no || ''), password: String(x.password || '').replace(/^'/, '') });
                await result(db.rpc('skn_upsert_users', { p_period: p.id, p_role: kind === 'Teachers' ? 'teacher' : 'student', p_rows: r }));
            }
            else if (kind === 'Clubs') {
                for (const x of items) {
                    if (!x.id)
                        continue;
                    const owners = String(x.owner_id || '').split(',').map(t => t.trim()).filter(Boolean);
                    await result(db.rpc('skn_save_club', { p_period: p.id, p_id: String(x.id), p_name: String(x.name || '').trim(), p_cap: Number(x.max_capacity) || 0, p_level: String(x.level || 'ทั้งหมด'), p_owners: owners, p_location: String(x.location || ''), p_comment: String(x.comment || '') }));
                }
            }
            else if (kind === 'Registration') {
                const data = items.filter(x => x.student_id && x.club_id).map(x => ({ period_id: p.id, reg_id: String(x.reg_id || 'AUTO'), student_id: String(x.student_id), club_id: String(x.club_id) }));
                for (let i = 0; i < data.length; i += 50)
                    await result(db.rpc('skn_import_registration', { p_period: p.id, p_rows: data.slice(i, i + 50) }));
            }
            else if (kind === 'Attendance_Data') {
                for (const x of items) {
                    if (!x.club_id)
                        continue;
                    let g;
                    try {
                        g = typeof x.data_json === 'string' ? JSON.parse(x.data_json) : x.data_json;
                    }
                    catch {
                        g = {};
                    }
                    const dates = Array.isArray(g?.dates) ? g.dates.slice(0, 20) : [];
                    while (dates.length < 20)
                        dates.push('');
                    const records = {};
                    const allowedIds = new Set((await result(db.from('registrations').select('student_id').eq('period_id', p.id).eq('club_id', String(x.club_id)))).map(r => r.student_id));
                    for (const [id, arr] of Object.entries(g?.records || {})) {
                        if (!Array.isArray(arr) || !allowedIds.has(id))
                            continue;
                        const v = arr.slice(0, 20).map(x => x === 'P' ? 1 : x === 'L' ? 2 : x === 'A' ? 3 : Number(x) || 0);
                        while (v.length < 20)
                            v.push(0);
                        records[id] = v;
                    }
                    await result(db.rpc('skn_import_attendance', { p_period: p.id, p_club: String(x.club_id), p_grid: validateGrid({ dates, records }) }));
                }
            }
            else if (kind === 'Club_Reports') {
                for (const x of items) {
                    if (!x.club_id)
                        continue;
                    let r = {};
                    try {
                        r = typeof x.report_json === 'string' ? JSON.parse(x.report_json) : x.report_json || {};
                    }
                    catch { }
                    const c = await clubById(p.id, String(x.club_id));
                    const media = {};
                    const photos = { 1: x.photo_1 || '', 2: x.photo_2 || '', 3: x.photo_3 || '', 4: x.photo_4 || '' };
                    media.logo = await mediaSave(x.logo, null, p.id, c.id, 'logo');
                    for (let i = 1; i <= 4; i++)
                        media[`photo_${i}`] = await mediaSave(photos[i], null, p.id, c.id, `photo_${i}`);
                    await result(db.from('club_reports').upsert({ period_id: p.id, club_id: c.id, teacher: r.teacher || '', act_data: r.actData || {}, media }, { onConflict: 'period_id,club_id' }));
                }
            }
            else if (kind === 'Config') {
                const rows = items.filter(x => x.key).map(x => ({ period_id: p.id, key: String(x.key), value: String(x.value ?? '') }));
                if (rows.length)
                    await result(db.from('period_config').upsert(rows, { onConflict: 'period_id,key' }));
            }
            else
                throw Error('Invalid legacy table');
            output = { success: true, count: items.length, kind };
            break;
        }
        case 'getPeriodImpact': {
            mustAdmin(u);
            try {
                output = await result(db.rpc('skn_period_impact', { p_period: String(args[0] || '') }));
            }
            catch (err) {
                const code = String(err?.code || '');
                const msg = String(err?.message || err);
                if (code === 'PGRST202' || code === '42883' || /Could not find the function.*skn_period_impact|function public.skn_period_impact.*does not exist/i.test(msg)) {
                    throw Object.assign(new Error('ไม่พบฟังก์ชัน skn_period_impact ใน Supabase: กรุณารัน SQL Migration 013 ของ V4.5 ให้สำเร็จ และรีโหลด PostgREST schema cache'), { code, hint: "ใน SQL Editor รัน: NOTIFY pgrst, 'reload schema';" });
                }
                if (code === '42501' || /permission denied|เฉพาะผู้ดูแลระบบ/i.test(msg)) {
                    throw Object.assign(new Error('ฐานข้อมูลไม่อนุญาตให้ตรวจรายการ กรุณาตรวจบัญชี Admin และสิทธิ์ EXECUTE ของ skn_period_impact'), { code, hint: 'เข้าสู่ระบบด้วยบัญชี admin ที่ถูกต้อง และตรวจการ GRANT EXECUTE ตาม SQL Migration 013' });
                }
                throw err;
            }
            break;
        }
        case 'setCurrentPeriod': {
            mustAdmin(u);
            output = await result(db.rpc('skn_set_current_period', { p_period: String(args[0] || '') }));
            break;
        }
        case 'deletePeriodWithBackup': {
            mustAdmin(u);
            const targetId = String(args[0] || '');
            const expectedCode = String(args[1] || '');
            const replacementId = args[2] ? String(args[2]) : null;
            assert(targetId && expectedCode, 'ต้องระบุปี/เทอมและรหัสยืนยันการลบ');
            const targetInfo = await getPeriod(targetId);
            assert(targetInfo.period.period_code === expectedCode, 'รหัสเทอมไม่ตรงกัน');
            // Fail closed: deletion will not proceed without a successful Drive backup.
            const snap = await snapshot(targetId);
            const backup = await gas('saveBackup', {
                periodId: targetId, clubId: 'ADMIN-REPORT',
                fileName: `SKN_Backup_Before_Delete_${expectedCode}.json`,
                content: JSON.stringify(snap)
            });
            await verifyBackupFile(JSON.stringify(snap), backup);
            await result(db.from('backup_logs').insert({
                period_id: targetId, period_code: expectedCode,
                file_id: backup.id, name: backup.name
            }));
            output = await result(db.rpc('skn_delete_period_v45', {
                p_period: targetId, p_expected_code: expectedCode,
                p_replacement: replacementId, p_backup_file: backup.id
            }));
            output.backupFileId = backup.id;
            break;
        }
        case 'deleteAcademicYearWithBackup': {
            mustAdmin(u);
            const year = Number(args[0]);
            const replacement = args[1] ? String(args[1]) : null;
            assert(year >= 2500 && year <= 2800, 'ปีการศึกษาไม่ถูกต้อง');
            const periodsForYear = (await getPeriod()).periods.filter(x => x.academic_year === year);
            assert(periodsForYear.length > 0, 'ไม่พบปีการศึกษานี้');
            const backupFiles = [];
            for (const term of periodsForYear) {
                const snap = await snapshot(term.id);
                const saved = await gas('saveBackup', {
                    periodId: term.id, clubId: 'ADMIN-REPORT',
                    fileName: `SKN_Before_Delete_${term.period_code}.json`,
                    content: JSON.stringify(snap)
                });
                await verifyBackupFile(JSON.stringify(snap), saved);
                await result(db.from('backup_logs').insert({
                    period_id: term.id, period_code: term.period_code,
                    file_id: saved.id, name: saved.name
                }));
                backupFiles.push({ periodId: term.id, fileId: saved.id });
            }
            output = await result(db.rpc('skn_delete_academic_year_v45', {
                p_year: year, p_replacement: replacement, p_backup_files: backupFiles
            }));
            break;
        }
        case 'readBackupFromDrive': {
            mustAdmin(u);
            output = await gas('readBackup', {
                periodId: p.id, clubId: 'ADMIN-REPORT', fileId: String(args[0] || '')
            });
            break;
        }
        case 'restoreBackupSnapshot': {
            mustAdmin(u);
            const snap = args[0];
            const year = Number(args[1]);
            const semester = Number(args[2]);
            const makeCurrent = args[3] === true;
            assert(snap?.format === 'SKN-SUPABASE-V1' && snap.tables && snap.period, 'รองรับเฉพาะไฟล์สำรอง SKN-SUPABASE-V1');
            assert(new TextEncoder().encode(JSON.stringify(snap)).length <= 7_500_000, 'ไฟล์ JSON เกิน 7.5 MB สำหรับหน้าเว็บ');
            if (String(args[4] || 'local') === 'local') {
                // Archive uploaded JSON in Drive before invoking the restore transaction.
                const uploaded = await gas('saveImportedBackup', {
                    periodId: p.id, clubId: 'ADMIN-REPORT', content: JSON.stringify(snap)
                });
                assert(uploaded?.success && uploaded.id, 'เก็บไฟล์ JSON ต้นฉบับใน Drive ไม่สำเร็จ');
                await result(db.from('backup_logs').insert({
                    period_id: p.id,
                    period_code: String(snap.period?.period_code || `${snap.period?.academic_year}-${snap.period?.semester}`),
                    file_id: uploaded.id, name: uploaded.name
                }));
            }
            const overwrite = args[6] === true;
            const vault = snap.credential_vault;
            let vaultKey = String(args[5] || '');
            if (vault?.keyMode === 'GAS-SCRIPT-PROPERTIES-V1') {
                const response = await gas('getBackupKey', { periodId: p.id, clubId: 'ADMIN-REPORT' });
                assert(response?.success && response?.key, 'GAS ไม่มีกุญแจถอดรหัสไฟล์สำรองนี้');
                vaultKey = String(response.key);
            }
            const credentials = vault ? await sknDecryptCredentials(vault, vaultKey) : null;
            // The vault is never included in the RPC payload; only decrypted credentials,
            // transmitted over authenticated HTTPS, are used to create MISSING accounts.
            const cleanSnapshot = { ...snap };
            delete cleanSnapshot.credential_vault;
            if (overwrite) {
                const target = (await getPeriod()).periods.find(x => x.academic_year === year && x.semester === semester);
                assert(target, 'ไม่พบเทอมปลายทางที่จะกู้ทับ');
                // Hard requirement: archive CURRENT data to Google Drive BEFORE replacing any rows.
                const original = await snapshot(target.id);
                // Also protect credentials in the automatic pre-overwrite safety backup.
                const keyResponse = await gas('getBackupKey', { periodId: target.id, clubId: 'ADMIN-REPORT' });
                assert(keyResponse?.success && String(keyResponse.key || '').length >= 60, 'ไม่พบกุญแจสำรองใน GAS');
                const archiveCred = await result(db.rpc('skn_backup_credentials_v48', { p_period: target.id }));
                assert(archiveCred?.students?.length === original.tables.students.length, 'Backup ก่อนกู้ทับ: ข้อมูลบัญชีนักเรียนไม่ครบ');
                const memberIds = new Set(original.tables.period_teachers.map((r) => r.teacher_id));
                assert(archiveCred.teachers?.length === memberIds.size && archiveCred.teachers.every((r) => memberIds.has(r.id)), 'Backup ก่อนกู้ทับ: ข้อมูลบัญชีครูไม่ครบ');
                original.credential_vault = await sknEncryptCredentials(archiveCred, String(keyResponse.key));
                original.credential_vault.keyMode = 'GAS-SCRIPT-PROPERTIES-V1';
                original.backup_manifest.version = 'V4.9';
                original.backup_manifest.credentials = 'AES-256-GCM (GAS installation key)';
                const content = JSON.stringify(original);
                const safe = await gas('saveBackup', { periodId: target.id, clubId: 'ADMIN-REPORT', fileName: 'Before_Restore_Overwrite.json', content });
                await verifyBackupFile(content, safe);
                await result(db.from('backup_logs').insert({ period_id: target.id, period_code: target.period_code, file_id: safe.id, name: safe.name }));
                output = await result(db.rpc('skn_restore_overwrite_v49', {
                    p_snapshot: cleanSnapshot, p_target: target.id, p_backup_file: safe.id,
                    p_make_current: makeCurrent, p_credentials: credentials || {}
                }));
                output.backupFileId = safe.id;
            }
            else if (credentials) {
                output = await result(db.rpc('skn_restore_snapshot_with_credentials_v48', {
                    p_snapshot: cleanSnapshot, p_year: year, p_sem: semester,
                    p_make_current: makeCurrent, p_credentials: credentials
                }));
            }
            else {
                output = await result(db.rpc('skn_restore_snapshot_v45', {
                    p_snapshot: cleanSnapshot, p_year: year, p_sem: semester, p_make_current: makeCurrent
                }));
            }
            break;
        }
        case 'createFullBackupNow': {
            mustAdmin(u);
            const keyResponse = await gas('getBackupKey', { periodId: p.id, clubId: 'ADMIN-REPORT' });
            const passphrase = String(keyResponse?.key || '');
            assert(keyResponse?.success && passphrase.length >= 60, 'ไม่สามารถอ่านกุญแจ Backup จาก GAS');
            const data = await snapshot(p.id);
            assert(data.tables.teachers.every((t) => !Object.prototype.hasOwnProperty.call(t, 'password')) &&
                data.tables.students.every((t) => !Object.prototype.hasOwnProperty.call(t, 'password')), 'ข้อมูลจาก Public View ไม่ปลอดภัย: พบคอลัมน์ password ในไฟล์ JSON ก่อนเข้ารหัส');
            const credentials = await result(db.rpc('skn_backup_credentials_v48', { p_period: p.id }));
            // Confirm the password payload has a matching student population and required teacher entries.
            assert(credentials?.students?.length === data.tables.students.length, 'จำนวนรหัสผ่านนักเรียนไม่ครบ ระบบยกเลิก Backup');
            const teacherIds = new Set(data.tables.period_teachers.map((x) => x.teacher_id));
            assert(credentials.teachers.every((t) => teacherIds.has(t.id)) &&
                credentials.teachers.length === teacherIds.size, 'จำนวนรหัสผ่านครูไม่ครบ ระบบยกเลิก Backup');
            assert(credentials.students.every((s) => typeof s.password === 'string' && s.password.length > 0) &&
                credentials.teachers.every((t) => typeof t.password === 'string' && t.password.length > 0), 'มีบัญชีที่ยังไม่ได้ตั้งรหัสผ่าน ระบบไม่สร้างไฟล์สำรองที่ไม่ครบ');
            data.credential_vault = await sknEncryptCredentials(credentials, passphrase);
            data.credential_vault.keyMode = 'GAS-SCRIPT-PROPERTIES-V1';
            data.backup_manifest.version = 'V4.8';
            data.backup_manifest.credentials = 'AES-256-GCM encrypted with installation key held in GAS Script Properties';
            data.backup_manifest.note = 'ไฟล์ JSON มีรหัสผ่านครูและนักเรียนที่เข้ารหัสไว้ใน credential_vault; ไฟล์ภาพต้นฉบับเก็บใน Drive แยกต่างหาก';
            const content = JSON.stringify(data);
            assert(new TextEncoder().encode(content).length <= 7_500_000, 'ไฟล์ JSON เกิน 7.5 MB โปรดใช้สำรองข้อมูลผ่าน Supabase Database Backup แทน');
            const name = `SKN_Full_Backup_${p.academic_year}_${p.semester}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            const saved = await gas('saveBackup', { periodId: p.id, clubId: 'ADMIN-REPORT', fileName: name, content });
            await verifyBackupFile(content, saved);
            await result(db.from('backup_logs').insert({ period_id: p.id,
                period_code: p.period_code || `${p.academic_year}-${p.semester}`,
                file_id: saved.id, name: saved.name }));
            output = { success: true, fileId: saved.id, url: saved.url, name: saved.name,
                periodCode: p.period_code || `${p.academic_year}-${p.semester}`,
                counts: data.backup_manifest.counts, sha256: saved.sha256,
                imagesIncluded: false, credentialsEncrypted: true, teacherPasswords: data.credential_vault.counts.teachers, studentPasswords: data.credential_vault.counts.students };
            break;
        }
        case 'getSignatureLibrary': {
            mustAdmin(u);
            let rows;
            try {
                rows = await result(db.from('skn_signature_library').select('*').eq('is_archived', false));
            }
            catch (e) {
                if (/PGRST205|42P01|schema cache|could not find the table/i.test(String(e?.code || '') + ' ' + String(e?.message || e)))
                    throw Error("ยังไม่พบคลังลายเซ็นใน Supabase: ให้รัน Migration 017 แล้ว NOTIFY pgrst, 'reload schema';");
                throw e;
            }
            output = rows;
            break;
        }
        case 'upsertSignatureLibrary': {
            mustAdmin(u);
            const x = args[0] || {};
            assert(['sigHeadClub', 'sigHeadDev', 'sigDeputy', 'sigDirector'].includes(String(x.slot || '')), 'ช่องลายเซ็นไม่ถูกต้อง');
            output = await result(db.rpc('skn_upsert_signature_library', {
                p_slot: String(x.slot), p_name: String(x.signerName || ''),
                p_file_id: String(x.fileId || ''), p_file_url: String(x.fileUrl || '')
            }));
            break;
        }
        case 'setSignatureLibraryApproval': {
            mustAdmin(u);
            const slot = String(args[0] || ''), enabled = args[1] === true, note = String(args[2] || '');
            assert(['sigHeadClub', 'sigHeadDev', 'sigDeputy', 'sigDirector'].includes(slot), 'ช่องลายเซ็นไม่ถูกต้อง');
            output = await result(db.rpc('skn_set_signature_library_approval', {
                p_slot: slot, p_enabled: enabled, p_consent_note: note
            }));
            break;
        }
        case 'archiveSignatureLibrary': {
            mustAdmin(u);
            output = await result(db.rpc('skn_archive_signature_library', { p_slot: String(args[0] || '') }));
            break;
        }
        case 'recordBulkSignatureExport': {
            mustAdmin(u);
            const manifest = args[0] || {}, exportId = String(args[1] || '');
            assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'รายการลายเซ็นไม่ถูกต้อง');
            assert(/^BULK-[A-Za-z0-9_-]{8,70}$/.test(exportId), 'รหัสชุดดาวน์โหลดไม่ถูกต้อง');
            output = await result(db.rpc('skn_record_signature_bulk_export', {
                p_period: p.id, p_export_id: exportId, p_manifest: manifest
            }));
            break;
        }
        case 'recordSignatureLibraryUse': {
            mustAdmin(u);
            const clubId = String(args[0] || ''), sources = args[1] || {};
            assert(sources && typeof sources === 'object' && !Array.isArray(sources), 'ข้อมูลลายเซ็นไม่ถูกต้อง');
            await clubById(p.id, clubId);
            output = await result(db.rpc('skn_record_signature_library_use', {
                p_period: p.id, p_club: clubId, p_sources: sources
            }));
            break;
        }
        case 'startNewSemester': {
            mustAdmin(u);
            assert(p.is_current, 'กรุณาเลือกภาคเรียนปัจจุบันก่อนขึ้นเทอมใหม่');
            const o = args[0] || {};
            // Mandatory backup: never proceed if Drive backup fails. Historical data is never erased.
            const data = await snapshot(p.id);
            const backupContent = JSON.stringify(data);
            const backup = await gas('saveBackup', { periodId: p.id, fileName: `SKN_Backup_Term${p.semester}_${p.academic_year}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`, content: backupContent });
            await verifyBackupFile(backupContent, backup);
            await result(db.from('backup_logs').insert({ period_id: p.id, period_code: p.period_code || `${p.academic_year}-${p.semester}`, file_id: backup.id, name: backup.name }));
            const opts = { p_source: p.id, p_year: Number(o.newYear), p_sem: Number(o.newSemester), p_teachers: o.copyTeachers === true, p_students: o.copyStudents === true, p_clubs: o.copyClubs === true, p_regs: o.copyRegistrations === true, p_att: o.copyAttendance === true, p_reports: o.copyReports === true };
            const newId = await result(db.rpc('skn_create_period', opts));
            output = { success: true, message: 'สร้างภาคเรียนใหม่เรียบร้อยแล้ว (เก็บข้อมูลเดิมไว้)', newPeriodId: newId, backupFileId: backup.id };
            break;
        }
        case 'previewSafeTrash': {
            mustAdmin(u);
            output = await result(db.rpc('skn_trash_preview_v49'));
            break;
        }
        case 'purgeSafeTrash': {
            mustAdmin(u);
            output = await result(db.rpc('skn_trash_purge_v49', { p_limit: 300 }));
            break;
        }
        case 'getBackupFilesList': {
            mustAdmin(u);
            const rows = await all('backup_logs');
            output = { success: true, data: rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(x => ({ fileId: x.file_id, periodCode: x.period_code || '', name: x.name, url: `https://drive.google.com/file/d/${encodeURIComponent(x.file_id)}/view`, date: new Date(x.created_at).getTime(), dateText: new Date(x.created_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) })) };
            break;
        }
        case 'getWebAppUrl': {
            output = location.href;
            break;
        }
        default: throw Error(`ไม่รองรับคำสั่ง ${method}`);
    }
    return output;
}
window.SKNBackend = { version: 'R3.9', invoke: sknInvoke, db, getApplicantTotals: sknApplicantCounts, countErrorText: sknCountFailureText };