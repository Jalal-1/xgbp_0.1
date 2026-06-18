import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { actorNames, shortHex, type ActorName } from '@xgbp/xgbp-contract';
import { deployXgbp } from './deploy.js';
import * as xgbp from './xgbp-api.js';
import type { NetworkConfig, NetworkName } from './config.js';
import { configureProviders } from './providers.js';
import type { DeployedXgbpContract, XgbpProviders } from './types.js';
import { buildWallet, type WalletContext } from './wallet.js';

type ActivityLevel = 'info' | 'pending' | 'success' | 'error';

type ActivityMessage = {
  level: ActivityLevel;
  text: string;
};

type TokenMetadata = {
  name: string;
  symbol: string;
  decimals: bigint;
};

type TuiSession = {
  walletContext: WalletContext;
  providers: XgbpProviders;
  contract: DeployedXgbpContract;
  token: TokenMetadata;
};

type TuiState = {
  networkName: NetworkName;
  network: NetworkConfig;
  rl: readline.Interface;
  session?: TuiSession;
  snapshot?: xgbp.ContractSnapshot;
  changedKeys: Set<string>;
  flashOn: boolean;
  spinnerFrame: number;
  liveStatus?: ActivityMessage;
  activity: ActivityMessage[];
};

const minWidth = 120;
const minHeight = 35;
const activityLimit = 3;
const spinnerFrames = ['-', '\\', '|', '/'];
const registryActors: ActorName[] = ['alice', 'bob'];

const ansi = {
  clear: '\x1b[2J\x1b[H',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  highlight: '\x1b[30;43m',
};

const actorColor: Record<ActorName, string> = {
  issuer: ansi.cyan,
  alice: ansi.magenta,
  bob: ansi.yellow,
};

const levelColor: Record<ActivityLevel, string> = {
  info: ansi.gray,
  pending: ansi.blue,
  success: ansi.green,
  error: ansi.red,
};

const paint = (value: string, color: string): string => `${color}${value}${ansi.reset}`;
const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const visibleLength = (value: string): number => stripAnsi(value).length;

const padVisible = (value: string, width: number): string => {
  const length = visibleLength(value);
  if (length >= width) return value;
  return `${value}${' '.repeat(width - length)}`;
};

const truncate = (value: string, width: number): string => {
  if (visibleLength(value) <= width) return value;
  const plain = stripAnsi(value);
  return `${plain.slice(0, Math.max(0, width - 3))}...`;
};

const center = (value: string, width: number): string => {
  const length = visibleLength(value);
  if (length >= width) return value;
  const left = Math.floor((width - length) / 2);
  return `${' '.repeat(left)}${value}${' '.repeat(width - length - left)}`;
};

const formatBox = (title: string, lines: string[], width: number, height: number, color = ansi.bold): string[] => {
  const inner = width - 2;
  const bodyLines = height - 4;
  const box = [`+${'-'.repeat(inner)}+`, `|${center(paint(title, color), inner)}|`, `+${'-'.repeat(inner)}+`];

  for (let i = 0; i < bodyLines; i += 1) {
    const line = lines[i] ?? '';
    box.push(`|${padVisible(truncate(line, inner), inner)}|`);
  }

  box.push(`+${'-'.repeat(inner)}+`);
  return box;
};

const joinColumns = (columns: string[][], gap = 2): string[] => {
  const height = Math.max(...columns.map((column) => column.length));
  const spacer = ' '.repeat(gap);
  const rows: string[] = [];

  for (let row = 0; row < height; row += 1) {
    rows.push(columns.map((column) => column[row] ?? '').join(spacer));
  }

  return rows;
};

const actorLabel = (actor: ActorName): string => {
  switch (actor) {
    case 'issuer':
      return 'Issuer';
    case 'alice':
      return 'Alice';
    case 'bob':
      return 'Bob';
  }
};

const formatUnits = (value: bigint, decimals: bigint): string => {
  if (decimals === 0n) return value.toLocaleString();

  const scale = 10n ** decimals;
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(Number(decimals), '0');
  return `${whole.toLocaleString()}.${fraction}`;
};

