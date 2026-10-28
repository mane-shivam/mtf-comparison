// Vercel serverless function: POST /api/refresh triggers the GitHub Actions refresh workflow.
//
// Env vars (Vercel project settings, never in the repo):
//   GITHUB_TOKEN      fine-grained token, Actions: read & write on this repo only
//   REFRESH_PASSCODE  short passcode the page asks for once
//   GITHUB_REPO       optional "owner/repo"; defaults to the repo Vercel deploys from
//   GITHUB_BRANCH     optional; defaults to "main"
//
// Rate limit: refuses if a run of the workflow started in the last 10 minutes or is
// still running. GitHub is the source of truth, so this needs no storage of its own.

import { timingSafeEqual } from 'node:crypto';

const WORKFLOW = 'refresh.yml';
const COOLDOWN_MS = 10 * 60 * 1000;

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST' });
  }

  const { GITHUB_TOKEN, REFRESH_PASSCODE } = process.env;
  const repo =
    process.env.GITHUB_REPO ||
    (process.env.VERCEL_GIT_REPO_OWNER && `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`);
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!GITHUB_TOKEN || !REFRESH_PASSCODE || !repo) {
    return res.status(500).json({ error: 'Refresh is not configured on the server' });
  }

  const body = await readBody(req);
  const pass = body.passcode ?? req.headers['x-refresh-passcode'];
  if (!sameSecret(pass, REFRESH_PASSCODE)) {
    return res.status(401).json({ error: 'Wrong passcode' });
  }

  const gh = (path, init = {}) =>
    fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mtf-compare',
        ...(init.headers || {}),
      },
    });

  const runs = await gh('/runs?per_page=1');
  if (!runs.ok) return res.status(502).json({ error: `GitHub: ${runs.status}` });
  const last = (await runs.json()).workflow_runs?.[0];
  if (last) {
    const age = Date.now() - new Date(last.created_at).getTime();
    if (last.status !== 'completed' || age < COOLDOWN_MS) {
      const mins = Math.max(1, Math.ceil((COOLDOWN_MS - age) / 60000));
      return res.status(429).json({
        error: last.status !== 'completed' ? 'A refresh is already running' : `Refreshed recently. Try again in ${mins} min`,
        runStatus: last.status,
      });
    }
  }

  const dispatch = await gh('/dispatches', { method: 'POST', body: JSON.stringify({ ref: branch }) });
  if (dispatch.status !== 204) {
    return res.status(502).json({ error: `GitHub dispatch failed: ${dispatch.status}` });
  }
  return res.status(202).json({ ok: true, startedAt: new Date().toISOString() });
}
