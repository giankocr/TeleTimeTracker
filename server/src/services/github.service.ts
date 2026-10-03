import { prisma } from '../db/prisma';
import { decryptSecret } from '../config/crypto';
import { env, githubToken } from '../config/env';
import { getSettingBool, SETTING_KEYS } from './settings.service';

/**
 * Integracion GitHub.
 * Obtiene commits y pull requests dentro de la ventana de tiempo de la tarea
 * para enriquecer el reporte final.
 */

export interface GithubCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  url: string;
  repo: string;
}

export interface GithubPullRequest {
  number: number;
  title: string;
  state: string;
  merged: boolean;
  url: string;
  repo: string;
  createdAt: string;
  updatedAt: string;
  author: string;
}

export interface GithubEnrichment {
  repos: string[];
  window: { from: string; to: string };
  commits: GithubCommit[];
  pullRequests: GithubPullRequest[];
  fetchedAt: string;
  errors?: string[];
}

const API = 'https://api.github.com';

async function githubFetch<T>(pathname: string, token: string): Promise<T> {
  const res = await fetch(`${API}${pathname}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'TeleTimeTracker/1.0',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status} en ${pathname}: ${body.slice(0, 180)}`);
  }
  return (await res.json()) as T;
}

/** Token a usar: el personal del usuario (cifrado) tiene prioridad sobre el global. */
function tokenFor(user: { githubToken: string | null }): string {
  const personal = decryptSecret(user.githubToken);
  return personal || githubToken();
}

export function parseRepos(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[,\n;]/)
    .map((r) => r.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''))
    .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
}

/** Repos efectivos: los del proyecto + (opcional) el del usuario. */
export async function reposFor(
  projectId: string | null,
  user: { githubUsername: string | null; githubToken: string | null } | null,
): Promise<string[]> {
  const repos = new Set<string>();
  if (projectId) {
    const project = await prisma.clientProject.findUnique({ where: { id: projectId } });
    parseRepos(project?.githubRepos).forEach((r) => repos.add(r));
  }
  if (!repos.size && user?.githubUsername) {
    repos.add(`${user.githubUsername}/*`);
  }
  return [...repos];
}

/**
 * Trae commits y PRs de los repos configurados dentro de [from, to].
 * `repos` puede contener "owner/*" para abarcar todos los repos del owner.
 */
export async function fetchActivity(
  repos: string[],
  from: Date,
  to: Date,
  token: string,
): Promise<GithubEnrichment> {
  const enrichment: GithubEnrichment = {
    repos,
    window: { from: from.toISOString(), to: to.toISOString() },
    commits: [],
    pullRequests: [],
    fetchedAt: new Date().toISOString(),
    errors: [],
  };
  if (!repos.length) return enrichment;

  const since = from.toISOString();
  const until = to.toISOString();

  for (const repo of repos) {
    try {
      if (repo.endsWith('/*')) {
        const owner = repo.slice(0, -2);
        const repoList = await githubFetch<Array<{ full_name: string; pushed_at: string }>>(
          `/users/${owner}/repos?per_page=100&sort=pushed`,
          token,
        );
        for (const r of repoList) {
          if (new Date(r.pushed_at) < from) continue;
          await collectRepo(enrichment, r.full_name, since, until, token);
        }
      } else {
        await collectRepo(enrichment, repo, since, until, token);
      }
    } catch (err) {
      enrichment.errors?.push(`${repo}: ${(err as Error).message}`);
    }
  }

  enrichment.commits.sort((a, b) => b.date.localeCompare(a.date));
  enrichment.commits = enrichment.commits.slice(0, 40);
  return enrichment;
}

async function collectRepo(
  enrichment: GithubEnrichment,
  fullName: string,
  since: string,
  until: string,
  token: string,
): Promise<void> {
  const commits = await githubFetch<
    Array<{ sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }>
  >(`/repos/${fullName}/commits?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=50`, token);

  for (const c of commits) {
    enrichment.commits.push({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0] ?? '',
      author: c.commit.author?.name ?? 'desconocido',
      date: c.commit.author?.date ?? '',
      url: c.html_url,
      repo: fullName,
    });
  }

  const sinceDate = since.slice(0, 10);
  const prs = await githubFetch<
    Array<{
      number: number;
      title: string;
      state: string;
      merged_at: string | null;
      html_url: string;
      created_at: string;
      updated_at: string;
      user: { login: string };
    }>
  >(`/repos/${fullName}/pulls?state=all&sort=updated&direction=desc&per_page=30`, token);

  for (const pr of prs) {
    const updated = pr.updated_at.slice(0, 10);
    if (updated < sinceDate) continue;
    enrichment.pullRequests.push({
      number: pr.number,
      title: pr.title,
      state: pr.merged_at ? 'merged' : pr.state,
      merged: Boolean(pr.merged_at),
      url: pr.html_url,
      repo: fullName,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      author: pr.user?.login ?? 'desconocido',
    });
  }
}

/**
 * Punto de entrada usado por el motor de tiempo al cerrar una tarea.
 * Devuelve null si GitHub esta deshabilitado o no hay repos configurados.
 */
export async function resolveGithubRepos(params: {
  userId: string;
  projectId: string | null;
  from: Date;
  to: Date;
}): Promise<GithubEnrichment | null> {
  const enabled = getSettingBool(SETTING_KEYS.GITHUB_ENRICH, env.GITHUB_ENRICH);
  if (!enabled) return null;

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { githubUsername: true, githubToken: true },
  });
  const repos = await reposFor(params.projectId, user);
  if (!repos.length) return null;

  const token = tokenFor(user ?? { githubToken: null });
  return fetchActivity(repos, params.from, params.to, token);
}

/** Formatea el enriquecimiento para el mensaje de Telegram. */
export function formatGithubSummary(data: GithubEnrichment | null): string {
  if (!data) return '';
  const lines: string[] = [];
  if (data.commits.length) {
    lines.push(`🔧 <b>Commits (${data.commits.length})</b>`);
    data.commits.slice(0, 8).forEach((c) => {
      lines.push(`• <code>${c.shortSha}</code> ${escape(c.message)} <i>(${c.repo})</i>`);
    });
  }
  if (data.pullRequests.length) {
    lines.push(`🔀 <b>Pull Requests (${data.pullRequests.length})</b>`);
    data.pullRequests.slice(0, 6).forEach((pr) => {
      lines.push(`• #${pr.number} ${escape(pr.title)} — <b>${pr.state}</b>`);
    });
  }
  return lines.join('\n');
}

const escape = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function parseGithubData(raw: string | null): GithubEnrichment | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GithubEnrichment;
  } catch {
    return null;
  }
}
