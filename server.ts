import express, { NextFunction, Request, Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { thermodynamicsChapters } from './src/data/chaptersData';

const root = process.cwd();
const dataDir = join(root, 'data');
const uploadDir = join(dataDir, 'uploads');
mkdirSync(uploadDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'learning-platform.sqlite'));
db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), title TEXT NOT NULL, logo TEXT, accent_color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','student')),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY,slug TEXT UNIQUE NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'published',archived INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY,subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',position INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY,chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,slug TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),draft_content TEXT NOT NULL DEFAULT '[]',published_content TEXT,simulation_id TEXT,simulation_config TEXT NOT NULL DEFAULT '{}',position INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(chapter_id,slug));
CREATE TABLE IF NOT EXISTS bookmarks (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,PRIMARY KEY(user_id,topic_id));
CREATE TABLE IF NOT EXISTS progress (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,completed INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,topic_id));`);

type User = { id: string; email: string; display_name: string; role: 'admin' | 'student' };
const id = () => randomUUID();
const now = () => new Date().toISOString();
const encode = (x: unknown) => JSON.stringify(x);
const decode = <T,>(x: string | null, fallback: T): T => { try { return x ? JSON.parse(x) : fallback; } catch { return fallback; } };
const slug = (x: string) => x.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || `item-${Date.now()}`;
const hash = (password: string) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const matches = (password: string, saved: string) => { const [salt, expected] = saved.split(':'); const actual = scryptSync(password, salt, 64).toString('hex'); return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex')); };
const block = (text: string) => ({ id: id(), type: text.trim().startsWith('$$') ? 'equation' : 'markdown', text });

function seedInitialContent() {
  if (!db.prepare('SELECT 1 FROM settings WHERE id=1').get()) db.prepare('INSERT INTO settings VALUES (1,?,?,?)').run('Learning Library', '', '#2563eb');
  // Seed only a brand-new database. Deleted content is never recreated on later starts.
  if (!db.prepare('SELECT 1 FROM subjects LIMIT 1').get()) {
    const subjectId = id();
    db.prepare('INSERT INTO subjects VALUES (?,?,?,?,?,?,?)').run(subjectId, 'thermodynamics', 'Thermodynamics', 'Engineering thermodynamics theory, examples, and selected interactive models.', 'published', 0, 1);
    thermodynamicsChapters.forEach((chapter, chapterOrder) => {
      const chapterId = id();
      db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?)').run(chapterId, subjectId, chapter.title.replace(/^Chapter \d+:\s*/, ''), chapter.description, chapterOrder + 1);
      chapter.sections.forEach((section, topicOrder) => {
        const content = [{ id: id(), type: 'paragraph', text: section.summary }, ...section.content.map(block)];
        const simulationId = ['pv-domain', 'carnot-cycle'].includes(section.simulationId || '') ? section.simulationId : null;
        db.prepare('INSERT INTO topics VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id(), chapterId, slug(section.id), section.title.replace(/^\d+\.\d+\s*/, ''), section.summary, 'published', encode(content), encode(content), simulationId, '{}', topicOrder + 1, now());
      });
    });
  }
  const email = process.env.ADMIN_EMAIL?.toLowerCase();
  if (email && process.env.ADMIN_PASSWORD && !db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id(), email, process.env.ADMIN_NAME || 'Platform administrator', hash(process.env.ADMIN_PASSWORD), 'admin', now());
}
seedInitialContent();

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use('/uploads', express.static(uploadDir));
const cookie = (req: Request) => ((req.headers.cookie || '').split(';').map(x => x.trim().split('='))).find(x => x[0] === 'learn_session')?.[1];
const me = (req: Request): User | null => { const token = cookie(req); if (!token) return null; return (db.prepare(`SELECT u.id,u.email,u.display_name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?`).get(token, now()) as User) || null; };
const userView = (u: User) => ({ id: u.id, email: u.email, name: u.display_name, role: u.role });
const requireUser = (req: Request, res: Response, next: NextFunction) => { const user = me(req); if (!user) return res.status(401).json({ error: 'Sign in is required.' }); (req as any).user = user; next(); };
const requireAdmin = (req: Request, res: Response, next: NextFunction) => requireUser(req, res, () => (req as any).user.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator access is required.' }));
const settings = () => db.prepare('SELECT title,logo,accent_color AS accentColor FROM settings WHERE id=1').get();
const blocks = (row: any, draft = false) => decode(row[draft ? 'draft_content' : 'published_content'], [] as any[]);
const nextPosition = (table: string, column: string, value: string) => ((db.prepare(`SELECT COALESCE(MAX(position),0) AS value FROM ${table} WHERE ${column}=?`).get(value) as any).value || 0) + 1;

function catalog(admin = false) {
  const subjects = db.prepare(`SELECT * FROM subjects ${admin ? '' : "WHERE status='published' AND archived=0"} ORDER BY position,title`).all() as any[];
  return subjects.map(subject => ({ ...subject, chapters: (db.prepare('SELECT * FROM chapters WHERE subject_id=? ORDER BY position,title').all(subject.id) as any[]).map(chapter => ({ ...chapter, topics: (db.prepare(`SELECT * FROM topics WHERE chapter_id=? ${admin ? '' : "AND status='published'"} ORDER BY position,title`).all(chapter.id) as any[]).map(topic => ({ id: topic.id, slug: topic.slug, title: topic.title, summary: topic.summary, status: topic.status, simulationId: topic.simulation_id, position: topic.position, hasDraft: admin && topic.draft_content !== topic.published_content })) })) }));
}
function topic(idValue: string, admin = false) {
  const row = db.prepare('SELECT t.*,c.id AS chapter_id,c.title AS chapter_title,s.id AS subject_id,s.title AS subject_title,s.archived FROM topics t JOIN chapters c ON c.id=t.chapter_id JOIN subjects s ON s.id=c.subject_id WHERE t.id=?').get(idValue) as any;
  if (!row || (!admin && (row.status !== 'published' || row.archived))) return null;
  return { id: row.id, slug: row.slug, title: row.title, summary: row.summary, status: row.status, content: blocks(row, admin), simulationId: row.simulation_id, simulationConfig: decode(row.simulation_config, {}), chapter: { id: row.chapter_id, title: row.chapter_title }, subject: { id: row.subject_id, title: row.subject_title }, siblings: db.prepare(`SELECT id,title,slug FROM topics WHERE chapter_id=? ${admin ? '' : "AND status='published'"} ORDER BY position,title`).all(row.chapter_id) };
}

app.get('/api/settings', (_req, res) => res.json(settings()));
app.get('/api/catalog', (_req, res) => res.json(catalog()));
app.get('/api/topics/:id', (req, res) => { const data = topic(req.params.id); data ? res.json(data) : res.status(404).json({ error: 'Published topic not found.' }); });
app.get('/api/search', (req, res) => { const q = String(req.query.q || '').trim().toLowerCase(); if (!q) return res.json([]); const rows = db.prepare(`SELECT t.*,c.title AS chapterTitle,s.title AS subjectTitle FROM topics t JOIN chapters c ON c.id=t.chapter_id JOIN subjects s ON s.id=c.subject_id WHERE t.status='published' AND s.status='published' AND s.archived=0`).all() as any[]; res.json(rows.filter(row => `${row.title} ${row.summary} ${JSON.stringify(blocks(row))}`.toLowerCase().includes(q)).slice(0, 30).map(({ id,title,summary,chapterTitle,subjectTitle }) => ({ id,title,summary,chapterTitle,subjectTitle }))); });
app.post('/api/auth/register', (req, res) => { const { email, password, name } = req.body || {}; if (!email || !password || String(password).length < 8) return res.status(400).json({ error: 'Use an email and a password of at least 8 characters.' }); try { db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(id(), String(email).toLowerCase(), String(name || 'Student'), hash(String(password)), 'student', now()); res.status(201).json({ message: 'Account created. Please sign in.' }); } catch { res.status(409).json({ error: 'An account with that email already exists.' }); } });
app.post('/api/auth/login', (req, res) => { const row = db.prepare('SELECT * FROM users WHERE email=?').get(String(req.body?.email || '').toLowerCase()) as any; if (!row || !matches(String(req.body?.password || ''), row.password_hash)) return res.status(401).json({ error: 'Incorrect email or password.' }); const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, row.id, new Date(Date.now() + 12096e5).toISOString()); res.setHeader('Set-Cookie', `learn_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`); res.json({ user: userView(row) }); });
app.get('/api/auth/me', (req, res) => { const user = me(req); res.json({ user: user ? userView(user) : null }); });
app.post('/api/auth/logout', requireUser, (req, res) => { const token = cookie(req); if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token); res.setHeader('Set-Cookie', 'learn_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); res.status(204).end(); });
app.get('/api/me/library', requireUser, (req, res) => { const user = (req as any).user as User; const progress: Record<string, boolean> = {}; (db.prepare('SELECT topic_id,completed FROM progress WHERE user_id=?').all(user.id) as any[]).forEach(x => progress[x.topic_id] = !!x.completed); res.json({ bookmarks: (db.prepare('SELECT topic_id FROM bookmarks WHERE user_id=?').all(user.id) as any[]).map(x => x.topic_id), progress }); });
app.put('/api/me/bookmarks/:id', requireUser, (req, res) => { const user = (req as any).user as User; if (!topic(req.params.id)) return res.status(404).json({ error: 'Published topic not found.' }); if (req.body?.bookmarked) db.prepare('INSERT OR IGNORE INTO bookmarks VALUES (?,?)').run(user.id, req.params.id); else db.prepare('DELETE FROM bookmarks WHERE user_id=? AND topic_id=?').run(user.id, req.params.id); res.status(204).end(); });
app.put('/api/me/progress/:id', requireUser, (req, res) => { const user = (req as any).user as User; if (!topic(req.params.id)) return res.status(404).json({ error: 'Published topic not found.' }); db.prepare('INSERT INTO progress VALUES (?,?,?,?) ON CONFLICT(user_id,topic_id) DO UPDATE SET completed=excluded.completed,updated_at=excluded.updated_at').run(user.id, req.params.id, req.body?.completed ? 1 : 0, now()); res.status(204).end(); });

app.get('/api/admin/catalog', requireAdmin, (_req, res) => res.json(catalog(true)));
app.get('/api/admin/topics/:id', requireAdmin, (req, res) => { const data = topic(req.params.id, true); data ? res.json(data) : res.status(404).json({ error: 'Topic not found.' }); });
app.put('/api/admin/settings', requireAdmin, (req, res) => { db.prepare('UPDATE settings SET title=?,logo=?,accent_color=? WHERE id=1').run(String(req.body?.title || 'Learning Library'), String(req.body?.logo || ''), String(req.body?.accentColor || '#2563eb')); res.json(settings()); });
app.post('/api/admin/subjects', requireAdmin, (req, res) => { const title = String(req.body?.title || '').trim(); if (!title) return res.status(400).json({ error: 'Subject title is required.' }); const x = { id: id(), slug: slug(req.body?.slug || title), title, description: String(req.body?.description || ''), status: 'draft', archived: 0, position: ((db.prepare('SELECT COALESCE(MAX(position),0) value FROM subjects').get() as any).value || 0) + 1 }; try { db.prepare('INSERT INTO subjects VALUES (?,?,?,?,?,?,?)').run(x.id,x.slug,x.title,x.description,x.status,x.archived,x.position); res.status(201).json(x); } catch { res.status(409).json({ error: 'That subject slug is already in use.' }); } });
app.patch('/api/admin/subjects/:id', requireAdmin, (req, res) => { const old = db.prepare('SELECT * FROM subjects WHERE id=?').get(req.params.id) as any; if (!old) return res.status(404).json({ error: 'Subject not found.' }); const x = { ...old, ...req.body, slug: req.body?.slug ? slug(req.body.slug) : old.slug, archived: req.body?.archived === undefined ? old.archived : Number(!!req.body.archived) }; db.prepare('UPDATE subjects SET slug=?,title=?,description=?,status=?,archived=?,position=? WHERE id=?').run(x.slug,x.title,x.description,x.status,x.archived,x.position,x.id); res.json(x); });
app.delete('/api/admin/subjects/:id', requireAdmin, (req, res) => { db.prepare('DELETE FROM subjects WHERE id=?').run(req.params.id); res.status(204).end(); });
app.post('/api/admin/chapters', requireAdmin, (req, res) => { const subjectId = String(req.body?.subjectId || ''), title = String(req.body?.title || '').trim(); if (!subjectId || !title) return res.status(400).json({ error: 'Subject and chapter title are required.' }); const x = { id: id(), subjectId, title, description: String(req.body?.description || ''), position: nextPosition('chapters','subject_id',subjectId) }; db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?)').run(x.id,x.subjectId,x.title,x.description,x.position); res.status(201).json(x); });
app.patch('/api/admin/chapters/:id', requireAdmin, (req, res) => { const old = db.prepare('SELECT * FROM chapters WHERE id=?').get(req.params.id) as any; if (!old) return res.status(404).json({ error: 'Chapter not found.' }); const x = { ...old, ...req.body }; db.prepare('UPDATE chapters SET title=?,description=?,position=? WHERE id=?').run(x.title,x.description,x.position,x.id); res.json(x); });
app.delete('/api/admin/chapters/:id', requireAdmin, (req, res) => { db.prepare('DELETE FROM chapters WHERE id=?').run(req.params.id); res.status(204).end(); });
app.post('/api/admin/topics', requireAdmin, (req, res) => { const chapterId = String(req.body?.chapterId || ''), title = String(req.body?.title || '').trim(); if (!chapterId || !title) return res.status(400).json({ error: 'Chapter and topic title are required.' }); const x = { id: id(), chapterId, slug: slug(req.body?.slug || title), title, summary: String(req.body?.summary || ''), draft: encode([{ id: id(), type: 'paragraph', text: '' }]), position: nextPosition('topics','chapter_id',chapterId) }; db.prepare('INSERT INTO topics VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(x.id,x.chapterId,x.slug,x.title,x.summary,'draft',x.draft,null,null,'{}',x.position,now()); res.status(201).json(x); });
app.patch('/api/admin/topics/:id', requireAdmin, (req, res) => { const old = db.prepare('SELECT * FROM topics WHERE id=?').get(req.params.id) as any; if (!old) return res.status(404).json({ error: 'Topic not found.' }); const b = req.body || {}; try { db.prepare('UPDATE topics SET title=?,slug=?,summary=?,draft_content=?,simulation_id=?,simulation_config=?,position=? WHERE id=?').run(b.title ?? old.title, b.slug ? slug(b.slug) : old.slug, b.summary ?? old.summary, Array.isArray(b.content) ? encode(b.content) : old.draft_content, b.simulationId === undefined ? old.simulation_id : b.simulationId || null, b.simulationConfig === undefined ? old.simulation_config : encode(b.simulationConfig), b.position ?? old.position, req.params.id); res.json(topic(req.params.id, true)); } catch { res.status(409).json({ error: 'That topic slug is already in use in this chapter.' }); } });
app.post('/api/admin/topics/:id/publish', requireAdmin, (req, res) => { if (!topic(req.params.id,true)) return res.status(404).json({ error: 'Topic not found.' }); db.prepare("UPDATE topics SET status='published',published_content=draft_content WHERE id=?").run(req.params.id); res.json(topic(req.params.id,true)); });
app.post('/api/admin/topics/:id/duplicate', requireAdmin, (req, res) => { const old = db.prepare('SELECT * FROM topics WHERE id=?').get(req.params.id) as any; if (!old) return res.status(404).json({ error: 'Topic not found.' }); const newId = id(); db.prepare('INSERT INTO topics VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(newId,old.chapter_id,`${old.slug}-copy-${Date.now()}`,`${old.title} (copy)`,old.summary,'draft',old.draft_content,null,old.simulation_id,old.simulation_config,nextPosition('topics','chapter_id',old.chapter_id),now()); res.status(201).json(topic(newId,true)); });
app.delete('/api/admin/topics/:id', requireAdmin, (req, res) => { db.prepare('DELETE FROM topics WHERE id=?').run(req.params.id); res.status(204).end(); });
app.post('/api/admin/uploads', requireAdmin, (req, res) => { const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(req.body?.dataUrl || ''); if (!match) return res.status(400).json({ error: 'Upload a PNG, JPEG, WebP, or GIF image.' }); const extension = extname(basename(req.body?.filename || 'image.png')) || `.${match[1].split('/')[1]}`; const file = `${id()}${extension.toLowerCase()}`; writeFileSync(join(uploadDir,file), Buffer.from(match[2], 'base64')); res.status(201).json({ url: `/uploads/${file}` }); });

const dist = join(root, 'dist');
if (existsSync(dist)) { app.use(express.static(dist)); app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html'))); }
app.listen(Number(process.env.PORT || 3001), () => console.log(`Learning platform API: http://localhost:${process.env.PORT || 3001}`));
