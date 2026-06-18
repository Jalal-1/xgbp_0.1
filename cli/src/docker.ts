import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const projectRoot = path.resolve(new URL(import.meta.url).pathname, '..', '..', '..');
const composeFile = path.join(projectRoot, 'infra', 'standalone.yml');
const projectName = 'xgbp-local';
const localPorts = [9944, 8088, 6300] as const;

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

export async function localNetworkUp(): Promise<void> {
  if (!projectHasRunningContainers()) {
    await assertLocalPortsAvailable();
  }

  runDocker(['compose', '-p', projectName, '-f', composeFile, 'up', '-d']);
}

export function localNetworkDown(): void {
  runDocker(['compose', '-p', projectName, '-f', composeFile, 'down']);
}

export function localNetworkStatus(): void {
  runDocker(['compose', '-p', projectName, '-f', composeFile, 'ps']);
}

function projectHasRunningContainers(): boolean {
  const result = spawnSync('docker', ['compose', '-p', projectName, '-f', composeFile, 'ps', '--status', 'running', '-q'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  return result.status === 0 && result.stdout.trim().length > 0;
}

async function assertLocalPortsAvailable(): Promise<void> {
  const checks = await Promise.all(localPorts.map(async (port) => ({ port, available: await canBindPort(port) })));
  const usedPorts = checks.filter(({ available }) => !available).map(({ port }) => port);

  if (usedPorts.length > 0) {
    throw new Error(
      `Local network port(s) already in use: ${usedPorts.join(', ')}. Stop the other local Midnight stack, then retry.`,
    );
  }
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen({ host: '0.0.0.0', port });
  });
}
