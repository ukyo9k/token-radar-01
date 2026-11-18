# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ukyo9k/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ukyo9k/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot of 758 protocols, finds the ones that record no token yet, and ranks them by an implied value — what a token would be worth if the protocol launched one at the valuation its already-trading peers carry. Every row also carries a concrete five-step farm plan, and the dashboard lets you search, filter and sort the board and open a detail view for any protocol.

## The model

```
implied value = TVL × category multiple × growth factor × age factor
```

- **TVL** is the protocol's own TVL from the snapshot.
- **Category multiple**: the median market-cap-to-TVL ratio of the token-bearing protocols in the same category, shrunk toward the global median with five phantom peers, so a thin category does not set its own multiple on a coin flip. A category with fewer than three trading peers uses the global median outright. Clamped to 0.05–2.00.
- **Growth factor**: the seven-day TVL change, clamped to −50%…+100%, as 1 + change ÷ 200. A week of −50% is worth 0.75, a week of +100% is worth 1.50.
- **Age factor**: 1 + 0.25 × (days listed ÷ 1095), capped at three years — a long track record with no token yet is worth more, because the launch, when it comes, has years of usage behind it.

Nothing in the model names a protocol in advance: every number is computed from the snapshot itself, and the same code on a different snapshot would rank a different board.

## Who reaches the board

A protocol reaches the board when DefiLlama records no token for it and it is not a bridge, liquid-staking or CEX product, carries no version marker or wrapped/staked word in its name, and is not named after an exchange. That is the house's own plausibility rule, applied to the five checks the snapshot supports. The watchlist is the floor, never the ceiling: 40 of the 198 rows are on it, and the other 158 are pre-token protocols below the floor that pass the same screen.

The board does not predict whether or when a token is issued, and its implied value is this entry's own claim. A protocol that records no token may still have one its DefiLlama record does not carry.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

`main.ts` (Node, standard library only, no network) reads the snapshot, writes the ranked board to `out/board.json`, the dashboard's data to `out/data.js`, copies `dashboard/` and `screenshots/` to `out/`, and writes `out/dossier.json`. Open `out/dashboard/index.html` in a browser to use the board. The run is deterministic: the same snapshot always writes the same bytes.

## Layout

- `main.ts` — the program: reads the snapshot, builds the board, writes the outputs.
- `lib/model.ts` — the snapshot parsing, the value model, the farm-step bank, the board builder and its checks.
- `lib/dossier.ts` — the dossier writer (makefun/dossier/v1): the screenshots plus a text of the dashboard's source.
- `dashboard/` — the page: `index.html`, `app.css`, `app.js`. Static, no network, no framework.
- `screenshots/` — three screenshots of the dashboard: the board, a detail view and a filtered view.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1gefbfp1&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
