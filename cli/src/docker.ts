import { spawnSync } from 'node:child_process';
import path from 'node:path';

const projectRoot = path.resolve(new URL(import.meta.url).pathname, '..', '..', '..');
const composeFile = path.join(projectRoot, 'infra', 'standalone.yml');
const projectName = 'mgbp-local';

function runDocker(args: string[]): void {
  const result = spawnSync('docker', args, {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} exited with ${result.status ?? 'unknown status'}`);
  }
}

export function localNetworkUp(): void {
  runDocker(['compose', '-p', projectName, '-f', composeFile, 'up', '-d']);
}

export function localNetworkDown(): void {
  runDocker(['compose', '-p', projectName, '-f', composeFile, 'down']);
}

export function localNetworkStatus(): void {
  runDocker(['compose', '-p', projectName, '-f', composeFile, 'ps']);
}

