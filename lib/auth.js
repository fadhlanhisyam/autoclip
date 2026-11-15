// Simple shared-password gate so strangers can't burn your API credits.
export function checkPassword(req) {
  const expected = (process.env.APP_PASSWORD || '').trim();
  if (!expected) return null; // no password configured
  const got = (req.headers.get('x-app-password') || '').trim();
  if (got !== expected) {
    return Response.json({ error: 'Password salah.' }, { status: 401 });
  }
  return null;
}