const key = (actor: ActorName, field: keyof xgbp.ActorStatus): string => `${actor}.${field}`;

const flash = (state: TuiState, id: string, value: string): string =>
  state.flashOn && state.changedKeys.has(id) ? paint(value, ansi.highlight) : value;

const boolView = (state: TuiState, id: string, value: boolean): string => {
  const rendered = paint(value ? 'yes' : 'no', value ? ansi.green : ansi.red);
  return flash(state, id, rendered);
};

const encrypted = (): string => paint('encrypted', ansi.gray);

const flattenSnapshot = (snapshot: xgbp.ContractSnapshot): Record<string, string> => {
  const flat: Record<string, string> = {
    kycRequired: String(snapshot.kycRequired),
    totalSupply: snapshot.totalSupply.toString(),
  };

  for (const actor of snapshot.actors) {
    flat[key(actor.actor, 'knownBalance')] = actor.knownBalance.toString();
    flat[key(actor.actor, 'registered')] = String(actor.registered);
    flat[key(actor.actor, 'kycApproved')] = String(actor.kycApproved);
    flat[key(actor.actor, 'frozen')] = String(actor.frozen);
  }

  return flat;
};

const rememberSnapshot = async (state: TuiState): Promise<void> => {
  if (state.session === undefined) return;

  // The TUI never invents balances or registry state. This snapshot is the
  // local private-state cache, updated only after real contract calls succeed.
  const previous = state.snapshot === undefined ? undefined : flattenSnapshot(state.snapshot);
  const next = await xgbp.snapshot(state.session.providers);
  const current = flattenSnapshot(next);
  const changed = new Set<string>();

  if (previous !== undefined) {
    for (const [id, value] of Object.entries(current)) {
      if (previous[id] !== value) changed.add(id);
    }
  }

  state.snapshot = next;
  state.changedKeys = changed;
};

const pushActivity = (state: TuiState, level: ActivityLevel, text: string): void => {
  state.activity = [...state.activity, { level, text }].slice(-activityLimit);
};

