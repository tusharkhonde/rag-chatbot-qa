import { useEffect, useState } from 'react';
import { api, setCsrfToken } from './lib/api';
import type { User } from './lib/types';
import { Admin } from './pages/Admin';
import { Chat } from './pages/Chat';
import { Login } from './pages/Login';

type View = 'chat' | 'admin';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still checking
  const [view, setView] = useState<View>('chat');

  // On load, ask the server whether our session cookie is valid. The SPA never knows the
  // session id itself; it only learns who is signed in and the CSRF token.
  useEffect(() => {
    api.me()
      .then(({ user, csrfToken }) => {
        setCsrfToken(csrfToken);
        setUser(user);
      })
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <div className="splash">Loading…</div>;
  if (user === null) {
    return (
      <Login
        onSignedIn={(u, token) => {
          setCsrfToken(token);
          setUser(u);
          setView('chat');
        }}
      />
    );
  }

  const signOut = async () => {
    await api.logout().catch(() => {});
    setCsrfToken('');
    setUser(null);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Docs Assistant</div>
        <nav>
          <button className={view === 'chat' ? 'tab active' : 'tab'} onClick={() => setView('chat')}>
            Chat
          </button>
          {user.role === 'admin' && (
            <button className={view === 'admin' ? 'tab active' : 'tab'} onClick={() => setView('admin')}>
              Admin
            </button>
          )}
        </nav>
        <div className="who">
          <span>
            {user.name} <span className={`badge role-${user.role}`}>{user.role}</span>
          </span>
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      {/* Hiding the Admin tab is UX only; the server enforces the admin role on every admin route. */}
      <main>{view === 'admin' && user.role === 'admin' ? <Admin currentUser={user} /> : <Chat />}</main>
    </div>
  );
}
