'use client';
// CreatePool — act|see redesign of the Meteora DAMM v1 pool-init flow.
// Left: the create-pool form (two deposit legs + fee tier + vault pre-flight).
// Right: the signature ledger + the deterministic PDAs we'll create + the
// honest outcome. Pool init is expensive (~5 SOL rent across ~7 new accounts),
// so it stays preview-then-confirm: every account is shown before you sign.
//
// Logic is unchanged from the prior screen — same props, same local state, same
// onPreviewChange / canSubmit / onSubmit / vault-init / token-deploy handlers.
// Only the presentation moved off the retired light design onto the rig, and the
// legacy TxModal was replaced by the inline act|see status line.

import React, { useMemo, useState } from 'react';
import bs58 from 'bs58';
import { fmtNum } from '../primitives';
import { Ledger } from '../design/Ledger';
import { TxError, TxHash, Address } from '../design/Inline';
import s from '../design/actsee.module.css';

/// Compact bs58 (start … end) for the deterministic-PDA preview list.
function shortB58(v) {
  if (!v) return '—';
  const str = typeof v === 'string' ? v : String(v);
  if (str.length <= 14) return str;
  return `${str.slice(0, 6)}…${str.slice(-6)}`;
}

const FEE_TIERS = [
  { bps: 25n, label: '0.25%', note: 'Default' },
  { bps: 100n, label: '1.0%', note: 'Volatile' },
  { bps: 400n, label: '4.0%', note: 'Exotic' },
];