const setLiveStatus = (state: TuiState, level: ActivityLevel, text: string): void => {
  state.liveStatus = { level, text };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const animateWhile = async <T>(state: TuiState, operation: Promise<T>): Promise<T> => {
  const timer = setInterval(() => {
    state.spinnerFrame = (state.spinnerFrame + 1) % spinnerFrames.length;
    render(state);
  }, 250);

  try {
    return await operation;
  } finally {
    clearInterval(timer);
    state.spinnerFrame = 0;
  }
};

const runPending = async <T>(state: TuiState, message: string, operation: () => Promise<T>): Promise<T> => {
  setLiveStatus(state, 'pending', message);
  pushActivity(state, 'pending', message);
  render(state);
  return await animateWhile(state, operation());
};

const pulseChangedValues = async (state: TuiState): Promise<void> => {
  const changed = new Set(state.changedKeys);
  if (changed.size === 0) {
    render(state);
    return;
  }

  for (let i = 0; i < 8; i += 1) {
    state.changedKeys = changed;
    state.flashOn = i % 2 === 0;
    render(state);
    await sleep(180);
  }

  state.flashOn = false;
  state.changedKeys = new Set();
  render(state);
};

const renderStartup = (state: TuiState): string[] => [
  paint('XGBP TUI', ansi.bold),
  '',
  `Network: ${paint(state.networkName, ansi.cyan)}`,
  '',
  'Select action:',
  '',
  `  ${paint('1', ansi.cyan)}  Deploy new XGBP contract`,
  `  ${paint('2', ansi.cyan)}  Exit`,
  '',
  ...renderActivity(state),
];

const renderSmallScreen = (state: TuiState, width: number, height: number): string[] => {
  const actions =
    state.session === undefined
      ? ['1 Deploy new XGBP contract', '2 Exit']
      : [
          '1 Guided flow',
          '2 KYC/register actors',
          '3 Mint',
          '4 Transfer',
          '5 Freeze/unfreeze',
          '6 Burn',
          '7 Refresh',
          '8 Exit',
        ];

  return [
    `Terminal too small. Resize to at least ${minWidth}x${minHeight}.`,
    `Current size: ${width}x${height}.`,
    '',
    'Available actions:',
    ...actions.map((action) => `  ${action}`),
    '',
    'Resize for the fixed dashboard view.',
    '',
    ...renderActivity(state),
  ];
};

const actorStatus = (snapshot: xgbp.ContractSnapshot, actor: ActorName): xgbp.ActorStatus => {
  const status = snapshot.actors.find((candidate) => candidate.actor === actor);
  if (status === undefined) throw new Error(`Missing actor state for ${actor}`);
  return status;
};

const renderActorBox = (state: TuiState, actor: ActorName): string[] => {
  if (state.snapshot === undefined || state.session === undefined) return formatBox(actorLabel(actor), [], 38, 10);

  const status = actorStatus(state.snapshot, actor);
  const token = state.session.token;
  const balance = `${formatUnits(status.knownBalance, token.decimals)} ${token.symbol}`;
  const lines = [
    `Account     ${shortHex(status.accountId)}`,
    `Own bal     ${flash(state, key(actor, 'knownBalance'), balance)}`,
    actor === 'issuer'
      ? `Role        ${paint('admin/deployer', ansi.cyan)}`
      : `Status      R:${boolView(state, key(actor, 'registered'), status.registered)} K:${boolView(
          state,
          key(actor, 'kycApproved'),
          status.kycApproved,
        )} F:${boolView(state, key(actor, 'frozen'), status.frozen)}`,
    ...actorNames.map((other) => {
      const otherStatus = actorStatus(state.snapshot as xgbp.ContractSnapshot, other);
      const value =
        other === actor
          ? `${formatUnits(otherStatus.knownBalance, token.decimals)} ${token.symbol} (own)`
          : encrypted();
      return `${actorLabel(other).padEnd(10)} ${value}`;
    }),
  ];

  return formatBox(`${actorLabel(actor)} Chain View`, lines, 38, 10, actorColor[actor]);
};

const renderPublicBox = (state: TuiState): string[] => {
  if (state.snapshot === undefined || state.session === undefined) return formatBox('Public Contract View', [], 58, 10);

  const contractAddress = state.session.contract.deployTxData.public.contractAddress;
  const token = state.session.token;
  const lines = [
    `Address      ${truncate(contractAddress, 42)}`,
    `Token        ${token.name} (${token.symbol})`,
    `Decimals     ${token.decimals.toString()}`,
    `Supply       ${flash(state, 'totalSupply', `${formatUnits(state.snapshot.totalSupply, token.decimals)} ${token.symbol}`)}`,
    `KYC required ${boolView(state, 'kycRequired', state.snapshot.kycRequired)}`,
    ...actorNames.map((actor) => `${actorLabel(actor)} bal`.padEnd(13) + encrypted()),
  ];

  return formatBox('Public Contract View', lines, 58, 10, ansi.gray);
};

const renderRegistryBox = (state: TuiState): string[] => {
  if (state.snapshot === undefined) return formatBox('KYC / Freeze Registry', [], 58, 10);

  const lines = [
    `KYC required ${boolView(state, 'kycRequired', state.snapshot.kycRequired)}`,
    'Actor     Registered  KYC  Frozen',
    ...registryActors.map((actor) => {
      const status = actorStatus(state.snapshot as xgbp.ContractSnapshot, actor);
      return `${actorLabel(actor).padEnd(9)} ${padVisible(
        boolView(state, key(actor, 'registered'), status.registered),
        11,
      )}${padVisible(boolView(state, key(actor, 'kycApproved'), status.kycApproved), 7)}${boolView(
        state,
        key(actor, 'frozen'),
        status.frozen,
      )}`;
    }),
  ];

  return formatBox('KYC / Freeze Registry', lines, 58, 10, ansi.green);
};

const renderActivity = (state: TuiState): string[] => {
  const history =
    state.liveStatus === undefined
      ? state.activity
      : state.activity.filter((message) => message.level !== state.liveStatus?.level || message.text !== state.liveStatus.text);
  const messages = state.liveStatus === undefined ? history : [state.liveStatus, ...history];
  if (messages.length === 0) return [paint('No activity yet.', ansi.gray)];

  return messages.map((message, index) => {
    const isLivePending = index === 0 && state.liveStatus?.level === 'pending';
    const label = isLivePending ? `${spinnerFrames[state.spinnerFrame]} WAIT` : message.level.toUpperCase().padEnd(7);
    return `${paint(label, levelColor[message.level])} ${message.text}`;
  });
};

const renderDashboard = (state: TuiState): string[] => {
  const contractAddress = state.session?.contract.deployTxData.public.contractAddress;
  const header = [
    `${paint('XGBP TUI', ansi.bold)} | network ${paint(state.networkName, ansi.cyan)} | contract ${
      contractAddress === undefined ? paint('not deployed', ansi.gray) : truncate(contractAddress, 38)
    }`,
  ];

  return [
    ...header,
    ...joinColumns(actorNames.map((actor) => renderActorBox(state, actor))),
    '',
    ...joinColumns([renderPublicBox(state), renderRegistryBox(state)]),
    '',
    ...formatBox('Information / Activity', renderActivity(state), 118, 8, ansi.blue),
    '+--------------------------------------------------------------------------------------------------------------------+',
    `| ${paint('1', ansi.cyan)} Guided flow   ${paint('2', ansi.cyan)} KYC/register   ${paint('3', ansi.cyan)} Mint   ${paint(
      '4',
      ansi.cyan,
    )} Transfer   ${paint('5', ansi.cyan)} Freeze/unfreeze                         |`,
    `| ${paint('6', ansi.cyan)} Burn   ${paint('7', ansi.cyan)} Refresh   ${paint('8', ansi.cyan)} Exit                                                        |`,
    '+--------------------------------------------------------------------------------------------------------------------+',
  ];
};

const render = (state: TuiState): void => {
  const width = output.columns ?? 80;
  const height = output.rows ?? 24;

  if (width < minWidth || height < minHeight) {
    output.write(`${ansi.clear}${renderSmallScreen(state, width, height).join('\n')}\n`);
    return;
  }

  // Full-frame ANSI redraw keeps provider/prover progress inside the fixed UI.
  const lines = state.session === undefined ? renderStartup(state) : renderDashboard(state);
  output.write(`${ansi.clear}${lines.join('\n')}\n`);
};

const ask = async (state: TuiState, prompt: string): Promise<string> => {
  render(state);
  return (await state.rl.question(`${paint('> ', ansi.cyan)}${prompt}`)).trim();
};

const parseHolder = (value: string): ActorName | undefined => {
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'alice') return 'alice';
  if (normalized === '2' || normalized === 'bob') return 'bob';
  return undefined;
};

