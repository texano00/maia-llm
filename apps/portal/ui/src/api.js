export async function api(path, init = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
  });

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(body?.message ?? body?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body?.error;
    throw error;
  }

  return body;
}

export const requestSignInCode = (email) =>
  api("/v1/admin/code", { method: "POST", body: JSON.stringify({ email }) });

export const signIn = (email, code) =>
  api("/v1/admin/session", { method: "POST", body: JSON.stringify({ email, code }) });

export const signOut = () => api("/v1/admin/session", { method: "DELETE" });

export const currentSession = () =>
  api("/v1/admin/session").catch((error) => (error.status === 401 ? null : Promise.reject(error)));

export const catalogueStatus = () => api("/v1/admin/catalogue");
export const forceRefresh = () => api("/v1/admin/catalogue/refresh", { method: "POST" });

export const listUseCases = () => api("/v1/admin/use-cases").then((body) => body.useCases);
export const createUseCase = (input) =>
  api("/v1/admin/use-cases", { method: "POST", body: JSON.stringify(input) });
export const updateUseCase = (id, input) =>
  api(`/v1/admin/use-cases/${id}`, { method: "PUT", body: JSON.stringify(input) });
export const deleteUseCase = (id) => api(`/v1/admin/use-cases/${id}`, { method: "DELETE" });
export const reorderUseCases = (ids) =>
  api("/v1/admin/use-cases/order", { method: "PUT", body: JSON.stringify({ ids }) });

export const uploadImage = (contentType, base64) =>
  api("/v1/admin/assets", { method: "POST", body: JSON.stringify({ contentType, base64 }) });

export const listInstallations = () =>
  api("/v1/admin/installations").then((body) => body.installations);
export const revokeInstallation = (id) =>
  api(`/v1/admin/installations/${id}`, { method: "DELETE" });

export const listAudit = () => api("/v1/admin/audit").then((body) => body.entries);

export const listAccounts = (params = {}) => {
  const query = new URLSearchParams();
  if (params.query) {
    query.set("query", params.query);
  }
  query.set("limit", String(params.limit ?? 50));
  query.set("offset", String(params.offset ?? 0));
  return api(`/admin-api/accounts?${query.toString()}`);
};

export const changeCapability = (accountId, change) =>
  api(`/admin-api/accounts/${encodeURIComponent(accountId)}/capabilities`, {
    method: "POST",
    body: JSON.stringify({ ...change, confirm: true })
  });
