import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, makeIdempotencyKey, setCsrfToken, type Role, type Session } from './api.js';

type Page = 'overview' | 'requests' | 'budgets' | 'activity' | 'create';
type Budget = { id: string; departmentId: string; departmentName: string; periodKey: string; limitMinor: string; reservedMinor: string; availableMinor: string; currencyCode: string };
type PurchaseRequest = { id: string; title: string; description: string; amountMinor: string; status: string; departmentId: string; departmentName: string; requesterUserId: string; requesterName: string; createdAt: string; submittedAt: string | null; decidedAt: string | null; currencyCode: string; periodKey?: string; requesterEmail?: string; rejectionReason?: string | null; budgetId?: string; budgetLimitMinor?: string; budgetReservedMinor?: string; budgetAvailableMinor?: string };
type AuditEvent = { id: string; requestId?: string; eventType: string; fromStatus: string | null; toStatus: string | null; reason: string | null; details: Record<string, unknown>; createdAt: string; actorName: string; actorEmail: string };
type Summary = { currencyCode: string; limitMinor: string; reservedMinor: string; availableMinor: string; requestCounts: Record<string, number>; awaitingApproval: number };
type Department = { id: string; name: string };

function money(minor: string | number | undefined, currency = 'AED') {
  const value = BigInt(minor ?? '0');
  const major = value / 100n;
  const fraction = (value % 100n).toString().padStart(2, '0');
  const majorText = new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(major);
  return `${majorText}.${fraction}`;
}
function date(value: string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}
function initials(name: string) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
function roleName(role: Role) { return role === 'finance_admin' ? 'Finance admin' : role === 'approver' ? 'Approver' : 'Employee'; }
function statusClass(status: string) { return `status-pill status-${status}`; }

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [page, setPage] = useState<Page>('overview');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [requests, setRequests] = useState<PurchaseRequest[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selected, setSelected] = useState<PurchaseRequest | null>(null);
  const [selectedAudit, setSelectedAudit] = useState<AuditEvent[]>([]);
  const [loginEmail, setLoginEmail] = useState('employee@reserveflow.local');
  const [loginPassword, setLoginPassword] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [createForm, setCreateForm] = useState({ budgetId: '', title: '', description: '', amount: '' });
  const [budgetForm, setBudgetForm] = useState({ departmentId: '', periodKey: new Date().toISOString().slice(0, 7), limitAmount: '' });
  const operationKeys = useRef(new Map<string, string>());
  const getOperationKey = (action: string, id: string) => {
    const keyId = `${action}:${id}`;
    let key = operationKeys.current.get(keyId);
    if (!key) { key = makeIdempotencyKey(); operationKeys.current.set(keyId, key); }
    return key;
  };
  const clearOperationKey = (action: string, id: string) => operationKeys.current.delete(`${action}:${id}`);

  const loadSession = useCallback(async () => {
    try {
      const result = await api<Session>('/api/auth/me');
      setCsrfToken(result.csrfToken);
      setSession(result);
    } catch {
      setCsrfToken(null);
      setSession(null);
    } finally { setAuthReady(true); }
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);

  const loadBaseData = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const [summaryResult, budgetResult, departmentResult] = await Promise.all([
        api<Summary>('/api/dashboard/summary'),
        api<{ budgets: Budget[] }>('/api/budgets'),
        api<{ departments: Department[] }>('/api/departments')
      ]);
      setSummary(summaryResult);
      setBudgets(budgetResult.budgets);
      setDepartments(departmentResult.departments);
      if (!createForm.budgetId && budgetResult.budgets[0]) setCreateForm((old) => ({ ...old, budgetId: budgetResult.budgets[0]!.id }));
      if (!budgetForm.departmentId && departmentResult.departments[0]) setBudgetForm((old) => ({ ...old, departmentId: departmentResult.departments[0]!.id }));
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }, [session, createForm.budgetId, budgetForm.departmentId]);

  const loadRequests = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (search.trim()) params.set('q', search.trim());
      if (statusFilter) params.set('status', statusFilter);
      const result = await api<{ requests: PurchaseRequest[] }>(`/api/requests?${params.toString()}`);
      setRequests(result.requests);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }, [session, search, statusFilter]);

  useEffect(() => { if (session) void loadBaseData(); }, [session, loadBaseData]);
  useEffect(() => { if (session && (page === 'requests' || page === 'overview')) void loadRequests(); }, [session, page, loadRequests]);

  async function handleLogin(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError('');
    try {
      const result = await api<{ authenticated: boolean; csrfToken: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: loginEmail, password: loginPassword }) });
      setCsrfToken(result.csrfToken);
      await loadSession();
      setPage('overview');
      setNotice('Signed in successfully.');
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  async function handleLogout() {
    try { await api<void>('/api/auth/logout', { method: 'POST', body: '{}' }); }
    catch (caught) { setError(errorMessage(caught)); }
    setCsrfToken(null); setSession(null); setSelected(null); setPage('overview');
  }

  async function openRequest(request: PurchaseRequest) {
    setError('');
    try {
      const [result, audit] = await Promise.all([
        api<{ request: PurchaseRequest }>(`/api/requests/${request.id}`),
        api<{ events: AuditEvent[] }>(`/api/requests/${request.id}/audit`)
      ]);
      setSelected(result.request); setSelectedAudit(audit.events);
    } catch (caught) { setError(errorMessage(caught)); }
  }

  async function createRequest(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(''); setNotice('');
    try {
      const result = await api<{ request: PurchaseRequest }>('/api/requests', { method: 'POST', body: JSON.stringify(createForm) });
      setNotice('Draft request created. Review it and submit when ready.');
      setPage('requests'); setSelected(result.request); setCreateForm({ budgetId: budgets[0]?.id ?? '', title: '', description: '', amount: '' });
      await Promise.all([loadRequests(), loadBaseData()]);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  async function submitRequest(requestId: string) {
    setLoading(true); setError(''); setNotice('');
    try {
      await api(`/api/requests/${requestId}/submit`, { method: 'POST', body: '{}' }, getOperationKey('submit', requestId));
      clearOperationKey('submit', requestId);
      setNotice('Request submitted for approval.'); await refreshAfterMutation(requestId);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  async function approveRequest(requestId: string) {
    setLoading(true); setError(''); setNotice('');
    try {
      await api(`/api/requests/${requestId}/approve`, { method: 'POST', body: '{}' }, getOperationKey('approve', requestId));
      clearOperationKey('approve', requestId);
      setNotice('Request approved and budget reserved.'); await refreshAfterMutation(requestId);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  async function rejectRequest(event: FormEvent) {
    event.preventDefault(); if (!rejectId) return;
    setLoading(true); setError(''); setNotice('');
    try {
      await api(`/api/requests/${rejectId}/reject`, { method: 'POST', body: JSON.stringify({ reason: rejectReason }) }, getOperationKey('reject', rejectId));
      clearOperationKey('reject', rejectId);
      const id = rejectId; setRejectId(null); setRejectReason(''); setNotice('Request rejected with a recorded reason.'); await refreshAfterMutation(id);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  async function cancelRequest(requestId: string) {
    if (!window.confirm('Cancel this request? If it was approved, its budget reservation will be released.')) return;
    setLoading(true); setError(''); setNotice('');
    try {
      await api(`/api/requests/${requestId}/cancel`, { method: 'POST', body: '{}' }, getOperationKey('cancel', requestId));
      clearOperationKey('cancel', requestId);
      setNotice('Request cancelled.'); await refreshAfterMutation(requestId);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  async function createBudget(event: FormEvent) {
    event.preventDefault(); setLoading(true); setError(''); setNotice('');
    try {
      await api('/api/budgets', { method: 'POST', body: JSON.stringify(budgetForm) });
      setNotice('Budget created.'); await loadBaseData(); setPage('budgets');
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  async function updateBudgetLimit(budget: Budget) {
    const entered = window.prompt(`New budget limit in ${budget.currencyCode}, for ${budget.departmentName} · ${budget.periodKey}`, `${BigInt(budget.limitMinor) / 100n}.${(BigInt(budget.limitMinor) % 100n).toString().padStart(2, '0')}`);
    if (entered === null) return;
    setLoading(true); setError(''); setNotice('');
    try {
      await api(`/api/budgets/${budget.id}`, { method: 'PATCH', body: JSON.stringify({ limitAmount: entered }) });
      setNotice('Budget limit updated.'); await loadBaseData();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  async function refreshAfterMutation(requestId: string) {
    await Promise.all([loadBaseData(), loadRequests()]);
    try {
      const [result, audit] = await Promise.all([
        api<{ request: PurchaseRequest }>(`/api/requests/${requestId}`),
        api<{ events: AuditEvent[] }>(`/api/requests/${requestId}/audit`)
      ]);
      setSelected(result.request); setSelectedAudit(audit.events);
    } catch { setSelected(null); setSelectedAudit([]); }
  }

  async function loadGlobalAudit() {
    setLoading(true); setError('');
    try {
      const result = await api<{ events: AuditEvent[] }>('/api/audit?limit=100');
      setSelectedAudit(result.events);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (session && page === 'activity' && session.user.role === 'finance_admin') void loadGlobalAudit(); }, [page, session]);

  const canCreate = session?.user.role === 'employee' || session?.user.role === 'approver';
  const canApproveSelected = session?.user.role === 'approver' && selected?.status === 'submitted' && selected.requesterUserId !== session.user.id;
  const canCancelSelected = !!session && selected && ['draft', 'submitted', 'approved'].includes(selected.status) && (session.user.role === 'finance_admin' || selected.requesterUserId === session.user.id);

  if (!authReady) return <div className="splash"><div className="brand-mark">R</div><p>Loading ReserveFlow…</p></div>;
  if (!session) return <Login email={loginEmail} password={loginPassword} setEmail={setLoginEmail} setPassword={setLoginPassword} onSubmit={handleLogin} loading={loading} error={error} />;

  return (
    <div className="app-frame">
      <aside className="sidebar">
        <a className="brand" href="#overview" onClick={(event) => { event.preventDefault(); setPage('overview'); }}>
          <span className="brand-mark">R</span><span className="brand-word">reserveflow<span>.</span></span>
        </a>
        <div className="workspace-switch"><div className="workspace-icon">{initials(session.organization.name)}</div><div className="workspace-text"><strong>{session.organization.name}</strong><small>{session.organization.currencyCode} workspace</small></div><span className="chevron">⌄</span></div>
        <p className="nav-label">WORKSPACE</p>
        <nav className="side-nav" aria-label="Main navigation">
          <NavButton active={page === 'overview'} icon="◫" label="Overview" onClick={() => { setPage('overview'); setSelected(null); }} />
          <NavButton active={page === 'requests'} icon="▤" label="Purchase requests" count={session.user.role === 'approver' && summary ? summary.awaitingApproval : undefined} onClick={() => { setPage('requests'); setSelected(null); }} />
          <NavButton active={page === 'budgets'} icon="▥" label="Budgets" onClick={() => { setPage('budgets'); setSelected(null); }} />
          {session.user.role === 'finance_admin' && <NavButton active={page === 'activity'} icon="◷" label="Audit activity" onClick={() => { setPage('activity'); setSelected(null); }} />}
        </nav>
        {canCreate && <button className="sidebar-create" onClick={() => setPage('create')}><span>＋</span> New purchase request</button>}
        <div className="sidebar-bottom"><div className="help-card"><div className="help-icon">✳</div><strong>Built for better controls</strong><p>Every approval is checked on the server and recorded with its budget reservation.</p><span>PORTFOLIO DEMO · SYNTHETIC DATA</span></div><div className="profile-row"><div className="avatar">{initials(session.user.fullName)}</div><div className="profile-info"><strong>{session.user.fullName}</strong><small>{roleName(session.user.role)}</small></div><button className="icon-button logout" title="Sign out" aria-label="Sign out" onClick={handleLogout}>↪</button></div></div>
      </aside>

      <main className="main-area">
        <header className="top-header"><div className="breadcrumbs">Workspace <span>/</span> <strong>{pageTitle(page)}</strong></div><div className="top-actions"><span className="secure-label"><span className="secure-dot"/> Session active</span><button className="icon-button" aria-label="Refresh data" onClick={() => { void loadBaseData(); void loadRequests(); }}>↻</button><div className="header-avatar">{initials(session.user.fullName)}</div></div></header>
        <div className="content-wrap">
          {(error || notice) && <div className={`alert ${error ? 'alert-error' : 'alert-success'}`} role="status"><span>{error ? '!' : '✓'}</span><div>{error || notice}</div><button onClick={() => { setError(''); setNotice(''); }} aria-label="Dismiss">×</button></div>}
          {page === 'overview' && <Overview session={session} summary={summary} requests={requests.slice(0, 5)} budgets={budgets.slice(0, 3)} loading={loading} onNew={() => setPage('create')} onRequests={() => setPage('requests')} onOpen={openRequest} />}
          {page === 'requests' && <RequestsPage requests={requests} loading={loading} search={search} setSearch={setSearch} statusFilter={statusFilter} setStatusFilter={setStatusFilter} onSearch={() => void loadRequests()} onOpen={openRequest} onNew={() => setPage('create')} role={session.user.role} />}
          {page === 'create' && <CreateRequestPage budgets={budgets} form={createForm} setForm={setCreateForm} currency={session.organization.currencyCode} loading={loading} onSubmit={createRequest} onCancel={() => setPage('requests')} />}
          {page === 'budgets' && <BudgetsPage budgets={budgets} departments={departments} role={session.user.role} form={budgetForm} setForm={setBudgetForm} loading={loading} onCreate={createBudget} onEdit={updateBudgetLimit} />}
          {page === 'activity' && <ActivityPage events={selectedAudit} loading={loading} />}
          {selected && page !== 'create' && <RequestDetail request={selected} events={selectedAudit} role={session.user.role} currentUserId={session.user.id} currency={session.organization.currencyCode} loading={loading} canApprove={!!canApproveSelected} canCancel={!!canCancelSelected} onClose={() => setSelected(null)} onSubmit={() => void submitRequest(selected.id)} onApprove={() => void approveRequest(selected.id)} onReject={() => { setRejectId(selected.id); setRejectReason(''); }} onCancel={() => void cancelRequest(selected.id)} />}
          {rejectId && <div className="modal-backdrop" role="presentation"><form className="modal-card" onSubmit={rejectRequest}><div className="modal-top"><div><span className="eyebrow">DECISION REQUIRED</span><h2>Reject request</h2></div><button className="icon-button" type="button" onClick={() => setRejectId(null)} aria-label="Close">×</button></div><p>Record a clear reason so the requester can understand the decision.</p><label>Rejection reason<textarea value={rejectReason} onChange={(event) => setRejectReason(event.target.value)} minLength={1} maxLength={1000} required placeholder="Explain why this request cannot be approved…" rows={4}/></label><div className="modal-actions"><button type="button" className="button secondary" onClick={() => setRejectId(null)}>Cancel</button><button type="submit" className="button danger" disabled={loading || !rejectReason.trim()}>Confirm rejection</button></div></form></div>}
        </div>
        <footer className="main-footer"><span>ReserveFlow <b>·</b> Local portfolio application</span><span><i/> No real payments are processed</span></footer>
      </main>
    </div>
  );
}

function Login({ email, password, setEmail, setPassword, onSubmit, loading, error }: { email: string; password: string; setEmail: (value: string) => void; setPassword: (value: string) => void; onSubmit: (event: FormEvent) => void; loading: boolean; error: string }) {
  return <main className="login-layout"><div className="login-brand"><span className="brand-mark">R</span><span className="brand-word">reserveflow<span>.</span></span></div><section className="login-left"><div className="login-copy"><p className="eyebrow">PURCHASE CONTROL, WITHOUT THE GUESSWORK</p><h1>Make every budget decision <em>count.</em></h1><p>Bring purchase requests, approval decisions, and budget reservations into one clear workflow.</p><div className="login-points"><span>✓ Budget-aware approvals</span><span>✓ Clear action history</span><span>✓ Safe concurrent updates</span></div></div><div className="login-decoration"><div className="deco-card deco-one"><span>BUDGET STATUS</span><strong>Within policy</strong><small><i/> Ready to allocate</small></div><div className="deco-card deco-two"><span>APPROVAL WORKFLOW</span><strong>Decision recorded</strong><small>Reservation recorded</small></div><div className="deco-orbit orbit-one"/><div className="deco-orbit orbit-two"/></div></section><section className="login-right"><form className="login-card" onSubmit={onSubmit}><span className="eyebrow">WELCOME BACK</span><h2>Sign in to ReserveFlow</h2><p>Use one of the local demo accounts to explore the workflow.</p>{error && <div className="alert alert-error"><span>!</span><div>{error}</div></div>}<label>Email address<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="button primary full-width" type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'} <span>→</span></button><div className="demo-credentials"><strong>Local demo credentials</strong><span>employee@reserveflow.local</span><span>approver@reserveflow.local</span><span>finance@reserveflow.local</span><small>Shared password is set in your local environment file. Synthetic data only.</small></div></form></section><footer className="login-footer">A student-built engineering demo <span>•</span> No bank or card connections</footer></main>;
}

function Overview({ session, summary, requests, budgets, loading, onNew, onRequests, onOpen }: { session: Session; summary: Summary | null; requests: PurchaseRequest[]; budgets: Budget[]; loading: boolean; onNew: () => void; onRequests: () => void; onOpen: (request: PurchaseRequest) => void }) {
  return <>
    <div className="page-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>Good to see you, {session.user.fullName.split(' ')[0]} <span className="wave">✦</span></h1><p className="page-subtitle">Here is what's happening with your purchase requests and budgets.</p></div>{(session.user.role === 'employee' || session.user.role === 'approver') && <button className="button primary" onClick={onNew}>＋ New request</button>}</div>
    <section className="metric-grid"><Metric title="Total budget" value={money(summary?.limitMinor, session.organization.currencyCode)} icon="▥" tint="blue" note="Across visible budgets" /><Metric title="Reserved" value={money(summary?.reservedMinor, session.organization.currencyCode)} icon="◷" tint="amber" note="Approved purchase requests" /><Metric title="Available" value={money(summary?.availableMinor, session.organization.currencyCode)} icon="↗" tint="green" note="Available to allocate" /><Metric title="Awaiting approval" value={String(summary?.awaitingApproval ?? '—')} icon="▤" tint="violet" note="Submitted requests" /></section>
    <div className="section-grid"><section className="panel requests-panel"><div className="panel-heading"><div><h2>{session.user.role === 'approver' ? 'Needs your attention' : 'Recent purchase requests'}</h2><p>{session.user.role === 'approver' ? 'Review and decide on requests in your department.' : 'Track recent decisions and request status.'}</p></div><button className="text-button" onClick={onRequests}>View all <span>→</span></button></div>{loading ? <LoadingRows/> : requests.length === 0 ? <EmptyState title="No requests yet" text="New requests will appear here when you create or receive them."/> : <RequestTable requests={requests} currency={session.organization.currencyCode} onOpen={onOpen} compact/>}</section><section className="panel budget-panel"><div className="panel-heading"><div><h2>Budget overview</h2><p>Current available allocation.</p></div><span className="panel-icon">▥</span></div>{budgets.length === 0 ? <EmptyState title="No budgets yet" text="A finance administrator can create a department budget."/> : budgets.map((budget) => { const limit = BigInt(budget.limitMinor); const reserved = BigInt(budget.reservedMinor); const ratio = limit > 0n ? Number((reserved * 10000n) / limit) / 100 : 0; return <div className="budget-item" key={budget.id}><div className="budget-item-title"><div><strong>{budget.departmentName}</strong><span>{budget.periodKey}</span></div><span className="budget-percent">{Math.min(ratio, 100).toFixed(0)}%</span></div><div className="progress-track"><span style={{ width: `${Math.min(ratio, 100)}%` }}/></div><div className="budget-item-values"><span>{money(budget.reservedMinor, budget.currencyCode)} reserved</span><strong>{money(budget.availableMinor, budget.currencyCode)} left</strong></div></div>; })}<div className="budget-footnote"><span className="legend-dot reserved-dot"/> Reserved <span className="legend-dot available-dot"/> Available</div></section></div>
    <section className="trust-strip"><div className="trust-mark">✓</div><div><strong>Approvals are checked against live budget state</strong><p>Server-side rules and PostgreSQL transactions help prevent concurrent requests from over-reserving funds.</p></div><span className="trust-chip">ENGINEERING CONTROL</span></section>
  </>;
}

function Metric({ title, value, icon, tint, note }: { title: string; value: string; icon: string; tint: string; note: string }) { return <article className="metric-card"><div className="metric-top"><span>{title}</span><span className={`metric-icon ${tint}`}>{icon}</span></div><strong className="metric-value">{value}</strong><small>{note}</small></article>; }
function LoadingRows() { return <div className="loading-rows"><span/><span/><span/></div>; }
function EmptyState({ title, text }: { title: string; text: string }) { return <div className="empty-state"><div>▤</div><strong>{title}</strong><p>{text}</p></div>; }
function RequestTable({ requests, currency, onOpen, compact = false }: { requests: PurchaseRequest[]; currency: string; onOpen: (request: PurchaseRequest) => void; compact?: boolean }) {
  return <div className={`table-wrap ${compact ? 'compact-table' : ''}`}><table><thead><tr><th>Request</th><th>Requester</th><th>Amount</th><th>Status</th><th>Created</th><th><span className="sr-only">View</span></th></tr></thead><tbody>{requests.map((request) => <tr key={request.id}><td><button className="request-title-button" onClick={() => onOpen(request)}><strong>{request.title}</strong><small>RF-{request.id.slice(0, 8).toUpperCase()}</small></button></td><td><div className="table-person"><span className="avatar tiny">{initials(request.requesterName)}</span><span>{request.requesterName}</span></div></td><td className="amount-cell">{money(request.amountMinor, request.currencyCode || currency)}</td><td><span className={statusClass(request.status)}>{statusLabel(request.status)}</span></td><td>{date(request.createdAt)}</td><td><button className="row-open" aria-label={`Open ${request.title}`} onClick={() => onOpen(request)}>↗</button></td></tr>)}</tbody></table></div>;
}
function RequestsPage({ requests, loading, search, setSearch, statusFilter, setStatusFilter, onSearch, onOpen, onNew, role }: { requests: PurchaseRequest[]; loading: boolean; search: string; setSearch: (value: string) => void; statusFilter: string; setStatusFilter: (value: string) => void; onSearch: () => void; onOpen: (request: PurchaseRequest) => void; onNew: () => void; role: Role }) {
  return <><div className="page-heading"><div><p className="eyebrow">REQUEST MANAGEMENT</p><h1>Purchase requests</h1><p className="page-subtitle">A shared record of planned spending, decisions, and budget status.</p></div>{(role === 'employee' || role === 'approver') && <button className="button primary" onClick={onNew}>＋ New request</button>}</div><section className="panel list-panel"><div className="filters-row"><label className="search-field"><span>⌕</span><input aria-label="Search requests" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onSearch(); }} placeholder="Search requests or people…"/></label><select aria-label="Filter status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); }}><option value="">All statuses</option><option value="draft">Draft</option><option value="submitted">Submitted</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="cancelled">Cancelled</option></select><button className="button secondary" onClick={onSearch}>Apply filters</button></div>{loading ? <LoadingRows/> : requests.length === 0 ? <EmptyState title="No matching requests" text="Try another filter or create a new purchase request."/> : <RequestTable requests={requests} currency="AED" onOpen={onOpen}/>}<div className="table-bottom"><span>Showing {requests.length} request{requests.length === 1 ? '' : 's'} · maximum 100 per view</span><span>Amounts use the organization currency</span></div></section></>;
}

function CreateRequestPage({ budgets, form, setForm, currency, loading, onSubmit, onCancel }: { budgets: Budget[]; form: { budgetId: string; title: string; description: string; amount: string }; setForm: (updater: (old: { budgetId: string; title: string; description: string; amount: string }) => { budgetId: string; title: string; description: string; amount: string }) => void; currency: string; loading: boolean; onSubmit: (event: FormEvent) => void; onCancel: () => void }) {
  return <><div className="page-heading"><div><p className="eyebrow">SPENDING WORKFLOW</p><h1>New purchase request</h1><p className="page-subtitle">Create a draft, review the details, and submit it for approval.</p></div></div><form className="form-panel" onSubmit={onSubmit}><div className="form-intro"><div className="large-form-icon">＋</div><div><h2>Request details</h2><p>Be clear about what the purchase is for and which budget should cover it.</p></div></div><div className="form-grid"><label className="span-two">Request title<input value={form.title} onChange={(event) => setForm((old) => ({ ...old, title: event.target.value }))} minLength={3} maxLength={140} required placeholder="e.g. Replacement laptops for operations"/></label><label>Budget<select value={form.budgetId} onChange={(event) => setForm((old) => ({ ...old, budgetId: event.target.value }))} required><option value="">Choose a budget</option>{budgets.map((budget) => <option key={budget.id} value={budget.id}>{budget.departmentName} · {budget.periodKey} · {money(budget.availableMinor, budget.currencyCode)} available</option>)}</select>{budgets.length === 0 && <small className="field-note">No budget is available yet. Ask your finance administrator to create one.</small>}</label><label>Requested amount ({currency})<input type="number" min="0.01" max="10000000000" step="0.01" value={form.amount} onChange={(event) => setForm((old) => ({ ...old, amount: event.target.value }))} required placeholder="0.00"/></label><label className="span-two">Business justification<textarea value={form.description} onChange={(event) => setForm((old) => ({ ...old, description: event.target.value }))} maxLength={2000} rows={4} placeholder="Explain the need, intended use, and expected benefit…"/></label></div><div className="form-hint"><span>ⓘ</span><p>Creating a request does not reserve funds. Budget is reserved only after an authorized approver accepts it.</p></div><div className="form-actions"><button type="button" className="button secondary" onClick={onCancel}>Cancel</button><button type="submit" className="button primary" disabled={loading || budgets.length === 0}>{loading ? 'Saving…' : 'Create draft'} <span>→</span></button></div></form></>;
}

function BudgetsPage({ budgets, departments, role, form, setForm, loading, onCreate, onEdit }: { budgets: Budget[]; departments: Department[]; role: Role; form: { departmentId: string; periodKey: string; limitAmount: string }; setForm: (updater: (old: { departmentId: string; periodKey: string; limitAmount: string }) => { departmentId: string; periodKey: string; limitAmount: string }) => void; loading: boolean; onCreate: (event: FormEvent) => void; onEdit: (budget: Budget) => void }) {
  return <><div className="page-heading"><div><p className="eyebrow">FINANCIAL CONTROLS</p><h1>Budgets</h1><p className="page-subtitle">Track allocation, reservations, and remaining capacity by department.</p></div></div>{role === 'finance_admin' && <form className="inline-budget-form" onSubmit={onCreate}><div><strong>Create a department budget</strong><p>One budget per department and monthly period.</p></div><label>Department<select required value={form.departmentId} onChange={(event) => setForm((old) => ({ ...old, departmentId: event.target.value }))}><option value="">Choose department</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label><label>Period<input type="month" required value={form.periodKey} onChange={(event) => setForm((old) => ({ ...old, periodKey: event.target.value }))}/></label><label>Limit amount<input type="number" min="0.01" step="0.01" required value={form.limitAmount} onChange={(event) => setForm((old) => ({ ...old, limitAmount: event.target.value }))} placeholder="0.00"/></label><button className="button primary" disabled={loading || !form.departmentId}>Create budget</button></form>}<section className="budget-card-grid">{budgets.map((budget) => { const ratio = BigInt(budget.limitMinor) > 0n ? Number(BigInt(budget.reservedMinor) * 10000n / BigInt(budget.limitMinor)) / 100 : 0; return <article className="budget-card" key={budget.id}><div className="budget-card-head"><div className="budget-card-icon">▥</div><span className="period-badge">{budget.periodKey}</span></div><h2>{budget.departmentName}</h2><p>{budget.currencyCode} allocation</p><div className="budget-big-value">{money(budget.limitMinor, budget.currencyCode)}</div><div className="progress-track large"><span style={{ width: `${Math.min(ratio, 100)}%` }}/></div><div className="budget-pair"><span>Reserved<strong>{money(budget.reservedMinor, budget.currencyCode)}</strong></span><span>Available<strong>{money(budget.availableMinor, budget.currencyCode)}</strong></span></div><div className="budget-card-footer"><span>{Math.min(ratio, 100).toFixed(0)}% committed</span>{role === 'finance_admin' && <button className="text-button" onClick={() => onEdit(budget)}>Edit limit ↗</button>}</div></article>; })}{budgets.length === 0 && <div className="panel empty-budget"><EmptyState title="No budgets configured" text={role === 'finance_admin' ? 'Create a budget to start accepting purchase requests.' : 'Your organization has not configured a budget for your department yet.'}/></div>}</section></>;
}

function RequestDetail({ request, events, role, currentUserId, currency, loading, canApprove, canCancel, onClose, onSubmit, onApprove, onReject, onCancel }: { request: PurchaseRequest; events: AuditEvent[]; role: Role; currentUserId: string; currency: string; loading: boolean; canApprove: boolean; canCancel: boolean; onClose: () => void; onSubmit: () => void; onApprove: () => void; onReject: () => void; onCancel: () => void }) {
  const isOwner = request.requesterUserId === currentUserId;
  return <div className="detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="detail-drawer" aria-label="Request details"><div className="detail-top"><div><span className="eyebrow">REQUEST DETAILS</span><p className="request-reference">RF-{request.id.slice(0, 8).toUpperCase()}</p></div><button className="icon-button" onClick={onClose} aria-label="Close details">×</button></div><span className={statusClass(request.status)}>{statusLabel(request.status)}</span><h2 className="detail-title">{request.title}</h2><p className="detail-description">{request.description || 'No business justification supplied.'}</p><div className="detail-amount"><span>Requested amount</span><strong>{money(request.amountMinor, request.currencyCode || currency)}</strong><small>{request.departmentName} · Requested by {request.requesterName}</small></div><div className="detail-info-grid"><div><span>Created</span><strong>{date(request.createdAt)}</strong></div><div><span>Submitted</span><strong>{date(request.submittedAt)}</strong></div><div><span>Budget period</span><strong>{request.periodKey ?? 'Current allocation'}</strong></div><div><span>Decision date</span><strong>{date(request.decidedAt)}</strong></div></div>{request.rejectionReason && <div className="rejection-note"><strong>Reason recorded</strong><p>{request.rejectionReason}</p></div>}
    <div className="detail-actions">{isOwner && request.status === 'draft' && <button className="button primary full-width" disabled={loading} onClick={onSubmit}>Submit for approval →</button>}{canApprove && <div className="two-actions"><button className="button secondary" disabled={loading} onClick={onReject}>Reject request</button><button className="button primary" disabled={loading} onClick={onApprove}>Approve & reserve</button></div>}{canCancel && <button className="button danger-outline full-width" disabled={loading} onClick={onCancel}>{request.status === 'approved' ? 'Cancel and release reservation' : 'Cancel request'}</button>}{role === 'approver' && request.status === 'submitted' && request.requesterUserId === currentUserId && <p className="policy-note">You cannot approve your own request.</p>}</div><div className="timeline-section"><div className="panel-heading"><div><h3>Activity history</h3><p>Recorded server-side events</p></div><span className="timeline-count">{events.length}</span></div>{events.length === 0 ? <p className="muted-note">No events are available.</p> : <ol className="timeline">{events.map((event) => <li key={event.id}><span className="timeline-dot"/><div><strong>{event.eventType.replaceAll('.', ' ')}</strong><p>{event.actorName} · {date(event.createdAt)}</p>{event.reason && <small>{event.reason}</small>}</div></li>)}</ol>}</div></aside></div>;
}

function ActivityPage({ events, loading }: { events: AuditEvent[]; loading: boolean }) { return <><div className="page-heading"><div><p className="eyebrow">AUDIT TRAIL</p><h1>Activity history</h1><p className="page-subtitle">Organization-level history of recorded budget and request events.</p></div></div><section className="panel activity-panel">{loading ? <LoadingRows/> : events.length === 0 ? <EmptyState title="No activity recorded" text="New budget and request events will appear here."/> : <ol className="timeline global-timeline">{events.map((event) => <li key={event.id}><span className="timeline-dot"/><div className="activity-content"><div><strong>{event.eventType.replaceAll('.', ' ')}</strong><span className="timeline-count">{date(event.createdAt)}</span></div><p>{event.actorName} ({event.actorEmail})</p>{event.requestId && <small>Request RF-{event.requestId.slice(0, 8).toUpperCase()}</small>}</div></li>)}</ol>}</section></>; }
function NavButton({ active, icon, label, count, onClick }: { active: boolean; icon: string; label: string; count?: number | undefined; onClick: () => void }) { return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick}><span className="nav-icon">{icon}</span><span>{label}</span>{count ? <small>{count}</small> : null}</button>; }
function pageTitle(page: Page) { return ({ overview: 'Overview', requests: 'Purchase requests', budgets: 'Budgets', activity: 'Audit activity', create: 'New request' })[page]; }
function statusLabel(status: string) { return status.charAt(0).toUpperCase() + status.slice(1); }
function errorMessage(error: unknown) { if (error instanceof ApiError) return `${error.message}${error.requestId ? ` (Reference: ${error.requestId})` : ''}`; return error instanceof Error ? error.message : 'Something went wrong. Try again.'; }