const askHolder = async (state: TuiState, label: string): Promise<ActorName | undefined> =>
  parseHolder(await ask(state, `${label} [1 alice, 2 bob]: `));

const askAmount = async (state: TuiState): Promise<bigint | undefined> => {
  const raw = await ask(state, 'Amount in base units: ');
  const amount = BigInt(raw);
  return amount > 0n ? amount : undefined;
};

const runStep = async (
  state: TuiState,
  actor: ActorName,
  description: string,
  operation: () => Promise<void>,
): Promise<boolean> => {
  try {
    await runPending(state, `Acting as ${actorLabel(actor)}: ${description}`, operation);
    await rememberSnapshot(state);
    setLiveStatus(state, 'success', `Acting as ${actorLabel(actor)}: ${description}`);
    pushActivity(state, 'success', `Acting as ${actorLabel(actor)}: ${description}`);
    await pulseChangedValues(state);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLiveStatus(state, 'error', `Acting as ${actorLabel(actor)}: ${description} failed: ${message}`);
    pushActivity(state, 'error', `Acting as ${actorLabel(actor)}: ${description} failed: ${message}`);
    render(state);
    return false;
  }
};

const requireSession = (state: TuiState): TuiSession => {
  if (state.session === undefined) throw new Error('Deploy a contract first.');
  return state.session;
};

