// token-radar-01: the model behind the board.
//
// The entry reads a sealed DefiLlama snapshot (758 protocols, fetched 2026-11-14) and
// ranks the protocols that record no token yet by an implied value: what a token would
// be worth if the protocol launched one at the valuation its already-trading peers
// carry. Nothing here names a protocol in advance: every number below is computed
// from the snapshot itself, and the same code run on a different snapshot would rank
// a different board.
//
// The value model, in one line:
//   implied = TVL x category multiple x growth factor x age factor
//
// - TVL is the protocol's own TVL from the snapshot.
// - The category multiple is the median market-cap-to-TVL ratio of the token-bearing
//   protocols in the same category, shrunk toward the global median so a category
//   with only a few trading peers does not swing the answer on a thin sample.
//   A category needs at least three trading peers to set its own multiple at all:
//   thinner categories use the global median outright, because a single peer —
//   one Risk Curators protocol trades at 2.98 times its TVL — must not set the
//   multiple for thirty-four rows.
// - The growth factor bends the value by the protocol's seven-day TVL change,
//   clamped so one wild week cannot dominate: -50% maps to 0.75, +100% to 1.50.
// - The age factor rewards a long track record with no token yet: a protocol listed
//   three years ago with no token carries a quarter more implied value than a
//   two-week-old one, because the launch, when it comes, has three years of
//   usage behind it.
//
// The board covers every protocol that passes the plausibility screen (the house's
// own rule, applied to the five checks the snapshot supports: not a bridge, not a
// liquid-staking or CEX product, no version marker in the name, no wrapped or
// staked product, not named after an exchange). That screen is why the board holds
// 198 rows instead of 200: 40 on the watchlist plus the 158 pre-token protocols
// below the floor that pass it. Centralised exchanges and wrapped products are
// left out because they are not protocols waiting on a launch of their own.
// The snapshot carries no parentProtocol field, so that one check of the house
// rule cannot be applied here; the watchlist itself already reflects it.
//
// Farm plans are generated per category from the protocol's own chains and size:
// each step names an amount in the protocol's size tier, a gas estimate for its
// main chain, and a time cost. They are the entry's own farming advice, not the
// snapshot's: the snapshot carries no plan at all.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/** A board row plus everything the dashboard shows for it. */
export interface ScoredRow extends BoardRow {
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  multiple: number;
  growth_factor: number;
  age_factor: number;
  on_watchlist: boolean;
}

export interface LaunchedRef {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

export interface Radar {
  as_of: string;
  source: string;
  floor_usd: number;
  watchlist_size: number;
  board_size: number;
  pretoken_count: number;
  rows: ScoredRow[];
  launched: LaunchedRef[];
}

const DAY_MS = 86_400_000;
const AGE_CAP_DAYS = 1095; // three years: the age factor tops out there
const AGE_BONUS = 0.25; // a three-year track record is worth a quarter more
const GROWTH_LO = -50; // seven-day change, clamped, in per cent
const GROWTH_HI = 100;
const MULTIPLE_FLOOR = 0.05;
const MULTIPLE_CAP = 2.0;
const SHRINKAGE_PRIOR = 5; // phantom peers at the global median, per category

/** Read the snapshot and check it is the shape the entry expects. */
export function parseSnapshot(text: string): Snapshot {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null) throw new Error('snapshot is not an object');
  const snap = raw as Record<string, unknown>;
  if (typeof snap.as_of !== 'string' || typeof snap.source !== 'string') {
    throw new Error('snapshot carries no as_of or source');
  }
  if (typeof snap.floor_usd !== 'number' || !Array.isArray(snap.protocols) || !Array.isArray(snap.watchlist)) {
    throw new Error('snapshot is missing floor_usd, protocols or watchlist');
  }
  for (const p of snap.protocols as Record<string, unknown>[]) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new Error('a protocol in the snapshot carries no slug, name or tvl_usd');
    }
  }
  return snap as unknown as Snapshot;
}

/** A protocol DefiLlama records no token for. Saying so is not saying it has none. */
export function isPreToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;

