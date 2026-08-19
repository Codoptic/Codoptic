import { spawn } from 'node:child_process';

export interface BackgroundJob {
  jobId: string;
  pid?: number;
  command: string;
  startedAt: number;
  output: string;
  done: boolean;
}

const jobs = new Map<string, BackgroundJob>();

export function startBackgroundJob(command: string, pid?: number): BackgroundJob {
  const job: BackgroundJob = {
    jobId: `job:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    pid,
    command,
    startedAt: Date.now(),
    output: '',
    done: false,
  };
  jobs.set(job.jobId, job);
  return job;
}

export function appendJobOutput(jobId: string, chunk: string): BackgroundJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  job.output = `${job.output}${chunk}`.slice(-64_000);
  return job;
}

export function completeJob(jobId: string): BackgroundJob | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  job.done = true;
  return job;
}

export function matchNotifyPattern(output: string, pattern?: string): boolean {
  if (!pattern) return false;
  try {
    return new RegExp(pattern, 'm').test(output);
  } catch {
    return output.includes(pattern);
  }
}

export function getBackgroundJob(jobId: string): BackgroundJob | undefined {
  return jobs.get(jobId);
}

export function startDetachedWorker(command: string, cwd: string): BackgroundJob {
  const child = spawn(command, { cwd, detached: true, stdio: 'ignore', shell: true });
  child.unref();
  return startBackgroundJob(command, child.pid);
}
