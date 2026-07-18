'use client';
// Swap screen — the act|see redesign. Left column ("You do this") is the
// trade form; right column ("What will happen") is the LIVE signature ledger:
// the true number of MetaMask signatures, the ordered steps, the outcome, and
// a live settlement status. All trade math + the on-chain submit path are
// lifted unchanged from the data layer (app/swap/page.tsx passes them as
// props); only the presentation is new. Dark palette via the actsee CSS module.

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { fmtUSD, fmtNum } from '../primitives';
import { TxError, TxHash } from '../design/Inline';
import s from '../design/actsee.module.css';

// Symbol → Oracle Gateway V2 feed symbol. Strip a leading wrapper prefix
// (w/r) then match the underlying ticker. USDC must precede USDT.
function oracleSymbolFor(symbol) {
  if (typeof symbol !== 'string') return null;
  let x = symbol.toUpperCase();
  if ((x.startsWith('W') || x.startsWith('R')) && x.length > 1) x = x.slice(1);
  if (x === 'WSOL') return 'SOL';
  if (x === 'ETH') return 'ETH';
  if (x === 'SOL') return 'SOL';
  if (x === 'BTC') return 'BTC';
  if (x === 'USDC') return 'USDC';
  if (x === 'USDT') return 'USDT';
  return null;
}

function resolvePrice(symbol, prices) {
  const oracleSym = oracleSymbolFor(symbol);
  if (!oracleSym) return 0;
  return prices?.[oracleSym]?.usd ?? 0;
}

// Map a token to the colored icon class in the ledger's visual language.
function iconClass(symbol) {
  const o = oracleSymbolFor(symbol);
  if (o === 'USDC' || o === 'USDT') return s.usdc;
  if (o === 'SOL') return s.sol;
  if (o === 'ETH') return s.eth;
  return s.gen;
}

function registerPhaseLabel(phase) {
  if (phase === 'creating-user') return 'Sign 1…';
  if (phase === 'confirming-user') return '1 confirming…';
  if (phase === 'binding-account') return 'Sign 2…';
  if (phase === 'confirming-account') return '2 confirming…';
  return 'Working…';
}