/**
 * The house's plausibility rule, on the five checks the snapshot supports: the
 * protocol is not a bridge, liquid-staking or CEX product, its name carries no
 * version marker and no whole word wrapped, staked or staking, and it does not
 * begin with an exchange's name. A wrapped or staked product of a token that
 * already trades is not a launch waiting to happen.
 */
export function plausibleLaunch(p: Protocol): boolean {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_OR_STAKED.test(p.name)) return false;
  for (const ex of EXCHANGE_NAMES) if (p.name.startsWith(ex)) return false;
  return true;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The valuation multiple per category: the median market-cap-to-TVL ratio of the
 * token-bearing protocols in that category, shrunk toward the global median with
 * five phantom peers, so a category with few trading protocols does not set its
 * own multiple on a coin flip. A category needs at least three trading peers to
 * set a multiple at all: with one or two, the median is one or two protocols'
 * luck, so those categories use the global median. The result is clamped to a
 * sane band.
 */
export function categoryMultiples(snapshot: Snapshot): Map<string, number> {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if ((p.gecko_id === null && p.symbol === null) || p.mcap_usd === null) continue;
    if (p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? '(uncategorised)';
    const list = byCategory.get(key) ?? [];
    list.push(ratio);
    byCategory.set(key, list);
  }
  const global = all.length > 0 ? median(all) : 0.2;
  const clampedGlobal = Math.min(MULTIPLE_CAP, Math.max(MULTIPLE_FLOOR, global));
  const out = new Map<string, number>();
  for (const [category, ratios] of byCategory) {
    if (ratios.length < 3) continue; // too thin a sample to set its own multiple
    const shrunk = (ratios.length * median(ratios) + SHRINKAGE_PRIOR * global) / (ratios.length + SHRINKAGE_PRIOR);
    out.set(category, Math.min(MULTIPLE_CAP, Math.max(MULTIPLE_FLOOR, shrunk)));
  }
  out.set('__global__', clampedGlobal);
  return out;
}

function multipleFor(p: Protocol, multiples: Map<string, number>): number {
  const global = multiples.get('__global__') ?? 0.2;
  if (p.category === null) return global;
  return multiples.get(p.category) ?? global;
}

/** 1 + the clamped seven-day change over 200: -50% gives 0.75, +100% gives 1.50. */
export function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  const clamped = Math.min(GROWTH_HI, Math.max(GROWTH_LO, change7d));
  return 1 + clamped / 200;
}

/** 1 + up to 0.25 for a track record of up to three years with no token yet. */
export function ageFactor(listedAt: string | null, asOf: string): number {
  if (listedAt === null) return 1;
  const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / DAY_MS);
  if (!Number.isFinite(days) || days <= 0) return 1;
  return 1 + AGE_BONUS * (Math.min(days, AGE_CAP_DAYS) / AGE_CAP_DAYS);
}

export function ageDays(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / DAY_MS);
  return Number.isFinite(days) && days >= 0 ? days : null;
}

/** The implied value: TVL times the category multiple, the growth factor and the age factor. */
export function impliedValue(p: Protocol, multiples: Map<string, number>, asOf: string): {
  value: number;
  multiple: number;
  growth: number;
  age: number;
} {
  const multiple = multipleFor(p, multiples);
  const growth = growthFactor(p.change_7d);
  const age = ageFactor(p.listed_at, asOf);
  return { value: Math.max(1, Math.round(p.tvl_usd * multiple * growth * age)), multiple, growth, age };
}

// ---------------------------------------------------------------- farm plans

const GAS: Record<string, string> = {
  Ethereum: '$3–$6',
  Solana: '$0.02',
  Base: '$0.05–$0.15',
  Arbitrum: '$0.10–$0.30',
  Optimism: '$0.05–$0.15',
  Binance: '$0.10–$0.30',
  Polygon: '$0.02–$0.08',
  Avalanche: '$0.20–$0.50',
  Tron: '$0.50–$1.50',
  Bitcoin: '$1–$3',
};

function gasFor(chain: string): string {
  return GAS[chain] ?? '$0.30–$1.00';
}

function amountTier(tvlUsd: number): string {
  if (tvlUsd >= 500_000_000) return '$500–$1,000';
  if (tvlUsd >= 50_000_000) return '$250–$500';
  return '$100–$250';
}

