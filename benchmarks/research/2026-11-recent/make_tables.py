# ruff: noqa: E501  (wide result tables and formulas read better unwrapped)
"""Print the tables used in report.md from results.json (every number in the report comes from here).

Usage: uv run --project compiler python benchmarks/research/2026-11-recent/make_tables.py > tables.md
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
R = json.loads((HERE / "results.json").read_text())
TOKENS = ("SOL", "JUP", "BONK", "KMNO")


def pct(x, nd=1):
    return "n/a" if x is None or x != x else f"{x * 100:.{nd}f}%"


def f(x, nd=1):
    return "n/a" if x is None or x != x else f"{x:,.{nd}f}"


def px(x):
    return f"{x:.6g}"


def lp_row(token, hz, mode, cfg, floor=0.05, curve="default", budget="realistic+keeper"):
    for r in R["lp_summary"]:
        if (r["token"], r["horizon"], r["fee_mode"], r["config"]) == (token, hz, mode, cfg) and (
                cfg == "none" or (r["floor"] == floor and r["curve"] == curve and r["budget"] == budget)):
            return r
    return None


out = []
P = out.append

P("## Regime\n")
P("| token | window (UTC) | open | close | return | low | max drawdown (peak -> trough) | vol (daily, ann.) | "
  "vol (hourly, ann.) | prior 30d vol (daily) | Jan-Oct vol (daily) | days with abs move > 5% |")
P("|---|---|---|---|---|---|---|---|---|---|---|---|")
for t in TOKENS:
    g = R["regimes"][t]
    ctx = g.get("context_jan_oct")
    P(f"| {t} | {g['start'][:10]} to {g['end'][:10]} | {px(g['open'])} | {px(g['close'])} | {pct(g['return'])} | "
      f"{px(g['low'])} | {pct(g['max_drawdown'])} ({g['drawdown_peak'][:10]} -> {g['drawdown_trough'][:10]}) | "
      f"{pct(g['vol_1d'], 0)} | {pct(g['vol_1h'], 0)} | {pct(g['prior_30d']['vol_1d'], 0)} | "
      f"{pct(ctx['vol_1d'], 0) if ctx else 'n/a'} | {g['days_abs_move_gt_5pct']} |")
P("")
P("| token | weekly returns (week starting) | biggest daily moves |")
P("|---|---|---|")
for t in TOKENS:
    g = R["regimes"][t]
    wk = ", ".join(f"{w['start'][5:]} {pct(w['return'])}" for w in g["weekly_returns"])
    mv = ", ".join(f"{m['date'][5:]} {pct(m['return'])}" for m in g["biggest_daily_moves"])
    P(f"| {t} | {wk} | {mv} |")
P("")
for t in ("SOL", "JUP"):
    c = R["regimes"][t].get("context_jan_oct")
    if c:
        P(f"- {t} Jan-Oct 7-day return 5th/95th percentile: {pct(c['r7_p5'])} / {pct(c['r7_p95'])}")
iv = R["deribit"]["sol_iv_daily_atm"]
win = {k: v for k, v in iv.items() if k >= R["regimes"]["SOL"]["start"][:10]}
if win:
    vals = sorted(v["median_iv"] for v in win.values())
    lo_d = min(win, key=lambda k: win[k]["median_iv"])
    hi_d = max(win, key=lambda k: win[k]["median_iv"])
    P(f"- Deribit SOL_USDC near-the-money IV (daily median of trades, strike/index 0.9-1.1, 2-60 days): "
      f"{len(win)} days, min {pct(vals[0], 0)} ({lo_d}), median {pct(vals[len(vals) // 2], 0)}, max {pct(vals[-1], 0)} "
      f"({hi_d}); {R['deribit']['meta'].get('n_trades')} SOL option trades with IV since 2026-09-01.")
P("")

for mode in ("arb-band", "band+noise"):
    P(f"## LPs, fee model {mode}: FORGE LP (B) vs plain Orca LP (A) vs HODL, default pricing, realistic budgets + keeper\n")
    P("| token | windows | demand | n | B >= A | extra median bps | extra min bps | APR A median | APR B median | "
      "A-HODL median bps | B-HODL median bps | avg util | B >= A without keeper | extra median without keeper |")
    P("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for t in TOKENS:
        for hz in ("7d", "30d", "56d"):
            for cfg in ("none", "u20-short", "u50-short", "u80-short", "u20-long", "u50-long", "u80-long"):
                r = lp_row(t, hz, mode, cfg)
                if not r:
                    continue
                nk = lp_row(t, hz, mode, cfg, budget="realistic") if cfg != "none" else None
                P(f"| {t} | {hz} | {cfg} | {r['n']} | {pct(r['share_B_ge_A'], 0)} | {f(r['extra_bps_median'])} | "
                  f"{f(r['extra_bps_min'])} | {pct(r['apr_a_median'], 0)} | {pct(r['apr_b_median'], 0)} | "
                  f"{f(r['a_hodl_bps_median'])} | {f(r['b_hodl_bps_median'])} | {pct(r['util_mean'], 0)} | "
                  f"{pct(nk['share_B_ge_A'], 0) if nk else ''} | {f(nk['extra_bps_median']) if nk else ''} |")
    P("")

P("## LP pricing sweep: median extra (B - A, bps of capital) over 7-day windows, u50-short, keeper\n")
for mode in ("arb-band", "band+noise"):
    P(f"Fee model {mode}\n")
    curves = list(R["assumptions"]["curves"])
    P("| token | floor | " + " | ".join(curves) + " |")
    P("|---|---|" + "---|" * len(curves))
    for t in TOKENS:
        for fl in R["assumptions"]["floors"]:
            vals = [lp_row(t, "7d", mode, "u50-short", fl, c) for c in curves]
            P(f"| {t} | {pct(fl, 0)} | " + " | ".join(f(v["extra_bps_median"]) if v else "" for v in vals) + " |")
    P("")
P("Same, u80-long (heaviest demand), arb-band\n")
curves = list(R["assumptions"]["curves"])
P("| token | floor | " + " | ".join(curves) + " |")
P("|---|---|" + "---|" * len(curves))
for t in TOKENS:
    for fl in R["assumptions"]["floors"]:
        vals = [lp_row(t, "7d", "arb-band", "u80-long", fl, c) for c in curves]
        P(f"| {t} | {pct(fl, 0)} | " + " | ".join(f(v["extra_bps_median"]) if v else "" for v in vals) + " |")
P("")

P("## Borrowers: 90% floor (one borrowed bucket around 0.9 x spot), $10,000 of token, default pricing, u = 0.5\n")
P("| token | tenor | starts | floor part $ | FORGE premium median $ (mean, max) | fee part binds | fair $ (trailing 30d RV) "
  "| premium / fair median | fair $ (Deribit IV) | premium / fair (IV) | fair $ (ex-post RV) | premium / fair (ex-post) "
  "| FORGE implied vol median |")
P("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for t in TOKENS:
    for tn in ("7d", "30d"):
        S = R["hedge_summary"].get(f"{t}/{tn}")
        if not S:
            continue
        d = S["default/arb-band/u50"]
        rv, ivv, ep = d.get("vs_rv_trailing30", {}), d.get("vs_deribit_iv", {}), d.get("vs_rv_expost", {})
        P(f"| {t} | {tn} | {S['n_starts']} | {f(d['floor_usd'], 2)} | {f(d['premium_usd_median'])} "
          f"({f(d['premium_usd_mean'])}, {f(d['premium_usd_max'])}) | {pct(d['share_fee_part_binds'], 0)} | "
          f"{f(rv.get('fair_usd_median'))} | {f(rv.get('ratio_median'), 2)} | {f(ivv.get('fair_usd_median'))} | "
          f"{f(ivv.get('ratio_median'), 2)} | {f(ep.get('fair_usd_median'))} | {f(ep.get('ratio_median'), 2)} | "
          f"{pct(rv.get('forge_implied_vol_median'), 0)} |")
P("")
P("Premium by utilization (median $, arb-band / band+noise):\n")
P("| token | tenor | u20 | u50 | u80 |")
P("|---|---|---|---|---|")
for t in TOKENS:
    for tn in ("7d", "30d"):
        S = R["hedge_summary"].get(f"{t}/{tn}")
        if S:
            P(f"| {t} | {tn} | " + " | ".join(
                f"{f(S[f'default/arb-band/u{u}']['premium_usd_median'])} / "
                f"{f(S[f'default/band+noise/u{u}']['premium_usd_median'])}" for u in (20, 50, 80)) + " |")
P("")
P("Realized outcome, default pricing, arb-band, u = 0.5 (payoff at expiry; hedge held to expiry):\n")
P("| token | tenor | ITM at expiry | path touched strike | payoff mean $ | premium mean $ | net mean $ | net > 0 "
  "| unhedged P&L mean $ | worst unhedged $ | worst hedged $ |")
P("|---|---|---|---|---|---|---|---|---|---|---|")
for t in TOKENS:
    for tn in ("7d", "30d"):
        S = R["hedge_summary"].get(f"{t}/{tn}")
        if S:
            o = S["outcome_default_arbband_u50"]
            P(f"| {t} | {tn} | {pct(o['share_put_in_the_money_at_expiry'], 0)} | {pct(o['share_path_touched_strike'], 0)} | "
              f"{f(o['payoff_usd_mean'])} | {f(o['premium_usd_mean'])} | {f(o['net_usd_mean'])} | "
              f"{pct(o['share_net_positive'], 0)} | {f(o['unhedged_pnl_usd_mean'])} | {f(o['unhedged_pnl_usd_min'])} | "
              f"{f(o['hedged_pnl_usd_min'])} |")
P("")
P("Collar 90/112 (borrowed put bucket + provided call bucket), medians, $ (reference: trailing 30d RV):\n")
P("| token | tenor | FORGE put premium - call-leg fees | call-leg fees | fair value of upside given away | "
  "FORGE economic cost | fair put | fair collar net (put - call) |")
P("|---|---|---|---|---|---|---|---|")
for t in TOKENS:
    for tn in ("7d", "30d"):
        S = R["hedge_summary"].get(f"{t}/{tn}")
        c = S and S.get("collar_vs_rv_trailing30")
        if c:
            P(f"| {t} | {tn} | {f(c['forge_net_cash_usd_median'])} | {f(c['call_fees_usd_median'])} | "
              f"{f(c['fair_call_giveaway_usd_median'])} | {f(c['forge_economic_cost_usd_median'])} | "
              f"{f(c['fair_put_usd_median'])} | {f(c['fair_collar_net_usd_median'])} |")
P("")
P("Fair floor rate (Black-Scholes value / (notional x tenor), annualized; median over starts) by strike:\n")
P("| token | tenor | vol ref | 75% | 80% | 85% | 90% | 95% |")
P("|---|---|---|---|---|---|---|---|")
for t in TOKENS:
    for tn in ("7d", "30d"):
        S = R["hedge_summary"].get(f"{t}/{tn}")
        if S:
            for ref, v in S["fair_floor_rate_median"].items():
                if ref in ("rv_trailing30", "deribit_iv"):
                    P(f"| {t} | {tn} | {ref} | " + " | ".join(pct(v[m], 0) for m in ("0.75", "0.80", "0.85", "0.90",
                                                                                         "0.95")) + " |")
P("")
P("## Borrowers ex ante: GBM at the reference vol, 90% put, expected FORGE premium vs Black-Scholes\n")
P("| token | tenor | vol ref | sigma | paths | BS fair $ | MC payoff mean $ (se) | E[forgone arb fees] / fair | "
  "E[forgone, band+noise u50] / fair | E[premium]/fair default u50 arb-band | flat m=1 u20 | default u80 | "
  "default u50 band+noise |")
P("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for k, g in R["gbm_exante"].items():
    t, tn, lab = k.split("/")
    gr = g["grid"]
    P(f"| {t} | {tn} | {lab} | {pct(g['sigma'], 0)} | {g['n_paths']} | {f(g['fair_put'])} | {f(g['mc_payoff_mean'])} "
      f"({f(g['mc_payoff_se'])}) | {f(g['forgone_arb_to_fair'], 2)} | "
      f"{f(g['forgone_arb_to_fair'] + g['forgone_noise_u50_to_fair'], 2)} | "
      f"{f(gr['arb-band/0.05/default/u50']['ratio_to_fair'], 2)} | {f(gr['arb-band/0.05/flat m=1/u20']['ratio_to_fair'], 2)} | "
      f"{f(gr['arb-band/0.05/default/u80']['ratio_to_fair'], 2)} | {f(gr['band+noise/0.05/default/u50']['ratio_to_fair'], 2)} |")
P("")
P("Expected premium / fair by floor (curve default, u50, arb-band) - shows how little the floor matters near the money:\n")
fl = R["assumptions"]["floors"]
P("| token | tenor | vol ref | " + " | ".join(pct(x, 0) for x in fl) + " |")
P("|---|---|---|" + "---|" * len(fl))
for k, g in R["gbm_exante"].items():
    t, tn, lab = k.split("/")
    P(f"| {t} | {tn} | {lab} | " + " | ".join(f(g["grid"][f"arb-band/{x}/default/u50"]["ratio_to_fair"], 2) for x in fl)
      + " |")
P("")

P("## Protocol: premium flow per $ of FORGE LP capital (median over 7-day windows, keeper, default pricing)\n")
P("| token | fee model | demand | premium paid, % of LP capital / yr | LP extra vs Orca, bps / 7d | max take on premium "
  "(B >= A in 95%) | revenue at 10% take on excess over forgone, bps / 7d |")
P("|---|---|---|---|---|---|---|")
for t in TOKENS:
    for mode in ("arb-band", "band+noise"):
        for cfg in ("u20-short", "u50-short", "u80-short", "u50-long"):
            r = lp_row(t, "7d", mode, cfg)
            mt = max([x for x, v in r["takes"].items() if v["share_B_ge_A"] >= 0.95], key=float, default=None)
            P(f"| {t} | {mode} | {cfg} | {pct(r['premium_apr_median'])} | {f(r['extra_bps_median'])} | "
              f"{pct(float(mt), 0) if mt else 'none'} | {f(r['takes_on_excess']['0.10']['revenue_bps_median'], 2)} |")
P("")

P("## Pricing band (arb-band; LP test on recent 7d/30d windows, every demand level; borrower test ex ante)\n")
P("| token | floor | curve | LP: max take on premium | LP: max take on excess | LP extra 7d u50-short bps | "
  "borrower E[premium]/fair 7d | 30d | in band |")
P("|---|---|---|---|---|---|---|---|---|")
for _k, b in R["pricing_band"]["arb-band"].items():
    ex = b["borrower_exante_ratio"]
    r7 = ", ".join(f"{lab.split('/')[1]} {f(v, 2)}" for lab, v in ex.items() if lab.startswith("7d"))
    r30 = ", ".join(f"{lab.split('/')[1]} {f(v, 2)}" for lab, v in ex.items() if lab.startswith("30d"))
    P(f"| {b['token']} | {pct(b['floor'], 0)} | {b['curve']} | {pct(b['lp_max_take_95pct'], 0)} | "
      f"{pct(b['lp_max_take_on_excess_95pct'], 0)} | {f(b['lp_extra_bps_median_7d_u50_short'])} | {r7} | {r30} | "
      f"{'yes' if b['in_band'] else 'no'} |")
P("")
print("\n".join(out))