const CreatePool = ({
  wallet,
  onConnect,
  tokens,
  balances,
  vaultsExist,
  poolExists,
  onPreviewChange,
  preview,
  txState,
  onSubmit,
  onInitVault,
  vaultInitState,
  onDeployToken,
  onResetDeployToken,
  deployTokenState,
}) => {
  const [showDeploy, setShowDeploy] = useState(false);
  const [picking, setPicking] = useState(null); // 'A' | 'B' | null
  const [fromSym, setFromSym] = useState(tokens?.[0]?.symbol ?? '');
  const [toSym, setToSym] = useState(tokens?.[1]?.symbol ?? '');
  const [amountA, setAmountA] = useState('');
  const [amountB, setAmountB] = useState('');
  const [feeBps, setFeeBps] = useState(25n);

  const fromTok = tokens?.find((t) => t.symbol === fromSym);
  const toTok = tokens?.find((t) => t.symbol === toSym);

  const balOf = (tok) => {
    if (!tok || !balances) return 0;
    const raw = balances[tok.address?.toLowerCase?.() ?? tok.address];
    return raw === undefined ? 0 : Number(raw) / 10 ** tok.decimals;
  };
  const fromBalance = useMemo(() => balOf(fromTok), [fromTok, balances]); // eslint-disable-line react-hooks/exhaustive-deps
  const toBalance = useMemo(() => balOf(toTok), [toTok, balances]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface inputs to the page wrapper so it can derive PDAs + estimate.
  React.useEffect(() => {
    if (typeof onPreviewChange !== 'function') return;
    onPreviewChange({
      fromSym,
      toSym,
      amountA: parseFloat(amountA) || 0,
      amountB: parseFloat(amountB) || 0,
      feeBps,
    });
  }, [fromSym, toSym, amountA, amountB, feeBps, onPreviewChange]);

  const a = parseFloat(amountA) || 0;
  const b = parseFloat(amountB) || 0;

  const fromVaultExists =
    fromTok && vaultsExist?.byMint?.[fromTok.mintAddress?.toLowerCase?.() ?? ''] === 'exists';
  const toVaultExists =
    toTok && vaultsExist?.byMint?.[toTok.mintAddress?.toLowerCase?.() ?? ''] === 'exists';

  const sameToken = fromSym === toSym;
  const balOk = a > 0 && a <= fromBalance && b > 0 && b <= toBalance;
  const vaultsOk = fromVaultExists && toVaultExists;
  const poolAlreadyExists = poolExists?.exists === 'exists';
  const canSubmit = wallet.connected && !sameToken && balOk && vaultsOk && !poolAlreadyExists;

  const phase = txState?.status ?? 'idle';
  const busy = phase === 'signing' || phase === 'submitting' || phase === 'confirming';

  let ctaLabel = 'Create pool';
  let ctaCaption = 'atomic · one signature · CPI → Meteora DAMM v1';
  let ctaDisabled = wallet.connected && !canSubmit;
  let ctaOnClick = () => {
    if (!wallet.connected) return onConnect();
    if (!canSubmit || typeof onSubmit !== 'function') return;
    onSubmit({ fromSym, toSym, amountA: a, amountB: b, feeBps });
  };
  if (!wallet.connected) {
    ctaLabel = 'Connect wallet';
    ctaCaption = 'one wallet — no bridge, no Phantom';
    ctaDisabled = false;
    ctaOnClick = onConnect;
  } else if (busy) {
    ctaLabel = phase === 'signing' ? 'Awaiting signature…' : phase === 'confirming' ? 'Confirming…' : 'Submitting…';
    ctaCaption = 'atomic · one signature · CPI → Meteora DAMM v1';
    ctaDisabled = true;
  } else if (sameToken) ctaLabel = 'Pick two different tokens';
  else if (a <= 0 || b <= 0) ctaLabel = 'Enter both deposit amounts';
  else if (a > fromBalance) ctaLabel = `Insufficient ${fromSym}`;
  else if (b > toBalance) ctaLabel = `Insufficient ${toSym}`;
  else if (!vaultsOk) ctaLabel = 'Vault setup required';
  else if (poolAlreadyExists) ctaLabel = 'Pool already exists';

  let statusNode = <>Preview · this is exactly what your wallet will sign</>;
  if (phase === 'confirmed')
    statusNode = (
      <>
        <span className={s.ok}>✓ Pool created · LP tokens in your wallet</span>
        {txState?.hash ? <> · <TxHash hash={txState.hash} /></> : null}
      </>
    );
  else if (phase === 'failed') statusNode = <TxError error={txState?.error} />;
  else if (busy) statusNode = <>Confirm in MetaMask…</>;

  const impliedPrice = a > 0 && b > 0 ? b / a : null;

  const TokChip = ({ side, tok }) => (
    <button type="button" className={s.tokchip} onClick={() => setPicking(side)}>
      <span className={`${s.ic} ${s.gen}`}>{(tok?.symbol ?? '?').charAt(0).toLowerCase()}</span>
      <span className={s.sym}>{tok?.symbol ?? '—'}</span>
      <span className={s.car}>▾</span>
    </button>
  );

  return (
    <main className={s.work}>
      <div className={s.strip}>
        <div className={s.lead}>
          <span className={s.eyebrow}>Meteora · DAMM v1</span>
          <h1>
            Create a <em>liquidity pool</em>.
          </h1>
        </div>
        <span className={s.routepill}>
          <span className={`${s.dot} ${s.evm}`} /> EVM · Rome <span className={s.ar}>→</span> Meteora{' '}
          <span className={`${s.dot} ${s.sol}`} />
        </span>
      </div>

      <div className={s.rig}>
        {/* ── ACT: pool form ── */}
        <form
          className={`${s.col} ${s.act}`}
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            if (ctaOnClick) ctaOnClick();
          }}
        >
          <div className={s.colhd}>
            <span className={s.sd} /> You do this
          </div>

          {/* Token A leg */}
          <div className={s.leg}>
            <div className={s.r1}>
              <label>Token A · initial deposit</label>
              <span className={s.bal}>
                balance <b>{fmtNum(fromBalance)}</b> {fromSym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  className={s.amt}
                  inputMode="decimal"
                  aria-label="Token A amount"
                  placeholder="0.00"
                  value={amountA}
                  onChange={(e) => setAmountA(e.target.value.replace(/[^0-9.]/g, ''))}
                />
                <div className={s.usd}>your Rome account</div>
              </div>
              <TokChip side="A" tok={fromTok} />
            </div>
          </div>

          <div className={s.flipwrap}>
            <span className={s.flip} aria-hidden>
              +
            </span>
          </div>

          {/* Token B leg */}
          <div className={s.leg}>
            <div className={s.r1}>
              <label>Token B · initial deposit</label>
              <span className={s.bal}>
                balance <b>{fmtNum(toBalance)}</b> {toSym}
              </span>
            </div>
            <div className={s.r2}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <input
                  className={s.amt}
                  inputMode="decimal"
                  aria-label="Token B amount"
                  placeholder="0.00"
                  value={amountB}
                  onChange={(e) => setAmountB(e.target.value.replace(/[^0-9.]/g, ''))}
                />
                <div className={s.usd}>
                  {impliedPrice != null ? `1 ${fromSym} = ${fmtNum(impliedPrice)} ${toSym}` : 'sets the initial price'}
                </div>
              </div>
              <TokChip side="B" tok={toTok} />
            </div>
          </div>

          {/* Fee tier */}
          <div className={s.slip}>
            <span className={s.lbl}>Trading fee</span>
            {FEE_TIERS.map((f) => (
              <button
                key={String(f.bps)}
                type="button"
                aria-pressed={feeBps === f.bps}
                onClick={() => setFeeBps(f.bps)}
                title={f.note}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Vault pre-flight */}
          <div className={s.field}>
            <label>Pre-flight · Meteora vaults</label>
            {vaultsExist?.loading ? (
              <div className={s.usd}>Checking Meteora vaults…</div>
            ) : (
              <>
                <VaultRow label={fromSym} tok={fromTok} exists={fromVaultExists} onInitVault={onInitVault} vaultInitState={vaultInitState} />
                <VaultRow label={toSym} tok={toTok} exists={toVaultExists} onInitVault={onInitVault} vaultInitState={vaultInitState} />
                {!vaultsOk && (
                  <div className={s.usd} style={{ marginTop: 6, lineHeight: 1.5 }}>
                    Meteora needs a dynamic-vault per token before a pool can be created — one signature each, ~0.011 SOL rent.
                  </div>
                )}
                {poolAlreadyExists && poolExists?.poolAddress && (
                  <div className={s.usd} style={{ marginTop: 6, color: 'var(--bad)', lineHeight: 1.5 }}>
                    A pool already exists for this pair + fee at <span className={s.mono}>{shortB58(poolExists.poolAddress)}</span>. Pick a different fee tier or trade it on /swap.
                  </div>
                )}
              </>
            )}
          </div>

          {wallet.connected && (
            <div className={s.setupnote}>
              <span>Need a token that isn&apos;t listed?</span>
              <button
                type="button"
                onClick={() => {
                  onResetDeployToken && onResetDeployToken();
                  setShowDeploy(true);
                }}
                title="Spin up a fresh SPL mint + ERC20-SPL wrapper (~5-6 popups, ~3.3 mETH gas)"
              >
                + Deploy new token
              </button>
            </div>
          )}

          <div className={s['cta-wrap']}>
            <button className={s.cta} type="submit" disabled={ctaDisabled}>
              <span>{ctaLabel}</span>
              <span className={s.sig}>{ctaCaption}</span>
            </button>
          </div>
        </form>

        {/* ── SEE: ledger + accounts + outcome ── */}
        <section className={`${s.col} ${s.see}`}>
          <div className={s.colhd}>
            <span className={s.sd} /> What will happen
            <span className={s.pool}>{fromSym}/{toSym} · Meteora</span>
          </div>
          <div className={s.body}>
            <Ledger
              steps={[
                { id: 'pool', label: 'Initialize the pool', detail: 'CPI → Meteora DAMM v1 initialize', atomic: true },
              ]}
              count={1}
              sub={
                <>
                  One EVM signature initializes the pool, its LP mint + protocol-fee accounts, and seeds your deposit — all atomically on Solana.
                </>
              }
            />
            <div className={s.outcome}>
              <div className={`${s.ln} ${s.get}`}>
                <span className={s.k}>You deposit</span>
                <span className={s.v}>
                  {fmtNum(a)} {fromSym} + {fmtNum(b)} {toSym}
                </span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Trading fee</span>
                <span className={s.v}>{(Number(feeBps) / 100).toFixed(2)}% <small>{String(feeBps)} bps</small></span>
              </div>
              <div className={s.ln}>
                <span className={s.k}>Initial price</span>
                <span className={s.v}>{impliedPrice != null ? `1 ${fromSym} = ${fmtNum(impliedPrice)} ${toSym}` : '—'}</span>
              </div>

              {preview?.addresses && (
                <div className={s.note} style={{ marginTop: 4 }}>
                  <div style={{ marginBottom: 6 }}>
                    <b>Accounts to be created</b> — deterministic PDAs:
                  </div>
                  <div className={s.mono} style={{ fontSize: 11, lineHeight: 1.7 }}>
                    <div>pool · {shortB58(preview.addresses.pool?.toBase58?.())}</div>
                    <div>lp_mint · {shortB58(preview.addresses.lpMint?.toBase58?.())}</div>
                    <div>protocol_fee_a · {shortB58(preview.addresses.protocolTokenAFee?.toBase58?.())}</div>
                    <div>protocol_fee_b · {shortB58(preview.addresses.protocolTokenBFee?.toBase58?.())}</div>
                    <div>your LP ATA · {shortB58(preview.addresses.payerPoolLp?.toBase58?.())}</div>
                  </div>
                </div>
              )}

              <div className={s.note}>
                You pay rent for ~7 new accounts (~5 SOL on devnet) and your initial deposit; the LP tokens land in your
                wallet. Pool init packs 7 inits into one CPI — near Solana&apos;s 1.4M-CU ceiling, so dense pairs may need a
                retry.
              </div>
            </div>
          </div>
          <div className={s.status}>{statusNode}</div>
        </section>
      </div>

      {picking && (
        <div className={s.scrim} onClick={() => setPicking(null)}>
          <div className={s.picker} onClick={(e) => e.stopPropagation()}>
            <span className={s.eyebrow}>Select token {picking}</span>
            <div className={s.list} style={{ marginTop: 14 }}>
              {tokens?.map((t) => (
                <button
                  key={t.symbol}
                  type="button"
                  className={s.row}
                  onClick={() => {
                    if (picking === 'A') setFromSym(t.symbol);
                    else setToSym(t.symbol);
                    setPicking(null);
                  }}
                >
                  <span className={`${s.ic} ${s.gen}`}>{t.symbol.charAt(0).toLowerCase()}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className={s.sym}>{t.symbol}</div>
                    <div className={s.nm}>{t.name ?? t.symbol}</div>
                  </div>
                  <span className={s.bl}>{fmtNum(balOf(t))}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showDeploy && (
        <DeployTokenModal onClose={() => setShowDeploy(false)} onSubmit={onDeployToken} state={deployTokenState} />
      )}
    </main>
  );
};

/// One vault pre-flight row — exists check + "Create vault" when missing.
const VaultRow = ({ label, tok, exists, onInitVault, vaultInitState }) => {
  if (!tok) return <div className={s.usd}>Vault for {label}: —</div>;
  const mintBs58 = tok.mintAddress;
  const mintHexLc = mintBs58 ? `0x${publicKeyBs58ToHexLc(mintBs58)}` : null;
  const matches = vaultInitState && mintHexLc && vaultInitState.mintHex === mintHexLc;
  const inFlight = matches && !['idle', 'success', 'failed'].includes(vaultInitState.phase);
  const justSucceeded = matches && vaultInitState.phase === 'success';
  const justFailed = matches && vaultInitState.phase === 'failed';
  return (
    <div className={s.setupnote}>
      <span>
        Vault · {label}: {exists || justSucceeded ? <span className={s.ok}>✓ ready</span> : '— missing'}
      </span>
      {!exists && !justSucceeded && (
        <button
          type="button"
          disabled={inFlight}
          onClick={() => onInitVault && mintBs58 && onInitVault(mintBs58)}
          title={`Bootstrap Meteora vault for ${label} — one signature, ~0.011 SOL rent`}
        >
          {inFlight ? vaultInitPhaseLabel(vaultInitState.phase) : 'Create vault'}
        </button>
      )}
      {justFailed && (
        <span className={s.usd} style={{ maxWidth: 220 }}>
          <TxError error={vaultInitState.error} />
        </span>
      )}
    </div>
  );
};

function vaultInitPhaseLabel(phase) {
  if (phase === 'signing') return 'Sign…';
  if (phase === 'confirming') return 'Confirming…';
  return 'Working…';
}

const DEPLOY_STEPS = [
  { phase: 'creating-user', label: 'Register with factory (skipped if already)' },
  { phase: 'creating-mint', label: 'Create SPL mint account' },
  { phase: 'init-mint', label: 'Initialize mint (decimals + authority)' },
  { phase: 'deploying-wrapper', label: 'Deploy ERC20-SPL wrapper' },
  { phase: 'binding-account', label: 'Bind your ATA to wrapper' },
  { phase: 'minting-supply', label: 'Mint initial supply' },
];
const DEPLOY_PHASE_INDEX = (phase) => {
  const map = {
    'creating-user': 0, 'confirming-user': 0,
    'creating-mint': 1, 'confirming-mint': 1,
    'init-mint': 2, 'confirming-init': 2,
    'deploying-wrapper': 3, 'confirming-wrapper': 3,
    'binding-account': 4, 'confirming-binding': 4,
    'minting-supply': 5, 'confirming-supply': 5,
  };
  if (phase === 'success') return DEPLOY_STEPS.length;
  return map[phase] ?? -1;
};

/// Deploy a fresh SPL mint + ERC20-SPL wrapper. act|see-scrim modal; the
/// multi-step orchestration logic is unchanged from the prior light modal.
const DeployTokenModal = ({ onClose, onSubmit, state }) => {
  const [baseSymbol, setBaseSymbol] = useState('');
  const [name, setName] = useState('');
  const [mintAmount, setMintAmount] = useState('1000');
  const inFlight = state && !['idle', 'success', 'failed'].includes(state.phase);
  const done = state?.phase === 'success';
  const failed = state?.phase === 'failed';

  const cleanBase = baseSymbol.replace(/^r/i, '');
  const finalSymbol = cleanBase ? `r${cleanBase}` : '';

  const submit = () => {
    if (inFlight || !finalSymbol || !mintAmount) return;
    onSubmit &&
      onSubmit({
        symbol: finalSymbol,
        name: name.trim() || `Rome-wrapped ${cleanBase}`,
        mintAmountHuman: parseFloat(mintAmount) || 0,
      });
  };

  const idx = DEPLOY_PHASE_INDEX(state?.phase ?? 'idle');
  const closable = done || failed || !inFlight;

  return (
    <div className={s.scrim} onClick={closable ? onClose : undefined}>
      <div className={s.picker} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <span className={s.eyebrow}>Deploy new token</span>

        {!inFlight && !done && !failed && (
          <>
            <div className={s.usd} style={{ margin: '10px 0 16px', lineHeight: 1.5 }}>
              Creates a brand-new SPL token on Solana, deploys the ERC20-SPL wrapper on Rome, and mints the initial
              supply to your wallet. ~5-6 popups, ~3.3 mETH gas.
            </div>
            <div className={s.field} style={{ borderTop: 'none', padding: '8px 0' }}>
              <label>Token symbol · we add the r prefix</label>
              <input
                className={s.txt}
                placeholder="TSLA"
                value={baseSymbol}
                onChange={(e) => setBaseSymbol(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase())}
              />
              {finalSymbol && <div className={s.usd} style={{ marginTop: 6 }}>Deploys as <b>{finalSymbol}</b></div>}
            </div>
            <div className={s.field} style={{ borderTop: 'none', padding: '8px 0' }}>
              <label>Display name</label>
              <input
                className={s.txt}
                placeholder={`Rome-wrapped ${cleanBase || 'XXX'}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className={s.field} style={{ borderTop: 'none', padding: '8px 0' }}>
              <label>Initial mint amount</label>
              <input className={s.txt} placeholder="1000" value={mintAmount} onChange={(e) => setMintAmount(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
            <div className={s['cta-wrap']} style={{ padding: '12px 0 0' }}>
              <button className={s.cta} type="button" onClick={submit} disabled={!finalSymbol || !mintAmount}>
                <span>Deploy {finalSymbol || 'token'}</span>
                <span className={s.sig}>fresh SPL mint + ERC20-SPL wrapper</span>
              </button>
            </div>
          </>
        )}

        {(inFlight || done) && (
          <ol className={s.steps} style={{ marginTop: 14 }}>
            {DEPLOY_STEPS.map((st, i) => {
              const status = done || i < idx ? 'done' : i === idx ? 'active' : 'pending';
              return (
                <li key={st.phase} className={status === 'pending' ? undefined : s.action}>
                  <span className={s.n} />
                  <div>
                    <div className={s.h}>
                      {st.label}
                      {status === 'active' && <span className={s.atomic}>in progress</span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {done && state.wrapper && (
          <div className={s.note} style={{ marginTop: 14 }}>
            <div style={{ marginBottom: 4 }}><b>Wrapper</b></div>
            <Address value={state.wrapper} />
          </div>
        )}
        {failed && (
          <div className={s.note} style={{ marginTop: 14, color: 'var(--bad)' }}>
            <TxError error={state.error} />
          </div>
        )}
        {(done || failed) && (
          <div className={s['cta-wrap']} style={{ padding: '14px 0 0' }}>
            <button className={s.cta} type="button" onClick={onClose}>
              <span>{done ? 'Done' : 'Close'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/// base58 pubkey → 0x-prefix-less hex, lowercased — matches useVaultInit's mintHex.
function publicKeyBs58ToHexLc(b58) {
  return Buffer.from(bs58.decode(b58)).toString('hex').toLowerCase();
}

export { CreatePool };