const deployNew = async (state: TuiState): Promise<void> => {
  if (state.session !== undefined) {
    pushActivity(state, 'info', 'A contract is already active in this TUI session.');
    return;
  }

  const token: TokenMetadata = { name: 'XGBP', symbol: 'XGBP', decimals: 2n };
  let walletContext: WalletContext | undefined;

  try {
    walletContext = await runPending(state, 'Starting wallet setup for deployer/issuer...', () =>
      buildWallet(state.network, undefined, {
        printSeed: state.networkName !== 'local',
        onProgress: (message) => {
          setLiveStatus(state, 'pending', message);
          render(state);
        },
      }),
    );
    const providers = await runPending(state, 'Configuring providers: private state, indexer, proof server, ZK artifacts...', () =>
      configureProviders(walletContext as WalletContext, state.network),
    );
    const contract = await runPending(state, 'Deploying XGBP contract and publishing verifier keys...', () =>
      deployXgbp(providers, walletContext as WalletContext, state.networkName, {
        ...token,
        verifierKeyChunkSize: 8,
        onProgress: (message) => {
          setLiveStatus(state, 'pending', message);
          render(state);
        },
      }),
    );

    state.session = { walletContext, providers, contract, token };
    await rememberSnapshot(state);
    setLiveStatus(state, 'success', `XGBP deployed at ${contract.deployTxData.public.contractAddress}`);
    pushActivity(state, 'success', `XGBP deployed at ${contract.deployTxData.public.contractAddress}`);
  } catch (error) {
    await walletContext?.wallet.stop();
    const message = error instanceof Error ? error.message : String(error);
    setLiveStatus(state, 'error', `Deploy failed: ${message}`);
    pushActivity(state, 'error', `Deploy failed: ${message}`);
  }
};

const kycAndRegisterActors = async (state: TuiState): Promise<void> => {
  const session = requireSession(state);

  await runStep(state, 'issuer', 'set KYC required', () => xgbp.setKycRequired(session.providers, session.contract, true));

  for (const actor of registryActors) {
    const status = state.snapshot === undefined ? undefined : actorStatus(state.snapshot, actor);
    if (status?.kycApproved !== true) {
      await runStep(state, 'issuer', `set KYC approved for ${actorLabel(actor)}`, () =>
        xgbp.setKycApproved(session.providers, session.contract, actor, true),
      );
    }
  }

  for (const actor of registryActors) {
    const status = state.snapshot === undefined ? undefined : actorStatus(state.snapshot, actor);
    if (status?.registered !== true) {
      await runStep(state, actor, 'register wallet', () => xgbp.register(session.providers, session.contract, actor));
    }
  }
};

const guidedFlow = async (state: TuiState): Promise<void> => {
  const session = requireSession(state);

  await kycAndRegisterActors(state);
  await runStep(state, 'issuer', 'mint 1000 base units to Alice', () =>
    xgbp.mint(session.providers, session.contract, 'alice', 1000n),
  );
  await runStep(state, 'alice', 'transfer 125 base units to Bob', () =>
    xgbp.transfer(session.providers, session.contract, 'alice', 'bob', 125n),
  );
  await runStep(state, 'issuer', 'freeze Bob', () => xgbp.freeze(session.providers, session.contract, 'bob'));
  await runStep(state, 'alice', 'attempt transfer 10 base units to frozen Bob', () =>
    xgbp.transfer(session.providers, session.contract, 'alice', 'bob', 10n),
  );
  await runStep(state, 'issuer', 'unfreeze Bob', () => xgbp.unfreeze(session.providers, session.contract, 'bob'));
  await runStep(state, 'alice', 'transfer 10 base units to Bob', () =>
    xgbp.transfer(session.providers, session.contract, 'alice', 'bob', 10n),
  );
  await runStep(state, 'bob', 'burn 25 base units', () => xgbp.burn(session.providers, session.contract, 'bob', 25n));
};

