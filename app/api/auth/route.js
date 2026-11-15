import { checkPassword } from '@/lib/auth';

export const runtime = 'nodejs';

// Lets the browser check the password before starting a long job.
export async function POST(req) {
  const denied = checkPassword(req);
  if (denied) return denied;
  return Response.json({ ok: true });
}
