// Auto-connect to an injected wallet when the app is opened INSIDE a wallet's
// in-app browser (Solflare / Phantom). Avoids the dead "connect wallet" screen
// where the adapter, still in "Loadable" state, tries to redirect to a wallet
// universal link even though we're already inside that wallet's browser.
//
// Returns true if it kicked off a direct connect, false if no injected wallet
// was detected (caller should fall back to the manual wallet modal).
export async function autoConnectInjected({ wallets, select, showToast }) {
  if (typeof window === 'undefined') return false;

  // Phantom's window.phantom.solana injection can lag a few ms behind JS
  // execution on mobile. Poll briefly before giving up and falling through to
  // the manual wallet modal — this prevents a race where we miss the injection
  // and leave the user staring at a dark screen / manual-connect modal.
  const detectDeadline = Date.now() + 600;
  let inSolflare = false;
  let inPhantom = false;
  while (Date.now() < detectDeadline) {
    inSolflare = !!(window.solflare?.isSolflare || window.SolflareApp);
    inPhantom = !!(window.phantom?.solana?.isPhantom);
    if (inSolflare || inPhantom) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  let walletName = null;
  if (inSolflare) walletName = 'Solflare';
  else if (inPhantom) walletName = 'Phantom';
  if (!walletName) return false;

  const target = (wallets || []).find((w) => w.adapter.name === walletName);
  const adapter = target?.adapter;
  if (!adapter) return false;

  try {
    if (showToast) showToast(`Connecting to ${walletName}...`);
    select(walletName);

    // Wait for the adapter to recognize its injected provider (readyState ->
    // Installed). Until then connect() would take the wrong redirect path.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const ready =
        adapter.readyState === 'Installed' ||
        window.solflare?.isSolflare ||
        window.SolflareApp ||
        window.phantom?.solana?.isPhantom;
      if (ready) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (adapter.connected) return true;
    await adapter.connect();
    return true;
  } catch (e) {
    // Let the caller fall back to the modal on failure.
    return false;
  }
}