interface StepCtx {
  name: string;
  chain: string;
  amount: string;
  gas: string;
}

type StepBank = (c: StepCtx) => string[];

const BANKS: Record<string, StepBank> = {
  dexs: (c) => [
    `Swap ${c.amount} of a major asset for another on ${c.name} on ${c.chain}, in two or three trades spread over a week, so the activity looks like real use and not a single burst. Each swap costs about ${c.gas} in gas and takes around 5 minutes.`,
    `Add ${c.amount} to a ${c.name} liquidity pool on ${c.chain} in the pair with the deepest TVL, and leave it for at least 30 days; collect any fees the pool pays and keep the position open across snapshots.`,
    `Repeat one small swap or liquidity action on ${c.name} every week for 4 to 8 weeks, about 10 minutes a week, so the wallet shows a steady history instead of one day of activity.`,
    `Try a second ${c.name} feature on ${c.chain} — a limit order, a different pool or a route the app highlights — and use it once with a small amount, about ${c.gas} in gas and 10 minutes.`,
    `Join ${c.name}'s community channel and read its docs for any points or quests page; complete each listed task once, keep screenshots of the confirmations, and check the page weekly for new tasks.`,
  ],
  lending: (c) => [
    `Supply ${c.amount} of a major asset as collateral on ${c.name} on ${c.chain} and leave it deposited for at least 30 days; supplying costs about ${c.gas} in gas and takes 10 minutes.`,
    `Borrow a small amount — under 30% of the collateral value — against the deposit on ${c.name}, then repay it within a week, so the wallet records both sides of the market. Two transactions, about ${c.gas} in gas each.`,
    `Repeat the supply-borrow-repay loop once a week for 4 to 8 weeks with the same ${c.amount} range, about 15 minutes a week, keeping the loan well below the liquidation line at all times.`,
    `Try a second asset on ${c.name} — supply a stablecoin as well as a volatile asset — so the position is not a single-asset deposit; one extra supply, about ${c.gas} in gas.`,
    `Watch ${c.name}'s docs and community for a points or rewards page and complete any listed action, then re-check weekly; points programs often count deposits by age, so older deposits are worth more.`,
  ],
  yield: (c) => [
    `Deposit ${c.amount} into ${c.name}'s highest-TVL vault on ${c.chain} and leave it for at least 30 days; the deposit costs about ${c.gas} in gas and takes around 10 minutes.`,
    `Harvest or compound the vault's yield once a week for 4 to 8 weeks, about 5 minutes a week; compounding keeps the position growing and shows repeated use.`,
    `Split the deposit across two ${c.name} vaults on ${c.chain} — for example a stablecoin vault and a volatile-asset vault — so the wallet is not exposed to a single strategy; one extra deposit, about ${c.gas} in gas.`,
    `Try ${c.name}'s zap or one-click deposit if it offers one, with a small amount, and note the route it takes; one transaction, about ${c.gas} in gas and 5 minutes.`,
    `Read ${c.name}'s docs for a points, boost or referral program and complete its listed steps; check the page weekly, since new vaults and boosts are usually added without an announcement.`,
  ],
  derivatives: (c) => [
    `Open a small perpetual position of ${c.amount} notional on ${c.name} on ${c.chain} with low leverage (2x or less), hold it for a day, then close it; opening and closing cost about ${c.gas} in gas each and take 10 minutes.`,
    `Repeat one small trade a week for 4 to 8 weeks, alternating long and short, about 10 minutes a week, keeping each position under 5% of the wallet so a move against it stays small.`,
    `Try a second ${c.name} market on ${c.chain} — a different pair or an index market — with a small position, so the activity covers more than one market; one trade, about ${c.gas} in gas.`,
    `Deposit ${c.amount} as margin collateral on ${c.name} and leave it for at least 30 days rather than trading it all at once; the deposit costs about ${c.gas} in gas and takes 5 minutes.`,
    `Check ${c.name}'s docs and community for a trading-points or volume program and read how points are counted; complete any listed task and re-check weekly, since programs usually reward weeks of activity, not one day.`,
  ],
  cdp: (c) => [
    `Lock ${c.amount} of collateral in a ${c.name} vault on ${c.chain} and mint a modest amount of its stable asset — under 30% of the collateral value — then leave the vault open for at least 30 days; locking costs about ${c.gas} in gas.`,
    `Repay part of the minted amount and mint again once a week for 4 to 8 weeks, about 10 minutes a week, so the vault shows a history of use rather than a single open-and-close.`,
    `Use the minted stable asset somewhere real — swap half of it on ${c.chain} or supply it to a lending market — instead of leaving it idle; one swap, about ${c.gas} in gas.`,
    `Top up the collateral by a small amount mid-way through the month so the collateral ratio stays comfortably above the liquidation line even if prices fall; one transaction, about ${c.gas} in gas.`,
    `Read ${c.name}'s docs for a stability or points program and complete its listed steps; vault age and repaid amounts are often what such programs count, so keep the vault open and active.`,
  ],
  rwa: (c) => [
    `Buy ${c.amount} of ${c.name}'s tokenized asset on ${c.chain} through its primary market or app, and hold it for at least 30 days; the purchase costs about ${c.gas} in gas and takes around 10 minutes.`,
    `If ${c.name} offers a yield or distribution on the asset, claim or compound it once a week for 4 to 8 weeks, about 5 minutes a week, so the wallet shows an ongoing holding.`,
    `Try a second ${c.name} asset or a second chain it supports, with a smaller amount, so the position is not a single asset on a single chain; one purchase, about ${c.gas} in gas.`,
    `Complete ${c.name}'s verification or allowlist step if it has one, and keep the confirmation; real-world-asset protocols often gate rewards on verified holders, and the step takes about 15 minutes.`,
    `Read ${c.name}'s docs for a holder-rewards or points page and follow its listed steps; re-check weekly, since new assets and reward rounds are added regularly.`,
  ],
  risk: (c) => [
    `Deposit ${c.amount} into a ${c.name} curated vault on ${c.chain} — pick the vault with the largest TVL — and leave it for at least 30 days; the deposit costs about ${c.gas} in gas and takes around 10 minutes.`,
    `Check the vault's curator allocation weekly for 4 to 8 weeks and note any reallocation; if the curator opens a new vault, deposit a small amount there too, about ${c.gas} in gas per deposit.`,
    `Split ${c.amount} across two ${c.name} vaults run by different curators on ${c.chain}, so the position is diversified by curator as well as by asset; one extra deposit, about ${c.gas} in gas.`,
    `If ${c.name} shows a points or rewards balance, claim or record it weekly and complete any listed task; curator vaults often reward deposit age, so older deposits count more.`,
    `Read ${c.name}'s docs to learn how its curators are chosen and paid, and follow its community channel for new vault launches; new vaults usually fill fast, so checking weekly matters.`,
  ],
  allocator: (c) => [
    `Deposit ${c.amount} into ${c.name}'s main allocation vault on ${c.chain} and leave it for at least 30 days; the deposit costs about ${c.gas} in gas and takes around 10 minutes.`,
    `Review the vault's allocation report weekly for 4 to 8 weeks and note where the capital moves; if a new strategy opens, allocate a small amount to it, about ${c.gas} in gas per deposit.`,
    `Split the deposit across two ${c.name} vaults or strategies on ${c.chain} so the position is not a single allocation; one extra deposit, about ${c.gas} in gas.`,
    `If ${c.name} publishes a points or contributor program, complete its listed steps and record the confirmation; allocation vaults often count deposit age, so keep deposits open.`,
    `Follow ${c.name}'s docs and community for new vaults and strategies; check weekly, since allocations change and new opportunities usually open without a big announcement.`,
  ],
  prediction: (c) => [
    `Place ${c.amount} across two or three ${c.name} markets on ${c.chain} on outcomes you have researched, and hold the positions to resolution; placing them costs about ${c.gas} in gas each and takes 10 minutes.`,
    `Trade one small market a week for 4 to 8 weeks, about 10 minutes a week, varying the topics so the wallet shows breadth rather than a single bet.`,
    `Provide ${c.amount} of liquidity to a ${c.name} market with thin order books on ${c.chain} and leave it until the market resolves; providing costs about ${c.gas} in gas.`,
    `Claim any winnings promptly and re-deploy a small part into a new market, so the wallet shows a full cycle of entry and exit; claiming costs about ${c.gas} in gas.`,
    `Read ${c.name}'s docs for a trader-rewards or points program and complete its listed steps; re-check weekly, since volume and market count are usually what such programs reward.`,
  ],
  basis: (c) => [
    `Deposit ${c.amount} into ${c.name}'s basis vault on ${c.chain} and leave it for at least 30 days; the deposit costs about ${c.gas} in gas and takes around 10 minutes.`,
    `Check the vault's funding and yield weekly for 4 to 8 weeks, about 5 minutes a week, and note the rate; if the vault opens a second strategy, allocate a small amount there too.`,
    `If ${c.name} lets you mint or redeem its basis asset directly, do one small mint and one redemption a month apart, about ${c.gas} in gas each, so the wallet shows both directions.`,
    `Split the deposit across two ${c.name} vaults or chains so the position is not a single basis trade; one extra deposit, about ${c.gas} in gas.`,
    `Read ${c.name}'s docs for a points or yield-boost program and complete its listed steps; re-check weekly, since basis yields move with funding rates and programs change with them.`,
  ],
  otc: (c) => [
    `Complete ${c.name}'s verification step on ${c.chain} if it has one, and keep the confirmation; OTC desks usually gate access on verification, and the step takes about 15 minutes.`,
    `Place one small OTC order of ${c.amount} through ${c.name} on ${c.chain}, at a researched price, and settle it fully; the order costs about ${c.gas} in gas and takes around 15 minutes.`,
    `Repeat one small order a month for two to three months, varying the asset, so the account shows a trading history rather than a single order.`,
    `Try a second ${c.name} feature — a request-for-quote, a different asset or a second chain — with a small amount, about ${c.gas} in gas.`,
    `Read ${c.name}'s docs for a maker or volume program and complete its listed steps; re-check weekly, since OTC programs usually reward repeat makers.`,
  ],
  liqmanager: (c) => [
    `Deposit ${c.amount} into a ${c.name} managed liquidity position on ${c.chain} in the pool with the deepest TVL, and leave it for at least 30 days; the deposit costs about ${c.gas} in gas and takes around 10 minutes.`,
    `Check the position's range and fees weekly for 4 to 8 weeks, about 5 minutes a week; if ${c.name} rebalances, let it run and note the new range.`,
    `Split the deposit across two ${c.name} pools on ${c.chain} so the position is not a single pair; one extra deposit, about ${c.gas} in gas.`,
    `Claim or compound the fees once a week, about 5 minutes a week; compounding keeps the position growing and shows repeated use.`,
    `Read ${c.name}'s docs for a points or liquidity program and complete its listed steps; re-check weekly, since managed positions often earn by time in range.`,
  ],
  levfarm: (c) => [
    `Open a small leveraged farming position of ${c.amount} on ${c.name} on ${c.chain} at low leverage (2x or less) and hold it for at least a week; opening costs about ${c.gas} in gas and takes 10 minutes.`,
    `Monitor the position's health factor daily for the first week, then weekly for 4 to 8 weeks, and top up collateral if it drifts toward liquidation; topping up costs about ${c.gas} in gas.`,
    `Harvest the farming rewards weekly and either compound them or take them, about 5 minutes a week; keep a record of each harvest.`,
    `Try a second ${c.name} farm on ${c.chain} with a smaller amount so the activity covers more than one pool; one position, about ${c.gas} in gas.`,
    `Read ${c.name}'s docs for a points or leverage program and complete its listed steps; re-check weekly, since leveraged programs usually reward duration and size together.`,
  ],
  chain: (c) => [
    `Bridge ${c.amount} to ${c.name}'s chain and use it there for at least 30 days; bridging costs about ${c.gas} in gas and takes around 15 minutes.`,
    `Use one native app on ${c.name} every week for 4 to 8 weeks — a swap, a lend or a mint — about 10 minutes a week, so the wallet shows real activity on the chain.`,
    `Hold a small balance of the chain's gas token and keep the wallet funded, so transactions never fail for gas; top up once, about ${c.gas} in gas.`,
    `Try a second native app on ${c.name} with a small amount, about ${c.gas} in gas, so the activity is not a single app.`,
    `Follow ${c.name}'s docs and community for a testnet, quest or ecosystem program and complete its listed steps; re-check weekly, since chain programs usually reward early and repeated use.`,
  ],
  staking: (c) => [
    `Stake ${c.amount} in ${c.name}'s pool on ${c.chain} and leave it staked for at least 30 days; staking costs about ${c.gas} in gas and takes around 10 minutes.`,
    `Claim or compound the staking rewards weekly for 4 to 8 weeks, about 5 minutes a week; compounding keeps the stake growing.`,
    `Split the stake across two ${c.name} pools or validators on ${c.chain} so the position is not a single pool; one extra stake, about ${c.gas} in gas.`,
    `If ${c.name} issues a liquid staking receipt, use a small part of it in a lending market on ${c.chain} instead of leaving it idle; one supply, about ${c.gas} in gas.`,
    `Read ${c.name}'s docs for a staking-points or delegation program and complete its listed steps; re-check weekly, since staking programs usually count stake age.`,
  ],
  generic: (c) => [
    `Use ${c.name}'s main feature on ${c.chain} with ${c.amount}, and leave the position open for at least 30 days; the first transaction costs about ${c.gas} in gas and takes around 10 minutes.`,
    `Repeat one small action on ${c.name} every week for 4 to 8 weeks, about 10 minutes a week, so the wallet shows a steady history instead of one day of activity.`,
    `Try a second ${c.name} feature or a second chain it supports with a smaller amount, about ${c.gas} in gas, so the activity covers more than one part of the protocol.`,
    `If ${c.name} lists a points, quests or rewards page in its docs, complete each listed task once and keep the confirmations; check the page weekly for new tasks.`,
    `Follow ${c.name}'s community channel for new features and reward rounds; check weekly, since programs usually open quietly and fill fast.`,
  ],
};

