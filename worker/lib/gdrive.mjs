// Upload finished clips to Google Drive with rclone (set up once by SETUP-GDRIVE.bat).
import { spawn } from 'node:child_process';
import fs from 'node:fs';

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// returns null when Google Drive is not connected (no rclone / no "gdrive" remote)
export async function driveReady(rclone) {
  if (!rclone || !fs.existsSync(rclone)) return null;
  const r = await run(rclone, ['listremotes']);
  return r.code === 0 && /^gdrive:/m.test(r.out) ? rclone : null;
}

// copy a local folder to gdrive:<remotePath>; returns { ok, error }
export async function uploadFolder(rclone, localDir, remotePath) {
  const r = await run(rclone, ['copy', localDir, `gdrive:${remotePath}`, '--transfers', '2', '--retries', '3', '--low-level-retries', '10']);
  const lines = r.err.trim().split(/\r?\n/).filter((l) => /ERROR|Failed/i.test(l) && !/client_id/.test(l));
  return r.code === 0 ? { ok: true } : { ok: false, error: (lines.pop() || r.err.trim().split(/\r?\n/).pop() || 'gagal').slice(0, 300) };
}
