import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { api } from '../lib/api';
import type { AdminUser, Collection, DocumentSummary, Role, User } from '../lib/types';

export function Admin({ currentUser }: { currentUser: User }) {
  const [tab, setTab] = useState<'documents' | 'users'>('documents');
  return (
    <div className="admin">
      <div className="subtabs">
        <button className={tab === 'documents' ? 'tab active' : 'tab'} onClick={() => setTab('documents')}>
          Documents
        </button>
        <button className={tab === 'users' ? 'tab active' : 'tab'} onClick={() => setTab('users')}>
          Users
        </button>
      </div>
      {tab === 'documents' ? <Documents /> : <Users currentUser={currentUser} />}
    </div>
  );
}

// ------------------------------------------------------------------ documents

interface UploadRow {
  name: string;
  status: 'queued' | 'uploading' | 'indexed' | 'duplicate' | 'error';
  detail?: string;
}

const ACCEPT = '.pdf,.md,.markdown,.txt';

function Documents() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState('');
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [newName, setNewName] = useState('');
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');

  const loadCollections = useCallback(async () => {
    const list = await api.collections();
    setCollections(list);
    setSelected((cur) => cur || list[0]?.id || '');
  }, []);
  const loadDocuments = useCallback(async (id: string) => setDocuments(id ? await api.documents(id) : []), []);

  useEffect(() => {
    loadCollections().catch((e) => setError(e.message));
  }, [loadCollections]);
  useEffect(() => {
    loadDocuments(selected).catch((e) => setError(e.message));
  }, [selected, loadDocuments]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const c = await api.createCollection(newName.trim());
      setNewName('');
      await loadCollections();
      setSelected(c.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Sequential uploads: each file is parsed, chunked and embedded server-side before the next.
  async function uploadFiles(files: File[]) {
    if (!selected || !files.length) return;
    const start = uploads.length;
    setUploads((u) => [...u, ...files.map((f) => ({ name: f.name, status: 'queued' as const }))]);
    const set = (i: number, row: Partial<UploadRow>) => setUploads((u) => u.map((r, j) => (j === start + i ? { ...r, ...row } : r)));
    for (const [i, file] of files.entries()) {
      set(i, { status: 'uploading' });
      try {
        const res = await api.upload(selected, file);
        set(i, res.created ? { status: 'indexed', detail: `${res.chunkCount} chunks` } : { status: 'duplicate', detail: 'already in this collection' });
      } catch (err) {
        set(i, { status: 'error', detail: (err as Error).message });
      }
    }
    await loadDocuments(selected);
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void uploadFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="grid">
      <section className="card">
        <h3>Collections</h3>
        <ul className="list">
          {collections.map((c) => (
            <li key={c.id}>
              <button className={c.id === selected ? 'row active' : 'row'} onClick={() => setSelected(c.id)}>
                {c.name}
              </button>
            </li>
          ))}
          {collections.length === 0 && <li className="muted">No collections yet.</li>}
        </ul>
        <form className="inline" onSubmit={create}>
          <input placeholder="New collection name" value={newName} onChange={(e) => setNewName(e.target.value)} pattern="[\w .\-]+" required />
          <button className="secondary">Create</button>
        </form>
      </section>

      <section className="card">
        <h3>Add documents</h3>
        <p className="muted">
          PDF, Markdown or text. Documents are indexed for search (split into chunks and embedded), not used to
          retrain the model; answers always cite them.
        </p>
        <label
          className={`dropzone ${dragging ? 'dragging' : ''} ${!selected ? 'disabled' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input type="file" multiple accept={ACCEPT} disabled={!selected} onChange={(e) => void uploadFiles([...(e.target.files ?? [])])} />
          {selected ? 'Drop files here or click to choose' : 'Create a collection first'}
        </label>
        {uploads.length > 0 && (
          <ul className="uploads">
            {uploads.map((u, i) => (
              <li key={i} className={u.status}>
                <span>{u.name}</span>
                <span>
                  {u.status}
                  {u.detail ? ` · ${u.detail}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <div className="error">{error}</div>}

        <h3>Documents in this collection</h3>
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Chunks</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((d) => (
              <tr key={d.id}>
                <td>{d.filename}</td>
                <td>{d.chunkCount}</td>
                <td>{new Date(d.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {documents.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  No documents yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ users

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 18);
}

function Users({ currentUser }: { currentUser: User }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [form, setForm] = useState({ name: '', email: '', role: 'user' as Role, password: '' });
  const [created, setCreated] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => setUsers(await api.users()), []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    setCreated('');
    try {
      await api.createUser(form);
      setCreated(`Created ${form.email}. Share the password with them securely; it isn't shown again.`);
      setForm({ name: '', email: '', role: 'user', password: '' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggle(u: AdminUser) {
    setError('');
    try {
      await api.setDisabled(u.id, !u.disabled);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="grid">
      <section className="card">
        <h3>Add a user</h3>
        <form className="stack" onSubmit={create}>
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label>
            Email
            <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </label>
          <label>
            Role
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="user">User (chat only)</option>
              <option value="admin">Admin (documents and users)</option>
            </select>
          </label>
          <label>
            Initial password (at least 12 characters)
            <div className="inline">
              <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={12} required />
              <button type="button" className="secondary" onClick={() => setForm({ ...form, password: randomPassword() })}>
                Generate
              </button>
            </div>
          </label>
          <button className="primary">Create user</button>
        </form>
        {created && <div className="ok">{created}</div>}
        {error && <div className="error">{error}</div>}
      </section>

      <section className="card">
        <h3>Users</h3>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.disabled ? 'disabled' : ''}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <span className={`badge role-${u.role}`}>{u.role}</span>
                </td>
                <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
                <td>
                  {u.id !== currentUser.id && (
                    <button className="link" onClick={() => void toggle(u)}>
                      {u.disabled ? 'Enable' : 'Disable'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