const Swap = ({
  wallet,
  onConnect,
  onQuoteInputsChange,
  costEstimate,
  onSubmitSwap,
  txState,
  balances,
  tokens,
  prices,
  registration,
  onRegisterWrapper,
  registerState,
  feeTierPools,
  selectedFeeBps,
  onSelectFeeBps,
  signaturePlan,
  // Real per-pair routability (a Meteora pool routes the CURRENT pair) and the
  // canonical routable default pair — both resolved by the route from the live
  // pool set. pairRoutable is undefined until the first quote resolves.
  pairRoutable,
  defaultPair,
}) => {
  const firstSym = tokens?.[0]?.symbol ?? 'USDC';
  const secondSym = tokens?.[1]?.symbol ?? 'WSOL';
  const [fromSym, setFromSym] = useState(firstSym);
  const [toSym, setToSym] = useState(secondSym);
  // True once the user manually picks a pair — stops the routable-default
  // effect from overriding their choice.
  const touchedRef = useRef(false);
  useEffect(() => {
    if (!tokens || tokens.length < 2) return;
    const syms = new Set(tokens.map((t) => t.symbol));
    if (!syms.has(fromSym)) setFromSym(tokens[0].symbol);
    if (!syms.has(toSym)) setToSym(tokens[1].symbol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens?.map((t) => t.symbol).join(',')]);
  // Open on the canonical routable pair (e.g. wUSDC→wSOL) once the route
  // resolves it — never default to an unroutable pair like wUSDC→wETH.
  useEffect(() => {
    if (touchedRef.current) return;
    if (defaultPair?.fromSym && defaultPair?.toSym) {
      setFromSym(defaultPair.fromSym);
      setToSym(defaultPair.toSym);
    }
  }, [defaultPair?.fromSym, defaultPair?.toSym]);
  const [amount, setAmount] = useState('1');
  const [slippage, setSlippage] = useState('0.5');
  const [showPicker, setShowPicker] = useState(null);

  // Merge live token list with oracle prices + wallet balances.
  const TOKENS = useMemo(() => {
    const list = tokens ?? [];
    return list.map((t) => {
      let balance = 0;
      const raw = balances?.[t.address?.toLowerCase?.() ?? t.address];
      if (raw !== undefined) balance = Number(raw) / 10 ** t.decimals;
      return {
        symbol: t.symbol,
        name: t.name ?? t.symbol,
        decimals: t.decimals,
        address: t.address,
        mintAddress: t.mintAddress,
        tokenType: t.tokenType,
        price: resolvePrice(t.symbol, prices),
        balance,
      };
    });
  }, [tokens, balances, prices]);

  const from = TOKENS.find((t) => t.symbol === fromSym);
  const to = TOKENS.find((t) => t.symbol === toSym);

  const a = parseFloat(amount) || 0;

  const feeBps = typeof costEstimate?.feeBps === 'number' ? costEstimate.feeBps : 30;
  const feeRate = feeBps / 10_000;

  const fromPrice = from?.price ?? 0;
  const toPrice = to?.price ?? 0;
  let actualOut = 0;
  if (costEstimate?.expectedOutput && to?.decimals != null) {
    actualOut = Number(costEstimate.expectedOutput) / 10 ** to.decimals;
  } else if (fromPrice > 0 && toPrice > 0) {
    actualOut = a * (fromPrice / toPrice) * (1 - feeRate);
  }

  const rate = a > 0 && actualOut > 0 ? actualOut / a : toPrice > 0 ? fromPrice / toPrice : 0;
  const out = actualOut;
  const minOut = out * (1 - parseFloat(slippage) / 100);

  // USD value of the trade. A stablecoin leg (USDC/USDT wrapper) is reliably
  // $1, so anchor to it — the realizable value through THIS pool — rather than
  // an oracle price for the volatile leg. The oracle can sit far from the pool
  // price, which would paint a phantom windfall (e.g. "$1 in → $82 out"). Both
  // legs then read consistently. Fall back to oracle only when neither leg is a
  // stable.
  const fromStable = ['USDC', 'USDT'].includes(oracleSymbolFor(fromSym));
  const toStable = ['USDC', 'USDT'].includes(oracleSymbolFor(toSym));
  const usdValue = fromStable ? a : toStable ? out : a * fromPrice;

  // Surface quote inputs to the route wrapper (drives the live cost quote).
  useEffect(() => {
    if (typeof onQuoteInputsChange !== 'function') return;
    onQuoteInputsChange({ fromSym, toSym, amount: a, slippagePct: parseFloat(slippage) || 0 });
  }, [onQuoteInputsChange, fromSym, toSym, a, slippage]);

  const liveFee =
    costEstimate && typeof costEstimate.feeUSD === 'number' ? costEstimate.feeUSD : usdValue * feeRate;
  // Rent only applies when this swap creates a new account (the out-token ATA);
  // a warm swap pays none. Tie it to the live signature plan's setup step.
  const createsAccount = (signaturePlan?.setupCount ?? 0) > 0;
  const liveRent =
    costEstimate && typeof costEstimate.rentUSD === 'number'
      ? costEstimate.rentUSD
      : createsAccount
        ? 0.02
        : 0;
  const liveGas =
    costEstimate && typeof costEstimate.gasUSD === 'number' ? costEstimate.gasUSD : 0.008;
  // Total = pool fee + EVM gas + (one-time) rent. (Was a stale formula that
  // dropped gas entirely — total read less than the gas line above it.)
  const liveTotal = liveFee + liveGas + liveRent;

  const flip = () => {
    touchedRef.current = true;
    setFromSym(toSym);
    setToSym(fromSym);
    setAmount(out > 0 ? out.toFixed(6).replace(/\.?0+$/, '') : '');
  };

  const fromBalance = from?.balance ?? 0;
  // Gate on the route's real per-pair routability — a per-token "swappable"
  // flag wrongly passed pairs that share no pool (wETH→wUSDC) and reverted at
  // submit. undefined = still resolving (optimistic label, but no submit yet).
  const routable = pairRoutable === true;
  const canSubmit = wallet.connected && a > 0 && a <= fromBalance && routable;

  let btnLabel = 'Swap';
  if (!wallet.connected) btnLabel = 'Connect wallet';
  else if (pairRoutable === false) btnLabel = `No pool · ${fromSym}→${toSym}`;
  else if (a <= 0) btnLabel = 'Enter an amount';
  else if (a > fromBalance) btnLabel = `Insufficient ${fromSym}`;

  const onSwap = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!wallet.connected) {
      onConnect();
      return;
    }
    if (!canSubmit) return;
    if (typeof onSubmitSwap === 'function') {
      onSubmitSwap({ fromSym, toSym, amount: a, slippagePct: parseFloat(slippage) || 0 });
    }
  };

  // Live signature ledger (true count incl. one-time setup) from on-chain state.
  const plan = signaturePlan ?? {
    steps: [{ id: 'swap', label: 'Swap on Meteora', detail: 'CPI → Meteora swap', atomic: true, setup: false }],
    count: 1,
    setupCount: 0,
    loading: false,
  };
  const countText = plan.loading ? '·' : String(plan.count);
  const sigWord = plan.count === 1 ? 'signature' : 'signatures';
  const sigCaption = plan.loading
    ? 'Checking your accounts…'
    : plan.count === 1
      ? '1 signature · settles atomically on Solana'
      : `${plan.count} signatures · first ${toSym} trade, then 1`;

  // Live settlement status line (replaces the old light modal).
  const status = txState?.status;
  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (status === 'signing') statusNode = <>Confirm in MetaMask…</>;
  else if (status === 'submitting') statusNode = <>Submitting to Rome…</>;
  else if (status === 'confirming') statusNode = <>Settling on Solana…</>;
  else if (status === 'confirmed')
    statusNode = (
      <>
        <span className={s.ok}>✓ Settled on Solana</span>
        {txState?.hash ? <> · <TxHash hash={txState.hash} /></> : null}
      </>
    );
  else if (status === 'failed')
    statusNode = <TxError error={txState?.error} />;

  // Preserve the wrapper-registration function (restyled, inline).
  const fromReg = registration?.[from?.address?.toLowerCase?.() ?? ''];
  const fromRegistering =
    registerState &&
    registerState.wrapperAddress &&
    from?.address &&
    registerState.wrapperAddress.toLowerCase() === from.address.toLowerCase() &&
    !['idle', 'success', 'failed'].includes(registerState.phase);

  return (
    <>
      <main className={s.work}>
        <div className={s.strip}>
          <div className={s.lead}>
            <span className={s.eyebrow}>The road between chains</span>
            <h1>
              Trade Solana from your EVM wallet — <em>one wallet, no bridge</em>.
            </h1>
          </div>
          <span className={s.routepill}>
            <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Meteora{' '}
            <span className={`${s.dot} ${s.sol}`} />
          </span>
        </div>

        <div className={s.rig}>
          {/* ── ACT ── */}
          <form className={`${s.col} ${s.act}`} autoComplete="off" onSubmit={onSwap}>
            <div className={s.colhd}>
              <span className={s.sd} /> You do this
            </div>

            <div className={s.leg}>
              <div className={s.r1}>
                <label>You pay</label>
                <span className={s.bal}>
                  balance <b>{fmtNum(fromBalance)}</b> {fromSym}
                </span>
              </div>
              <div className={s.r2}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input
                    className={s.amt}
                    inputMode="decimal"
                    aria-label="Pay amount"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <div className={s.usd}>≈ {fmtUSD(usdValue)}</div>
                </div>
                <button type="button" className={s.tokchip} onClick={() => setShowPicker('from')}>
                  <span className={`${s.ic} ${iconClass(fromSym)}`}>{fromSym.charAt(0).toLowerCase()}</span>
                  <span className={s.sym}>{fromSym}</span>
                  <span className={s.car}>▾</span>
                </button>
              </div>
              <div className={s.pct}>
                {[25, 50, 100].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setAmount(((fromBalance * p) / 100).toFixed(6).replace(/\.?0+$/, ''))}
                  >
                    {p === 100 ? 'Max' : `${p}%`}
                  </button>
                ))}
              </div>
              {fromReg === 'unregistered' && (
                <div className={s.setupnote}>
                  <span>Set up {fromSym} on EVM so MetaMask shows it.</span>
                  <button
                    type="button"
                    disabled={fromRegistering}
                    onClick={() => onRegisterWrapper && onRegisterWrapper(from.address)}
                  >
                    {fromRegistering ? registerPhaseLabel(registerState.phase) : `Set up ${fromSym}`}
                  </button>
                </div>
              )}
            </div>

            <div className={s.flipwrap}>
              <button type="button" className={s.flip} aria-label="Flip" onClick={flip}>
                ⇅
              </button>
            </div>

            <div className={s.leg}>
              <div className={s.r1}>
                <label>You receive</label>
                <span className={s.bal}>
                  balance <b>{fmtNum(to?.balance ?? 0)}</b> {toSym}
                </span>
              </div>
              <div className={s.r2}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <input
                    className={`${s.amt} ${s.out}`}
                    readOnly
                    aria-label="Receive amount"
                    value={out > 0 ? out.toFixed(6).replace(/\.?0+$/, '') : '0.00'}
                  />
                  <div className={s.usd}>≈ {fmtUSD(usdValue)}</div>
                </div>
                <button type="button" className={s.tokchip} onClick={() => setShowPicker('to')}>
                  <span className={`${s.ic} ${iconClass(toSym)}`}>{toSym.charAt(0).toLowerCase()}</span>
                  <span className={s.sym}>{toSym}</span>
                  <span className={s.car}>▾</span>
                </button>
              </div>
            </div>

            <div className={s.slip}>
              <span className={s.lbl}>Slippage</span>
              {['0.1', '0.5', '1.0'].map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={slippage === v}
                  onClick={() => setSlippage(v)}
                >
                  {v}%
                </button>
              ))}
              <input
                aria-label="Custom slippage"
                value={slippage}
                onChange={(e) => setSlippage(e.target.value)}
              />
            </div>

            {feeTierPools && feeTierPools.length > 1 && (
              <div className={s.slip}>
                <span className={s.lbl}>Fee tier</span>
                {feeTierPools.map((p) => (
                  <button
                    key={p.feeBps}
                    type="button"
                    aria-pressed={selectedFeeBps === p.feeBps}
                    onClick={() => onSelectFeeBps && onSelectFeeBps(p.feeBps)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className={s['cta-wrap']}>
              <button className={s.cta} type="submit" disabled={wallet.connected && !canSubmit}>
                <span>{btnLabel}</span>
                <span className={s.sig}>{sigCaption}</span>
              </button>
            </div>
          </form>

          {/* ── SEE ── */}
          <section className={`${s.col} ${s.see}`}>
            <div className={s.colhd}>
              <span className={s.sd} /> What will happen
              <span className={s.pool}>Meteora DAMM v1 · CykB…PhCLa</span>
            </div>
            <div className={s.body}>
              <div className={s.sigbox}>
                <div className={`${s.big} ${plan.loading ? s.loading : ''}`}>{countText}</div>
                <div>
                  <div className={s.l1}>
                    {plan.loading ? 'checking accounts' : sigWord} in MetaMask
                  </div>
                  <div className={s.l2}>
                    One wallet — <b>no bridge, no Phantom, no second account</b>.
                  </div>
                </div>
              </div>

              <div className={s.ledtitle}>You will sign, in order</div>
              <ol className={s.steps}>
                {plan.steps.map((st) => (
                  <li key={st.id} className={st.setup ? undefined : s.action}>
                    <span className={s.n} />
                    <div>
                      <div className={s.h}>
                        {st.label}
                        {st.atomic && <span className={s.atomic}>atomic</span>}
                        {st.setup && <span className={s.once}>one-time</span>}
                      </div>
                      {st.detail && (
                        <div className={s.d}>
                          <code>{st.detail}</code>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              <div className={s.outcome}>
                <div className={`${s.ln} ${s.get}`}>
                  <span className={s.k}>You receive at least</span>
                  <span className={s.v}>
                    {fmtNum(minOut, 6)} {toSym}
                  </span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>Rate</span>
                  <span className={s.v}>
                    1 {fromSym} = {fmtNum(rate, 6)} {toSym}
                  </span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>
                    Pool fee <small>{feeBps} bps</small>
                  </span>
                  <span className={s.v}>{fmtUSD(liveFee)}</span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>EVM gas · Rome</span>
                  <span className={s.v}>{fmtUSD(liveGas, { decimals: 3 })}</span>
                </div>
                <div className={s.ln}>
                  <span className={s.k}>Total cost</span>
                  <span className={s.v}>{fmtUSD(liveTotal)}</span>
                </div>
                <div className={s.note}>
                  {plan.setupCount > 0 ? (
                    <>
                      First trade into a new token adds <b>one</b> account-creation signature; after
                      that every swap is a single signature.
                    </>
                  ) : (
                    <>
                      The trade and your balance change land <b>together, or neither</b> — one atomic
                      Rome transaction.
                    </>
                  )}
                </div>
              </div>
            </div>
            <div className={s.status}>{statusNode}</div>
          </section>
        </div>
      </main>

      {showPicker && (
        <TokenPicker
          tokens={TOKENS.filter((t) => (showPicker === 'from' ? t.symbol !== toSym : t.symbol !== fromSym))}
          current={showPicker === 'from' ? fromSym : toSym}
          onPick={(sym) => {
            touchedRef.current = true;
            showPicker === 'from' ? setFromSym(sym) : setToSym(sym);
            setShowPicker(null);
          }}
          onClose={() => setShowPicker(null)}
        />
      )}
    </>
  );
};

const TokenPicker = ({ tokens, current, onPick, onClose }) => {
  const [q, setQ] = useState('');
  const filtered = tokens.filter(
    (t) =>
      t.symbol.toLowerCase().includes(q.toLowerCase()) ||
      (t.name ?? '').toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className={s.scrim} onClick={onClose}>
      <div className={s.picker} onClick={(e) => e.stopPropagation()}>
        <span className={s.eyebrow}>Select token</span>
        <input
          className={s.search}
          autoFocus
          placeholder="Search name or paste address"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className={s.list}>
          {filtered.map((t) => (
            <button
              key={t.symbol}
              type="button"
              className={s.row}
              disabled={t.symbol === current}
              onClick={() => onPick(t.symbol)}
            >
              <span className={`${s.ic} ${iconClass(t.symbol)}`}>{t.symbol.charAt(0).toLowerCase()}</span>
              <div style={{ minWidth: 0 }}>
                <div className={s.sym}>{t.symbol}</div>
                <div className={s.nm}>{t.name}</div>
              </div>
              <span className={s.bl}>{fmtNum(t.balance)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export { Swap };
