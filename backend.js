/* SKN direct browser backend: every database call uses the user's Supabase Auth JWT.
   SQL RLS and SECURITY DEFINER RPCs enforce security; never put a service key here. */
const db = window.SKN_DB;
const encoder = new TextEncoder();
function hex(bytes) { return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join(''); }
function assert(cond, msg = 'ไม่มีสิทธิ์ดำเนินการ') { if (!cond)
    throw Error(msg); }
async function result(q) { const r = await q; if (r.error)
    throw Error(r.error.message); return r.data; }
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
function owner(u, club) { return u.role === 'admin' || (u.role === 'teacher' && club.owner_ids?.includes(u.id)); }
function visibleClub(u, club) { return u.role === 'admin' || owner(u, club) || Boolean(u.archiveRead && u.type === 'teacher'); }
async function clubById(p, id) { const c = await result(db.from('clubs').select('*').eq('period_id', p).eq('id', id).maybeSingle()); assert(c, 'ไม่พบชุมนุม'); return c; }
const twenty = () => Array(20).fill(0);
function validateGrid(g) { assert(g && Array.isArray(g.dates) && g.dates.length === 20, 'วันที่เช็กชื่อต้องมี 20 ครั้ง'); assert(g.records && typeof g.records === 'object', 'ข้อมูลเช็กชื่อผิดรูปแบบ'); const obj = { dates: g.dates.map((x) => typeof x === 'string' ? x.slice(0, 10) : ''), records: {} }; for (const [sid, arr] of Object.entries(g.records)) {
    assert(Array.isArray(arr) && arr.length === 20, 'รายการเช็กชื่อต้องมี 20 ครั้ง');
    obj.records[sid] = arr.map(v => { const n = Number(v); assert(Number.isInteger(n) && n >= 0 && n <= 3, 'สถานะเช็กชื่อไม่ถูกต้อง'); return n; });
} return obj; }
function renderClub(c, regs, teachers) { return { id: c.id, name: c.name, max_capacity: c.max_capacity, current_count: regs.filter(r => r.club_id === c.id).length, level: c.level, owner_id: c.owner_ids.join(','), teacher_name: c.owner_ids.map((id) => teachers.find(t => t.id === id)?.name || '').filter(Boolean).join(', '), location: c.location, comment: c.comment }; }
function studentView(s, regs) { return { ...s, password: '', club_id: regs.find(r => r.student_id === s.id)?.club_id || '' }; }
async function gas(action, payload) { return window.SKNFile.invoke(action, payload); }
async function sum(p) { const [ss, tt, cc, rr] = await Promise.all([all('students', p), all('period_teachers', p), all('clubs', p), all('registrations', p)]); const owners = new Set(cc.flatMap(c => c.owner_ids)); return { student: { total: ss.length, registered: rr.length, unregistered: ss.length - rr.length }, teacher: { total: tt.length, hasClub: tt.filter(t => owners.has(t.teacher_id)).length, noClub: tt.filter(t => !owners.has(t.teacher_id)).length }, clubsCount: cc.length }; }
async function snapshot(periodId) { const data = { format: 'SKN-SUPABASE-V1', created_at: new Date().toISOString(), period: (await getPeriod(periodId)).period, tables: {} }; for (const name of ['teachers', 'period_teachers', 'students', 'clubs', 'registrations', 'attendance', 'club_reports', 'period_config']) {
    const records = name === 'teachers' ? await all(name) : await all(name, periodId);
    data.tables[name] = records;
} return data; }
async function mediaSave(input, existing, p, c, slot) {
    if (!input)
        return null;
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
    assert(match[2].length < 2_500_000, 'ภาพมีขนาดใหญ่เกินไป');
    const sha = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(match[2]))));
    if (existing?.[slot]?.sha === sha)
        return existing[slot];
    const r = await gas('saveFile', { periodId: p, clubId: c, slot, fileName: `${slot}-${sha.slice(0, 12)}.${match[1].split('/')[1]}`, mime: match[1], base64: match[2] });
    return { id: r.id, sha, mime: match[1] };
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
async function checkLogin(username, password) {
    const v = await result(db.rpc('skn_prepare_login', { p_username: String(username || ''), p_password: String(password || '') }));
    if (!v?.success)
        return { success: false, message: v?.message || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
    // Supabase Auth enforces a minimum password length; legacy 4-digit passwords still work
    // through the original bcrypt check, while Auth receives an irreversible lengthened string.
    const derived = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('skn-v2|' + v.email + '|' + password))));
    let auth = await db.auth.signInWithPassword({ email: v.email, password: derived });
    if (auth.error) {
        const created = await db.auth.signUp({ email: v.email, password: derived });
        if (created.error || !created.data?.session)
            throw Error('Supabase Auth เข้าสู่ระบบไม่สำเร็จ: กรุณาปิด Confirm Email และตรวจสอบการสมัครบัญชีครั้งแรก');
        auth = created;
    }
    const { period: current } = await getPeriod();
    const actorId = await result(db.rpc('skn_actor_id'));
    const actorRole = await result(db.rpc('skn_actor_role'));
    if (!actorId || !actorRole)
        throw Error('ไม่พบสิทธิ์ของบัญชี Supabase Auth โปรดตรวจสอบ Trigger');
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
    return { success: true, user: { id: u.id, name: u.name, role: u.role, level: u.level || '', clubId: reg?.club_id || '', hasClub: memberships.some((c) => c.owner_ids.includes(actorId)) } };
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
        case 'getPeriods':
            output = { periods, periodId: p.id, isReadonly: !canEdit(u, p) };
            break;
        case 'getAppData': {
            const [clubs, regs, config, teachers] = await Promise.all([all('clubs', p.id), all('registrations', p.id), cfg(p.id), all('teachers')]);
            try {
                const a = JSON.parse(config.adminSettings || '{}');
                config.adminSettings = JSON.stringify({ ...a, semester: String(p.semester), academicYear: String(p.academic_year) });
            }
            catch { }
            const memberships = await all('period_teachers', p.id);
            const selected = memberships.map(m => ({ id: m.teacher_id, name: m.display_name || teachers.find(t => t.id === m.teacher_id)?.name || '' }));
            output = { clubs: clubs.map(c => renderClub(c, regs, selected)), config, teachers: selected, summary: isAdmin ? await sum(p.id) : null,
                serverTime: Date.now(), periods: periods.map(x => ({ id: x.id, academicYear: x.academic_year, semester: x.semester, isCurrent: x.is_current })),
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
            assert(visibleClub(u, club));
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
            assert(owner(u, c));
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
            const [ss, rr, cc] = await Promise.all([all('students', p.id), all('registrations', p.id), all('clubs', p.id)]);
            output = ss.filter(s => {
                const level = String(args[0]), room = String(args[1]).trim();
                const target = String(s.room || '').trim();
                const roomMatch = target === room || (s.level + '.' + target) === room ||
                    (s.level + '/' + target) === room || target.replace(/^ม\.[1-6]\/?/, '') === room.replace(/^ม\.[1-6]\/?/, '');
                const levelMatch = s.level === level || (level === 'ม.ต้น' && /^ม\.[123]/.test(s.level)) ||
                    (level === 'ม.ปลาย' && /^ม\.[456]/.test(s.level));
                return roomMatch && levelMatch;
            }).sort((a, b) => Number(a.no) - Number(b.no)).map(s => ({ id: s.id, name: s.name, no: s.no, club_name: cc.find(c => c.id === rr.find(r => r.student_id === s.id)?.club_id)?.name || 'ยังไม่ได้สมัครชุมนุม' }));
            break;
        }
        case 'getUsersByRole': {
            assert(u.role !== 'student');
            const type = String(args[0]);
            assert(type === 'teacher' || type === 'student');
            if (type === 'teacher') {
                const [tt, mm] = await Promise.all([all('teachers'), all('period_teachers', p.id)]);
                output = tt.filter(t => mm.some(x => x.teacher_id === t.id)).map(t => ({ id: t.id, name: mm.find(x => x.teacher_id === t.id)?.display_name || t.name, username: t.username, password: '', role: t.role })).sort((a, b) => (a.role === 'admin' ? -1 : 0) - (b.role === 'admin' ? -1 : 0) || a.id.localeCompare(b.id, 'th', { numeric: true }));
            }
            else {
                const [ss, rr] = await Promise.all([all('students', p.id), all('registrations', p.id)]);
                output = ss.map(s => studentView(s, rr)).sort((a, b) => a.level.localeCompare(b.level, 'th', { numeric: true }) || a.room.localeCompare(b.room, 'th', { numeric: true }) || Number(a.no) - Number(b.no));
            }
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
            const lines = csvParse(raw);
            const ids = new Set();
            let duplicates = 0;
            const data = [];
            for (let i = 0; i < lines.length; i++) {
                const r = lines[i].map(v => v.trim());
                if (!r[0] || r[0].toLowerCase() === 'id' || r[0].toLowerCase().includes('id') && i === 0)
                    continue;
                if (ids.has(r[0])) {
                    duplicates++;
                    continue;
                }
                ids.add(r[0]);
                data.push(type === 'teacher' ? { id: r[0], name: r[1] || '', username: r[2] || r[0], password: r[3] || '', role: r[4] || 'teacher' } : { id: r[0], name: r[1] || '', level: r[2] || '', room: r[3] || '', no: r[4] || '', password: r[5] || '' });
            }
            const existing = type === 'teacher' ? await all('teachers') : await all('students', p.id);
            const eMap = new Map(existing.map(x => [x.id, x]));
            const addedNames = data.filter(x => !eMap.has(x.id)).map(({ password, ...rest }) => rest), updatedNames = data.filter(x => eMap.has(x.id) && Object.entries(x).some(([k, v]) => k !== 'password' && eMap.get(x.id)[k] !== v)).map(({ password, ...rest }) => rest);
            for (let i = 0; i < data.length; i += 150)
                await result(db.rpc('skn_upsert_users', { p_period: p.id, p_role: type, p_rows: data.slice(i, i + 150) }));
            output = { addedCount: addedNames.length, updatedCount: updatedNames.length, addedNames, updatedNames, duplicateInCsvCount: duplicates };
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
                    if (c.owner_ids.includes(id)) {
                        if (c.owner_ids.length === 1)
                            await result(db.rpc('skn_delete_club', { p_period: p.id, p_club: c.id }));
                        else
                            await result(db.from('clubs').update({ owner_ids: c.owner_ids.filter((x) => x !== id) }).eq('period_id', p.id).eq('id', c.id));
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
                assert(owner(u, prev));
            const owners = [...new Set((f.owner_ids || []).map((x) => String(x).trim()).filter(Boolean))];
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
            if (method === 'saveAdvancedSystemSettings' && values.adminSettings) {
                const a = { ...values.adminSettings, semester: String(p.semester), academicYear: String(p.academic_year) };
                const idx = rows.findIndex(x => x.key === 'adminSettings');
                if (idx >= 0)
                    rows[idx].value = JSON.stringify(a);
            }
            if (rows.length)
                await result(db.from('period_config').upsert(rows, { onConflict: 'period_id,key' }));
            output = { success: true, message: 'บันทึกการตั้งค่าระบบเรียบร้อย' };
            break;
        }
        case 'saveClubReportData': {
            mustWrite(u, p);
            const id = String(args[0]), c = await clubById(p.id, id);
            assert(owner(u, c));
            const f = args[1] || {};
            const prior = await result(db.from('club_reports').select('media').eq('period_id', p.id).eq('club_id', id).maybeSingle());
            const original = prior?.media || {};
            const media = {};
            media.logo = await mediaSave(f.logo, original, p.id, id, 'logo');
            for (let i = 1; i <= 4; i++)
                media[`photo_${i}`] = await mediaSave(f.photos?.[i], original, p.id, id, `photo_${i}`);
            for (const key of ['sigTeacher', 'sigHeadClub', 'sigHeadDev', 'sigDeputy', 'sigDirector'])
                media[key] = await mediaSave(f.signatures?.[key], original, p.id, id, key);
            await result(db.from('club_reports').upsert({ period_id: p.id, club_id: id, teacher: String(f.teacher || ''), act_data: f.actData || {}, media, updated_at: new Date().toISOString() }, { onConflict: 'period_id,club_id' }));
            output = { success: true, message: 'บันทึกข้อมูลรายงานเรียบร้อยแล้ว' };
            break;
        }
        case 'getSavedClubReport': {
            const id = String(args[0]), c = await clubById(p.id, id);
            assert(visibleClub(u, c));
            const r = await result(db.from('club_reports').select('*').eq('period_id', p.id).eq('club_id', id).maybeSingle());
            if (!r) {
                output = { found: false, data: null };
                break;
            }
            const ids = Object.entries(r.media || {}).filter(([_, v]) => v?.id).map(([k, v]) => ({ slot: k, id: v.id }));
            const imgs = ids.length ? await gas('getFiles', { periodId: p.id, clubId: id, files: ids }) : { files: {} };
            output = { found: true, data: { teacher: r.teacher, actData: r.act_data, logo: imgs.files?.logo || '', photos: { 1: imgs.files?.photo_1 || '', 2: imgs.files?.photo_2 || '', 3: imgs.files?.photo_3 || '', 4: imgs.files?.photo_4 || '' }, signatures: Object.fromEntries(['sigTeacher', 'sigHeadClub', 'sigHeadDev', 'sigDeputy', 'sigDirector'].map(k => [k, imgs.files?.[k] || ''])) } };
            break;
        }
        case 'sendClubReportEmail': {
            mustWrite(u, p);
            const f = args[1] || {};
            const club = await clubById(p.id, String(f.clubId || args[2] || ''));
            assert(owner(u, club));
            const email = String(args[0] || '');
            assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'อีเมลไม่ถูกต้อง');
            assert(typeof f.pdfFile === 'string' && f.pdfFile.startsWith('data:application/pdf;base64,') && f.pdfFile.length < 12_000_000, 'กรุณาแนบ PDF ขนาดไม่เกิน 9 MB');
            const a = await gas('sendReportEmail', { periodId: p.id, clubId: club.id, email, data: { ...f, clubName: club.name, semester: p.semester, academicYear: p.academic_year }, period: `${p.semester}-${p.academic_year}` });
            output = { success: true, url: a.url || '' };
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
                const data = items.filter(x => x.student_id && x.club_id).map(x => ({ period_id: p.id, reg_id: String(x.reg_id || 'REG-' + crypto.randomUUID()), student_id: String(x.student_id), club_id: String(x.club_id) }));
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
        case 'savePdfToDrive': {
            mustWrite(u, p);
            const club = await clubById(p.id, String(args[0] || ''));
            assert(owner(u, club));
            const file = String(args[1] || '');
            const match = file.match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);
            assert(match && match[1].length < 12_000_000, 'โปรดเลือก PDF ขนาดไม่เกิน 9 MB');
            const safe = club.name.replace(/[\\/\r\n]/g, '_').slice(0, 80);
            const r = await gas('saveFile', { periodId: p.id, clubId: club.id, slot: 'pdf', fileName: `${club.id}_${safe}_${Date.now()}.pdf`, mime: 'application/pdf', base64: match[1] });
            output = { success: true, message: 'บันทึก PDF ลง Google Drive แล้ว', url: r.url };
            break;
        }
        case 'startNewSemester': {
            mustAdmin(u);
            assert(p.is_current, 'กรุณาเลือกภาคเรียนปัจจุบันก่อนขึ้นเทอมใหม่');
            const o = args[0] || {};
            // Mandatory backup: never proceed if Drive backup fails. Historical data is never erased.
            const data = await snapshot(p.id);
            const backup = await gas('saveBackup', { periodId: p.id, fileName: `SKN_Backup_Term${p.semester}_${p.academic_year}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`, content: JSON.stringify(data) });
            await result(db.from('backup_logs').insert({ period_id: p.id, file_id: backup.id, name: backup.name }));
            const opts = { p_source: p.id, p_year: Number(o.newYear), p_sem: Number(o.newSemester), p_teachers: o.copyTeachers === true, p_students: o.copyStudents === true, p_clubs: o.copyClubs === true, p_regs: o.copyRegistrations === true, p_att: o.copyAttendance === true, p_reports: o.copyReports === true };
            const newId = await result(db.rpc('skn_create_period', opts));
            output = { success: true, message: 'สร้างภาคเรียนใหม่เรียบร้อยแล้ว (เก็บข้อมูลเดิมไว้)', newPeriodId: newId, backupFileId: backup.id };
            break;
        }
        case 'getBackupFilesList': {
            mustAdmin(u);
            const rows = await all('backup_logs');
            output = { success: true, data: rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(x => ({ name: x.name, url: `https://drive.google.com/file/d/${encodeURIComponent(x.file_id)}/view`, date: new Date(x.created_at).getTime(), dateText: new Date(x.created_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) })) };
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
window.SKNBackend = { invoke: sknInvoke, db };