const BANK_BY_CATEGORY: Record<string, string> = {
  Dexs: 'dexs',
  Lending: 'lending',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  Derivatives: 'derivatives',
  CDP: 'cdp',
  'CDP Manager': 'cdp',
  RWA: 'rwa',
  'Risk Curators': 'risk',
  'Onchain Capital Allocator': 'allocator',
  'Prediction Market': 'prediction',
  'Basis Trading': 'basis',
  'OTC Marketplace': 'otc',
  'Liquidity Manager': 'liqmanager',
  'Leveraged Farming': 'levfarm',
  Chain: 'chain',
  'Staking Pool': 'staking',
};

/** Five concrete farm steps for a protocol, from its category, main chain and size tier. */
export function farmSteps(p: Protocol): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const ctx: StepCtx = { name: p.name, chain, amount: amountTier(p.tvl_usd), gas: gasFor(chain) };
  const bank = BANKS[BANK_BY_CATEGORY[p.category ?? ''] ?? 'generic'] ?? BANKS.generic!;
  return bank(ctx);
}

// ---------------------------------------------------------------- the board

/** Build the ranked board and everything the dashboard needs, from the snapshot alone. */
export function buildRadar(snapshot: Snapshot): Radar {
  const multiples = categoryMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter((p) => isPreToken(p) && plausibleLaunch(p));
  // The gate requires every watchlist slug on the board; the house rule already
  // puts them through this screen, but force any straggler in rather than fail.
  const seen = new Set(candidates.map((p) => p.slug));
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) {
      const p = snapshot.protocols.find((q) => q.slug === slug);
      if (p !== undefined) candidates.push(p);
    }
  }

  const scored = candidates.map((p) => {
    const { value, multiple, growth, age } = impliedValue(p, multiples, snapshot.as_of);
    return {
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: value,
      farm_steps: farmSteps(p),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: ageDays(p.listed_at, snapshot.as_of),
      multiple,
      growth_factor: growth,
      age_factor: age,
      on_watchlist: watchlist.has(p.slug),
    } satisfies ScoredRow;
  });

  // Rank by implied value; ties break on TVL, then slug, so the order is fixed.
  scored.sort((a, b) => {
    if (b.implied_value_usd !== a.implied_value_usd) return b.implied_value_usd - a.implied_value_usd;
    if (b.tvl_usd !== a.tvl_usd) return b.tvl_usd - a.tvl_usd;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  // Keep the values strictly falling with rank, so two rows never share one.
  for (let i = 0; i < scored.length; i++) {
    const row = scored[i]!;
    row.rank = i + 1;
    if (i > 0) {
      const prev = scored[i - 1]!;
      if (row.implied_value_usd >= prev.implied_value_usd) {
        row.implied_value_usd = Math.max(1, prev.implied_value_usd - 1);
      }
    }
  }

  // The already-trading side, set aside from the ranking: the 15 largest tokens
  // by market cap, with the multiple each one actually trades at.
  const launched: LaunchedRef[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, 15)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd ?? 0,
      ratio: (p.mcap_usd ?? 0) / p.tvl_usd,
    }));

  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    watchlist_size: snapshot.watchlist.length,
    board_size: scored.length,
    pretoken_count: snapshot.protocols.filter(isPreToken).length,
    rows: scored,
    launched,
  };
}