const mint = async (state: TuiState): Promise<void> => {
  const session = requireSession(state);
  const actor = await askHolder(state, 'Mint recipient');
  const amount = await askAmount(state);

  if (actor === undefined || amount === undefined) {
    pushActivity(state, 'error', 'Mint cancelled: invalid actor or amount.');
    return;
  }

  await runStep(state, 'issuer', `mint ${amount.toString()} base units to ${actorLabel(actor)}`, () =>
    xgbp.mint(session.providers, session.contract, actor, amount),
  );
};

const transfer = async (state: TuiState): Promise<void> => {
  const session = requireSession(state);
  const from = await askHolder(state, 'Transfer sender');
  const to = await askHolder(state, 'Transfer recipient');
  const amount = await askAmount(state);

  if (from === undefined || to === undefined || amount === undefined) {
    pushActivity(state, 'error', 'Transfer cancelled: invalid actor or amount.');
    return;
  }

  await runStep(state, from, `transfer ${amount.toString()} base units to ${actorLabel(to)}`, () =>
    xgbp.transfer(session.providers, session.contract, from, to, amount),
  );
};

const freezeOrUnfreeze = async (state: TuiState): Promise<void> => {
  const session = requireSession(state);
  const actor = await askHolder(state, 'Freeze target');
  const mode = (await ask(state, 'Action [f freeze, u unfreeze]: ')).toLowerCase();

  if (actor === undefined || (mode !== 'f' && mode !== 'u')) {
    pushActivity(state, 'error', 'Freeze action cancelled: invalid input.');
    return;
  }

  if (mode === 'f') {
    await runStep(state, 'issuer', `freeze ${actorLabel(actor)}`, () => xgbp.freeze(session.providers, session.contract, actor));
    return;
  }

  await runStep(state, 'issuer', `unfreeze ${actorLabel(actor)}`, () => xgbp.unfreeze(session.providers, session.contract, actor));
};

const burn = async (state: TuiState): Promise<void> => {
  const session = requireSession(state);
  const actor = await askHolder(state, 'Burning actor');
  const amount = await askAmount(state);

  if (actor === undefined || amount === undefined) {
    pushActivity(state, 'error', 'Burn cancelled: invalid actor or amount.');
    return;
  }

  await runStep(state, actor, `burn ${amount.toString()} base units`, () =>
    xgbp.burn(session.providers, session.contract, actor, amount),
  );
};

const refresh = async (state: TuiState): Promise<void> => {
  await rememberSnapshot(state);
  setLiveStatus(state, 'success', 'Refreshed wallet private-state cache for active contract session.');
  pushActivity(state, 'success', 'Refreshed wallet private-state cache for active contract session.');
  await pulseChangedValues(state);
};

const dashboardLoop = async (state: TuiState): Promise<void> => {
  while (state.session !== undefined) {
    const choice = await ask(state, 'Select action: ');

    switch (choice) {
      case '1':
        await guidedFlow(state);
        break;
      case '2':
        await kycAndRegisterActors(state);
        break;
      case '3':
        await mint(state);
        break;
      case '4':
        await transfer(state);
        break;
      case '5':
        await freezeOrUnfreeze(state);
        break;
      case '6':
        await burn(state);
        break;
      case '7':
        await refresh(state);
        break;
      case '8':
        return;
      default:
        pushActivity(state, 'error', 'Unknown action.');
        break;
    }
  }
};

export const runTui = async (networkName: NetworkName, network: NetworkConfig): Promise<void> => {
  const rl = readline.createInterface({ input, output });
  const state: TuiState = {
    networkName,
    network,
    rl,
    changedKeys: new Set(),
    flashOn: false,
    spinnerFrame: 0,
    liveStatus: undefined,
    activity: [],
  };

  output.write(ansi.hideCursor);

  try {
    let done = false;
    while (!done) {
      const choice = await ask(state, 'Select action: ');

      switch (choice) {
        case '1':
          await deployNew(state);
          await dashboardLoop(state);
          done = true;
          break;
        case '2':
          done = true;
          break;
        default:
          pushActivity(state, 'error', 'Unknown action.');
          break;
      }
    }
  } finally {
    await state.session?.walletContext.wallet.stop();
    rl.close();
    output.write(ansi.showCursor);
  }
};