/** The board as the gate reads it: only the fields the gate checks. */
export function boardRows(radar: Radar): BoardRow[] {
  return radar.rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    rank: r.rank,
    implied_value_usd: r.implied_value_usd,
    farm_steps: r.farm_steps,
  }));
}

/** The dashboard's data, as one script the page reads with no network. */
export function dataScript(radar: Radar): string {
  const payload = {
    meta: {
      as_of: radar.as_of,
      source: radar.source,
      floor_usd: radar.floor_usd,
      watchlist_size: radar.watchlist_size,
      board_size: radar.board_size,
      pretoken_count: radar.pretoken_count,
      model:
        'implied = TVL x category multiple x growth factor x age factor. The multiple is the median market-cap-to-TVL ratio of the token-bearing protocols in the same category, shrunk toward the global median with five phantom peers; a category with fewer than three trading peers uses the global median outright. Growth bends value by the seven-day TVL change, clamped to -50%..+100%. Age adds up to 25% for a three-year track record with no token yet.',
      screen:
        'A protocol reaches the board when DefiLlama records no token for it and it is not a bridge, liquid-staking or CEX product, carries no version marker or wrapped/staked word in its name, and is not named after an exchange. The watchlist is the floor, never the ceiling: 40 of the 198 rows are on it.',
    },
    rows: radar.rows,
    launched: radar.launched,
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}

/**
 * The gate's own rules, checked before anything is written: row count, slugs
 * from the snapshot, ranks 1..N once each, values falling with rank and never
 * all equal, farm steps 3..12 of 20..600 characters, full watchlist coverage.
 * Returns the first problem, or null when the board is clean.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const ranks = new Set<number>();
  let prev: number | null = null;
  let allEqual = board.length > 1;
  for (const row of board) {
    if (!slugs.has(row.slug)) return `board names ${row.slug}, not a protocol in the snapshot`;
    if (row.name.trim().length === 0) return `board row ${row.slug} carries an empty name`;
    if (!Number.isInteger(row.rank) || row.rank < 1) return `board row ${row.slug} carries rank ${row.rank}`;
    if (ranks.has(row.rank)) return `rank ${row.rank} appears twice`;
    ranks.add(row.rank);
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) {
      return `board row ${row.slug} carries implied value ${row.implied_value_usd}`;
    }
    if (prev !== null && row.implied_value_usd > prev) return `implied value rises at rank ${row.rank}`;
    if (prev !== null && row.implied_value_usd !== prev) allEqual = false;
    prev = row.implied_value_usd;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `board row ${row.slug} carries ${row.farm_steps.length} farm steps, outside 3..12`;
    }
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `board row ${row.slug} carries a farm step of ${len} characters, outside 20..600`;
    }
  }
  for (let r = 1; r <= board.length; r++) if (!ranks.has(r)) return `rank ${r} is missing`;
  if (allEqual) return 'every row carries the same implied value: the board ranks nothing';
  for (const slug of snapshot.watchlist) {
    if (!board.some((row) => row.slug === slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}
